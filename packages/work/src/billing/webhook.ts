import { billingEnvironments, type BillingEnvironment } from "@morrow/policy/billing-state";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
  type WorkSqlConnector,
  type WorkTx,
} from "../connection.js";
import { parseReceiptFacts, planReceiptApplication, receiptModeAccepted } from "./apply-plan.js";
import type { BillingBrokerPort } from "./commands.js";

// The Stripe webhook (M5 PR-1; ADR-0022 items 9 and 12, the item 9 amendment of 2026-10-20).
// POST /api/billing/stripe/webhook, public and sessionless. The api never parses the
// event: it passes the raw body (base64, byte-exact) and the Stripe-Signature header to
// the broker, which verifies the signature over the raw bytes, reads the object back with
// its own key and records a receipt (tenant only from the customer mapping). The api then
// applies that receipt through the receipt-only ingress definers in one transaction and
// answers 200 only after the commit; a lost commit is read back before any answer, and
// anything else is 503 so Stripe retries. A rejected signature is 400 with no row.

export interface StripeWebhookDependencies {
  readonly connector: WorkSqlConnector;
  readonly environment: BillingEnvironment;
  readonly broker: BillingBrokerPort;
  readonly now: () => number;
}
type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
export const stripeWebhookPath = "/api/billing/stripe/webhook";
export const stripeWebhookLimits = Object.freeze({
  bodyBytes: 262144,
  signatureBytes: 4096,
  brokerBudgetMs: 8000,
  databaseMs: 5000,
});

const responseHeaders = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});
const reply = (status: number, received: boolean, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ received }), { status, headers: { ...responseHeaders, ...extra } });

class BodyTooLarge extends Error {}
async function readRaw(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(0|[1-9][0-9]{0,8})$/.test(declared) || Number(declared) > stripeWebhookLimits.bodyBytes)
  )
    throw new BodyTooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw Error("WEBHOOK_BODY_INVALID");
      bytes += item.value.byteLength;
      if (bytes > stripeWebhookLimits.bodyBytes) throw new BodyTooLarge();
      chunks.push(item.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
/** Byte-exact base64 of the raw body, for the broker RPC. */
export function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

type Applied = { readonly outcome: string; readonly code: string | null };
async function apply(
  tx: WorkTx,
  receiptId: string,
  objectDigest: string,
  environment: BillingEnvironment,
  now: string,
): Promise<Applied> {
  const begun = await tx.run("receiptBegin", [receiptId, objectDigest]);
  const row = begun.length === 1 ? begun[0]! : null;
  if (!row || typeof row.outcome !== "string") throw new WorkReject("unavailable");
  if (row.outcome === "already_applied") {
    tx.rollbackOnly();
    return { outcome: "already_applied", code: null };
  }
  if (row.outcome !== "begun") throw new WorkReject("unavailable");
  const facts = parseReceiptFacts(row.facts);
  if (facts.receipt.id !== receiptId || facts.receipt.objectDigest !== objectDigest)
    throw new WorkReject("unavailable");
  // The broker already refuses the other mode; a receipt of it is never applied here.
  if (!receiptModeAccepted(facts.receipt, environment)) throw new WorkReject("unavailable");
  const plan = planReceiptApplication(facts, environment, now);
  tx.markSubmitted();
  const applied = await tx.run("receiptApply", [receiptId, objectDigest, JSON.stringify(plan)]);
  const result = applied.length === 1 ? applied[0]! : null;
  if (!result || typeof result.outcome !== "string") throw new WorkReject("unavailable");
  if (result.outcome === "already_applied") {
    tx.rollbackOnly();
    return { outcome: "already_applied", code: null };
  }
  if (result.outcome !== "applied") {
    // A decided refusal: nothing persists; Stripe retries the event.
    tx.rollbackOnly();
    throw new WorkReject(result.outcome === "conflict" ? "state_conflict" : "unavailable");
  }
  return { outcome: plan.outcome, code: plan.code };
}
async function status(tx: WorkTx, receiptId: string): Promise<boolean> {
  const rows = await tx.run("receiptStatus", [receiptId]);
  const row = rows.length === 1 ? rows[0]! : null;
  if (!row || typeof row.outcome !== "string") throw new WorkReject("unavailable");
  return row.outcome === "applied";
}

function dependencies(value: StripeWebhookDependencies): StripeWebhookDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    !(billingEnvironments as readonly unknown[]).includes(value.environment) ||
    !value.broker ||
    typeof value.broker.webhookVerify !== "function"
  )
    throw Error("STRIPE_WEBHOOK_CONFIGURATION_INVALID");
  const now = value.now;
  return Object.freeze({
    connector: Object.freeze({ open: value.connector.open.bind(value.connector) }),
    environment: value.environment,
    broker: value.broker,
    now: () => Reflect.apply(now, undefined, []) as number,
  });
}

// No dependencies: 404 with no network or database access (the route is not mounted).
export function createStripeWebhookHandler(d?: StripeWebhookDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(
    request: Request,
    ctx: Context,
  ): Promise<{ outcome: string; response: Response }> {
    if (!configured)
      return {
        outcome: "unbound",
        response: new Response('{"code":"not_found"}', { status: 404, headers: responseHeaders }),
      };
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return { outcome: "invalid", response: reply(400, false) };
    }
    if (url.pathname !== stripeWebhookPath || url.search !== "")
      return {
        outcome: "not_found",
        response: new Response('{"code":"not_found"}', { status: 404, headers: responseHeaders }),
      };
    if (request.method !== "POST")
      return { outcome: "method", response: reply(405, false, { allow: "POST" }) };
    const signature = request.headers.get("stripe-signature");
    if (
      signature === null ||
      signature.length === 0 ||
      signature.length > stripeWebhookLimits.signatureBytes ||
      !/^[\x21-\x7e]+$/.test(signature)
    )
      return { outcome: "signature_missing", response: reply(400, false) };
    let raw: Uint8Array;
    try {
      raw = await readRaw(request);
    } catch (error) {
      return error instanceof BodyTooLarge
        ? { outcome: "too_large", response: reply(413, false) }
        : { outcome: "invalid", response: reply(400, false) };
    }
    if (raw.byteLength === 0) return { outcome: "invalid", response: reply(400, false) };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), stripeWebhookLimits.brokerBudgetMs + 6000);
    try {
      let verdict;
      try {
        verdict = await configured.broker.webhookVerify(base64Bytes(raw), signature, abort.signal);
      } catch {
        return { outcome: "broker_held", response: reply(503, false) };
      }
      if (verdict.verdict === "rejected")
        return { outcome: "rejected", response: reply(400, false) };
      if (verdict.verdict === "ignored") return { outcome: "ignored", response: reply(200, true) };
      const receiptId = verdict.receiptId!;
      const digest = verdict.objectDigest!;
      const open = (): Promise<WorkSqlConnection> =>
        configured.connector.open({
          signal: abort.signal,
          deadlineMs: configured.now() + stripeWebhookLimits.databaseMs,
          waitUntil: (p) => ctx.waitUntil(p),
        });
      const options = () => ({
        readOnly: false,
        deadlineMs: configured.now() + stripeWebhookLimits.databaseMs,
        signal: abort.signal,
        now: configured.now,
      });
      let connection: WorkSqlConnection;
      try {
        connection = await open();
      } catch {
        return { outcome: "unavailable", response: reply(503, false) };
      }
      try {
        const applied = await withWorkTransaction(connection, options(), (tx) =>
          apply(
            tx,
            receiptId,
            digest,
            configured.environment,
            new Date(configured.now()).toISOString(),
          ),
        );
        logReceipt(receiptId, applied);
        return { outcome: applied.outcome, response: reply(200, true) };
      } catch (error) {
        if (!(error instanceof WorkOutcomeUnknown))
          return { outcome: "unavailable", response: reply(503, false) };
      } finally {
        await connection.close().catch(() => {});
      }
      // The commit's reply was lost: read the application back before any answer.
      try {
        const readback = await open();
        try {
          const applied = await withWorkTransaction(
            readback,
            { ...options(), readOnly: true },
            (tx) => status(tx, receiptId),
          );
          return applied
            ? { outcome: "readback_applied", response: reply(200, true) }
            : { outcome: "readback_pending", response: reply(503, false) };
        } finally {
          await readback.close().catch(() => {});
        }
      } catch {
        return { outcome: "uncertain", response: reply(503, false) };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    async fetch(request: Request, _env: unknown, ctx: Context): Promise<Response> {
      let outcome = "unavailable";
      try {
        if (!(request instanceof Request)) return reply(400, false);
        const handled = await handle(request, ctx);
        outcome = handled.outcome;
        return handled.response;
      } catch {
        return reply(503, false);
      } finally {
        console.log(JSON.stringify({ event: "morrow_billing_webhook", outcome }));
      }
    },
  });
}

// Held, unattributed and conflicting payments are recorded on the receipt and logged once
// for the owner: the internal receipt id and the fixed code, never provider text.
function logReceipt(receiptId: string, applied: Applied) {
  if (["held", "conflict", "refused"].includes(applied.outcome))
    console.log(
      JSON.stringify({
        event: "morrow_billing_receipt",
        receiptId,
        outcome: applied.outcome,
        code: applied.code,
      }),
    );
}
