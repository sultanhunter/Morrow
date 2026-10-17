import {
  createStandaloneWorkspaceBootstrap,
  type StandaloneWorkspaceSqlControl,
} from "../../packages/identity/src/standalone-workspace-bootstrap";
import {
  createStandaloneRequestGuard,
  standaloneJson,
} from "../../packages/identity/src/standalone-request-guard";
import { identitySql } from "../../packages/identity/src/index";

type Case = {
  name: string;
  expectedStatus: number;
  zeroSql?: boolean;
  mode?: "preview" | "apply" | "status" | "two_workspaces";
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | number[];
  stage?: string;
  kind?: string;
  roleFlag?: string;
  expectedCsrf?: string;
};
const origin = "https://workspace.example.test";
const config = JSON.stringify({ schemaVersion: 1, mode: "https", origin });
const sleep = (n: number) => new Promise<void>((resolve) => setTimeout(resolve, n));
export default {
  async fetch(request: Request) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/synthetic-standalone-workspace"
    )
      return new Response(null, { status: 404 });
    const input = (await request.json()) as {
      secret: string;
      token: string;
      command: string;
      cases: Case[];
    };
    const checks: { name: string; passed: boolean }[] = [];
    const metrics: {
      name: string;
      connects: number;
      releases: number;
      releaseCompletions: number;
      queries: string[];
      cancellations: number;
    }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    for (const c of input.cases) {
      let at = 1800000000000,
        connects = 0,
        releases = 0,
        releaseCompletions = 0,
        cancellations = 0;
      const queried: string[] = [],
        controller = new AbortController();
      const base = {
        principal_id: "human_a",
        organization_id: "org_a",
        membership_id: "membership_a",
        policy_revision: "1",
      };
      const fault = async (stage: string) => {
        if (c.stage !== stage) return;
        if (c.kind === "expiry") at += 5000;
        if (c.kind === "clock") at--;
        if (c.kind === "throw") throw Error("PRIVATE_SYNTHETIC_SQL_DETAIL");
        if (c.kind === "abort") controller.abort();
        if (c.kind === "stall") {
          setTimeout(() => controller.abort(), 5);
          await new Promise(() => {});
        }
        if (c.kind === "late") {
          setTimeout(() => controller.abort(), 5);
          await sleep(20);
        }
      };
      const pool = {
        async connect(control: Readonly<StandaloneWorkspaceSqlControl>) {
          const connectionNumber = ++connects;
          check(
            c.name + "_control_" + connectionNumber,
            Object.isFrozen(control) &&
              control.deadlineMs === 1800000005000 &&
              control.signal instanceof AbortSignal,
          );
          control.signal.addEventListener(
            "abort",
            () => {
              cancellations++;
            },
            { once: true },
          );
          await fault("connect");
          let bound = "workspace_a",
            disposed = false;
          return {
            async query(
              text: string,
              values: readonly string[],
              supplied: Readonly<StandaloneWorkspaceSqlControl>,
            ) {
              const stage = Object.entries(identitySql).find(([, sql]) => sql === text)?.[0];
              if (!stage || disposed || supplied !== control || !Object.isFrozen(values))
                throw Error("SYNTHETIC_QUERY_PROTOCOL");
              queried.push(stage);
              await fault(stage);
              if (stage === "role")
                return {
                  rows: [
                    {
                      role: "morrow_api",
                      login: "morrow_api",
                      rolsuper: false,
                      rolbypassrls: false,
                      rolcreatedb: false,
                      rolcreaterole: false,
                      owner_member: false,
                      ...(c.roleFlag ? { [c.roleFlag]: true } : {}),
                    },
                  ],
                };
              if (stage === "bind") {
                bound = values[1]!;
                check(
                  c.name + "_private_binding_" + connectionNumber,
                  /^[a-f0-9]{64}$/.test(values[0]!) &&
                    values[0] !== input.secret &&
                    !text.includes(input.secret),
                );
              }
              if (stage === "resolve")
                return {
                  rows:
                    c.kind === "missing"
                      ? []
                      : [
                          {
                            ...base,
                            workspace_id: c.kind === "foreign" ? "workspace_foreign" : bound,
                          },
                        ],
                };
              if (stage === "workspace")
                return {
                  rows:
                    c.kind === "workspace_revoked"
                      ? []
                      : [
                          {
                            id: bound,
                            organization_id: "org_a",
                            display_name: "Synthetic " + bound,
                          },
                        ],
                };
              if (stage === "workspaceAuthority")
                return {
                  rows:
                    c.kind === "authority_revoked"
                      ? []
                      : [
                          {
                            ...base,
                            workspace_id: bound,
                            policy_revision: "2",
                            grants: [],
                            ...(c.kind === "principal_changed" ? { principal_id: "human_b" } : {}),
                          },
                        ],
                };
              return { rows: [] };
            },
            async release(discard: boolean) {
              releases++;
              disposed = true;
              check(c.name + "_discard_" + releases, discard === true);
              await fault("release");
              releaseCompletions++;
            },
          };
        },
      };
      const make = (workspaceId?: string) => {
        const route = c.mode && c.mode !== "two_workspaces" ? c.mode : "bootstrap";
        const path =
          c.path ??
          `/workspace/${workspaceId ?? "workspace_a"}/${route === "bootstrap" ? "bootstrap" : "store-links" + (route === "apply" ? "" : "/" + route)}`;
        const mutation = route !== "bootstrap";
        const body =
          c.body === undefined
            ? mutation
              ? JSON.stringify({ handoffToken: input.token })
              : undefined
            : Array.isArray(c.body)
              ? new Uint8Array(c.body)
              : c.body;
        return new Request(origin + path, {
          method: c.method ?? (mutation ? "POST" : "GET"),
          headers: {
            Cookie: `__Host-morrow_session=${input.secret}`,
            ...(mutation
              ? {
                  Origin: origin,
                  "Content-Type": "application/json",
                  "Sec-Fetch-Site": "same-origin",
                  "X-Morrow-Request": "1",
                  "Idempotency-Key": input.command,
                }
              : {}),
            ...c.headers,
          },
          signal: controller.signal,
          ...(body === undefined ? {} : { body }),
        });
      };
      try {
        const api = createStandaloneWorkspaceBootstrap({
          configurationJson: config,
          pool,
          now: () => at,
        });
        let response: Response;
        if (c.mode === "two_workspaces") {
          const results = await Promise.all([
            api.fetch(make("workspace_a")),
            api.fetch(make("workspace_b")),
          ]);
          const bodies = (await Promise.all(results.map((r) => r.clone().json()))) as {
            workspace: { id: string };
          }[];
          check(
            c.name + "_independent_selection",
            bodies[0]?.workspace.id === "workspace_a" && bodies[1]?.workspace.id === "workspace_b",
          );
          response = results[0]!;
        } else if (c.mode) {
          const guard = createStandaloneRequestGuard(config, () => at);
          response = await guard.handle(make(), c.mode, async (context) => {
            check(
              c.name + "_request_tuple",
              context.workspaceId === "workspace_a" &&
                context.commandId === input.command &&
                /^[a-f0-9]{64}$/.test(context.sessionDigest) &&
                /^[a-f0-9]{64}$/.test(context.nonceDigest ?? ""),
            );
            check(c.name + "_native_HMAC_independent_oracle", context.csrfToken === c.expectedCsrf);
            await fault("callback");
            return standaloneJson(
              200,
              c.mode === "preview" ? { csrfToken: context.csrfToken } : { outcome: "applied" },
            );
          });
        } else response = await api.fetch(make());
        const text = await response.text();
        check(c.name + "_status", response.status === c.expectedStatus);
        check(
          c.name + "_private_values_absent",
          !text.includes(input.secret) &&
            !text.includes(input.token) &&
            !text.includes("PRIVATE_SYNTHETIC"),
        );
        check(
          c.name + "_response_headers",
          response.headers.get("Cache-Control") === "no-store" &&
            response.headers.get("X-Content-Type-Options") === "nosniff" &&
            response.headers.get("Referrer-Policy") === "no-referrer" &&
            response.headers.get("Access-Control-Allow-Origin") === null,
        );
        if (c.zeroSql) check(c.name + "_zero_SQL", connects === 0 && queried.length === 0);
        if (response.status === 200 && !c.mode) {
          const value = JSON.parse(text);
          check(
            c.name + "_closed_latest_policy",
            Object.keys(value).sort().join(",") === "policyRevision,schemaVersion,workspace" &&
              value.schemaVersion === 1 &&
              value.policyRevision === 2 &&
              Object.keys(value.workspace).sort().join(",") === "displayName,id",
          );
        }
        if (c.mode === "apply" && c.stage === "callback")
          check(
            c.name + "_unknown_only",
            text === '{"schemaVersion":1,"outcome":"outcome_unknown"}',
          );
        if (c.stage && c.kind === "throw" && c.stage !== "release" && c.stage !== "callback")
          check(
            c.name + "_no_SQL_after_unknown",
            queried.at(-1) === c.stage && !queried.includes("rollback"),
          );
        if (c.kind === "late") await sleep(30);
        if (connects > 0) {
          check(c.name + "_disposal_attempted", releases === connects);
          if (!(c.stage === "release" && c.kind === "throw"))
            check(c.name + "_disposal_completed", releaseCompletions === connects);
          else check(c.name + "_lost_release_ack_retained", releaseCompletions === 0);
        }
      } catch {
        check(c.name + "_unexpected_failure", false);
      }
      metrics.push({
        name: c.name,
        connects,
        releases,
        releaseCompletions,
        queries: queried,
        cancellations,
      });
    }
    return Response.json({ checks, metrics });
  },
};
