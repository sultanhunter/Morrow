import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

export interface LoginControl {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export interface LoginFlowSqlClient {
  query(
    text: string,
    values: readonly string[],
    control: LoginControl,
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
  release(discard: boolean): Promise<void>;
}
export interface LoginFlowSqlPool {
  connect(control: LoginControl): Promise<LoginFlowSqlClient>;
}
export type TransitionRow = Readonly<{
  outcome: string;
  flow_id: string | null;
  flow_revision: string | null;
  expires_at_ms: string | null;
  audit_id: string | null;
}>;
export type ClaimRow = TransitionRow &
  Readonly<{
    challenge_id: string | null;
    begin_command_id: string | null;
    admission_command_id: string | null;
    issuer_command_id: string | null;
    workspace_id: string | null;
    state_digest: string | null;
    cookie_digest: string | null;
    browser_proof_digest: string | null;
    verifier_digest: string | null;
    ciphertext: string | null;
    encryption_nonce: string | null;
    key_id: string | null;
    aad_digest: string | null;
    code_digest: string | null;
  }>;
export type EligibilityRow = Readonly<{ matches: boolean; database_now_ms: string }>;
export type ReconciliationRow = Readonly<{
  outcome: string;
  phase: string | null;
  flow_revision: string | null;
  expires_at_ms: string | null;
  admission_id: string | null;
  issuer_request_digest: string | null;
  issuer_outcome: string | null;
  family_id: string | null;
  generation_id: string | null;
  provider_binding_id: string | null;
  family_expires_at_ms: string | null;
  issuer_audit_id: string | null;
}>;
export type MaintenanceRow = Readonly<{
  outcome: string;
  erased_capsules: string | null;
  pruned_closed_states: string | null;
  pseudonymized_audits: string | null;
  pruned_audits: string | null;
  retained_unresolved: string | null;
}>;
const select = (columns: string, fn: string, count: number) =>
  `SELECT ${columns} FROM morrow_identity.${fn}(${Array.from({ length: count }, (_, i) => "$" + (i + 1)).join(",")})`;
const transition = ["outcome", "flow_id", "flow_revision", "expires_at_ms", "audit_id"];
const claim = [
  ...transition,
  "challenge_id",
  "begin_command_id",
  "admission_command_id",
  "issuer_command_id",
  "workspace_id",
  "state_digest",
  "cookie_digest",
  "browser_proof_digest",
  "verifier_digest",
  "ciphertext",
  "encryption_nonce",
  "key_id",
  "aad_digest",
  "code_digest",
];
const reconciliation = [
  "outcome",
  "phase",
  "flow_revision",
  "expires_at_ms",
  "admission_id",
  "issuer_request_digest",
  "issuer_outcome",
  "family_id",
  "generation_id",
  "provider_binding_id",
  "family_expires_at_ms",
  "issuer_audit_id",
];
const maintenance = [
  "outcome",
  "erased_capsules",
  "pruned_closed_states",
  "pseudonymized_audits",
  "pruned_audits",
  "retained_unresolved",
];
export const loginFlowCustodySql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
  readOnlyBegin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  role: "SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,pg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS role_member FROM pg_catalog.pg_roles r WHERE r.rolname=current_user",
  timeout: "SET LOCAL statement_timeout = '1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
  createIntent: select(transition.join(","), "create_login_flow_intent", 6),
  bindBegin: select(transition.join(","), "bind_login_flow_begin", 12),
  claimCallback: select(claim.join(","), "claim_login_callback", 4),
  observeEligibility: select("matches,database_now_ms", "observe_login_flow_eligibility", 2),
  reconcile: select(reconciliation.join(","), "reconcile_login_flow", 5),
  maintain: select(maintenance.join(","), "maintain_login_flows", 1),
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
export class LoginFlowCustodyError extends Error {
  constructor(readonly code: "LOGIN_FLOW_INVALID" | "LOGIN_FLOW_OUTCOME_UNKNOWN") {
    super(code);
    this.name = "LoginFlowCustodyError";
  }
}
const invalid = () => new LoginFlowCustodyError("LOGIN_FLOW_INVALID"),
  unknown = () => new LoginFlowCustodyError("LOGIN_FLOW_OUTCOME_UNKNOWN");
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const decimal = (v: unknown, positive = false): v is string =>
  typeof v === "string" &&
  (positive ? /^[1-9][0-9]{0,15}$/ : /^(0|[1-9][0-9]{0,15})$/).test(v) &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) <= (positive ? 9007199254740991 : 8640000000000000);
const time = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
function base64url(value: unknown, minimum: number, maximum: number): value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((maximum * 4) / 3) ||
    value.length % 4 === 1
  )
    return false;
  try {
    const raw = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
    );
    return (
      raw.length >= minimum &&
      raw.length <= maximum &&
      btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === value
    );
  } catch {
    return false;
  }
}
function closed(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw unknown();
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).sort().join(",") !== [...names].sort().join(",")) throw unknown();
  const copy: Record<string, unknown> = {};
  for (const n of names) {
    const d = ds[n];
    if (!d || !Object.hasOwn(d, "value")) throw unknown();
    Object.defineProperty(copy, n, { value: d.value, enumerable: true });
  }
  return Object.freeze(copy);
}
function row(value: unknown, names: readonly string[]) {
  const a = closed(value, ["rows"]).rows;
  if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype) throw unknown();
  const ds = Object.getOwnPropertyDescriptors(a);
  if (
    Reflect.ownKeys(ds).sort().join(",") !== "0,length" ||
    Object.getOwnPropertyDescriptor(a, "length")?.value !== 1 ||
    !ds["0"] ||
    !Object.hasOwn(ds["0"], "value")
  )
    throw unknown();
  return closed(ds["0"].value, names);
}
const inputs = {
  createIntent: [
    "configurationDigest",
    "flowId",
    "beginCommandId",
    "admissionCommandId",
    "issuerCommandId",
    "workspaceId",
  ],
  bindBegin: [
    "configurationDigest",
    "flowId",
    "expectedRevision",
    "challengeId",
    "stateDigest",
    "cookieDigest",
    "browserProofDigest",
    "verifierDigest",
    "ciphertext",
    "encryptionNonce",
    "keyId",
    "aadDigest",
  ],
  claimCallback: ["configurationDigest", "cookieDigest", "stateDigest", "codeDigest"],
  observeEligibility: ["flowId", "configurationDigest"],
  reconcile: [
    "configurationDigest",
    "flowId",
    "beginCommandId",
    "admissionCommandId",
    "issuerCommandId",
  ],
  maintain: ["configurationDigest"],
} as const;
type Kind = keyof typeof inputs;
function textInput(text: unknown, kind: Kind): readonly string[] {
  try {
    const v = closed(parseWorkosSessionStatusJson(text, 8192), ["schemaVersion", ...inputs[kind]]);
    if (v.schemaVersion !== 1) throw invalid();
    for (const n of inputs[kind]) {
      const x = v[n];
      const valid = n.endsWith("Digest")
        ? digest(x)
        : n === "workspaceId"
          ? id(x)
          : n === "expectedRevision"
            ? decimal(x, true)
            : n === "ciphertext"
              ? base64url(x, 16, 512)
              : n === "encryptionNonce"
                ? base64url(x, 12, 12)
                : uuid(x);
      if (!valid) throw invalid();
    }
    if (kind === "createIntent" || kind === "reconcile") {
      const a = [v.flowId, v.beginCommandId, v.admissionCommandId, v.issuerCommandId];
      if (new Set(a).size !== 4) throw invalid();
    }
    return Object.freeze(inputs[kind].map((n) => v[n] as string));
  } catch {
    throw invalid();
  }
}
function decode(value: unknown, kind: Kind, values: readonly string[], at: number) {
  const names =
    kind === "claimCallback"
      ? claim
      : kind === "observeEligibility"
        ? ["matches", "database_now_ms"]
        : kind === "reconcile"
          ? reconciliation
          : kind === "maintain"
            ? maintenance
            : transition;
  const r = row(value, names);
  if (kind === "observeEligibility") {
    if (typeof r.matches !== "boolean" || !decimal(r.database_now_ms)) throw unknown();
    return r;
  }
  const success =
    kind === "createIntent"
      ? "newly_created"
      : kind === "bindBegin"
        ? "newly_ready"
        : kind === "claimCallback"
          ? "newly_claimed"
          : kind === "reconcile"
            ? "observed"
            : "completed";
  if (r.outcome !== success) {
    const allowed =
      kind === "createIntent"
        ? ["held", "denied", "conflict", "rate_limited", "quota_limited"]
        : kind === "reconcile" || kind === "maintain"
          ? ["held"]
          : ["held", "denied", "conflict"];
    if (!allowed.includes(r.outcome as string) || names.slice(1).some((n) => r[n] !== null))
      throw unknown();
    return r;
  }
  if (kind === "maintain") {
    if (names.slice(1).some((n) => !decimal(r[n]) || Number(r[n]) > 100)) throw unknown();
    return r;
  }
  if (kind === "reconcile") {
    if (
      !["intent", "awaiting_callback", "claimed"].includes(r.phase as string) ||
      !decimal(r.flow_revision, true) ||
      !decimal(r.expires_at_ms) ||
      !(r.admission_id === null || uuid(r.admission_id))
    )
      throw unknown();
    const issuer = reconciliation.slice(5);
    if (r.issuer_outcome === null) {
      if (issuer.some((n) => r[n] !== null)) throw unknown();
    } else {
      if (!digest(r.issuer_request_digest) || !uuid(r.issuer_audit_id)) throw unknown();
      if (r.issuer_outcome === "denied") {
        if (
          ["family_id", "generation_id", "provider_binding_id", "family_expires_at_ms"].some(
            (n) => r[n] !== null,
          )
        )
          throw unknown();
      } else if (
        r.issuer_outcome !== "admitted" ||
        ![r.family_id, r.generation_id, r.provider_binding_id].every(uuid) ||
        !decimal(r.family_expires_at_ms)
      )
        throw unknown();
    }
    return r;
  }
  if (
    !uuid(r.flow_id) ||
    !decimal(r.flow_revision, true) ||
    !decimal(r.expires_at_ms) ||
    Number(r.expires_at_ms) <= at ||
    !uuid(r.audit_id)
  )
    throw unknown();
  if (kind !== "claimCallback" && r.flow_id !== values[1]) throw unknown();
  if (
    (kind === "createIntent" && r.flow_revision !== "1") ||
    (kind === "bindBegin" && Number(r.flow_revision) !== Number(values[2]) + 1)
  )
    throw unknown();
  if (kind === "claimCallback") {
    if (
      ![
        r.challenge_id,
        r.begin_command_id,
        r.admission_command_id,
        r.issuer_command_id,
        r.key_id,
      ].every(uuid) ||
      !id(r.workspace_id) ||
      ![
        r.state_digest,
        r.cookie_digest,
        r.browser_proof_digest,
        r.verifier_digest,
        r.aad_digest,
        r.code_digest,
      ].every(digest) ||
      new Set([r.flow_id, r.begin_command_id, r.admission_command_id, r.issuer_command_id]).size !==
        4 ||
      r.cookie_digest !== values[1] ||
      r.state_digest !== values[2] ||
      r.code_digest !== values[3]
    )
      throw unknown();
    const check = {
      schemaVersion: 1,
      configurationDigest: values[0],
      flowId: r.flow_id,
      expectedRevision: r.flow_revision,
      challengeId: r.challenge_id,
      stateDigest: r.state_digest,
      cookieDigest: r.cookie_digest,
      browserProofDigest: r.browser_proof_digest,
      verifierDigest: r.verifier_digest,
      ciphertext: r.ciphertext,
      encryptionNonce: r.encryption_nonce,
      keyId: r.key_id,
      aadDigest: r.aad_digest,
    };
    textInput(JSON.stringify(check), "bindBegin");
  }
  return r;
}
function factory(
  { pool, now }: { pool: LoginFlowSqlPool; now: () => number },
  maintenanceOnly: boolean,
) {
  let last = -1,
    bad = false;
  const clock = () => {
    try {
      const at = now();
      if (bad || !time(at) || at < last) throw unknown();
      last = at;
      return at;
    } catch {
      bad = true;
      throw unknown();
    }
  };
  async function execute(kind: Kind, text: unknown, external: LoginControl) {
    const values = textInput(text, kind),
      started = clock();
    if (!external || !time(external.deadlineMs) || !(external.signal instanceof AbortSignal))
      throw invalid();
    const deadline = Math.min(started + 5000, external.deadlineMs),
      abort = new AbortController();
    let stopped = false,
      client: LoginFlowSqlClient | undefined,
      disposal: Promise<void> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
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
      if (stopped || external.signal.aborted || at >= deadline) {
        stop();
        throw unknown();
      }
      return at;
    };
    const race = async <V>(p: Promise<V>): Promise<V> => {
      const r = await Promise.race([p.then((value) => ({ value })), interrupted]);
      if ("stopped" in r || stopped) throw unknown();
      return r.value;
    };
    const control = Object.freeze({ deadlineMs: deadline, signal: abort.signal });
    const query = async (sql: string, args: readonly string[] = Object.freeze([])) => {
      check();
      try {
        const pending = Promise.resolve(client!.query(sql, args, control));
        void pending.catch(() => {});
        const result = await race(pending);
        check();
        return result;
      } catch {
        stop();
        throw unknown();
      }
    };
    try {
      const at = check();
      external.signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(stop, deadline - at);
      const connecting = Promise.resolve(pool.connect(control)).then((c) => {
        client = c;
        if (stopped) {
          dispose();
          throw unknown();
        }
        return c;
      });
      void connecting.catch(() => {});
      await race(connecting);
      check();
      await query(
        kind === "observeEligibility" || kind === "reconcile"
          ? loginFlowCustodySql.readOnlyBegin
          : loginFlowCustodySql.begin,
      );
      const roleNames = [
          "role",
          "login",
          "rolsuper",
          "rolbypassrls",
          "rolcreatedb",
          "rolcreaterole",
          "rolreplication",
          "rolinherit",
          "owner_member",
          "role_member",
        ],
        r = row(await query(loginFlowCustodySql.role), roleNames),
        role = maintenanceOnly ? "morrow_identity_login_maintenance" : "morrow_identity_login";
      if (r.role !== role || r.login !== role || roleNames.slice(2).some((n) => r[n] !== false))
        throw unknown();
      await query(loginFlowCustodySql.timeout);
      await query(loginFlowCustodySql.idleTimeout);
      const result = decode(await query(loginFlowCustodySql[kind], values), kind, values, check());
      await query(loginFlowCustodySql.commit);
      const closing = dispose();
      if (!closing) throw unknown();
      await race(closing);
      check();
      if (
        (kind === "createIntent" || kind === "bindBegin" || kind === "claimCallback") &&
        result.expires_at_ms !== null &&
        Number(result.expires_at_ms) <= clock()
      )
        throw unknown();
      return result;
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
      external.signal.removeEventListener("abort", stop);
      stop();
    }
  }
  return execute;
}
export function createLoginFlowCustody(options: { pool: LoginFlowSqlPool; now: () => number }) {
  const run = factory(options, false);
  return Object.freeze({
    createIntent: (text: unknown, c: LoginControl) =>
      run("createIntent", text, c) as Promise<TransitionRow>,
    bindBegin: (text: unknown, c: LoginControl) =>
      run("bindBegin", text, c) as Promise<TransitionRow>,
    claimCallback: (text: unknown, c: LoginControl) =>
      run("claimCallback", text, c) as Promise<ClaimRow>,
    observeEligibility: (text: unknown, c: LoginControl) =>
      run("observeEligibility", text, c) as Promise<EligibilityRow>,
    reconcile: (text: unknown, c: LoginControl) =>
      run("reconcile", text, c) as Promise<ReconciliationRow>,
  });
}
export function createLoginFlowMaintenance(options: { pool: LoginFlowSqlPool; now: () => number }) {
  const run = factory(options, true);
  return Object.freeze({
    maintain: (text: unknown, c: LoginControl) =>
      run("maintain", text, c) as Promise<MaintenanceRow>,
  });
}
