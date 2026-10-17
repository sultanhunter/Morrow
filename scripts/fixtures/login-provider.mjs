import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { parseWorkosSessionStatusJson } from "../../packages/identity/src/workos-session-status-json.ts";

// Independent native RSA/S256 oracle; no imports from the login controller,
// verifier, reader, workspace selector, issuer or their success calculations.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 65537,
});
const jwk = Object.freeze({
  ...publicKey.export({ format: "jwk" }),
  kid: "login-https-native-rsa",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
});
const fail = () => Error("SYNTHETIC_LOGIN_PROVIDER_HELD");
const proof = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, "base64url").toString("base64url") === value;
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function createSyntheticLoginProvider({
  configurationJson,
  subjectId,
  providerSessionId,
  now = Date.now,
  hooks = {},
  session = {},
}) {
  const configuration = parseWorkosSessionStatusJson(configurationJson, 32768);
  const binding = parseWorkosSessionStatusJson(configuration.authenticationBindingJson, 8192);
  const profile = parseWorkosSessionStatusJson(configuration.verificationProfileJson, 8192);
  if (
    !/^user_[A-Z0-9]{26}$/.test(subjectId) ||
    !/^session_[A-Z0-9]{26}$/.test(providerSessionId) ||
    binding.clientId !== profile.clientId ||
    binding.environmentId !== profile.environmentId ||
    binding.applicationId !== profile.applicationId ||
    typeof now !== "function"
  )
    throw fail();
  const flows = new Map(),
    secrets = [],
    metrics = { exchange: 0, publicKeyset: 0, sessionPage: 0 };
  let selected = null;
  const check = (control) => {
    const at = now();
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !control ||
      control.signal?.aborted ||
      !Number.isSafeInteger(control.deadlineMs) ||
      at >= control.deadlineMs
    )
      throw fail();
    return at;
  };
  const before = async (name, control) => {
    check(control);
    if (hooks[name]) await hooks[name](control);
    return check(control);
  };
  const port = Object.freeze({
    async exchange(value, control) {
      metrics.exchange++;
      check(control);
      const row = parseWorkosSessionStatusJson(value, 32768);
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(",") !==
          "admissionId,clientId,code,redirectUri,schemaVersion,verifier" ||
        row.schemaVersion !== 1 ||
        !uuid(row.admissionId) ||
        row.clientId !== binding.clientId ||
        row.redirectUri !== binding.redirectUri ||
        typeof row.code !== "string" ||
        !proof(row.verifier)
      )
        throw fail();
      const flow = flows.get(row.code);
      if (!flow || flow.used) throw fail();
      flow.used = true;
      if (createHash("sha256").update(row.verifier, "ascii").digest("base64url") !== flow.challenge)
        throw fail();
      secrets.push(row.code, row.verifier);
      const at = await before("exchange", control);
      const claims = {
        iss: profile.issuer,
        client_id: profile.clientId,
        sub: subjectId,
        sid: providerSessionId,
        iat: Math.floor(at / 1000) - 1,
        exp: Math.floor(at / 1000) + 120,
      };
      const input = b64({ alg: "RS256", kid: jwk.kid, typ: "JWT" }) + "." + b64(claims);
      const accessToken =
        input +
        "." +
        sign("RSA-SHA256", Buffer.from(input, "ascii"), privateKey).toString("base64url");
      const snapshot = {
        schemaVersion: 1,
        profileRevision: profile.revision,
        environmentId: profile.environmentId,
        applicationId: profile.applicationId,
        clientId: profile.clientId,
        observedAtMs: at - 1,
        expiresAtMs: at + 299000,
        jwks: { keys: [jwk] },
      };
      selected = { at, snapshot };
      secrets.push(accessToken);
      return JSON.stringify({ schemaVersion: 1, accessToken });
    },
    async readPublicKeyset(control) {
      metrics.publicKeyset++;
      await before("publicKeyset", control);
      if (!selected) throw fail();
      return JSON.stringify(selected.snapshot);
    },
    async readSessionPage(selectorJson, control) {
      metrics.sessionPage++;
      await before("sessionPage", control);
      if (!selected) throw fail();
      const query = parseWorkosSessionStatusJson(selectorJson, 2048);
      if (
        !query ||
        typeof query !== "object" ||
        Array.isArray(query) ||
        Object.keys(query).sort().join(",") !== "after,limit,order,schemaVersion,subjectId" ||
        query.schemaVersion !== 1 ||
        query.subjectId !== subjectId ||
        query.after !== null ||
        query.limit !== 100 ||
        query.order !== "asc"
      )
        throw fail();
      return JSON.stringify({
        object: "list",
        data: [
          {
            object: "session",
            id: providerSessionId,
            user_id: subjectId,
            status: "active",
            auth_method: "oauth",
            ended_at: null,
            created_at: new Date(selected.at - 60000).toISOString(),
            updated_at: new Date(selected.at - 1000).toISOString(),
            expires_at: new Date(selected.at + 60000).toISOString(),
            ...session,
          },
        ],
        list_metadata: { before: null, after: null },
      });
    },
  });
  return Object.freeze({
    port,
    metrics,
    secrets,
    arm(authorizationUrl) {
      if (typeof authorizationUrl !== "string") throw fail();
      const url = new URL(authorizationUrl);
      const names = [...url.searchParams.keys()];
      if (
        url.origin + url.pathname !== "https://api.workos.com/user_management/authorize" ||
        url.hash ||
        url.username ||
        url.password ||
        names.length !== 7 ||
        new Set(names).size !== 7 ||
        names.slice().sort().join(",") !==
          "client_id,code_challenge,code_challenge_method,provider,redirect_uri,response_type,state" ||
        url.searchParams.get("client_id") !== binding.clientId ||
        url.searchParams.get("redirect_uri") !== binding.redirectUri ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("provider") !== "authkit" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !proof(url.searchParams.get("state")) ||
        !proof(url.searchParams.get("code_challenge"))
      )
        throw fail();
      const code = "synthetic_opaque_code_" + randomBytes(24).toString("base64url");
      flows.set(code, { challenge: url.searchParams.get("code_challenge"), used: false });
      const callback = new URL(binding.redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state"));
      secrets.push(code, url.searchParams.get("state"), authorizationUrl);
      return Object.freeze({ callbackUrl: callback.href, code });
    },
  });
}
