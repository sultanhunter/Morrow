// Local workerd fixture only; no deployed route, provider or identity issuer.
import { createHash } from "node:crypto";
import {
  createAuthenticationExchangeAdmission,
  authenticationExchangeAdmissionSql as sql,
  authenticationExchangeCodeChallenge,
  AuthenticationExchangeAdmissionError,
} from "../../packages/identity/src/authentication-exchange-admission";

const binding = {
  bindingId: "binding_fixture",
  bindingRevision: 1,
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  redirectUri: "https://morrow.example/auth/callback",
  returnPath: "/work",
};
const commandId = "command_fixture",
  admissionId = "00000000-0000-4000-8000-000000000001";
const role = {
  role: "morrow_identity_preauth",
  login: "morrow_identity_preauth",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
};
function pool(
  options: {
    role?: Record<string, unknown>;
    row?: Record<string, unknown>;
    failAt?: string;
    releaseFails?: boolean;
    duplicateBegin?: boolean;
    releaseWait?: Promise<void>;
  } = {},
) {
  const queries: { text: string; values?: readonly string[] }[] = [];
  let connections = 0;
  return {
    queries,
    get connections() {
      return connections;
    },
    async connect() {
      connections++;
      return {
        async query(text: string, values?: readonly string[]) {
          queries.push(values ? { text, values } : { text });
          if (text === options.failAt) throw Error("PRIVATE_FIXTURE_ERROR");
          if (text === sql.role) return { rows: [options.role ?? role] };
          if (text === sql.create)
            return { rows: options.duplicateBegin ? [] : [{ challenge_id: values![0] }] };
          if (text === sql.admit || text === sql.reconcile)
            return {
              rows: [
                options.row ?? {
                  outcome: text === sql.reconcile ? "held" : "newly_reserved",
                  admission_id: admissionId,
                },
              ],
            };
          return { rows: [] };
        },
        async release() {
          if (options.releaseFails) throw Error("PRIVATE_FIXTURE_RELEASE");
          if (options.releaseWait) await options.releaseWait;
        },
      };
    },
  };
}
export default {
  async fetch(request: Request) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/authentication-exchange-admission"
    )
      return new Response(null, { status: 404 });
    const checks: { name: string; passed: boolean }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    const s = (p: ReturnType<typeof pool>) =>
      createAuthenticationExchangeAdmission(p, JSON.stringify(binding));
    const p = pool(),
      material = await s(p).begin(JSON.stringify({ commandId }));
    if (!material) throw Error("FIXTURE_INITIATION_MISSING");
    check(
      "independent_private_initiation",
      new Set([material.state, material.browserProof, material.verifier]).size === 3 &&
        [material.state, material.browserProof, material.verifier].every((value) =>
          /^[A-Za-z0-9_-]{43}$/.test(value),
        ),
    );
    check(
      "rfc7636_ascii_vector",
      authenticationExchangeCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") ===
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    check(
      "twelve_ordered_commitments_no_raw_proofs",
      p.queries.find((q) => q.text === sql.create)?.values?.length === 12 &&
        ![material.state, material.browserProof, material.verifier].some((secret) =>
          JSON.stringify(p.queries).includes(secret),
        ),
    );
    const input = {
      commandId,
      challengeId: material.challengeId,
      state: material.state,
      browserProof: material.browserProof,
      verifier: material.verifier,
      code: " exact e\u0301 😀\u0000 ",
    };
    const inputJson = JSON.stringify(input),
      a = pool(),
      result = await s(a).admit(inputJson);
    check(
      "admission_is_correlation_only",
      result.outcome === "newly_reserved" &&
        result.admissionId === admissionId &&
        Object.keys(result).sort().join(",") === "admissionId,commandId,outcome" &&
        Object.isFrozen(result),
    );
    check(
      "opaque_code_digest_exact",
      a.queries.find((q) => q.text === sql.admit)?.values?.at(-1) ===
        createHash("sha256").update(input.code, "utf8").digest("hex"),
    );
    check(
      "thirteen_ordered_commitments_no_raw_callback",
      a.queries.find((q) => q.text === sql.admit)?.values?.length === 13 &&
        ![input.code, input.state, input.browserProof, input.verifier].some((secret) =>
          JSON.stringify(a.queries).includes(secret),
        ),
    );
    const lookup = pool(),
      held = await s(lookup).reconcile(inputJson);
    check(
      "reconcile_read_only_no_new_admission",
      held.outcome === "held" &&
        lookup.queries[0]?.text === sql.beginReadOnly &&
        !lookup.queries.some((q) => q.text === sql.admit || q.text === sql.create),
    );
    check(
      "duplicate_begin_no_secret_disclosure",
      (await s(pool({ duplicateBegin: true })).begin(JSON.stringify({ commandId }))) === null,
    );
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw Error();
        },
        getPrototypeOf() {
          traps++;
          throw Error();
        },
        ownKeys() {
          traps++;
          throw Error();
        },
        getOwnPropertyDescriptor() {
          traps++;
          throw Error();
        },
      },
    );
    const accessor = {
      get commandId() {
        traps++;
        throw Error();
      },
    };
    for (const [name, value] of [
      ["proxy_zero_reflection", hostile],
      ["getter_zero_reflection", accessor],
      ["raw_object_denied", input],
      ["malformed_json_denied", "{bad"],
      ["malformed_utf16_denied", JSON.stringify({ ...input, code: "\ud800" })],
      ["oversized_code_denied", JSON.stringify({ ...input, code: "x".repeat(4097) })],
      ["caller_authority_denied", JSON.stringify({ ...input, authenticated: true })],
    ] as const) {
      const f = pool();
      let denied = false;
      try {
        await s(f).admit(value);
      } catch (error) {
        denied =
          error instanceof AuthenticationExchangeAdmissionError &&
          error.code === "AUTH_EXCHANGE_INPUT_INVALID";
      }
      check(name, denied && traps === 0 && f.connections === 0);
    }
    let badFactory = false;
    try {
      createAuthenticationExchangeAdmission(pool(), hostile);
    } catch (error) {
      badFactory =
        error instanceof AuthenticationExchangeAdmissionError &&
        error.code === "AUTH_EXCHANGE_INPUT_INVALID";
    }
    check("binding_proxy_zero_reflection", badFactory && traps === 0);
    for (const [name, options, method, expected] of [
      [
        "api_role_denied",
        { role: { ...role, role: "morrow_api" } },
        "admit",
        "AUTH_EXCHANGE_UNAVAILABLE",
      ],
      [
        "membership_denied",
        { role: { ...role, role_member: true } },
        "admit",
        "AUTH_EXCHANGE_UNAVAILABLE",
      ],
      [
        "reconcile_fresh_reply_denied",
        { row: { outcome: "newly_reserved", admission_id: admissionId } },
        "reconcile",
        "AUTH_EXCHANGE_UNAVAILABLE",
      ],
      [
        "null_new_reservation_denied",
        { row: { outcome: "newly_reserved", admission_id: null } },
        "admit",
        "AUTH_EXCHANGE_UNAVAILABLE",
      ],
      ["commit_loss_uncertain", { failAt: sql.commit }, "admit", "AUTH_EXCHANGE_UNCERTAIN"],
      ["release_loss_uncertain", { releaseFails: true }, "admit", "AUTH_EXCHANGE_UNCERTAIN"],
    ] as const) {
      const f = pool(options);
      let denied = false;
      try {
        await s(f)[method](inputJson);
      } catch (error) {
        denied =
          error instanceof AuthenticationExchangeAdmissionError &&
          error.code === expected &&
          error.commandId === commandId &&
          error.message === expected;
      }
      check(
        name,
        denied &&
          f.queries.filter((q) =>
            ([sql.create, sql.admit, sql.reconcile] as readonly string[]).includes(q.text),
          ).length <= 1,
      );
    }
    let unblock!: () => void;
    const releaseWait = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const waiting = pool({ releaseWait });
    let settled = false;
    const pending = s(waiting)
      .begin(JSON.stringify({ commandId }))
      .then((value) => {
        settled = true;
        return value;
      });
    // Allow the fixed async query sequence to reach its intentionally held release.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    check(
      "private_material_withheld_during_release",
      waiting.queries.at(-1)?.text === sql.commit && !settled,
    );
    unblock();
    await pending;
    let dynamicDenied = false;
    try {
      new Function("return 1")();
    } catch {
      dynamicDenied = true;
    }
    check("dynamic_code_generation_denied", dynamicDenied);
    return Response.json({ checks });
  },
};
