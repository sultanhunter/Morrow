// M3 PR-2: closed decoders of the runs routes' replies (internal JSON between the api Worker
// and this SPA; docs/contracts/work-api.md "Runs routes"). A body that does not match
// exactly decodes to null, which the work outcome mapping turns into an unconfirmed read or
// an uncertain command, never a guess. The runs bodies carry ids, statuses, counts, credits
// and opaque catalogue keys only: a body naming a provider model string, or with content
// fields, does not decode.
import type { RunAdmittedView, RunDetailView, RunProductView, RunView } from "@morrow/workspace-ui";
import { isId } from "./client";
import { isUtcTime } from "./work-decoders";
import { isModelKey } from "./agents-decoders";

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value: Json, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const nullableInteger = (value: unknown, max: number) => value === null || integer(value, 0, max);
const status = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z_]{1,32}$/.test(value);
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const runId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const productId = (value: unknown): value is string =>
  typeof value === "string" && /^product:[1-9][0-9]{0,19}$/.test(value);
const listingFields = ["descriptionHtml", "seo.description", "seo.title", "tags", "title"];
const big = Number.MAX_SAFE_INTEGER;
const selectionOf = (value: unknown) =>
  record(value) &&
  exactly(value, ["model", "effort"]) &&
  isModelKey(value.model) &&
  isModelKey(value.effort)
    ? { model: value.model as string, effort: value.effort as string }
    : null;

/** One run as GET /work/tasks/:taskId/runs and GET /work/runs/:runId return it. */
export function decodeRun(value: unknown): RunView | null {
  if (
    !record(value) ||
    !exactly(value, [
      "runId",
      "revision",
      "taskId",
      "childTaskId",
      "storeId",
      "status",
      "endedReason",
      "selection",
      "catalogueVersion",
      "creditsPerProduct",
      "productCount",
      "fields",
      "productsDrafted",
      "productsFailed",
      "createdAt",
      "startedAt",
      "endedAt",
      "updatedAt",
    ])
  )
    return null;
  const selection = selectionOf(value.selection);
  if (
    !runId(value.runId) ||
    !integer(value.revision, 1, big) ||
    !isId(value.taskId) ||
    !isId(value.childTaskId) ||
    !isId(value.storeId) ||
    !status(value.status) ||
    !(value.endedReason === null || status(value.endedReason)) ||
    selection === null ||
    !integer(value.catalogueVersion, 1, 999) ||
    !integer(value.creditsPerProduct, 1, 99) ||
    !integer(value.productCount, 1, 25) ||
    !Array.isArray(value.fields) ||
    value.fields.length < 1 ||
    !value.fields.every((f) => typeof f === "string" && listingFields.includes(f)) ||
    !integer(value.productsDrafted, 0, 25) ||
    !integer(value.productsFailed, 0, 25) ||
    !isUtcTime(value.createdAt) ||
    !(value.startedAt === null || isUtcTime(value.startedAt)) ||
    !(value.endedAt === null || isUtcTime(value.endedAt)) ||
    !isUtcTime(value.updatedAt)
  )
    return null;
  return {
    runId: value.runId,
    taskId: value.taskId,
    storeId: value.storeId,
    status: value.status,
    endedReason: value.endedReason as string | null,
    selection,
    creditsPerProduct: value.creditsPerProduct,
    productCount: value.productCount,
    fields: [...(value.fields as string[])],
    productsDrafted: value.productsDrafted,
    productsFailed: value.productsFailed,
    createdAt: value.createdAt,
    endedAt: value.endedAt as string | null,
  };
}

/** GET /work/tasks/:taskId/runs: the task's runs, newest first, at most 20. */
export function decodeRunsOfTask(body: unknown, taskId: string): readonly RunView[] | null {
  if (!record(body) || !exactly(body, ["schemaVersion", "runs"]) || body.schemaVersion !== 1)
    return null;
  if (!Array.isArray(body.runs) || body.runs.length > 20) return null;
  const runs: RunView[] = [];
  for (const value of body.runs as unknown[]) {
    const run = decodeRun(value);
    if (!run || run.taskId !== taskId) return null;
    runs.push(run);
  }
  return runs;
}

function decodeFlags(value: unknown): RunProductView["flags"] | null | undefined {
  if (value === null) return null;
  if (
    !record(value) ||
    !exactly(value, ["newUrls", "newEmails", "newPhones", "tagsAdded", "tagsRemoved"]) ||
    !Object.values(value).every((n) => integer(n, 0, 999))
  )
    return undefined;
  return {
    newUrls: value.newUrls as number,
    newEmails: value.newEmails as number,
    newPhones: value.newPhones as number,
    tagsAdded: value.tagsAdded as number,
    tagsRemoved: value.tagsRemoved as number,
  };
}

/** GET /work/runs/:runId. */
export function decodeRunDetail(body: unknown, id: string): RunDetailView | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", "run", "credits", "usage", "products", "interrupted"]) ||
    body.schemaVersion !== 1 ||
    typeof body.interrupted !== "boolean"
  )
    return null;
  const run = decodeRun(body.run);
  if (!run || run.runId !== id) return null;
  const c = body.credits;
  if (
    !record(c) ||
    !exactly(c, ["reserved", "settled", "status"]) ||
    !nullableInteger(c.reserved, 2475) ||
    !nullableInteger(c.settled, 2475) ||
    !(c.status === null || status(c.status))
  )
    return null;
  const u = body.usage;
  if (
    !record(u) ||
    !exactly(u, ["attempts", "inputTokens", "outputTokens"]) ||
    !nullableInteger(u.attempts, 1000) ||
    !nullableInteger(u.inputTokens, big) ||
    !nullableInteger(u.outputTokens, big)
  )
    return null;
  if (!Array.isArray(body.products) || body.products.length !== run.productCount) return null;
  const products: RunProductView[] = [];
  for (const [i, p] of (body.products as unknown[]).entries()) {
    if (
      !record(p) ||
      !exactly(p, [
        "index",
        "productId",
        "status",
        "attempts",
        "failureCode",
        "proposalId",
        "flags",
      ]) ||
      p.index !== i ||
      !productId(p.productId) ||
      !status(p.status) ||
      !integer(p.attempts, 0, 2) ||
      !(p.failureCode === null || status(p.failureCode)) ||
      !(p.proposalId === null || isId(p.proposalId))
    )
      return null;
    const flags = decodeFlags(p.flags);
    if (flags === undefined) return null;
    products.push({
      index: i,
      productId: p.productId,
      status: p.status,
      attempts: p.attempts,
      failureCode: p.failureCode as string | null,
      proposalId: p.proposalId as string | null,
      flags,
    });
  }
  return {
    run,
    credits: {
      reserved: c.reserved as number | null,
      settled: c.settled as number | null,
      status: c.status as string | null,
    },
    usage: {
      attempts: u.attempts as number | null,
      inputTokens: u.inputTokens as number | null,
      outputTokens: u.outputTokens as number | null,
    },
    products,
    interrupted: body.interrupted,
  };
}

/** POST /work/tasks/:taskId/runs (201, or 200 with replayed). */
export function decodeRunAdmitted(body: unknown): RunAdmittedView | null {
  if (!record(body) || body.schemaVersion !== 1) return null;
  const keys = [
    "schemaVersion",
    "runId",
    "status",
    "childTaskId",
    "productCount",
    "creditsReserved",
    "catalogueVersion",
    "selection",
  ];
  if (!exactly(body, body.replayed === true ? [...keys, "replayed"] : keys)) return null;
  const selection = selectionOf(body.selection);
  if (
    !runId(body.runId) ||
    !status(body.status) ||
    !runId(body.childTaskId) ||
    !integer(body.productCount, 1, 25) ||
    !integer(body.creditsReserved, 1, 2475) ||
    !integer(body.catalogueVersion, 1, 999) ||
    selection === null
  )
    return null;
  return {
    runId: body.runId,
    childTaskId: body.childTaskId,
    productCount: body.productCount,
    creditsReserved: body.creditsReserved,
    selection,
  };
}

/** POST /work/runs-reconcile. */
export function decodeReconciled(body: unknown): { readonly closed: number } | null {
  if (!record(body) || body.schemaVersion !== 1) return null;
  if (
    !exactly(
      body,
      body.replayed === true
        ? ["schemaVersion", "closed", "replayed"]
        : ["schemaVersion", "closed"],
    )
  )
    return null;
  if (!integer(body.closed, 0, 25)) return null;
  return { closed: body.closed };
}
