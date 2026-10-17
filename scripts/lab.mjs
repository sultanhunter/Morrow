import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  validateDefinition,
  validateCapabilityInput,
  validateCapabilityOutput,
} from "../packages/contracts/src/validation.ts";
import { writeArtifact } from "./artifacts.mjs";
export const lab = JSON.parse(
  readFileSync(new URL("../docs/development/lab-fixtures.json", import.meta.url), "utf8"),
);
/** Explicit synthetic read simulator; never imported by application processes. */
export function fakeCatalogRead({
  organizationId,
  workspaceId,
  storeId,
  accountId,
  mode = "ready",
  now = lab.clock,
  input,
}) {
  if (!Number.isFinite(Date.parse(now))) return { kind: "denied", reason: "invalid_clock" };
  if (!validateCapabilityInput("catalog.products.read", input))
    return { kind: "denied", reason: "invalid_input" };
  const account = lab.accounts.find((a) => a.id === accountId && a.provider === "fake-shopify");
  if (
    !account ||
    account.organizationId !== organizationId ||
    account.workspaceId !== workspaceId ||
    account.storeId !== storeId
  )
    return { kind: "denied", reason: "account_scope" };
  if (Date.parse(account.expiresAt) <= Date.parse(now) || mode === "expired")
    return { kind: "expired", reason: "connection_expired" };
  if (mode === "uncertain")
    return { kind: "uncertain", reason: "read_timeout", retryAllowed: false };
  const selected = input.productIds
    .map((id) => lab.products.find((p) => p.id === id))
    .filter(Boolean);
  if (selected.length !== input.productIds.length)
    return { kind: "denied", reason: "unknown_product" };
  if (input.fields.some((f) => f !== "title"))
    return { kind: "denied", reason: "unsupported_field" };
  if (mode === "partial")
    return structuredClone({
      kind: "partial",
      verified: selected.slice(0, 1).map((p) => p.snapshot),
      unresolved: input.productIds.slice(1),
      complete: false,
    });
  if (mode !== "ready") return { kind: "denied", reason: "unsupported_mode" };
  const output = structuredClone({
    products: selected.map((p) => p.snapshot),
    freshness: lab.freshness,
  });
  if (!validateCapabilityOutput("catalog.products.read", output))
    throw Error("Invalid synthetic output");
  return { kind: "verified_fixture", output };
}
export function runLab(mode = "partial") {
  for (const [name, value] of [
    ["HostContext", lab.host],
    ["Goal", lab.goal],
    ["Task", lab.task],
  ])
    if (!validateDefinition("core", name, value)) throw Error("Invalid lab " + name);
  const result = fakeCatalogRead({
    organizationId: "org-small",
    workspaceId: "workspace-main",
    storeId: "store-main",
    accountId: "account-shopify",
    mode,
    input: { productIds: ["product-shirt", "product-bag"], fields: ["title"] },
  });
  return {
    synthetic: true,
    durable: false,
    providerCalls: 0,
    paidDispatches: 0,
    clock: lab.clock,
    goalId: lab.goal.id,
    taskId: lab.task.id,
    taskStatus: lab.task.status,
    result,
    completionClaim: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runLab(process.argv[2] ?? "partial");
  writeArtifact("lab/example.json", result);
  console.log(JSON.stringify(result, null, 2));
}
