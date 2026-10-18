import { authenticationExchangeAdmissionSql as preauthSql } from "../../packages/identity/src/authentication-exchange-admission.js";
import { browserSessionAdmissionSql as sessionSql } from "../../packages/identity/src/workos-browser-session-admission.js";
import { loginFlowCustodySql as loginSql } from "../../packages/identity/src/login-flow-custody.js";
import type { LoginControlledSqlPool } from "../../packages/identity/src/login-preauth-control.js";

// Synthetic SQL port only. The independent PostgreSQL/HTTPS lab uses the real
// migration and three real sessions (account login, P05.T01x). These counters do
// not claim database proof.
export function createStandaloneLoginFixture(input: {
  at: number;
  profile: Record<string, unknown>;
  profileJson: string;
  snapshotJson: string;
  token: string;
  page: string;
  stage?: (
    stage: string,
    state: {
      setTime: (v: number) => void;
      setEligible: (v: boolean) => void;
      calls: { role: string; stage: string; text: string; values: readonly string[] }[];
      releases: { role: string; completed: boolean }[];
      external: { kind: string; input?: string }[];
      flow: Record<string, string> | undefined;
      flows: Record<string, string>[];
    },
  ) => void | Promise<void>;
  claimChange?: Record<string, unknown>;
  eligibility?: boolean;
  exchangeOutput?: string;
  providerPage?: string;
  roleFlags?: Record<string, unknown>;
  // Milliseconds from the admission clock to the generation's expiry (default 15 minutes,
  // the pre-P05.T01y lifetime; P05.T01y generations live up to 30 minutes).
  admissionLifetimeMs?: number;
}) {
  let at = input.at,
    eligible = input.eligibility !== false;
  let flow: Record<string, string> | undefined;
  let claimed = false;
  const calls: { role: string; stage: string; text: string; values: readonly string[] }[] = [];
  const releases: { role: string; completed: boolean }[] = [];
  const external: { kind: string; input?: string }[] = [];
  const flows: Record<string, string>[] = [];
  const commands = new Set<string>();
  const controls = () => ({
    setTime: (value: number) => {
      at = value;
    },
    setEligible: (value: boolean) => {
      eligible = value;
    },
    calls,
    releases,
    external,
    flow,
    flows,
  });
  const stage = async (name: string) => {
    await input.stage?.(name, controls());
  };
  const pool = (role: string): LoginControlledSqlPool => ({
    async connect(control) {
      await stage(role + ":connect");
      return {
        async query(text, values, queryControl) {
          if (control.signal.aborted || queryControl.signal.aborted)
            throw Error("SYNTHETIC_ABORTED");
          const source = role === "login" ? loginSql : role === "preauth" ? preauthSql : sessionSql;
          const name = Object.entries(source).find(([, sql]) => sql === text)?.[0] ?? "unexpected";
          calls.push({ role, stage: name, text, values });
          await stage(role + ":" + name);
          if (name === "role") {
            const nameByRole = {
              login: "morrow_identity_login",
              preauth: "morrow_identity_preauth",
              sessions: "morrow_identity_sessions",
            };
            const principal = nameByRole[role as keyof typeof nameByRole];
            return {
              rows: [
                {
                  role: principal,
                  login: principal,
                  rolsuper: false,
                  rolbypassrls: false,
                  rolcreatedb: false,
                  rolcreaterole: false,
                  rolinherit: false,
                  owner_member: false,
                  role_member: false,
                  ...(role !== "preauth" ? { rolreplication: false } : {}),
                  ...input.roleFlags,
                },
              ],
            };
          }
          if (role === "login") {
            if (name === "createAccountIntent") {
              const [
                configurationDigest,
                flowId,
                beginCommandId,
                admissionCommandId,
                issuerCommandId,
              ] = values as string[];
              flow = {
                configurationDigest: configurationDigest!,
                flowId: flowId!,
                beginCommandId: beginCommandId!,
                admissionCommandId: admissionCommandId!,
                issuerCommandId: issuerCommandId!,
                expiresAtMs: String(at + 300000),
                revision: "1",
                phase: "intent",
              };
              flows.push(flow);
              claimed = false;
              return {
                rows: [
                  {
                    outcome: "newly_created",
                    flow_id: flow.flowId,
                    flow_revision: "1",
                    expires_at_ms: flow.expiresAtMs,
                    audit_id: "b713fcb7-f66b-45ed-b815-5b7659a79105",
                  },
                ],
              };
            }
            if (name === "bindBegin") {
              if (!flow) throw Error("NO_INTENT");
              const names = [
                "configurationDigest",
                "flowId",
                "revision",
                "challengeId",
                "stateDigest",
                "cookieDigest",
                "browserProofDigest",
                "verifierDigest",
                "ciphertext",
                "encryptionNonce",
                "keyId",
                "aadDigest",
              ];
              names.forEach((key, index) => {
                flow![key] = values[index]!;
              });
              flow.phase = "awaiting_callback";
              flow.revision = "2";
              return {
                rows: [
                  {
                    outcome: "newly_ready",
                    flow_id: flow.flowId,
                    flow_revision: "2",
                    expires_at_ms: flow.expiresAtMs,
                    audit_id: "b713fcb7-f66b-45ed-b815-5b7659a79106",
                  },
                ],
              };
            }
            if (name === "claimCallback") {
              const fields = [
                "flow_id",
                "flow_revision",
                "expires_at_ms",
                "audit_id",
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
              if (
                !flow ||
                claimed ||
                flow.configurationDigest !== values[0] ||
                flow.cookieDigest !== values[1] ||
                flow.stateDigest !== values[2]
              )
                return {
                  rows: [
                    Object.fromEntries([["outcome", "held"], ...fields.map((key) => [key, null])]),
                  ],
                };
              claimed = true;
              flow.phase = "claimed";
              flow.revision = "3";
              const row = {
                outcome: "newly_claimed",
                flow_id: flow.flowId,
                flow_revision: "3",
                expires_at_ms: flow.expiresAtMs,
                audit_id: "b713fcb7-f66b-45ed-b815-5b7659a79107",
                challenge_id: flow.challengeId,
                begin_command_id: flow.beginCommandId,
                admission_command_id: flow.admissionCommandId,
                issuer_command_id: flow.issuerCommandId,
                workspace_id: null,
                state_digest: flow.stateDigest,
                cookie_digest: flow.cookieDigest,
                browser_proof_digest: flow.browserProofDigest,
                verifier_digest: flow.verifierDigest,
                ciphertext: flow.ciphertext,
                encryption_nonce: flow.encryptionNonce,
                key_id: flow.keyId,
                aad_digest: flow.aadDigest,
                code_digest: values[3],
                ...input.claimChange,
              };
              flow.ciphertext = "";
              return { rows: [row] };
            }
            if (name === "observeEligibility")
              return { rows: [{ matches: eligible, database_now_ms: String(at) }] };
          }
          if (role === "preauth" && name === "create") {
            if (commands.has(values[1]!)) return { rows: [] };
            commands.add(values[1]!);
            return { rows: [{ challenge_id: values[0] }] };
          }
          if (role === "preauth" && name === "admit") {
            if (commands.has(values[0]!))
              return {
                rows: [{ outcome: "held", admission_id: "03d0144a-f65e-4a7f-a7d5-b9b6783440c2" }],
              };
            commands.add(values[0]!);
            return {
              rows: [
                { outcome: "newly_reserved", admission_id: "03d0144a-f65e-4a7f-a7d5-b9b6783440c2" },
              ],
            };
          }
          if (role === "sessions" && name === "admitAccount")
            return {
              rows: [
                {
                  outcome: "newly_admitted",
                  family_id: values[19],
                  generation_id: values[20],
                  provider_binding_id: "9bcc50b3-047a-49c4-89e6-0a425121fd20",
                  expires_at_ms: String(at + (input.admissionLifetimeMs ?? 900000)),
                  audit_id: "45c901f7-5792-4b47-8ea8-5fab2331e91c",
                },
              ],
            };
          return { rows: [] };
        },
        async release(discard) {
          if (discard !== true) throw Error("NOT_DISPOSABLE");
          const record = { role, completed: false };
          releases.push(record);
          await stage(role + ":release");
          record.completed = true;
        },
      };
    },
  });
  const bindingJson = JSON.stringify({
    bindingId: "binding_a",
    bindingRevision: 1,
    environmentId: input.profile.environmentId,
    applicationId: input.profile.applicationId,
    clientId: input.profile.clientId,
    redirectUri: "https://workspace.example.test/auth/workos/callback",
    returnPath: "/",
  });
  const configurationJson = JSON.stringify({
    schemaVersion: 1,
    controllerProtocol: "morrow-login-v1",
    origin: "https://workspace.example.test",
    retentionTier: "staging",
    authenticationBindingJson: bindingJson,
    verificationProfileJson: input.profileJson,
    profileId: "profile_a",
    profileRecordRevision: 1,
  });
  const providerPort = {
    async exchange(text: string, control: { signal: AbortSignal }) {
      external.push({ kind: "exchange", input: text });
      await stage("provider:exchange");
      if (control.signal.aborted) throw Error("ABORT");
      return input.exchangeOutput ?? JSON.stringify({ schemaVersion: 1, accessToken: input.token });
    },
    async readPublicKeyset(control: { signal: AbortSignal }) {
      external.push({ kind: "keyset" });
      await stage("provider:keyset");
      if (control.signal.aborted) throw Error("ABORT");
      return input.snapshotJson;
    },
    async readSessionPage(text: string, control: { signal: AbortSignal }) {
      external.push({ kind: "page", input: text });
      await stage("provider:page");
      if (control.signal.aborted) throw Error("ABORT");
      return input.providerPage ?? input.page;
    },
  };
  return {
    ...controls(),
    now: () => at,
    configurationJson,
    loginPool: pool("login"),
    preauthPool: pool("preauth"),
    sessionPool: pool("sessions"),
    providerPort,
  };
}
