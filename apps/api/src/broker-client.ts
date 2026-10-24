import {
  brokerLimits,
  brokerUtf8Bytes,
  challengeLimits,
  challengeTokenValid,
  decodeNeonLeaseGrant,
  decodeShopifyCredentialResult,
  decodeStripeCheckoutResult,
  decodeStripeCustomerResult,
  decodeStripePortalResult,
  decodeStripeWebhookResult,
  shopifyInstallationIdPattern,
  shopifyOperationIdValid,
  shopifyReadLimits,
  shopifyWriteLimits,
  stripeLimits,
  stripeOperationIdValid,
  type ApiBrokerRpc,
  type ChallengeVerdict,
} from "../../../packages/identity/src/broker-protocol.js";
import type { BillingBrokerPort } from "../../../packages/work/src/billing/port.js";
import type { CatalogReader } from "../../../packages/work/src/catalog/http.js";
import type { ApplyBrokerPort } from "../../../packages/work/src/review/http.js";
import type { CredentialDestroyer } from "../../../packages/work/src/connections/http.js";
import type { LoginControl } from "../../../packages/identity/src/standalone-login-protocol.js";
import type { WorkosSessionPageReader } from "../../../packages/identity/src/workos-session-status.js";

// api-side adapters over the ApiBroker service binding (P04.T02a D3, D6). They
// are structural (no `cloudflare:` import): no AbortSignal or absolute time
// crosses RPC, each call makes at most one RPC raced against the caller's own
// signal and timer, a late result is discarded, and nothing is retried.

const held = () => Error("API_BROKER_HELD");
const time = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8640000000000000;

// The control's own data only: exactly deadlineMs and signal.
export function brokerControl(value: unknown): Readonly<LoginControl> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw held();
  const keys = Reflect.ownKeys(value);
  const deadline = Object.getOwnPropertyDescriptor(value, "deadlineMs");
  const signal = Object.getOwnPropertyDescriptor(value, "signal");
  if (
    keys.length !== 2 ||
    !deadline ||
    !signal ||
    !("value" in deadline) ||
    !("value" in signal) ||
    !time(deadline.value) ||
    !(signal.value instanceof AbortSignal)
  )
    throw held();
  return Object.freeze({ deadlineMs: deadline.value, signal: signal.value });
}
function clock(now: () => number): number {
  const at: unknown = now();
  if (!time(at)) throw held();
  return at;
}

// Races one started operation against `signal` and a timer of `ms`. The loser is
// left to settle unobserved; its value is never used.
export async function raceBrokerCall<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T> {
  if (signal.aborted || !(ms > 0)) throw held();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(held());
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, ms);
  });
  void stopped.catch(() => {});
  try {
    const pending = start();
    void Promise.resolve(pending).catch(() => {});
    return await Promise.race([pending, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (stop) signal.removeEventListener("abort", stop);
  }
}

export function createBrokerNeonCredentialBroker(
  broker: ApiBrokerRpc,
  now: () => number,
): Readonly<{ borrow(namespaceJson: string, control: Readonly<LoginControl>): Promise<unknown> }> {
  return Object.freeze({
    async borrow(namespaceJson: string, supplied: Readonly<LoginControl>): Promise<unknown> {
      const control = brokerControl(supplied);
      if (
        typeof namespaceJson !== "string" ||
        brokerUtf8Bytes(namespaceJson) > brokerLimits.namespaceMaxBytes ||
        control.signal.aborted
      )
        throw held();
      const remaining = control.deadlineMs - clock(now);
      if (remaining <= 0) throw held();
      const grant = await raceBrokerCall(
        () => broker.neonLease(namespaceJson),
        control.signal,
        remaining,
      );
      const password = decodeNeonLeaseGrant(grant);
      // expiresAtMs adds nothing beyond the pool's own deadline D; the password is
      // static. release resolves locally and never aborts the signal, which the
      // pool's normal release path listens on.
      const release = async (releaseControl: Readonly<LoginControl>): Promise<void> => {
        brokerControl(releaseControl);
      };
      return Object.freeze({
        namespaceJson,
        password,
        expiresAtMs: control.deadlineMs,
        revocationSignal: new AbortController().signal,
        release,
      });
    },
  });
}

export function createBrokerSessionPageReader(
  broker: ApiBrokerRpc,
  workosNamespaceJson: string,
  now: () => number,
): WorkosSessionPageReader {
  return async (selectorJson: string, supplied) => {
    const control = brokerControl(supplied);
    if (typeof selectorJson !== "string" || control.signal.aborted) throw held();
    const budgetMs = Math.min(brokerLimits.sessionPageMaxMs, control.deadlineMs - clock(now));
    if (budgetMs <= 0) throw held();
    const page = await raceBrokerCall(
      () => broker.workosSessionPage(workosNamespaceJson, selectorJson, budgetMs),
      control.signal,
      budgetMs,
    );
    if (typeof page !== "string" || brokerUtf8Bytes(page) > brokerLimits.sessionPageMaxBytes)
      throw held();
    return page;
  };
}

// One health() RPC at a time, at most once per 30 s per isolate, each bounded by
// 1000 ms; a public /healthz therefore cannot amplify broker calls.
export function createBrokerHealth(
  broker: ApiBrokerRpc,
  now: () => number,
): () => Promise<boolean> {
  let cached: Readonly<{ at: number; value: boolean }> | undefined;
  let pending: Promise<boolean> | undefined;
  return () => {
    let at: number;
    try {
      at = clock(now);
    } catch {
      return Promise.resolve(false);
    }
    if (cached && at >= cached.at && at - cached.at < brokerLimits.healthCacheMs)
      return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = (async () => {
      let value = false;
      try {
        // A fresh signal per call: Workers bind I/O objects to the request that
        // created them, and this instance outlives the request that composed it.
        const unaborted = new AbortController().signal;
        value =
          (await raceBrokerCall(() => broker.health(), unaborted, brokerLimits.healthMaxMs)) ===
          true;
      } catch {
        value = false;
      }
      cached = Object.freeze({ at, value });
      pending = undefined;
      return value;
    })();
    return pending;
  };
}

// P05.T01ab: exactly one challengeVerify RPC, raced against the request's signal and
// the budget plus a small RPC allowance; never retried. Only "passed" or "failed"
// are verdicts; anything else, a late reply or a throw is API_BROKER_HELD.
export function createBrokerChallengeVerifier(
  broker: ApiBrokerRpc,
): (
  action: string,
  token: string,
  budgetMs: number,
  signal: AbortSignal,
) => Promise<ChallengeVerdict> {
  return async (action, token, budgetMs, signal) => {
    if (
      typeof action !== "string" ||
      !challengeTokenValid(token) ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > challengeLimits.budgetMaxMs ||
      !(signal instanceof AbortSignal)
    )
      throw held();
    const verdict: unknown = await raceBrokerCall(
      () => broker.challengeVerify(action, token, budgetMs),
      signal,
      budgetMs + 250,
    );
    if (verdict !== "passed" && verdict !== "failed") throw held();
    return verdict;
  };
}

// M5 PR-1: the billing port over the ApiBroker's four Stripe methods. Ids and strings only
// cross RPC; each call is exactly one RPC raced against the caller's signal and a budget
// plus a small RPC allowance, never retried (a retry is the client's, with the same
// Idempotency-Key, which reconciles the same operation). A result that is not the closed
// JSON, a late reply or a throw is API_BROKER_HELD.
export const brokerStripeBudgetMs = 8000;
export function createBrokerStripe(broker: ApiBrokerRpc): BillingBrokerPort {
  const budget = brokerStripeBudgetMs;
  const allowance = budget + 500;
  const operation = (id: unknown): string => {
    if (!stripeOperationIdValid(id)) throw held();
    return id;
  };
  return Object.freeze({
    async customerEnsure(operationId: string, signal: AbortSignal) {
      const id = operation(operationId);
      return decodeStripeCustomerResult(
        await raceBrokerCall(() => broker.stripeCustomerEnsure(id, budget), signal, allowance),
      );
    },
    async checkoutCreate(operationId: string, signal: AbortSignal) {
      const id = operation(operationId);
      return decodeStripeCheckoutResult(
        await raceBrokerCall(() => broker.stripeCheckoutCreate(id, budget), signal, allowance),
      );
    },
    async portalCreate(operationId: string, signal: AbortSignal) {
      const id = operation(operationId);
      return decodeStripePortalResult(
        await raceBrokerCall(() => broker.stripePortalCreate(id, budget), signal, allowance),
      );
    },
    async webhookVerify(rawBodyBase64: string, signatureHeader: string, signal: AbortSignal) {
      if (
        typeof rawBodyBase64 !== "string" ||
        rawBodyBase64.length === 0 ||
        rawBodyBase64.length > stripeLimits.webhookBase64MaxBytes ||
        typeof signatureHeader !== "string" ||
        signatureHeader.length === 0 ||
        signatureHeader.length > stripeLimits.signatureMaxBytes
      )
        throw held();
      return decodeStripeWebhookResult(
        await raceBrokerCall(
          () => broker.stripeWebhookVerify(rawBodyBase64, signatureHeader, budget),
          signal,
          allowance,
        ),
      );
    },
  });
}

// "Disconnect store": after the disconnect committed, one ApiBroker.shopifyCredentialDestroy
// for the disconnected installation (the broker fixes the reason), raced against the
// caller's signal and the budget plus a small RPC allowance, never retried here (the
// connector's cron re-drives a destruction that did not complete). The closed result is
// decoded; anything else, a late reply or a throw is API_BROKER_HELD.
export const brokerCredentialBudgetMs = 4000;
export function createBrokerCredentialDestroyer(broker: ApiBrokerRpc): CredentialDestroyer {
  return Object.freeze({
    async destroy(installationId: string, signal: AbortSignal) {
      if (typeof installationId !== "string" || !shopifyInstallationIdPattern.test(installationId))
        throw held();
      return decodeShopifyCredentialResult(
        await raceBrokerCall(
          () => broker.shopifyCredentialDestroy(installationId),
          signal,
          brokerCredentialBudgetMs,
        ),
      );
    },
  });
}

// M2 PR-3: the catalogue routes' one ApiBroker.shopifyRead, under the read lease the route's
// transaction opened: the lease, its generation and subject, the query and its closed
// variables cross RPC, raced against the caller's signal and the budget plus a small RPC
// allowance, never retried. The result is returned as text for the route's closed decoder.
export function createBrokerShopifyReader(broker: ApiBrokerRpc): CatalogReader {
  return Object.freeze({
    async read(
      lease: Parameters<CatalogReader["read"]>[0],
      queryName: Parameters<CatalogReader["read"]>[1],
      variablesJson: string,
      signal: AbortSignal,
      budgetMs: number,
    ) {
      if (
        !Number.isSafeInteger(budgetMs) ||
        budgetMs < 1 ||
        budgetMs > shopifyReadLimits.budgetMaxMs ||
        typeof variablesJson !== "string" ||
        brokerUtf8Bytes(variablesJson) > shopifyReadLimits.variablesMaxBytes
      )
        throw held();
      const text: unknown = await raceBrokerCall(
        () =>
          broker.shopifyRead(
            lease.leaseId,
            lease.generation,
            lease.subjectId,
            queryName,
            variablesJson,
            budgetMs,
          ),
        signal,
        budgetMs + 250,
      );
      if (typeof text !== "string" || brokerUtf8Bytes(text) > shopifyReadLimits.resultMaxBytes)
        throw held();
      return text;
    },
  });
}

// v1 PR 3: the gateway's ApiBroker.shopifyProductApply and shopifyProductReconcile, one
// operation id and a budget each, raced against the caller's signal and the budget plus a
// small RPC allowance, never retried here (the review route decides what follows: an apply
// whose reply is lost is read back, never sent again). The result is returned as text for the
// route's closed decoder.
export function createBrokerApplyPort(broker: ApiBrokerRpc): ApplyBrokerPort {
  const call = async (
    method: "shopifyProductApply" | "shopifyProductReconcile",
    operationId: string,
    budgetMs: number,
    signal: AbortSignal,
  ) => {
    if (
      !shopifyOperationIdValid(operationId) ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > shopifyWriteLimits.budgetMaxMs
    )
      throw held();
    const text: unknown = await raceBrokerCall(
      () => broker[method](operationId, budgetMs),
      signal,
      budgetMs + 500,
    );
    if (typeof text !== "string" || brokerUtf8Bytes(text) > shopifyWriteLimits.resultMaxBytes)
      throw held();
    return text;
  };
  return Object.freeze({
    apply: (operationId: string, budgetMs: number, signal: AbortSignal) =>
      call("shopifyProductApply", operationId, budgetMs, signal),
    reconcile: (operationId: string, budgetMs: number, signal: AbortSignal) =>
      call("shopifyProductReconcile", operationId, budgetMs, signal),
  });
}
