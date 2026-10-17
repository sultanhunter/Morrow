import { createStandaloneStoreLinking } from "../../packages/identity/src/standalone-store-linking";
import { workspaceStoreLinkingControlSql as sql } from "../../packages/identity/src/workspace-store-linking-control";
import { workspaceStoreLinkingSql as legacy } from "../../packages/identity/src/workspace-store-linking";
import type { StandaloneWorkspaceSqlControl } from "../../packages/identity/src/standalone-workspace-bootstrap";

type Case = {
  name: string;
  route?: "preview" | "apply" | "status";
  workflow?: boolean;
  expectedStatus: number;
  expectedOutcome?: string;
  headers?: Record<string, string>;
  body?: string | number[];
  path?: string;
  method?: string;
  zeroSql?: boolean;
  zeroApply?: boolean;
  roleFlag?: string;
  lookup?: string;
  result?: string;
  phase?: "read" | "apply";
  stage?: string;
  fault?: string;
};
const origin = "https://workspace.example.test";
const configurationJson = JSON.stringify({ schemaVersion: 1, mode: "https", origin });
const sleep = (n: number) => new Promise<void>((resolve) => setTimeout(resolve, n));
export default {
  async fetch(request: Request) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/synthetic-standalone-store-linking"
    )
      return new Response(null, { status: 404 });
    const input = (await request.json()) as {
      secret: string;
      token: string;
      command: string;
      csrf: string;
      cases: Case[];
    };
    const checks: { name: string; passed: boolean }[] = [];
    const metrics: {
      name: string;
      connections: number;
      releaseAttempts: number;
      releaseCompletions: number;
      statements: string[];
      applyStatements: number;
      faultIndex: number | null;
    }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    for (const c of input.cases) {
      let at = 1800000000000,
        connections = 0,
        releaseAttempts = 0,
        releaseCompletions = 0,
        applyStatements = 0,
        faultIndex: number | null = null;
      const statements: string[] = [],
        requestAbort = new AbortController();
      const applied = {
        outcome: "applied",
        link_id: "link_a",
        ownership_revision: "4",
        policy_revision: "8",
        audit_id: "audit_a",
      };
      const fault = async (phase: string, stage: string) => {
        if (phase !== c.phase || stage !== c.stage) return;
        faultIndex = statements.length;
        if (c.fault === "expiry") at += 5000;
        if (c.fault === "clock") at--;
        if (c.fault === "throw") throw Error("PRIVATE_SYNTHETIC_QUERY_DETAIL");
        if (c.fault === "abort") requestAbort.abort();
        if (c.fault === "late") {
          setTimeout(() => requestAbort.abort(), 5);
          await sleep(20);
        }
        if (c.fault === "stall") {
          setTimeout(() => requestAbort.abort(), 5);
          await new Promise(() => {});
        }
      };
      const pool = {
        async connect(control: Readonly<StandaloneWorkspaceSqlControl>) {
          const number = ++connections;
          check(
            c.name + "_controlled_connection_" + number,
            Object.isFrozen(control) &&
              control.signal instanceof AbortSignal &&
              control.deadlineMs === 1800000005000,
          );
          if (c.stage === "connect") await fault(c.phase ?? "read", "connect");
          let phase = "read",
            disposed = false;
          return {
            async query(
              text: string,
              values: readonly string[],
              ownedControl: Readonly<StandaloneWorkspaceSqlControl>,
            ) {
              if (disposed || ownedControl !== control || !Object.isFrozen(values))
                throw Error("SYNTHETIC_PROTOCOL_FAILURE");
              if (text === legacy.begin) phase = "apply";
              const stage =
                text === sql.role
                  ? "role"
                  : text === sql.lookup
                    ? "lookup"
                    : text === sql.status
                      ? "status"
                      : text === legacy.apply
                        ? "apply"
                        : text === legacy.commit
                          ? "commit"
                          : text === legacy.rollback
                            ? "rollback"
                            : text === legacy.begin || text === sql.begin
                              ? "begin"
                              : text === sql.timeout
                                ? "timeout"
                                : text === sql.idleTimeout
                                  ? "idleTimeout"
                                  : "invalid";
              if (stage === "invalid") throw Error("SYNTHETIC_PROTOCOL_FAILURE");
              statements.push(phase + ":" + stage);
              if (stage === "apply") applyStatements++;
              await fault(phase, stage);
              if (stage === "role")
                return {
                  rows: [
                    {
                      role: "morrow_identity_linking",
                      login: "morrow_identity_linking",
                      rolsuper: false,
                      rolbypassrls: false,
                      rolcreatedb: false,
                      rolcreaterole: false,
                      rolinherit: false,
                      owner_member: false,
                      role_member: false,
                      rolreplication: false,
                      ...(c.roleFlag ? { [c.roleFlag]: true } : {}),
                    },
                  ],
                };
              if (stage === "lookup") {
                if (c.lookup === "absent") return { rows: [] };
                const row = {
                  handoff_id: "handoff_a",
                  command_id: values[3],
                  request_digest: "c".repeat(64),
                  session_digest: values[0],
                  nonce_digest: values[2],
                  organization_id: "org_a",
                  workspace_id: values[1],
                  installation_id: "installation_a",
                  purpose: "workspace_first",
                  expected_policy_revision: "7",
                  expected_ownership_revision: "3",
                };
                check(
                  c.name + "_derived_tuple_" + number,
                  values.length === 4 &&
                    /^[a-f0-9]{64}$/.test(values[0]!) &&
                    values[1] === "workspace_a" &&
                    /^[a-f0-9]{64}$/.test(values[2]!) &&
                    values[3] === input.command,
                );
                if (c.lookup === "foreign_workspace") row.workspace_id = "workspace_foreign";
                if (c.lookup === "foreign_session") row.session_digest = "e".repeat(64);
                if (c.lookup === "foreign_nonce") row.nonce_digest = "f".repeat(64);
                if (c.lookup === "foreign_command")
                  row.command_id = "1519ea9d-c5eb-4613-906c-26a870c0e9e8";
                if (c.lookup === "unsafe_revision")
                  row.expected_policy_revision = "9007199254740992";
                return { rows: [row] };
              }
              if (stage === "apply") {
                check(
                  c.name + "_private_11_tuple",
                  values.length === 11 &&
                    values[0] === "handoff_a" &&
                    values[1] === input.command &&
                    values[2] === "c".repeat(64) &&
                    values[5] === "org_a" &&
                    values[6] === "workspace_a" &&
                    values[7] === "installation_a" &&
                    values[8] === "workspace_first" &&
                    values[9] === "7" &&
                    values[10] === "3",
                );
                if (c.result === "denied")
                  return {
                    rows: [
                      {
                        outcome: "denied",
                        link_id: null,
                        ownership_revision: null,
                        policy_revision: "8",
                        audit_id: "audit_a",
                      },
                    ],
                  };
                if (c.result === "conflict")
                  return {
                    rows: [
                      {
                        outcome: "conflict",
                        link_id: null,
                        ownership_revision: null,
                        policy_revision: null,
                        audit_id: null,
                      },
                    ],
                  };
                if (c.result === "malformed")
                  return { rows: [{ ...applied, ownership_revision: "99" }] };
                return { rows: [{ ...applied }] };
              }
              if (stage === "status") {
                if (c.result === "absent") return { rows: [] };
                if (c.result === "malformed")
                  return { rows: [{ ...applied, outcome: "unexpected" }] };
                return { rows: [{ ...applied }] };
              }
              return { rows: [] };
            },
            async release(discard: boolean) {
              releaseAttempts++;
              disposed = true;
              check(c.name + "_disposable_" + number, discard === true);
              await fault(phase, "release");
              releaseCompletions++;
            },
          };
        },
      };
      const make = (route: "preview" | "apply" | "status", csrf = input.csrf) => {
        const suffix = route === "apply" ? "" : "/" + route;
        const body =
          c.body === undefined
            ? JSON.stringify({ handoffToken: input.token })
            : Array.isArray(c.body)
              ? new Uint8Array(c.body)
              : c.body;
        return new Request(origin + (c.path ?? "/workspace/workspace_a/store-links" + suffix), {
          method: c.method ?? "POST",
          headers: {
            Cookie: `__Host-morrow_session=${input.secret}`,
            Origin: origin,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
            "X-Morrow-Request": "1",
            "Idempotency-Key": input.command,
            ...(route === "apply" ? { "X-Morrow-CSRF": csrf } : {}),
            ...c.headers,
          },
          signal: requestAbort.signal,
          body,
        });
      };
      try {
        const api = createStandaloneStoreLinking({ configurationJson, pool, now: () => at });
        let response: Response;
        if (c.workflow) {
          const preview = await api.fetch(make("preview")),
            p = (await preview.json()) as {
              schemaVersion: number;
              link: Record<string, unknown>;
              csrfToken: string;
            };
          check(
            c.name + "_preview_closed_summary",
            preview.status === 200 &&
              Object.keys(p).sort().join(",") === "csrfToken,link,schemaVersion" &&
              Object.keys(p.link).sort().join(",") ===
                "expectedOwnershipRevision,expectedPolicyRevision,installationId,purpose" &&
              p.csrfToken === input.csrf,
          );
          const appliedResponse = await api.fetch(make("apply", p.csrfToken)),
            a = (await appliedResponse.json()) as Record<string, unknown>;
          check(
            c.name + "_applied_closed_result",
            appliedResponse.status === 200 &&
              Object.keys(a).sort().join(",") ===
                "auditId,linkId,outcome,ownershipRevision,policyRevision,schemaVersion" &&
              a.outcome === "applied" &&
              a.linkId === "link_a",
          );
          const before = applyStatements;
          response = await api.fetch(make("status"));
          check(
            c.name + "_status_readonly",
            before === 1 &&
              applyStatements === before &&
              statements.at(-2) === "read:status" &&
              statements.at(-1) === "read:commit",
          );
          check(c.name + "_same_pipeline_connections", connections === 4);
        } else response = await api.fetch(make(c.route ?? "apply"));
        const text = await response.text(),
          value = JSON.parse(text) as Record<string, unknown>;
        check(c.name + "_status", response.status === c.expectedStatus);
        if (c.expectedOutcome) check(c.name + "_outcome", value.outcome === c.expectedOutcome);
        if (c.zeroSql) check(c.name + "_zero_SQL", connections === 0 && statements.length === 0);
        if (c.zeroApply) check(c.name + "_zero_apply", applyStatements === 0);
        check(
          c.name + "_private_material_absent",
          !text.includes(input.secret) &&
            !text.includes(input.token) &&
            !text.includes("PRIVATE_SYNTHETIC") &&
            !text.includes("sessionDigest") &&
            !text.includes("nonceDigest") &&
            !text.includes("requestDigest") &&
            !text.includes("handoff_a"),
        );
        check(
          c.name + "_security_headers",
          response.headers.get("Cache-Control") === "no-store" &&
            response.headers.get("Referrer-Policy") === "no-referrer" &&
            response.headers.get("X-Content-Type-Options") === "nosniff" &&
            response.headers.get("Access-Control-Allow-Origin") === null,
        );
        if (c.fault === "throw" && c.stage !== "release")
          check(
            c.name + "_no_SQL_after_lost_ack",
            faultIndex !== null &&
              statements.length === faultIndex &&
              !statements.includes("apply:rollback"),
          );
        if (c.route === "status")
          check(
            c.name + "_status_never_applies",
            applyStatements === 0 && !statements.some((stage) => stage.startsWith("apply:")),
          );
        if (c.fault === "late") await sleep(30);
        if (connections > 0) {
          check(c.name + "_release_attempts_owned", releaseAttempts === connections);
          if (!(c.stage === "release" && c.fault === "throw"))
            check(c.name + "_release_acknowledgements", releaseCompletions === connections);
          else check(c.name + "_lost_release_ack_retained", releaseCompletions < releaseAttempts);
        }
      } catch {
        check(c.name + "_unexpected_failure", false);
      }
      metrics.push({
        name: c.name,
        connections,
        releaseAttempts,
        releaseCompletions,
        statements,
        applyStatements,
        faultIndex,
      });
    }
    return Response.json({ checks, metrics });
  },
};
