import { createStandaloneLoginBridge } from "../../packages/identity/src/standalone-login.js";
import { createStandaloneLoginFixture } from "./standalone-login-fixture.js";
type Case = {
  name: string;
  mode?: string;
  headers?: Record<string, string>;
  body?: string | number[];
  path?: string;
  cookie?: string;
  stage?: string;
  fault?: string;
  field?: string;
  value?: string;
  expectedStatus: number;
  expectedLocation?: string;
  zeroSql?: boolean;
  expectedPorts?: string[];
};
const origin = "https://workspace.example.test";
export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/synthetic-login")
      return new Response(null, { status: 404 });
    const input = (await request.json()) as {
      at: number;
      profile: Record<string, unknown>;
      profileJson: string;
      snapshotJson: string;
      token: string;
      page: string;
      cases: Case[];
    };
    const checks: { name: string; passed: boolean }[] = [],
      metrics: {
        name: string;
        statements: string[];
        ports: string[];
        releaseAttempts: number;
        releaseCompletions: number;
        sinkInvocations: number;
      }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    for (const c of input.cases) {
      let armed = false,
        sinkInvocations = 0,
        failed = false;
      const abort = new AbortController();
      const fixture = createStandaloneLoginFixture({
        ...input,
        ...(c.mode === "tamper" ? { claimChange: { [c.field!]: c.value } } : {}),
        stage: async (name, state) => {
          if (armed && c.fault === "slow_lease") {
            if (name === "selection:resolve") state.setTime(input.at + 11000);
            return;
          }
          if (!armed || name !== c.stage) return;
          if (c.fault === "throw") throw Error("SYNTHETIC_PRIVATE_FAULT");
          if (c.fault === "expiry") state.setTime(input.at + 25000);
          if (c.fault === "clock") state.setTime(input.at - 1);
          if (c.fault === "revoke") state.setEligible(false);
          if (c.fault === "abort") abort.abort();
        },
      });
      const bridge = await createStandaloneLoginBridge(fixture);
      const originalVerify = crypto.subtle.verify;
      if (c.fault === "slow_lease")
        crypto.subtle.verify = async function (...args) {
          const verified = await Reflect.apply(originalVerify, this, args);
          fixture.setTime(input.at + 8000);
          return verified;
        };
      const start = () =>
        new Request(origin + "/auth/login", {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Morrow-Request": "1",
            ...(c.mode === "start" ? c.headers : {}),
          },
          body:
            c.mode === "start"
              ? Array.isArray(c.body)
                ? new Uint8Array(c.body)
                : (c.body ?? JSON.stringify({ schemaVersion: 1, workspaceId: "workspace_a" }))
              : JSON.stringify({ schemaVersion: 1, workspaceId: "workspace_a" }),
        });
      let result: Response,
        expectedCookie = false,
        startBody = "",
        flowCookie = "",
        state = "",
        before = 0;
      if (c.mode === "start") result = await bridge.fetch(start());
      else if (c.mode === "static")
        result = await bridge.fetch(new Request(origin + (c.path ?? "/auth/result")));
      else if (c.mode === "malformed") result = await bridge.fetch(new Request(origin + c.path));
      else {
        const beginning = await bridge.fetch(start());
        check(c.name + ":begin_success", beginning.status === 200);
        startBody = await beginning.text();
        state = new URL(
          (JSON.parse(startBody) as { authorizationUrl: string }).authorizationUrl,
        ).searchParams.get("state")!;
        flowCookie = beginning.headers.getSetCookie()[0]!.split(";")[0]!;
        const code = "synthetic-code";
        const makeCallback = () =>
          new Request(origin + (c.path ?? `/auth/workos/callback?code=${code}&state=${state}`), {
            headers: {
              Cookie: (c.cookie ?? flowCookie).replaceAll("PROOF", flowCookie.split("=")[1]!),
              ...c.headers,
            },
            signal: abort.signal,
          });
        before = fixture.calls.length;
        armed = true;
        if (["sink_throw", "sink_reject", "sink_pending"].includes(c.mode ?? "")) {
          try {
            await bridge.dispatch(makeCallback(), (output) => {
              sinkInvocations++;
              check(
                c.name + ":snapshot_frozen",
                Object.isFrozen(output) &&
                  Object.isFrozen(output.headers) &&
                  output.headers.every(Object.isFrozen) &&
                  Object.isFrozen(output.cookies),
              );
              check(c.name + ":one_cookie_at_handoff", output.cookies.length === 1);
              if (c.mode === "sink_reject") return Promise.reject(Error("SYNTHETIC_SINK_FAULT"));
              if (c.mode === "sink_pending") return new Promise<void>(() => {});
              throw Error("SYNTHETIC_SINK_FAULT");
            });
          } catch {
            failed = true;
          }
          check(c.name + ":transport_unknown", failed && sinkInvocations === 1);
          result = await bridge.fetch(makeCallback());
        } else if (c.mode === "aborted") {
          await bridge.dispatch(makeCallback(), () => {
            sinkInvocations++;
          });
          check(c.name + ":no_handoff", sinkInvocations === 0);
          result = new Response(null, { status: 503 });
        } else if (c.mode === "key_loss") {
          const replacement = await createStandaloneLoginBridge(fixture);
          result = await replacement.fetch(makeCallback());
        } else {
          result = await bridge.fetch(makeCallback());
          expectedCookie = c.mode === "success" || c.mode === "replay";
          if (c.mode === "replay") {
            check(
              c.name + ":first_success",
              result.headers.get("location") === "/" && result.headers.getSetCookie().length === 1,
            );
            result = await bridge.fetch(makeCallback());
            expectedCookie = false;
          }
        }
      }
      crypto.subtle.verify = originalVerify;
      check(c.name + ":status", result.status === c.expectedStatus);
      if (c.expectedLocation)
        check(c.name + ":clean_location", result.headers.get("location") === c.expectedLocation);
      const cookies = result.headers.getSetCookie();
      if (c.mode !== "start")
        check(c.name + ":cookie_count", cookies.length === (expectedCookie ? 1 : 0));
      if (expectedCookie) {
        check(
          c.name + ":fixed_cookie_attributes",
          /^__Host-morrow_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=900$/.test(
            cookies[0]!,
          ),
        );
        const secret = (cookies[0] ?? "=missing;").split("=")[1]!.split(";")[0]!;
        const digest = [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
          ),
        ]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        const row = fixture.calls.find((v) => v.role === "sessions" && v.stage === "admit");
        check(c.name + ":cookie_from_M", row?.values[17] === digest);
      }
      if (c.zeroSql) check(c.name + ":zero_SQL", fixture.calls.length === before);
      if (c.expectedPorts)
        check(
          c.name + ":port_sequence",
          JSON.stringify(fixture.external.map((v) => v.kind)) === JSON.stringify(c.expectedPorts),
        );
      const body = await result.text();
      check(
        c.name + ":no_reflected_secrets",
        !body.includes(input.token) &&
          !body.includes("SYNTHETIC_PRIVATE_FAULT") &&
          !body.includes("synthetic-code"),
      );
      check(
        c.name + ":no_callback_clear",
        !cookies.some((value) => value.startsWith("__Host-morrow_login=")),
      );
      check(
        c.name + ":at_most_one_issuer",
        fixture.calls.filter((v) => v.role === "sessions" && v.stage === "admit").length <= 1,
      );
      check(
        c.name + ":at_most_one_exchange",
        fixture.external.filter((v) => v.kind === "exchange").length <= 1,
      );
      if (c.fault === "throw" && c.stage?.endsWith(":release"))
        check(
          c.name + ":release_failure_remains_uncertain",
          fixture.releases.filter((v) => !v.completed).length === 1,
        );
      else if (c.mode !== "aborted")
        check(
          c.name + ":all_releases_observed",
          fixture.releases.every((v) => v.completed),
        );
      if (c.stage === "preauth:admit" && c.fault === "throw")
        check(c.name + ":no_SQL_after_uncertainty", fixture.calls.at(-1)?.stage === "admit");
      if (c.stage === "sessions:admit" && c.fault === "throw")
        check(c.name + ":no_rollback_after_uncertainty", fixture.calls.at(-1)?.stage === "admit");
      const exchange = fixture.external.find((v) => v.kind === "exchange");
      if (exchange?.input) {
        const verifier = JSON.parse(exchange.input).verifier as string;
        check(
          c.name + ":no_SQL_plaintext",
          !JSON.stringify(fixture.calls).includes(verifier) &&
            !JSON.stringify(fixture.calls).includes("synthetic-code"),
        );
        check(c.name + ":no_PKCE_in_start", !startBody.includes(verifier));
      }
      metrics.push({
        name: c.name,
        statements: fixture.calls.map((v) => v.role + ":" + v.stage),
        ports: fixture.external.map((v) => v.kind),
        releaseAttempts: fixture.releases.length,
        releaseCompletions: fixture.releases.filter((v) => v.completed).length,
        sinkInvocations,
      });
    }
    return Response.json({ checks, metrics });
  },
};
