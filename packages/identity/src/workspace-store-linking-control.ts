import { executorRoleMemberSql } from "./executor-role-preflight.js";
import {
  createWorkspaceStoreLinks,
  workspaceStoreLinkingSql,
  type WorkspaceStoreLinkInput,
  type WorkspaceStoreLinkResult,
} from "./workspace-store-linking.js";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";
import type {
  StandaloneWorkspaceSqlClient,
  StandaloneWorkspaceSqlControl,
  StandaloneWorkspaceSqlPool,
} from "./standalone-workspace-bootstrap.js";

export const workspaceStoreLinkingControlSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  role: `SELECT current_user AS role, session_user AS login, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
pg_catalog.pg_has_role(current_user, 'morrow_identity_owner','MEMBER') AS owner_member,
${executorRoleMemberSql},r.rolreplication
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: workspaceStoreLinkingSql.timeout,
  idleTimeout: workspaceStoreLinkingSql.idleTimeout,
  lookup:
    "SELECT handoff_id,command_id,request_digest,session_digest,nonce_digest,organization_id,workspace_id,installation_id,purpose,expected_policy_revision,expected_ownership_revision FROM morrow_identity.lookup_workspace_store_link($1,$2,$3,$4)",
  status:
    "SELECT outcome,link_id,ownership_revision,policy_revision,audit_id FROM morrow_identity.workspace_store_link_status($1,$2,$3,$4)",
  // M2 PR-2 (migration 0026, P09.T02a): the actor's authority for the TypeScript kernel,
  // the Shopify continuation issuer (READ WRITE) and the connections read.
  authority:
    "SELECT principal_id,organization_id,workspace_id,membership_id,policy_revision,grants::text AS grants,grant_count,database_now_ms FROM morrow_identity.linking_actor_authority($1,$2)",
  issue: "SELECT morrow_identity.issue_shopify_link_handoff($1,$2,$3,$4,$5) AS outcome",
  connections:
    "SELECT installations::text AS installations,app_registered,install_url,route,linked,owner FROM morrow_identity.workspace_connections($1,$2)",
  commit: workspaceStoreLinkingSql.commit,
});
// M2 PR-2: the actor facts the connection kernel decides on (governance.connection.connect
// administer on the workspace resource). Server facts only; grants are re-validated by
// the kernel itself.
export interface LinkingAuthorityFacts {
  readonly principalId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly policyRevision: number;
  readonly grants: readonly unknown[];
  readonly databaseNowMs: number;
}
export type ShopifyIssueOutcome =
  | "issued"
  | "exists"
  | "denied"
  | "route_not_ready"
  | "not_found"
  | "invalid";
const issueOutcomes: readonly string[] = [
  "issued",
  "exists",
  "denied",
  "route_not_ready",
  "not_found",
  "invalid",
];
export interface WorkspaceConnectionFacts {
  readonly installations: readonly unknown[];
  readonly appRegistered: boolean;
  readonly installUrl: string | null;
  readonly route: "morrow_direct" | "shopify_app_pricing" | "unfixed" | "missing" | "invalid";
  readonly linked: boolean;
  /** The reader is the organization's owner, the only actor a Shopify link admits. */
  readonly owner: boolean;
}
const routes: readonly string[] = [
  "morrow_direct",
  "shopify_app_pricing",
  "unfixed",
  "missing",
  "invalid",
];
export class WorkspaceStoreLinkingControlError extends Error {
  constructor(
    readonly code: "WORKSPACE_LINKING_CONTROL_INVALID" | "WORKSPACE_LINKING_OUTCOME_UNKNOWN",
  ) {
    super(code);
    this.name = "WorkspaceStoreLinkingControlError";
  }
}
const invalid = () => new WorkspaceStoreLinkingControlError("WORKSPACE_LINKING_CONTROL_INVALID");
const unknown = () => new WorkspaceStoreLinkingControlError("WORKSPACE_LINKING_OUTCOME_UNKNOWN");
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
const purposes = [
  "install_first",
  "workspace_first",
  "existing_account",
  "additional_store",
  "cross_host_resume",
];
const inputNames = [
  "handoffId",
  "commandId",
  "requestDigest",
  "sessionDigest",
  "nonceDigest",
  "organizationId",
  "workspaceId",
  "installationId",
  "purpose",
  "expectedPolicyRevision",
  "expectedOwnershipRevision",
];
function closed(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw unknown();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).sort().join(",") !== [...names].sort().join(",")) throw unknown();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const d = descriptors[name];
    if (!d || !Object.hasOwn(d, "value")) throw unknown();
    Object.defineProperty(result, name, { value: d.value, enumerable: true });
  }
  return Object.freeze(result);
}
function parse(text: unknown, names: readonly string[]) {
  try {
    return closed(parseWorkosSessionStatusJson(text, 4096), names);
  } catch {
    throw invalid();
  }
}
function sessionSelector(text: unknown) {
  const v = parse(text, ["sessionDigest", "workspaceId"]);
  if (!digest(v.sessionDigest) || !id(v.workspaceId)) throw invalid();
  return v as Readonly<{ sessionDigest: string; workspaceId: string }>;
}
function issueInput(text: unknown) {
  const v = parse(text, ["sessionDigest", "workspaceId", "nonceDigest", "commandId", "grantId"]);
  if (
    !digest(v.sessionDigest) ||
    !digest(v.nonceDigest) ||
    !id(v.workspaceId) ||
    !uuid(v.commandId) ||
    !id(v.grantId)
  )
    throw invalid();
  return v as Readonly<{
    sessionDigest: string;
    workspaceId: string;
    nonceDigest: string;
    commandId: string;
    grantId: string;
  }>;
}
// A JSON array that PostgreSQL rendered from jsonb (jsonb::text: no duplicate member names
// can exist), bounded in bytes; its items are validated by their consumers.
const utf8 = new TextEncoder();
function jsonArray(text: unknown, limit: number): readonly unknown[] {
  let value: unknown;
  try {
    if (typeof text !== "string" || text.length > limit || utf8.encode(text).length > limit)
      throw unknown();
    value = JSON.parse(text);
  } catch {
    throw unknown();
  }
  if (!Array.isArray(value)) throw unknown();
  return Object.freeze(value);
}
// The authority read: the facts, null (no session-eligible actor), or "overflow" (more
// than 1000 grants, which the kernel refuses to read, as the work kernel does).
function authorityRow(
  value: unknown,
  selected: { workspaceId: string },
): LinkingAuthorityFacts | null | "overflow" {
  const row = rows(value);
  if (row === null) return null;
  const v = closed(row, [
    "principal_id",
    "organization_id",
    "workspace_id",
    "membership_id",
    "policy_revision",
    "grants",
    "grant_count",
    "database_now_ms",
  ]);
  if (
    ![v.principal_id, v.organization_id, v.workspace_id, v.membership_id].every(id) ||
    v.workspace_id !== selected.workspaceId ||
    typeof v.grant_count !== "number" ||
    !Number.isSafeInteger(v.grant_count) ||
    v.grant_count < 0 ||
    typeof v.database_now_ms !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(v.database_now_ms) ||
    !time(Number(v.database_now_ms))
  )
    throw unknown();
  if (v.grant_count > 1000) return "overflow";
  const grants = jsonArray(v.grants, 4 * 1024 * 1024);
  if (grants.length !== v.grant_count) throw unknown();
  return Object.freeze({
    principalId: v.principal_id as string,
    organizationId: v.organization_id as string,
    workspaceId: v.workspace_id as string,
    membershipId: v.membership_id as string,
    policyRevision: revision(v.policy_revision),
    grants,
    databaseNowMs: Number(v.database_now_ms),
  });
}
function issueRow(value: unknown): ShopifyIssueOutcome {
  const v = closed(rows(value), ["outcome"]);
  if (typeof v.outcome !== "string" || !issueOutcomes.includes(v.outcome)) throw unknown();
  return v.outcome as ShopifyIssueOutcome;
}
function connectionsRow(value: unknown): WorkspaceConnectionFacts | null {
  const row = rows(value);
  if (row === null) return null;
  const v = closed(row, [
    "installations",
    "app_registered",
    "install_url",
    "route",
    "linked",
    "owner",
  ]);
  if (
    typeof v.app_registered !== "boolean" ||
    typeof v.linked !== "boolean" ||
    typeof v.owner !== "boolean" ||
    typeof v.route !== "string" ||
    !routes.includes(v.route) ||
    (v.app_registered
      ? typeof v.install_url !== "string" || v.install_url.length > 2048
      : v.install_url !== null)
  )
    throw unknown();
  const installations = jsonArray(v.installations, 512 * 1024);
  if (installations.length > 51) throw unknown();
  return Object.freeze({
    installations,
    appRegistered: v.app_registered,
    installUrl: v.install_url as string | null,
    route: v.route as WorkspaceConnectionFacts["route"],
    linked: v.linked,
    owner: v.owner,
  });
}
function selector(text: unknown) {
  const v = parse(text, ["sessionDigest", "workspaceId", "nonceDigest", "commandId"]);
  if (
    !digest(v.sessionDigest) ||
    !digest(v.nonceDigest) ||
    !id(v.workspaceId) ||
    !uuid(v.commandId)
  )
    throw invalid();
  return v as Readonly<{
    sessionDigest: string;
    workspaceId: string;
    nonceDigest: string;
    commandId: string;
  }>;
}
function rows(value: unknown) {
  const a = closed(value, ["rows"]).rows;
  if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype) throw unknown();
  const ds = Object.getOwnPropertyDescriptors(a),
    length = Object.getOwnPropertyDescriptor(a, "length")?.value;
  if (
    (length !== 0 && length !== 1) ||
    Reflect.ownKeys(a).sort().join(",") !== (length ? "0,length" : "length")
  )
    throw unknown();
  if (!length) return null;
  if (!ds["0"] || !Object.hasOwn(ds["0"], "value")) throw unknown();
  return ds["0"].value as unknown;
}
const roleNames = [
  "role",
  "login",
  "rolsuper",
  "rolbypassrls",
  "rolcreatedb",
  "rolcreaterole",
  "rolinherit",
  "owner_member",
  "role_member",
  "rolreplication",
];
function role(value: unknown) {
  const r = closed(rows(value), roleNames);
  if (
    r.role !== "morrow_identity_linking" ||
    r.login !== r.role ||
    roleNames.slice(2).some((k) => r[k] !== false)
  )
    throw unknown();
  return r;
}
function revision(v: unknown) {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/.test(v)) throw unknown();
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw unknown();
  return n;
}
function input(text: unknown): Readonly<WorkspaceStoreLinkInput> {
  const v = parse(text, inputNames);
  if (
    ![v.handoffId, v.organizationId, v.workspaceId, v.installationId].every(id) ||
    !uuid(v.commandId) ||
    ![v.requestDigest, v.sessionDigest, v.nonceDigest].every(digest) ||
    !purposes.includes(v.purpose as string) ||
    ![v.expectedPolicyRevision, v.expectedOwnershipRevision].every(
      (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1,
    )
  )
    throw invalid();
  return v as unknown as Readonly<WorkspaceStoreLinkInput>;
}
function lookup(value: unknown, selected: ReturnType<typeof selector>) {
  const row = rows(value);
  if (row === null) return null;
  const v = closed(row, [
    "handoff_id",
    "command_id",
    "request_digest",
    "session_digest",
    "nonce_digest",
    "organization_id",
    "workspace_id",
    "installation_id",
    "purpose",
    "expected_policy_revision",
    "expected_ownership_revision",
  ]);
  const result = input(
    JSON.stringify({
      handoffId: v.handoff_id,
      commandId: v.command_id,
      requestDigest: v.request_digest,
      sessionDigest: v.session_digest,
      nonceDigest: v.nonce_digest,
      organizationId: v.organization_id,
      workspaceId: v.workspace_id,
      installationId: v.installation_id,
      purpose: v.purpose,
      expectedPolicyRevision: revision(v.expected_policy_revision),
      expectedOwnershipRevision: revision(v.expected_ownership_revision),
    }),
  );
  if (
    result.sessionDigest !== selected.sessionDigest ||
    result.workspaceId !== selected.workspaceId ||
    result.nonceDigest !== selected.nonceDigest ||
    result.commandId !== selected.commandId
  )
    throw unknown();
  return result;
}
function status(value: unknown): WorkspaceStoreLinkResult | null {
  const row = rows(value);
  if (row === null) return null;
  const v = closed(row, [
    "outcome",
    "link_id",
    "ownership_revision",
    "policy_revision",
    "audit_id",
  ]);
  if (!["applied", "denied"].includes(v.outcome as string)) throw unknown();
  const own = v.ownership_revision === null ? null : revision(v.ownership_revision),
    policy = v.policy_revision === null ? null : revision(v.policy_revision);
  if (
    v.outcome === "applied"
      ? !id(v.link_id) || !id(v.audit_id) || own === null || policy === null
      : v.link_id !== null || own !== null || !id(v.audit_id) || policy === null
  )
    throw unknown();
  return Object.freeze({
    outcome: v.outcome,
    linkId: v.link_id,
    ownershipRevision: own,
    policyRevision: policy,
    auditId: v.audit_id,
  }) as WorkspaceStoreLinkResult;
}

export function createControlledWorkspaceStoreLinking({
  pool,
  now,
}: {
  pool: StandaloneWorkspaceSqlPool;
  now: () => number;
}) {
  let last = -1,
    invalidClock = false;
  const clock = () => {
    try {
      const at = now();
      if (invalidClock || !time(at) || at < last) throw unknown();
      last = at;
      return at;
    } catch {
      invalidClock = true;
      throw unknown();
    }
  };
  async function own<T>(
    external: StandaloneWorkspaceSqlControl,
    execute: (
      query: (text: string, values?: readonly string[]) => Promise<unknown>,
      release: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const started = clock();
    if (!external || !time(external.deadlineMs) || !(external.signal instanceof AbortSignal))
      throw invalid();
    const signal = external.signal;
    const deadline = Math.min(started + 5000, external.deadlineMs),
      abort = new AbortController();
    let client: StandaloneWorkspaceSqlClient | undefined,
      disposal: Promise<void> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    let interrupt!: () => void;
    const interrupted = new Promise<{ stopped: true }>((resolve) => {
      interrupt = () => resolve({ stopped: true });
    });
    const dispose = () => {
      if (client && !disposal) {
        const owned = client;
        disposal = Promise.resolve().then(() => owned.release(true));
        void disposal.catch(() => {});
      }
      return disposal;
    };
    const stop = () => {
      stopped = true;
      abort.abort();
      interrupt();
      dispose();
    };
    const check = () => {
      const at = clock();
      if (stopped || signal.aborted || at >= deadline) {
        stop();
        throw unknown();
      }
      return at;
    };
    const race = async <V>(p: Promise<V>): Promise<V> => {
      const answer = await Promise.race([p.then((value) => ({ value })), interrupted]);
      if ("stopped" in answer || stopped) throw unknown();
      return answer.value;
    };
    const control = Object.freeze({ deadlineMs: deadline, signal: abort.signal });
    const query = async (text: string, values: readonly string[] = Object.freeze([])) => {
      check();
      try {
        const pending = Promise.resolve(client!.query(text, values, control));
        void pending.catch(() => {});
        const result = await race(pending);
        check();
        return result;
      } catch {
        stop();
        throw unknown();
      }
    };
    const release = async () => {
      const pending = dispose();
      if (!pending) throw unknown();
      await race(pending);
      check();
    };
    try {
      const at = check();
      signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(stop, deadline - at);
      const connecting = Promise.resolve(pool.connect(control)).then((value) => {
        client = value;
        if (stopped || abort.signal.aborted) {
          dispose();
          throw unknown();
        }
        return value;
      });
      void connecting.catch(() => {});
      await race(connecting);
      check();
      const value = await execute(query, release);
      check();
      await release();
      check();
      return value;
    } catch {
      const pending = dispose();
      if (pending && !stopped) {
        try {
          await race(pending);
        } catch {}
      }
      throw unknown();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      stop();
    }
  }
  const read = async (
    text: unknown,
    control: StandaloneWorkspaceSqlControl,
    kind: "lookup" | "status",
  ) => {
    const selected = selector(text),
      values = Object.freeze([
        selected.sessionDigest,
        selected.workspaceId,
        selected.nonceDigest,
        selected.commandId,
      ]);
    return own(control, async (query) => {
      await query(workspaceStoreLinkingControlSql.begin);
      role(await query(workspaceStoreLinkingControlSql.role));
      await query(workspaceStoreLinkingControlSql.timeout);
      await query(workspaceStoreLinkingControlSql.idleTimeout);
      const result = await query(workspaceStoreLinkingControlSql[kind], values);
      const decoded = kind === "lookup" ? lookup(result, selected) : status(result);
      await query(workspaceStoreLinkingControlSql.commit);
      return decoded;
    });
  };
  const prologue = async (
    query: (text: string, values?: readonly string[]) => Promise<unknown>,
    begin: string,
  ) => {
    await query(begin);
    role(await query(workspaceStoreLinkingControlSql.role));
    await query(workspaceStoreLinkingControlSql.timeout);
    await query(workspaceStoreLinkingControlSql.idleTimeout);
  };
  return Object.freeze({
    // M2 PR-2: the actor and its grants, for the kernel (READ ONLY). More than 1000
    // grants is no actor here (the issuer's denial).
    async authority(text: unknown, control: StandaloneWorkspaceSqlControl) {
      const selected = sessionSelector(text);
      return own(control, async (query) => {
        await prologue(query, workspaceStoreLinkingControlSql.begin);
        const facts = authorityRow(
          await query(workspaceStoreLinkingControlSql.authority, [
            selected.sessionDigest,
            selected.workspaceId,
          ]),
          selected,
        );
        await query(workspaceStoreLinkingControlSql.commit);
        return facts === "overflow" ? null : facts;
      });
    },
    // M2 PR-2: the P09.T02a issuer, one READ WRITE transaction. A lost COMMIT
    // acknowledgement is WORKSPACE_LINKING_OUTCOME_UNKNOWN; a retry with the same
    // command answers exists.
    async issue(
      text: unknown,
      control: StandaloneWorkspaceSqlControl,
    ): Promise<ShopifyIssueOutcome> {
      const input = issueInput(text);
      return own(control, async (query) => {
        await prologue(query, workspaceStoreLinkingSql.begin);
        const outcome = issueRow(
          await query(workspaceStoreLinkingControlSql.issue, [
            input.sessionDigest,
            input.workspaceId,
            input.nonceDigest,
            input.commandId,
            input.grantId,
          ]),
        );
        await query(workspaceStoreLinkingControlSql.commit);
        return outcome;
      });
    },
    // M2 PR-2: the connections screen's facts and the actor's authority, one READ ONLY
    // transaction (one snapshot). More than 1000 grants is unavailable, never "signed out"
    // (WORKSPACE_LINKING_OUTCOME_UNKNOWN; the route answers 503).
    async connections(text: unknown, control: StandaloneWorkspaceSqlControl) {
      const selected = sessionSelector(text);
      return own(control, async (query) => {
        await prologue(query, workspaceStoreLinkingControlSql.begin);
        const values = [selected.sessionDigest, selected.workspaceId];
        const facts = authorityRow(
          await query(workspaceStoreLinkingControlSql.authority, values),
          selected,
        );
        if (facts === "overflow") throw unknown();
        const connections = connectionsRow(
          await query(workspaceStoreLinkingControlSql.connections, values),
        );
        await query(workspaceStoreLinkingControlSql.commit);
        return facts && connections ? Object.freeze({ facts, connections }) : null;
      });
    },
    async lookup(text: unknown, control: StandaloneWorkspaceSqlControl) {
      return (await read(text, control, "lookup")) as Readonly<WorkspaceStoreLinkInput> | null;
    },
    async status(text: unknown, control: StandaloneWorkspaceSqlControl) {
      return (await read(text, control, "status")) as WorkspaceStoreLinkResult | null;
    },
    async apply(
      text: unknown,
      control: StandaloneWorkspaceSqlControl,
    ): Promise<WorkspaceStoreLinkResult> {
      const snapshot = JSON.stringify(input(text));
      return own(control, async (query, release) => {
        const service = createWorkspaceStoreLinks({
          connect: async () => ({
            async query(statement, values = Object.freeze([])) {
              if (
                !(Object.values(workspaceStoreLinkingSql) as readonly string[]).includes(statement)
              )
                throw unknown();
              if (statement === workspaceStoreLinkingSql.role) {
                const safe = role(await query(workspaceStoreLinkingControlSql.role));
                const legacy = Object.fromEntries(
                  Object.entries(safe).filter(([key]) => key !== "rolreplication"),
                );
                return { rows: [Object.freeze(legacy)] };
              }
              return (await query(statement, Object.freeze([...values]))) as {
                rows: readonly Record<string, unknown>[];
              };
            },
            release,
          }),
        });
        return service.apply(snapshot);
      });
    },
  });
}
