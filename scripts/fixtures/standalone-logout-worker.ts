import { createStandaloneLogout } from "../../packages/identity/src/standalone-logout.js";
import {
  createStandaloneLogoutFixture,
  logoutFixtureRequest,
} from "./standalone-logout-fixture.js";
type Case = {
  name: string;
  headers?: Record<string, string>;
  cookie?: string;
  body?: string | number[];
  method?: string;
  path?: string;
  mode?: string;
  stage?: string;
  fault?: string;
  status: number;
  outcome: string;
  zeroSql?: boolean;
  effects?: number;
};
const first = "A".repeat(43),
  second = "B".repeat(42) + "A";
export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/synthetic-logout")
      return new Response(null, { status: 404 });
    const { cases } = (await request.json()) as { cases: Case[] };
    const checks: { name: string; passed: boolean }[] = [],
      metrics: Record<string, unknown>[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    for (const c of cases) {
      const abort = new AbortController();
      let sinkInvocations = 0,
        held = true;
      let open!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
          open = resolve;
        }),
        arrival = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const fixture = createStandaloneLogoutFixture({
        roleUnsafe: c.mode === "unsafe",
        denied: c.mode === "foreign",
        malformed: c.mode === "malformedResult",
        stage: async (name, f) => {
          if (
            ((c.mode === "heldRelease" && name === "release") ||
              (c.mode === "lateConnection" && name === "connect") ||
              (c.mode === "race" && name === "release")) &&
            held
          ) {
            held = false;
            entered();
            await gate;
          }
          if (name !== c.stage) return;
          if (c.fault === "throw") throw Error("SYNTHETIC_PRIVATE_FAULT");
          if (c.fault === "expiry") f.setTime(f.now() + 5000);
          if (c.fault === "clock") f.setTime(f.now() - 1);
          if (c.fault === "abort") abort.abort();
        },
      });
      await fixture.register(first);
      await fixture.register(second);
      const handler = await createStandaloneLogout(fixture);
      const make = () =>
        logoutFixtureRequest({
          headers: c.headers,
          cookie: c.cookie,
          body: Array.isArray(c.body) ? new Uint8Array(c.body) : c.body,
          path: c.path,
          method: c.method,
          signal: abort.signal,
        });
      let response: Response;
      if (c.mode === "heldRelease" || c.mode === "lateConnection" || c.mode === "race") {
        const original = make(),
          replay = original.clone();
        let settled = false;
        const pending = handler.fetch(original).then(
          (r) => {
            settled = true;
            return r;
          },
          () => {
            settled = true;
            return new Response(null, { status: 503 });
          },
        );
        await arrival;
        // Microtask draining is sufficient: owned release has not resolved.
        await Promise.resolve();
        await Promise.resolve();
        check(c.name + ":held_not_success", !settled);
        if (c.mode === "lateConnection") abort.abort();
        if (c.mode === "race") {
          check(c.name + ":old_ended", await fixture.ended(first));
          check(c.name + ":new_family_live", !(await fixture.ended(second)));
        }
        open();
        response = await pending;
        if (c.mode === "lateConnection") {
          for (let i = 0; i < 16 && fixture.metrics.releaseCompletions === 0; i++)
            await Promise.resolve();
          check(c.name + ":late_connection_disposed", fixture.metrics.releaseCompletions === 1);
          check(c.name + ":no_function", fixture.metrics.invocationCount === 0);
          response = new Response(
            JSON.stringify({ schemaVersion: 1, outcome: "logout_unavailable" }),
            { status: 503 },
          );
        }
        if (c.mode === "race") {
          const same = await handler.fetch(replay);
          check(
            c.name + ":replay_old_only",
            same.status === 200 && fixture.metrics.effects === 1 && !(await fixture.ended(second)),
          );
          check(c.name + ":no_cookie_replay", same.headers.getSetCookie().length === 0);
          const fresh = await handler.fetch(
            logoutFixtureRequest({ cookie: "__Host-morrow_session=" + second }),
          );
          check(
            c.name + ":explicit_new_capture",
            fresh.status === 200 && fixture.metrics.effects === 2 && (await fixture.ended(second)),
          );
        }
      } else if (c.mode?.startsWith("sink")) {
        let failed = false;
        try {
          await handler.dispatch(make(), (output) => {
            sinkInvocations++;
            check(
              c.name + ":frozen_snapshot",
              Object.isFrozen(output) &&
                Object.isFrozen(output.headers) &&
                output.headers.every(Object.isFrozen) &&
                Object.isFrozen(output.cookies),
            );
            check(c.name + ":no_cookie_snapshot", output.cookies.length === 0);
            if (c.mode === "sinkReject") return Promise.reject(Error("SYNTHETIC_PRIVATE_FAULT"));
            if (c.mode === "sinkPending") return new Promise<void>(() => {});
            throw Error("SYNTHETIC_PRIVATE_FAULT");
          });
        } catch {
          failed = true;
        }
        check(c.name + ":single_unknown_transport", failed && sinkInvocations === 1);
        response = new Response(
          JSON.stringify({ schemaVersion: 1, outcome: "logout_outcome_unknown" }),
          { status: 503 },
        );
      } else {
        try {
          response = await handler.fetch(make());
        } catch {
          response = new Response(
            JSON.stringify({ schemaVersion: 1, outcome: "logout_outcome_unknown" }),
            { status: 503 },
          );
        }
      }
      const text = await response.text();
      check(c.name + ":status", response.status === c.status);
      check(
        c.name + ":fixed_body",
        text === JSON.stringify({ schemaVersion: 1, outcome: c.outcome }),
      );
      check(c.name + ":zero_cookie", response.headers.getSetCookie().length === 0);
      check(
        c.name + ":no_redirect_or_CORS",
        !response.headers.has("location") && !response.headers.has("access-control-allow-origin"),
      );
      check(
        c.name + ":no_private_values",
        ![first, second, "SYNTHETIC_PRIVATE_FAULT", "private-invalid-audit"].some((value) =>
          text.includes(value),
        ),
      );
      if (c.zeroSql)
        check(
          c.name + ":zero_SQL",
          fixture.metrics.connections === 0 && fixture.metrics.invocationCount === 0,
        );
      if (c.effects !== undefined)
        check(c.name + ":effect_count", fixture.metrics.effects === c.effects);
      if (c.fault === "throw" && c.stage !== "release") {
        const sql = fixture.calls.filter((call) => call.stage !== "release");
        check(c.name + ":no_following_SQL", sql.at(-1)?.stage === c.stage);
      }
      if (!c.zeroSql && c.mode !== "lateConnection")
        check(
          c.name + ":separate_disposal_counts",
          fixture.metrics.releaseAttempts ===
            fixture.metrics.releaseCompletions +
              (c.stage === "release" && c.fault === "throw" ? 1 : 0),
        );
      if (c.status === 200) {
        check(c.name + ":real_crypto_transcripts", Object.values(fixture.evidence).every(Boolean));
        check(
          c.name + ":fixed_security_headers",
          response.headers.get("cache-control") === "no-store" &&
            response.headers.get("referrer-policy") === "no-referrer" &&
            response.headers.get("x-content-type-options") === "nosniff",
        );
      }
      metrics.push({
        name: c.name,
        ...fixture.metrics,
        sinkInvocations,
        statements: fixture.calls.map((call) => call.stage),
      });
    }
    return Response.json({ checks, metrics });
  },
};
