import { createSyntheticFixedWorkosLoginPort } from "../../packages/identity/src/fixed-workos-login-port.js";
import { createStandaloneLoginBridge } from "../../packages/identity/src/standalone-login.js";
import { createStandaloneLoginFixture } from "./standalone-login-fixture.js";

type Input = {
  at: number;
  configurationJson: string;
  profile: Record<string, unknown>;
  profileJson: string;
  token: string;
  publicJwk: Record<string, unknown>;
  claims: { sub: string; sid: string };
  page: string;
  verifier: string;
  challenge: string;
  cases: {
    name: string;
    method: "exchange" | "keyset" | "page" | "chain" | "concurrent";
    fault?: string;
    expected: "pass" | "held";
    zeroFetch?: boolean;
    zeroBorrow?: boolean;
  }[];
};
const encode = new TextEncoder();
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/synthetic-fixed-provider")
      return new Response(null, { status: 404 });
    const input = (await request.json()) as Input;
    const checks: { name: string; passed: boolean }[] = [];
    const metrics: Record<string, unknown>[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    const configuration = JSON.parse(input.configurationJson);
    const binding = JSON.parse(configuration.authenticationBindingJson);
    const namespace = JSON.stringify({
      schemaVersion: 1,
      providerId: "workos",
      environmentId: input.profile.environmentId,
      applicationId: input.profile.applicationId,
      clientId: input.profile.clientId,
      purpose: "list_active_sessions",
    });
    for (const c of input.cases) {
      let at = input.at,
        calls = 0,
        borrows = 0,
        releaseAttempts = 0,
        releaseCompletions = 0,
        bodyCancelAttempts = 0,
        bodyCancelCompletions = 0;
      const stages: string[] = [],
        markers: boolean[] = [],
        codes = new Map<string, string>();
      const abort = new AbortController(),
        revocation = new AbortController();
      const expect = (name: string, condition: boolean) => {
        check(c.name + ":" + name, condition);
        if (!condition) throw Error("SYNTHETIC_ORACLE_REJECTED");
      };
      const result = (
        url: string,
        text: string | Uint8Array<ArrayBuffer>,
        changes: {
          status?: number;
          headers?: Record<string, string>;
          redirected?: boolean;
          finalUrl?: string;
          tracked?: boolean;
          pending?: boolean;
          badChunk?: boolean;
        } = {},
      ) => {
        const body = changes.tracked
          ? new ReadableStream({
              start(controller) {
                if (!changes.pending) {
                  controller.enqueue(
                    changes.badChunk
                      ? ("invalid-chunk" as unknown as Uint8Array)
                      : typeof text === "string"
                        ? encode.encode(text)
                        : text,
                  );
                  controller.close();
                }
              },
              cancel() {
                bodyCancelAttempts++;
                if (c.fault === "cancel_reject")
                  return Promise.reject(Error("SYNTHETIC_CANCEL_REJECTED"));
                if (c.fault === "cancel_pending") return new Promise<void>(() => {});
                bodyCancelCompletions++;
              },
            })
          : text;
        const response = new Response(body, {
          status: changes.status ?? 200,
          headers: changes.headers ?? { "Content-Type": "application/json" },
        });
        Object.defineProperty(response, "url", { value: changes.finalUrl ?? url });
        if (changes.redirected) Object.defineProperty(response, "redirected", { value: true });
        return response;
      };
      const syntheticFetch: typeof fetch = async (source, init = {}) => {
        const requestIndex = calls++;
        const url = new URL(String(source)),
          headers = new Headers(init.headers);
        expect("fixed_origin_" + requestIndex, url.origin === "https://api.workos.com");
        expect(
          "fixed_options_" + requestIndex,
          init.redirect === "error" &&
            init.credentials === "omit" &&
            init.cache === "no-store" &&
            init.signal instanceof AbortSignal &&
            !init.signal.aborted,
        );
        expect(
          "no_cookie_or_referrer_" + requestIndex,
          !headers.has("cookie") &&
            !headers.has("referer") &&
            headers.get("accept") === "application/json",
        );
        let kind: string, text: string;
        if (url.pathname === "/user_management/authenticate") {
          kind = "exchange";
          expect(
            "post_exact_headers_" + requestIndex,
            init.method === "POST" &&
              [...headers.keys()].sort().join(",") === "accept,content-type" &&
              headers.get("content-type") === "application/json" &&
              !url.search,
          );
          const posted = JSON.parse(String(init.body));
          expect(
            "post_exact_four_fields_" + requestIndex,
            Object.keys(posted).sort().join(",") === "client_id,code,code_verifier,grant_type" &&
              posted.client_id === input.profile.clientId &&
              posted.grant_type === "authorization_code",
          );
          const digest = base64(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", encode.encode(posted.code_verifier)),
            ),
          );
          expect("independent_S256_" + requestIndex, digest === codes.get(posted.code));
          codes.delete(posted.code);
          text = JSON.stringify({
            access_token: input.token,
            refresh_token: "worker_dropped_refresh_marker",
            oauth_tokens: { secret: "worker_dropped_oauth_marker" },
          });
        } else if (url.pathname === `/sso/jwks/${input.profile.clientId}`) {
          kind = "keyset";
          expect(
            "anonymous_bound_jwks_" + requestIndex,
            init.method === "GET" &&
              [...headers.keys()].join(",") === "accept" &&
              init.body === undefined &&
              !url.search,
          );
          text = JSON.stringify({ keys: [input.publicJwk] });
        } else {
          kind = "page";
          expect(
            "exact_session_GET_" + requestIndex,
            init.method === "GET" &&
              url.pathname === `/user_management/users/${input.claims.sub}/sessions` &&
              url.search === "?limit=100&order=asc" &&
              init.body === undefined,
          );
          expect(
            "management_marker_only_here_" + requestIndex,
            [...headers.keys()].sort().join(",") === "accept,authorization" &&
              headers.get("authorization") === "Bearer worker_management_marker_86_only",
          );
          text = input.page;
        }
        stages.push(kind);
        markers.push(headers.has("authorization"));
        if (c.fault === "clock") at--;
        if (c.fault === "expiry") at += 10001;
        if (c.fault === "abort") abort.abort();
        if (c.fault === "revoke") revocation.abort();
        if (c.fault === "late_response") {
          abort.abort();
          await settle();
          return result(url.href, text, { tracked: true, pending: true });
        }
        if (c.fault === "status") return result(url.href, text, { status: 429 });
        if (c.fault === "redirect") return result(url.href, text, { status: 302 });
        if (c.fault === "redirected") return result(url.href, text, { redirected: true });
        if (c.fault === "foreign_url")
          return result(url.href, text, { finalUrl: "https://foreign.invalid/" });
        if (c.fault === "media")
          return result(url.href, text, {
            headers: { "Content-Type": "application/json; charset=utf-8; x=y" },
          });
        if (c.fault === "declared_size")
          return result(url.href, text, {
            headers: { "Content-Type": "application/json", "Content-Length": "131073" },
          });
        if (c.fault === "noncanonical_size")
          return result(url.href, text, {
            headers: { "Content-Type": "application/json", "Content-Length": "01" },
          });
        if (c.fault === "oversize") return result(url.href, " ".repeat(131073));
        if (c.fault === "bom") return result(url.href, "\uFEFF" + text);
        if (c.fault === "utf8") return result(url.href, new Uint8Array([255]));
        if (c.fault === "duplicate")
          return result(
            url.href,
            kind === "exchange"
              ? '{"access_token":"a.b.c","access_token":"d.e.f"}'
              : kind === "keyset"
                ? '{"keys":[],"keys":[]}'
                : '{"object":"list","object":"list"}',
          );
        if (c.fault === "private_jwk")
          return result(
            url.href,
            JSON.stringify({ keys: [{ ...input.publicJwk, d: "private-material" }] }),
          );
        if (c.fault === "certificate")
          return result(url.href, JSON.stringify({ keys: [{ ...input.publicJwk, x5c: ["%%%"] }] }));
        if (c.fault === "keys17")
          return result(
            url.href,
            JSON.stringify({
              keys: Array.from({ length: 17 }, (_, n) => ({ ...input.publicJwk, kid: "k" + n })),
            }),
          );
        if (c.fault === "cancel_reject" || c.fault === "cancel_pending")
          return result(url.href, text, {
            tracked: true,
            pending: true,
            finalUrl: "https://foreign.invalid/",
          });
        if (c.fault === "bad_chunk")
          return result(url.href, text, { tracked: true, badChunk: true });
        if (c.fault === "compressed")
          return result(url.href, text, {
            headers: {
              "Content-Type": "APPLICATION/JSON; CHARSET=UTF-8",
              "Content-Encoding": "gzip",
              "Content-Length": "1",
            },
          });
        if (c.fault === "certificate_valid")
          return result(
            url.href,
            JSON.stringify({
              keys: [{ ...input.publicJwk, x5c: ["AQID"], "x5t#S256": "A".repeat(43) }],
            }),
          );
        return result(url.href, text);
      };
      const broker = {
        async borrow(selectorJson: string, control: { deadlineMs: number; signal: AbortSignal }) {
          borrows++;
          expect(
            "fixed_broker_namespace",
            selectorJson === namespace && !control.signal.aborted && control.deadlineMs > at,
          );
          const lease = {
            namespaceJson: c.fault === "wrong_namespace" ? namespace + " " : namespace,
            credential: c.fault === "bad_credential" ? "short" : "worker_management_marker_86_only",
            expiresAtMs: c.fault === "expired_lease" ? at - 1 : at + 60000,
            revocationSignal: revocation.signal,
            async release(cleanup: { deadlineMs: number; signal: AbortSignal }) {
              releaseAttempts++;
              expect("release_latched_once", releaseAttempts === 1);
              expect(
                "release_control_bounded",
                cleanup.deadlineMs > at &&
                  cleanup.deadlineMs <= at + (abort.signal.aborted ? 1000 : 10000),
              );
              if (c.fault === "release_reject") throw Error("SYNTHETIC_RELEASE_REJECTED");
              if (c.fault === "release_pending") {
                abort.abort();
                return new Promise<void>(() => {});
              }
              releaseCompletions++;
            },
          };
          if (c.fault === "late_lease") {
            abort.abort();
            await settle();
          }
          if (c.fault === "revoked_lease") revocation.abort();
          return lease;
        },
      };
      let held = false,
        output = "",
        sqlCalls = 0,
        sqlReleased = 0;
      try {
        const cfg =
          c.fault === "config_extra"
            ? JSON.stringify({ ...configuration, fetch: "forbidden" })
            : input.configurationJson;
        const port = await createSyntheticFixedWorkosLoginPort({
          configurationJson: cfg,
          sessionCredentialBroker: broker,
          now: () => at,
          fetch: syntheticFetch,
        });
        expect(
          "closed_frozen_port",
          Object.isFrozen(port) &&
            Object.keys(port).sort().join(",") === "exchange,readPublicKeyset,readSessionPage",
        );
        const control = {
          deadlineMs: c.fault === "expired_control" ? at : at + 10000,
          signal: abort.signal,
        };
        if (c.fault === "aborted_control") abort.abort();
        const exchange = (code = "worker-code") => {
          codes.set(code, input.challenge);
          let exchangeInput = JSON.stringify({
            schemaVersion: 1,
            admissionId: "03d0144a-f65e-4a7f-a7d5-b9b6783440c2",
            code,
            verifier: input.verifier,
            clientId: input.profile.clientId,
            redirectUri: binding.redirectUri,
          });
          if (c.fault === "foreign_client")
            exchangeInput = exchangeInput.replace(
              String(input.profile.clientId),
              "client_00000000000000000000000009",
            );
          if (c.fault === "foreign_callback")
            exchangeInput = exchangeInput.replace(
              binding.redirectUri,
              "https://foreign.invalid/auth/workos/callback",
            );
          if (c.fault === "invalid_verifier")
            exchangeInput = exchangeInput.replace(input.verifier, input.verifier + "=");
          if (c.fault === "invalid_admission")
            exchangeInput = exchangeInput.replace(
              "03d0144a-f65e-4a7f-a7d5-b9b6783440c2",
              "not-a-uuid",
            );
          if (c.fault === "duplicate_input")
            exchangeInput = exchangeInput.replace(
              '"schemaVersion":1',
              '"schemaVersion":1,"schemaVersion":1',
            );
          return port.exchange(exchangeInput, control);
        };
        if (c.method === "exchange") output = await exchange();
        if (c.method === "keyset") output = await port.readPublicKeyset(control);
        if (c.method === "page") {
          const pageOutput = await port.readSessionPage(
            JSON.stringify({
              schemaVersion: 1,
              subjectId: c.fault === "invalid_subject" ? "foreign" : input.claims.sub,
              after: c.fault === "invalid_cursor" ? "foreign" : null,
              limit: 100,
              order: "asc",
            }),
            control,
          );
          expect("primitive_page_output", typeof pageOutput === "string");
          output = pageOutput as string;
        }
        if (c.method === "concurrent") {
          const results = await Promise.all([exchange("code-one"), exchange("code-two")]);
          output = results[0];
          expect(
            "independent_callback_results",
            results.every((value) => JSON.parse(value).accessToken === input.token) && calls === 2,
          );
        }
        if (c.method === "chain") {
          const fixture = createStandaloneLoginFixture({ ...input, snapshotJson: "{}" });
          const bridge = await createStandaloneLoginBridge({ ...fixture, providerPort: port });
          const start = await bridge.fetch(
            new Request(configuration.origin + "/auth/login", {
              method: "POST",
              headers: {
                Origin: configuration.origin,
                "Content-Type": "application/json",
                "X-Morrow-Request": "1",
              },
              body: '{"schemaVersion":1,"workspaceId":"workspace_a"}',
            }),
          );
          const authorization = new URL(
            ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
          );
          expect(
            "authorization_bound_client_callback_S256",
            authorization.searchParams.get("client_id") === input.profile.clientId &&
              authorization.searchParams.get("redirect_uri") === binding.redirectUri &&
              authorization.searchParams.get("code_challenge_method") === "S256",
          );
          codes.set("chain-code", authorization.searchParams.get("code_challenge")!);
          const callback =
            configuration.origin +
            "/auth/workos/callback?code=chain-code&state=" +
            authorization.searchParams.get("state");
          const response = await bridge.fetch(
            new Request(callback, {
              headers: { Cookie: start.headers.getSetCookie()[0]!.split(";")[0]! },
            }),
          );
          expect(
            "unchanged_owning_chain_cookie",
            response.status === 303 &&
              response.headers.get("location") === "/" &&
              response.headers.getSetCookie().length === 1,
          );
          expect("POST_JWKS_session_order", stages.join(",") === "exchange,keyset,page");
          sqlCalls = fixture.calls.length;
          sqlReleased = fixture.releases.filter((value) => value.completed).length;
          expect(
            "owning_M_reached",
            fixture.calls.some((value) => value.role === "sessions" && value.stage === "admit"),
          );
          output = "chain_success";
        }
      } catch (error) {
        held = true;
        check(
          c.name + ":fixed_error",
          (error as Error).message === "WORKOS_LOGIN_PORT_HELD" ||
            (error as Error).message === "SYNTHETIC_ORACLE_REJECTED",
        );
      }
      await settle();
      check(c.name + ":expected_outcome", held === (c.expected === "held"));
      if (c.zeroFetch) check(c.name + ":zero_fetch", calls === 0);
      if (c.zeroBorrow) check(c.name + ":zero_borrow", borrows === 0);
      check(
        c.name + ":no_automatic_retry",
        calls <= (c.method === "chain" ? 3 : c.method === "concurrent" ? 2 : 1),
      );
      check(
        c.name + ":marker_only_session_GET",
        markers.every((marker, i) => marker === (stages[i] === "page")),
      );
      if (!held && c.method === "exchange")
        check(
          c.name + ":token_only_projection",
          Object.keys(JSON.parse(output)).sort().join(",") === "accessToken,schemaVersion" &&
            JSON.parse(output).accessToken === input.token,
        );
      if (!held && c.method === "keyset") {
        const snapshot = JSON.parse(output);
        check(
          c.name + ":bound_snapshot",
          snapshot.clientId === input.profile.clientId &&
            snapshot.observedAtMs === at &&
            snapshot.expiresAtMs === at + 300000 &&
            Object.keys(snapshot.jwks.keys[0]).sort().join(",") ===
              Object.keys(input.publicJwk).sort().join(","),
        );
      }
      if (!held && c.method === "page")
        check(
          c.name + ":released_before_page",
          output === input.page && releaseAttempts === 1 && releaseCompletions === 1,
        );
      if (
        [
          "wrong_namespace",
          "bad_credential",
          "expired_lease",
          "revoked_lease",
          "late_lease",
        ].includes(c.fault ?? "")
      )
        check(
          c.name + ":rejected_lease_disposal",
          releaseAttempts === 1 && releaseCompletions === 1 && calls === 0,
        );
      if (c.fault === "release_reject" || c.fault === "release_pending")
        check(
          c.name + ":release_unverified_not_retried",
          releaseAttempts === 1 && releaseCompletions === 0,
        );
      if (c.fault === "late_response")
        check(
          c.name + ":late_body_disposal",
          bodyCancelAttempts === 1 && bodyCancelCompletions === 1,
        );
      if (c.fault === "cancel_reject" || c.fault === "cancel_pending")
        check(
          c.name + ":body_disposal_unverified",
          bodyCancelAttempts === 1 && bodyCancelCompletions === 0,
        );
      metrics.push({
        name: c.name,
        calls,
        borrows,
        releaseAttempts,
        releaseCompletions,
        bodyCancelAttempts,
        bodyCancelCompletions,
        stages,
        sqlCalls,
        sqlReleased,
      });
    }
    return Response.json({ checks, metrics });
  },
};
