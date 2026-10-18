import { createWorkersFixedWorkosLoginPort } from "../../packages/identity/src/fixed-workos-login-port.js";
import { createStandaloneLoginBridge } from "../../packages/identity/src/standalone-login.js";
import { createStandaloneLoginFixture } from "./standalone-login-fixture.js";

type Scenario = {
  name: string;
  method: "exchange" | "keyset" | "page" | "chain" | "concurrent" | "construct";
  fault?: string;
  configurationJson: string;
  profile: Record<string, unknown>;
  profileJson: string;
  at: number;
  subjectId: string;
  verifier: string;
};
type State = Awaited<ReturnType<typeof initialize>>;
let pending: State | undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function initialize(input: Scenario) {
  const configuration = JSON.parse(input.configurationJson);
  const binding = JSON.parse(configuration.authenticationBindingJson);
  const profile = input.profile;
  const namespaceJson = JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    purpose: "list_active_sessions",
  });
  const wall = Date.now();
  let offset = 0;
  const now = () => input.at + Date.now() - wall + offset;
  const checks: { name: string; passed: boolean }[] = [];
  const expect = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) throw Error("PLATFORM_FIXTURE_REJECTED");
  };
  const metrics = {
    borrows: 0,
    releaseAttempts: 0,
    releaseCompletions: 0,
    timelyReleaseCompletions: 0,
    lateReleaseCompletions: 0,
    activeLeases: 0,
    sqlCalls: 0,
    sqlReleases: 0,
    admittedFamilies: 0,
  };
  const broker = {
    async borrow(selector: string, control: { deadlineMs: number; signal: AbortSignal }) {
      expect("fixed_broker_namespace_" + metrics.borrows, selector === namespaceJson);
      expect(
        "live_original_borrow_control_" + metrics.borrows,
        !control.signal.aborted && control.deadlineMs > now(),
      );
      metrics.borrows++;
      metrics.activeLeases++;
      const revocation = new AbortController();
      let released = false;
      if (input.fault === "revoked_lease") revocation.abort();
      const lease = {
        namespaceJson: input.fault === "wrong_namespace" ? namespaceJson + " " : namespaceJson,
        credential: "platform_management_marker_87_only",
        expiresAtMs: input.fault === "expired_lease" ? now() : now() + 60000,
        revocationSignal: revocation.signal,
        async release(releaseControl: { deadlineMs: number; signal: AbortSignal }) {
          metrics.releaseAttempts++;
          expect("once_latched_release_" + metrics.releaseAttempts, !released);
          released = true;
          expect(
            "bounded_release_control_" + metrics.releaseAttempts,
            releaseControl.deadlineMs > now() && !releaseControl.signal.aborted,
          );
          if (input.fault === "release_reject") throw Error("SYNTHETIC_RELEASE_REJECTED");
          if (input.fault === "release_pending") return new Promise<void>(() => {});
          metrics.releaseCompletions++;
          metrics.activeLeases--;
          if (releaseControl.deadlineMs > now() && !releaseControl.signal.aborted)
            metrics.timelyReleaseCompletions++;
          else metrics.lateReleaseCompletions++;
        },
      };
      if (input.fault === "late_lease") await sleep(80);
      return lease;
    },
  };
  const dependencies = {
    configurationJson: input.configurationJson,
    sessionCredentialBroker: broker,
    now,
  };
  let port: Awaited<ReturnType<typeof createWorkersFixedWorkosLoginPort>> | undefined;
  let constructorHeld = false;
  try {
    const extras =
      input.fault === "extra_fetch"
        ? {
            fetch: () => {
              throw Error("MUST_NOT_CALL");
            },
          }
        : input.fault === "extra_redirect"
          ? { redirect: "follow" }
          : input.fault === "extra_url"
            ? { url: "https://foreign.invalid" }
            : {};
    port = await createWorkersFixedWorkosLoginPort({ ...dependencies, ...extras });
    expect(
      "frozen_three_method_port",
      Object.isFrozen(port) &&
        Object.keys(port).sort().join(",") === "exchange,readPublicKeyset,readSessionPage",
    );
  } catch (error) {
    constructorHeld = true;
    expect("fixed_constructor_error", (error as Error).message === "WORKOS_LOGIN_PORT_HELD");
  }
  expect("constructor_zero_borrow", metrics.borrows === 0);
  const bridges: {
    bridge: Awaited<ReturnType<typeof createStandaloneLoginBridge>>;
    fixture: ReturnType<typeof createStandaloneLoginFixture>;
    cookie: string;
  }[] = [];
  const authorizationUrls: string[] = [];
  if (port && (input.method === "chain" || input.method === "concurrent")) {
    for (let i = 0; i < (input.method === "concurrent" ? 2 : 1); i++) {
      const fixture = createStandaloneLoginFixture({
        at: input.at,
        profile: input.profile,
        profileJson: input.profileJson,
        snapshotJson: "{}",
        token: "unused_fixture_token",
        page: "{}",
      });
      const bridge = await createStandaloneLoginBridge({
        ...fixture,
        configurationJson: input.configurationJson,
        now,
        providerPort: port,
      });
      const start = await bridge.fetch(
        new Request(configuration.origin + "/auth/login", {
          method: "POST",
          headers: {
            Origin: configuration.origin,
            "Content-Type": "application/json",
            "X-Morrow-Request": "1",
          },
          body: '{"schemaVersion":2}',
        }),
      );
      expect(
        "real84_start_" + i,
        start.status === 200 && start.headers.getSetCookie().length === 1,
      );
      authorizationUrls.push(
        ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
      );
      bridges.push({ bridge, fixture, cookie: start.headers.getSetCookie()[0]!.split(";")[0]! });
    }
  }
  return {
    input,
    binding,
    port,
    constructorHeld,
    metrics,
    checks,
    expect,
    authorizationUrls,
    bridges,
    now,
    advance: (amount: number) => {
      offset += amount;
    },
  };
}

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === "/characterize") {
      const input = (await request.json()) as { clientId: string; unsupportedError?: boolean };
      if (!/^client_[A-Z0-9]{26}$/.test(input.clientId)) return new Response(null, { status: 400 });
      const url = "https://api.workos.com/sso/jwks/" + input.clientId;
      const captured = globalThis.fetch.bind(globalThis);
      try {
        const response = await captured(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: input.unsupportedError ? "error" : "manual",
          credentials: "omit",
          cache: "no-store",
          referrer: "",
          referrerPolicy: "no-referrer",
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        return Response.json({
          rejected: false,
          expectedUrl: response.url === url,
          redirected: response.redirected,
          status: response.status,
          jsonMedia: response.headers.get("content-type") === "application/json",
          gzip: response.headers.get("content-encoding") === "gzip",
          lengthPresent: response.headers.has("content-length"),
          decodedBytes: bytes.length,
          jsonBody: new TextDecoder().decode(bytes).startsWith('{"keys":'),
        });
      } catch {
        return Response.json({ rejected: true });
      }
    }
    if (path === "/initialize") {
      pending = await initialize((await request.json()) as Scenario);
      return Response.json({
        constructorHeld: pending.constructorHeld,
        checks: pending.checks,
        authorizationUrls: pending.authorizationUrls,
        borrows: pending.metrics.borrows,
      });
    }
    if (path !== "/run" || !pending) return new Response(null, { status: 404 });
    const state = pending;
    pending = undefined;
    const { input, port, metrics, expect } = state;
    // Native I/O controls belong to this invocation's request context. Keep the
    // captured port across requests, but never retain an old request's signal.
    const abort = new AbortController();
    const supplied = (await request.json()) as { code?: string; callbackUrls?: string[] };
    let held = state.constructorHeld,
      output = "",
      timer: ReturnType<typeof setTimeout> | undefined;
    const short = ["deadline", "stream_late", "release_pending"].includes(input.fault ?? "");
    const control = { deadlineMs: state.now() + (short ? 40 : 10000), signal: abort.signal };
    if (input.fault === "expired_control") control.deadlineMs = state.now();
    if (input.fault === "aborted_control") abort.abort();
    if (["abort", "late_lease"].includes(input.fault ?? ""))
      timer = setTimeout(() => abort.abort(), 10);
    if (input.fault === "clock") timer = setTimeout(() => state.advance(-10001), 10);
    try {
      if (!port) throw Error("WORKOS_LOGIN_PORT_HELD");
      if (input.method === "exchange") {
        output = await port.exchange(
          JSON.stringify({
            schemaVersion: 1,
            admissionId: "03d0144a-f65e-4a7f-a7d5-b9b6783440c2",
            code: supplied.code,
            verifier: input.verifier,
            clientId: input.profile.clientId,
            redirectUri: state.binding.redirectUri,
          }),
          control,
        );
        expect(
          "token_only_projection",
          Object.keys(JSON.parse(output)).sort().join(",") === "accessToken,schemaVersion",
        );
      } else if (input.method === "keyset") {
        output = await port.readPublicKeyset(control);
        const snapshot = JSON.parse(output);
        expect(
          "bound_public_snapshot",
          snapshot.clientId === input.profile.clientId &&
            snapshot.environmentId === input.profile.environmentId &&
            snapshot.expiresAtMs === snapshot.observedAtMs + 300000 &&
            snapshot.jwks.keys.length === 1,
        );
      } else if (input.method === "page") {
        const page = await port.readSessionPage(
          JSON.stringify({
            schemaVersion: 1,
            subjectId: input.subjectId,
            after: null,
            limit: 100,
            order: "asc",
          }),
          control,
        );
        expect("primitive_page", typeof page === "string");
        output = page as string;
        expect(
          "released_before_page",
          metrics.releaseAttempts === 1 &&
            metrics.timelyReleaseCompletions === 1 &&
            metrics.activeLeases === 0 &&
            typeof output === "string",
        );
      } else if (input.method === "chain" || input.method === "concurrent") {
        expect(
          "callbacks_registered_by_host",
          supplied.callbackUrls?.length === state.bridges.length,
        );
        await Promise.all(
          state.bridges.map(async ({ bridge, fixture, cookie }, i) => {
            const result = await bridge.fetch(
              new Request(supplied.callbackUrls![i]!, { headers: { Cookie: cookie } }),
            );
            expect(
              "unchanged84_owning_chain_cookie_" + i,
              result.status === 303 &&
                result.headers.get("location") === "/" &&
                result.headers.getSetCookie().length === 1,
            );
            expect(
              "unchanged_M_admission_" + i,
              fixture.calls.some(
                (call) => call.role === "sessions" && call.stage === "admitAccount",
              ),
            );
            metrics.admittedFamilies++;
            metrics.sqlCalls += fixture.calls.length;
            metrics.sqlReleases += fixture.releases.filter((release) => release.completed).length;
          }),
        );
      }
    } catch (error) {
      held = true;
      expect(
        "fixed_held_error",
        ["WORKOS_LOGIN_PORT_HELD", "PLATFORM_FIXTURE_REJECTED"].includes((error as Error).message),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Let attributable synthetic late broker/service work finish. This does not
    // change the completed operation's deadline or restore its held output.
    if (["late_lease", "abort", "clock", "deadline", "stream_late"].includes(input.fault ?? ""))
      await sleep(150);
    return Response.json({
      held,
      checks: state.checks,
      metrics,
      outputReturned: !held && input.method !== "construct",
      cleanupState:
        metrics.borrows === 0
          ? "not_acquired"
          : metrics.activeLeases === 0 && metrics.releaseAttempts === metrics.releaseCompletions
            ? "acknowledged"
            : "unverified",
    });
  },
};
