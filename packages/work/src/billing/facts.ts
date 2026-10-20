import type {
  CurrentBilling_BillingAccount,
  CurrentBilling_CreditWallet,
  CurrentBilling_EntitlementSnapshot,
  CurrentBilling_WorkspaceBillingRoute,
} from "@morrow/contracts";
import { validateCurrentBillingDefinition, validateDefinition } from "@morrow/contracts/validation";
import type { BillingFactsReader, BillingScope } from "@morrow/policy/billing-state";
import { workspaceBillingRouteFromRow } from "../billing-route.js";
import type { WorkStatementName } from "../sql.js";

// The SQL billing facts reader (M5 PR-1; P01.T04a §6, §8.8; integration "Billing facts,
// billing period and credit wallet"). It turns the tenant's own rows (tenant_read policies
// and column grants, plus the association bridge) into the exact input of
// parseWorkspaceBillingFacts, and also returns the billing period (the line period of the
// latest granted subscription invoice), the credit wallet and the open checkout intent.
// Every row is checked against the scope; any other shape is BILLING_FACTS_ROW_INVALID, so
// the reader fails closed. The receipt ingress (apply-plan.ts) maps receipt_begin's facts
// with the same row mappers.

export class BillingFactsRowError extends Error {
  constructor(readonly code: "BILLING_FACTS_ROW_INVALID") {
    super(code);
    this.name = "BillingFactsRowError";
  }
}
const invalid = (): never => {
  throw new BillingFactsRowError("BILLING_FACTS_ROW_INVALID");
};
type Row = Readonly<Record<string, unknown>>;
const exact = (row: Row, names: readonly string[]) =>
  !!row &&
  typeof row === "object" &&
  Object.keys(row).sort().join(",") === [...names].sort().join(",");
const revision = (value: unknown): number =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,15}$/.test(value) &&
  Number.isSafeInteger(Number(value))
    ? Number(value)
    : invalid();
const units = (value: unknown): string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,17})$/.test(value) ? value : invalid();
const id = (value: unknown): value is string => validateDefinition("core", "Id", value);
const utc = (value: unknown): value is string =>
  validateDefinition("core", "UtcTime", value) && Number.isFinite(Date.parse(value as string));

/** One association of the bridge (work_store_installations): current means status linked. */
export interface BillingAssociation {
  readonly installationId: string;
  readonly storeId: string;
  readonly associatedAt: string;
  readonly current: boolean;
}
export function associationFromRow(row: Row): BillingAssociation {
  if (
    !exact(row, ["installation_id", "store_id", "connection_id", "status", "linked_at"]) ||
    !id(row.installation_id) ||
    !id(row.store_id) ||
    !id(row.connection_id) ||
    !["unlinked", "linked", "suspended", "uninstalled"].includes(row.status as string) ||
    !utc(row.linked_at)
  )
    return invalid();
  return Object.freeze({
    installationId: row.installation_id as string,
    storeId: row.store_id as string,
    associatedAt: row.linked_at as string,
    current: row.status === "linked",
  });
}
export function accountFromRow(row: Row): CurrentBilling_BillingAccount {
  if (
    !exact(row, [
      "organization_id",
      "workspace_id",
      "id",
      "route",
      "mode",
      "currency",
      "status",
      "revision",
    ])
  )
    return invalid();
  const account = {
    schemaVersion: 2,
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    route: row.route,
    mode: row.mode,
    installationId: null,
    storeId: null,
    currency: row.currency,
    status: row.status,
    revision: revision(row.revision),
  };
  if (!validateCurrentBillingDefinition("BillingAccount", account)) return invalid();
  return Object.freeze(account) as CurrentBilling_BillingAccount;
}
export function snapshotFromRow(row: Row): CurrentBilling_EntitlementSnapshot {
  if (
    !exact(row, [
      "organization_id",
      "workspace_id",
      "billing_account_id",
      "revision",
      "route",
      "mode",
      "subscription_key",
      "status",
      "provider_evidence_ref",
      "verified_at",
      "valid_until",
    ])
  )
    return invalid();
  const snapshot = {
    schemaVersion: 2,
    billingAccountId: row.billing_account_id,
    route: row.route,
    mode: row.mode,
    installationId: null,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    storeId: null,
    subscriptionId: row.subscription_key,
    status: row.status,
    providerEvidenceRef: row.provider_evidence_ref,
    verifiedAt: row.verified_at,
    validUntil: row.valid_until,
    revision: revision(row.revision),
  };
  if (!validateCurrentBillingDefinition("EntitlementSnapshot", snapshot)) return invalid();
  return Object.freeze(snapshot) as CurrentBilling_EntitlementSnapshot;
}
export interface BillingWallet {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly wallet: CurrentBilling_CreditWallet;
}
export function walletFromRow(row: Row): BillingWallet {
  if (
    !exact(row, [
      "organization_id",
      "workspace_id",
      "billing_account_id",
      "available",
      "reserved",
      "consumed",
      "rate_revision",
      "terms_revision",
      "revision",
    ]) ||
    !id(row.organization_id) ||
    !id(row.workspace_id)
  )
    return invalid();
  const wallet = {
    schemaVersion: 1,
    billingAccountId: row.billing_account_id,
    available: units(row.available),
    reserved: units(row.reserved),
    consumed: units(row.consumed),
    rateRevision: revision(row.rate_revision),
    termsRevision: revision(row.terms_revision),
    revision: revision(row.revision),
  };
  if (!validateCurrentBillingDefinition("CreditWallet", wallet)) return invalid();
  return Object.freeze({
    organizationId: row.organization_id as string,
    workspaceId: row.workspace_id as string,
    wallet: Object.freeze(wallet) as CurrentBilling_CreditWallet,
  });
}
const conflictCodes = [
  "ROUTE_MISMATCH",
  "DUPLICATE_SUBSCRIPTION",
  "SUBSCRIPTION_TERMINAL",
  "SUBSCRIPTION_REQUIRED",
];
/** An open conflict (R7), keyed by (route, subscription): the parseWorkspaceBillingFacts shape. */
export function conflictFromRow(row: Row) {
  if (
    !exact(row, ["route", "subscription_key", "code"]) ||
    row.route !== "morrow_direct" ||
    !conflictCodes.includes(row.code as string) ||
    !validateCurrentBillingDefinition("StripeSubscriptionKey", row.subscription_key)
  )
    return invalid();
  return Object.freeze({
    route: "morrow_direct" as const,
    code: row.code as string,
    subscriptionKey: row.subscription_key as string,
    paymentKey: null,
  });
}
export interface BillingPeriod {
  readonly start: string;
  readonly end: string;
}
export function periodFromRow(row: Row): BillingPeriod {
  if (
    !exact(row, ["period_start", "period_end"]) ||
    !utc(row.period_start) ||
    !utc(row.period_end) ||
    Date.parse(row.period_end as string) <= Date.parse(row.period_start as string)
  )
    return invalid();
  return Object.freeze({ start: row.period_start as string, end: row.period_end as string });
}
export interface BillingIntentView {
  readonly id: string;
  readonly status: "open" | "completed";
  readonly priceKey: string;
  readonly expiresAt: string;
}
export function intentFromRow(row: Row): BillingIntentView {
  if (
    !exact(row, ["id", "status", "price_key", "expires_at"]) ||
    !id(row.id) ||
    (row.status !== "open" && row.status !== "completed") ||
    !validateCurrentBillingDefinition("StripePriceKey", row.price_key) ||
    !utc(row.expires_at)
  )
    return invalid();
  return Object.freeze({
    id: row.id as string,
    status: row.status,
    priceKey: row.price_key as string,
    expiresAt: row.expires_at as string,
  });
}

/** The tenant's mapped records, before parseWorkspaceBillingFacts. */
export interface BillingRecords {
  readonly route: CurrentBilling_WorkspaceBillingRoute | null;
  readonly associations: readonly BillingAssociation[];
  readonly account: CurrentBilling_BillingAccount | null;
  readonly snapshot: CurrentBilling_EntitlementSnapshot | null;
  readonly conflicts: readonly ReturnType<typeof conflictFromRow>[];
  readonly checkoutIntentPending: boolean;
}
/**
 * The exact parseWorkspaceBillingFacts input (§8.8): Morrow-direct has one storeless payer
 * once its route is fixed and its account exists; no payer before the route is fixed. The
 * test seed is never read (the MVP has none: ADR-0022 item 5).
 */
export function billingFactsInput(records: BillingRecords, scope: BillingScope) {
  const same = (r: { organizationId: string | null; workspaceId: string | null }) =>
    r.organizationId === scope.organizationId && r.workspaceId === scope.workspaceId;
  if (
    (records.route && !same(records.route)) ||
    (records.account && !same(records.account)) ||
    (records.snapshot &&
      (!same(records.snapshot) ||
        !records.account ||
        records.snapshot.billingAccountId !== records.account.id)) ||
    records.associations.length > 100 ||
    records.conflicts.length > 100
  )
    return invalid();
  const payers =
    records.route?.route && records.account
      ? [
          {
            account: records.account,
            entitlement: records.snapshot,
            association: null,
            openReversals: [],
          },
        ]
      : [];
  return {
    route: records.route,
    associations: records.associations.map((a) => ({ ...a })),
    payers,
    conflicts: records.conflicts.map((c) => ({ ...c })),
    checkoutIntentPending: records.checkoutIntentPending,
    testSeed: null,
  };
}

export type BillingQuery = (
  name: WorkStatementName,
  values: readonly (string | null)[],
) => Promise<readonly Row[]>;
export interface BillingFactsRead {
  /** The parseWorkspaceBillingFacts input. */
  readonly facts: ReturnType<typeof billingFactsInput>;
  readonly account: CurrentBilling_BillingAccount | null;
  readonly snapshot: CurrentBilling_EntitlementSnapshot | null;
  readonly wallet: CurrentBilling_CreditWallet | null;
  readonly billingPeriod: BillingPeriod | null;
  readonly intent: BillingIntentView | null;
}
const atMostOne = (rows: readonly Row[]): Row | null =>
  rows.length === 0 ? null : rows.length === 1 ? rows[0]! : invalid();

/**
 * createBillingFactsReader(query): `read(scope)` runs the fixed reads in the caller's
 * transaction (session context: the tenant is current_tenant(), and every row must name
 * `scope`); `facts` is the BillingFactsReader that createBillingConstraintsReader takes.
 */
export function createBillingFactsReader(query: BillingQuery) {
  async function read(scope: BillingScope): Promise<BillingFactsRead> {
    if (!scope || !id(scope.organizationId) || !id(scope.workspaceId)) return invalid();
    const ws = scope.workspaceId;
    const routeRow = atMostOne(await query("workspaceBillingRoute", [ws]));
    const route = routeRow ? workspaceBillingRouteFromRow(routeRow) : null;
    const associationRows = await query("billingAssociations", []);
    if (associationRows.length > 100) return invalid();
    const associations = associationRows.map(associationFromRow);
    const accountRow = atMostOne(await query("billingAccount", [ws]));
    const account = accountRow ? accountFromRow(accountRow) : null;
    let snapshot: CurrentBilling_EntitlementSnapshot | null = null;
    let wallet: BillingWallet | null = null;
    if (account) {
      const snapshotRow = atMostOne(await query("billingSnapshotLatest", [ws, account.id]));
      snapshot = snapshotRow ? snapshotFromRow(snapshotRow) : null;
      const walletRow = atMostOne(await query("billingWallet", [ws, account.id]));
      wallet = walletRow ? walletFromRow(walletRow) : null;
      if (wallet && (wallet.organizationId !== scope.organizationId || wallet.workspaceId !== ws))
        return invalid();
    }
    const conflictRows = await query("billingConflicts", [ws]);
    if (conflictRows.length > 100) return invalid();
    const conflicts = conflictRows.map(conflictFromRow);
    const intentRow = atMostOne(await query("billingIntentCurrent", [ws]));
    const intent = intentRow ? intentFromRow(intentRow) : null;
    const periodRow = atMostOne(await query("billingPeriodLatest", [ws]));
    const billingPeriod = periodRow ? periodFromRow(periodRow) : null;
    const facts = billingFactsInput(
      { route, associations, account, snapshot, conflicts, checkoutIntentPending: intent !== null },
      scope,
    );
    return Object.freeze({
      facts,
      account,
      snapshot,
      wallet: wallet?.wallet ?? null,
      billingPeriod,
      intent,
    });
  }
  const facts: BillingFactsReader = async (scope) => (await read(scope)).facts;
  return Object.freeze({ read, facts });
}
