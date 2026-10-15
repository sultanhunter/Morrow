// Local workerd qualification with independent signed fixtures and synthetic SQL.
import { createWorkosAuthenticationEvidence } from "../../packages/identity/src/workos-authentication-evidence";
import {
  createWorkosBrowserSessionAdmission,
  browserSessionAdmissionSql,
  type BrowserSessionAdmissionControl,
  type BrowserSessionAdmissionSqlClient,
} from "../../packages/identity/src/workos-browser-session-admission";
type Case = {
  name: string;
  profileJson: string;
  snapshotJson: string;
  token: string;
  page: string;
  now: number;
  selector: string;
  mode?: string;
  stage?: string;
  kind?: string;
  row?: Record<string, unknown>;
  role?: Record<string, unknown>;
  expected: string;
  shortLease?: boolean;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));
export default {
  async fetch(request: Request) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/synthetic-browser-session-admission"
    )
      return new Response(null, { status: 404 });
    const input = (await request.json()) as { cases: Case[] };
    const checks: { name: string; passed: boolean }[] = [];
    const metrics: { name: string; connects: number; queries: number; releases: number }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    for (const c of input.cases) {
      try {
        let at = c.now,
          currentProfile = c.profileJson,
          connects = 0,
          releases = 0,
          releaseDone = 0,
          traps = 0,
          rowGetters = 0,
          parametersValid = true,
          controlsValid = true;
        const queried: string[] = [],
          valuesSeen: readonly string[][] = [];
        let admitParams: readonly string[] | null = null;
        const cancel = new AbortController();
        const source = JSON.parse(c.profileJson) as Record<string, unknown>;
        const owner = createWorkosAuthenticationEvidence(c.profileJson, c.snapshotJson, {
          now: () => at,
          currentProfile: () => currentProfile,
          readPage: async () => c.page,
        });
        const proof = await owner.verify(c.token);
        check(c.name + "_own_signed_evidence", proof.outcome === "verified_active_evidence");
        const evidence = owner.readEvidence(proof.handle)!;
        const role = {
          role: "morrow_identity_sessions",
          login: "morrow_identity_sessions",
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolinherit: false,
          owner_member: false,
          role_member: false,
          ...c.role,
        };
        const controlCheck = (control: Readonly<BrowserSessionAdmissionControl>) => {
          controlsValid &&=
            Object.isFrozen(control) &&
            control.signal instanceof AbortSignal &&
            control.deadlineMs === Math.min(c.now + 5000, evidence.expiresAtMs);
        };
        const fault = async (stage: string) => {
          if (c.stage !== stage) return;
          if (c.kind === "expiry") at = evidence.expiresAtMs;
          else if (c.kind === "profile") currentProfile = "{}";
          else if (c.kind === "clock") at = c.now - 1;
          else if (c.kind === "cancel") cancel.abort();
          else if (c.kind === "throw")
            throw new Proxy(
              {},
              {
                get() {
                  traps++;
                  throw Error("PRIVATE_SYNTHETIC_DETAIL");
                },
              },
            );
          else if (c.kind === "late") await sleep(120);
          else if (c.kind === "stall") await new Promise(() => {});
        };
        const newClient = (): BrowserSessionAdmissionSqlClient => {
          let disposed = false;
          return {
            async query(text, values, control) {
              controlCheck(control);
              const stage = Object.entries(browserSessionAdmissionSql).find(
                ([, v]) => v === text,
              )?.[0];
              if (!stage) throw Error();
              queried.push(stage);
              (valuesSeen as string[][]).push([...values]);
              parametersValid &&= !disposed && Object.isFrozen(values);
              await fault(stage);
              if (stage === "role") return { rows: [role] };
              if (stage === "admit") {
                admitParams = values;
                const selected = JSON.parse(c.selector) as Record<string, unknown>;
                const expected = [
                  selected.commandId,
                  source.providerId,
                  source.environmentId,
                  source.applicationId,
                  source.clientId,
                  source.issuer,
                  String(source.revision),
                  evidence.tokenProfileDigest,
                  evidence.subjectId,
                  evidence.providerSessionId,
                  selected.workspaceId,
                  String(evidence.issuedAtMs),
                  String(evidence.observedAtMs),
                  String(evidence.expiresAtMs),
                  evidence.keySetDigest,
                  evidence.observationProfileDigest,
                ];
                parametersValid &&=
                  values.length === 27 &&
                  same([values[0], ...values.slice(2, 17)], expected) &&
                  values[1] === (await sha(JSON.stringify(values.filter((_v, i) => i !== 1)))) &&
                  same(values.slice(18, 25), [
                    selected.profileId,
                    String(selected.profileRecordRevision),
                    selected.mappingId,
                    String(selected.mappingRevision),
                    String(selected.bindingRevision),
                    selected.membershipId,
                    String(selected.policyRevision),
                  ]) &&
                  values[25] !== values[26];
                const row = {
                  outcome: "newly_admitted",
                  family_id: values[25],
                  generation_id: values[26],
                  provider_binding_id: "fa670265-ae36-4bcb-a822-849225268e31",
                  expires_at_ms: String(at + 900000),
                  audit_id: "58c32486-9ba8-461b-b521-9a8a1deba837",
                  ...c.row,
                };
                if (c.mode === "row_accessor")
                  Object.defineProperty(row, "family_id", {
                    enumerable: true,
                    get() {
                      rowGetters++;
                      throw Error();
                    },
                  });
                return { rows: [row] };
              }
              if (stage === "reconcile")
                return {
                  rows: [
                    {
                      outcome: "replayed",
                      family_id: admitParams?.[25] ?? "a4351961-15f3-4efb-b8e4-15789344072c",
                      generation_id: admitParams?.[26] ?? "1def400c-af4f-4956-80ba-68438c977c34",
                      provider_binding_id: "fa670265-ae36-4bcb-a822-849225268e31",
                      expires_at_ms: String(at - 1),
                      audit_id: "58c32486-9ba8-461b-b521-9a8a1deba837",
                    },
                  ],
                };
              return { rows: [] };
            },
            async release(discard) {
              releases++;
              parametersValid &&= discard === true;
              disposed = true;
              await fault("release");
              releaseDone++;
            },
          };
        };
        const service = createWorkosBrowserSessionAdmission({
          now: () => at,
          signal: cancel.signal,
          readEvidence: (h) => owner.readEvidence(h),
          pool: {
            async connect(control) {
              connects++;
              controlCheck(control);
              await fault("connect");
              return newClient();
            },
          },
        });
        let handle: unknown = proof.handle,
          selected: unknown = c.selector;
        if (c.mode === "foreign") {
          const foreign = createWorkosAuthenticationEvidence(c.profileJson, c.snapshotJson, {
            now: () => at,
            currentProfile: () => c.profileJson,
            readPage: async () => c.page,
          });
          handle = (await foreign.verify(c.token)).handle;
        }
        if (c.mode === "serialized") handle = JSON.stringify(evidence);
        if (c.mode === "forged") handle = {};
        if (c.mode === "expired") at = evidence.expiresAtMs;
        if (c.mode === "selector_proxy")
          selected = new Proxy(
            {},
            {
              get() {
                traps++;
                throw Error();
              },
              ownKeys() {
                traps++;
                throw Error();
              },
            },
          );
        if (c.mode === "handle_proxy")
          handle = new Proxy(
            {},
            {
              get() {
                traps++;
                throw Error();
              },
              ownKeys() {
                traps++;
                throw Error();
              },
            },
          );
        const result = await service.admit(handle, selected);
        check(c.name + "_outcome", result.outcome === c.expected);
        check(
          c.name + "_closed_result",
          Object.isFrozen(result) &&
            Object.keys(result).sort().join(",") === "correlation,credential,outcome",
        );
        if (result.outcome === "newly_admitted") {
          const material = result.credential!;
          const params = admitParams as unknown as readonly string[];
          check(
            c.name + "_private_entropy_and_digest",
            /^[A-Za-z0-9_-]{43}$/.test(material.secret) &&
              params[17] === (await sha(material.secret)) &&
              material.familyId === params[25] &&
              material.generationId === params[26] &&
              material.expiresAtMs === c.now + 900000 &&
              Object.isFrozen(material),
          );
          check(
            c.name + "_commit_release_before_delivery",
            queried.at(-1) === "commit" && releases === 1 && releaseDone === 1,
          );
          check(
            c.name + "_sql_excludes_bearer",
            !JSON.stringify(valuesSeen).includes(material.secret) &&
              !JSON.stringify(valuesSeen).includes(c.token),
          );
          const before = queried.length;
          const replay = await service.admit(proof.handle, c.selector);
          check(
            c.name + "_same_command_no_regeneration",
            replay.outcome === "held" && replay.credential === null && queried.length === before,
          );
          if (c.mode === "reconcile") {
            const r = await service.reconcile(
              JSON.stringify({ schemaVersion: 1, ...result.correlation }),
            );
            check(
              c.name + "_readonly_reconciliation",
              r.outcome === "replayed" &&
                r.attribution !== null &&
                !Object.hasOwn(r.attribution, "secret") &&
                queried.includes("readOnlyBegin"),
            );
          }
        } else check(c.name + "_held_no_credential", result.credential === null);
        if (
          [
            "forged",
            "foreign",
            "serialized",
            "expired",
            "selector_proxy",
            "handle_proxy",
            "invalid_selector",
          ].includes(c.mode ?? "")
        )
          check(c.name + "_no_sql_acquisition", connects === 0);
        if (c.kind === "late") await sleep(140);
        check(c.name + "_parameters_and_deadlines", parametersValid && controlsValid);
        check(c.name + "_privacy_zero_getters", traps === 0 && rowGetters === 0);
        if (c.kind === "throw")
          check(
            c.name + "_no_query_after_uncertain",
            !queried.includes("rollback") &&
              !(queried.includes("commit") && c.stage !== "release" && c.stage !== "commit"),
          );
        if (c.kind === "late" && c.stage === "connect")
          check(c.name + "_late_discard", queried.length === 0 && releases === 1);
        if (c.kind === "stall" && c.stage === "release")
          check(
            c.name + "_unverified_release_no_success",
            result.outcome === "held" && releases === 1 && releaseDone === 0,
          );
        metrics.push({ name: c.name, connects, queries: queried.length, releases });
      } catch {
        check(c.name + "_unexpected_failure", false);
      }
    }
    return Response.json({ checks, metrics });
  },
};
