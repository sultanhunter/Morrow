import { generateKeyPairSync, sign as rsaSign, createHash } from "node:crypto";

export const workosSessionTokenEpoch = 1792051200000;
const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
export function createWorkosSessionTokenSigningKey(
  kid = "synthetic-key-one",
  modulusLength = 2048,
) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
    publicExponent: 65537,
  });
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };
  const signRaw = (claimsText, headerText = JSON.stringify({ alg: "RS256", kid, typ: "JWT" })) => {
    const signingInput = encode(headerText) + "." + encode(claimsText);
    return (
      signingInput +
      "." +
      rsaSign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString("base64url")
    );
  };
  return { privateKey, publicKey, publicJwk, signRaw };
}
export function buildWorkosSessionTokenFixture(options = {}) {
  let now = options.now ?? workosSessionTokenEpoch;
  const clock = () => now;
  const key = options.key ?? createWorkosSessionTokenSigningKey();
  const profile = {
    schemaVersion: 1,
    providerId: "workos",
    environmentId: "environment_" + "A".repeat(26),
    applicationId: "app_" + "B".repeat(26),
    clientId: "client_" + "C".repeat(26),
    issuer: "https://api.workos.com/user_management/client_" + "C".repeat(26),
    revision: 1,
    audiencePolicy: "absent",
    ...options.profile,
  };
  const claims = {
    iss: profile.issuer,
    client_id: profile.clientId,
    sub: "user_" + "D".repeat(26),
    sid: "session_" + "E".repeat(26),
    iat: Math.floor(now / 1000) - 5,
    exp: Math.floor(now / 1000) + 120,
    ...options.claims,
  };
  const snapshot = {
    schemaVersion: 1,
    profileRevision: profile.revision,
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    observedAtMs: now - 1000,
    expiresAtMs: now + 299000,
    jwks: { keys: [key.publicJwk] },
    ...options.snapshot,
  };
  const sign = (claimOverrides = {}, headerOverrides = {}) =>
    key.signRaw(
      JSON.stringify({ ...claims, ...claimOverrides }),
      JSON.stringify({ alg: "RS256", kid: key.publicJwk.kid, typ: "JWT", ...headerOverrides }),
    );
  return {
    profile,
    snapshot,
    claims,
    profileJson: JSON.stringify(profile),
    snapshotJson: JSON.stringify(snapshot),
    clock,
    setNow(value) {
      now = value;
    },
    get now() {
      return now;
    },
    sign,
    signRaw: key.signRaw,
    privateKey: key.privateKey,
    publicKey: key.publicKey,
    publicJwk: key.publicJwk,
  };
}
export function workosSessionTokenSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
