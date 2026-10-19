// P01.T04a PR-B: builders over the `library` section of
// docs/contracts/fixtures/P01.T04a.json, shared by scripts/verify-billing.mjs and
// the billing tests. They assemble the raw facts a trusted billing reader would
// return (§6, §8.8); the billing library is the only implementation that reads
// them. Runs under tsx.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./foundation.mjs";
import {
  parseWorkspaceBillingFacts,
  workspaceBillingState,
} from "../packages/policy/src/billing-state.ts";

export const routeFixturePath = "docs/contracts/fixtures/P01.T04a.json";
const fixture = JSON.parse(readFileSync(resolve(root, routeFixturePath), "utf8"));
const base = fixture.library;

/** A fresh, mutable copy of the fixture's library section. */
export const library = () => structuredClone(base);
export const templates = () => structuredClone(fixture.templates);
export const scopeW = Object.freeze({
  organizationId: base.organizationId,
  workspaceId: base.workspaceId,
});
export const scopeW2 = Object.freeze({
  organizationId: base.organizationId,
  workspaceId: base.otherWorkspaceId,
});

/** A copy of a record (or of every record in an array) in `live` mode, for production cases. */
export function live(value) {
  const copy = structuredClone(value);
  const visit = (node) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      if (node.mode === "test") node.mode = "live";
      for (const child of Object.values(node)) if (child && typeof child === "object") visit(child);
    }
  };
  visit(copy);
  return copy;
}

const associationFor = (installationId) =>
  Object.values(base.associations).find((a) => a.installationId === installationId) ?? null;

/**
 * One payer's facts from the library's account `key` ("morrow_w", "shopify_a", ...).
 * Overrides replace the account, entitlement, association or reversals; the
 * association defaults to the account's installation.
 */
export function payerFacts(key, overrides = {}) {
  const account =
    overrides.account === undefined ? structuredClone(base.accounts[key]) : overrides.account;
  const entitlement =
    overrides.entitlement === undefined
      ? structuredClone(base.entitlements[key])
      : overrides.entitlement;
  const association =
    overrides.association === undefined
      ? account?.installationId
        ? structuredClone(associationFor(account.installationId))
        : null
      : overrides.association;
  return { account, entitlement, association, openReversals: overrides.openReversals ?? [] };
}

/**
 * Raw facts as the reader returns them. A payer's association is synchronised
 * with the workspace association of the same installation, as the reader's
 * join would give it.
 */
export function rawFacts({
  route = base.routes.open,
  associations = [],
  payers = [],
  conflicts = [],
  checkoutIntentPending = false,
  testSeed = null,
} = {}) {
  const links = structuredClone(associations);
  return {
    route: structuredClone(route),
    associations: links,
    payers: payers.map((p) => ({
      ...structuredClone(p),
      association:
        p.association === null
          ? null
          : (structuredClone(
              links.find((a) => a.installationId === p.association.installationId),
            ) ?? structuredClone(p.association)),
    })),
    conflicts: structuredClone(conflicts),
    checkoutIntentPending,
    testSeed: structuredClone(testSeed),
  };
}

/** Parses raw facts for `scope` and derives the state at `now` in `environment`. */
export function billingState(
  raw,
  { environment = "staging", now = base.now, scope = scopeW } = {},
) {
  return workspaceBillingState(
    parseWorkspaceBillingFacts(raw, scope, environment),
    now,
    environment,
  );
}

/** An association copy with overrides, e.g. `link("iA", { current: false })`. */
export const link = (key, overrides = {}) => ({
  ...structuredClone(base.associations[key]),
  ...overrides,
});
