import { createHash, generateKeyPairSync, sign } from "node:crypto";

// Independent native RSA oracle; no imports from either component's fixtures.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 65537,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "authentication-evidence-native-rsa",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
};
export const workosAuthenticationEvidenceEpoch = 1800000000000;
export const workosAuthenticationEvidenceId = (prefix, n) =>
  `${prefix}_${String(n).padStart(26, "0")}`;
export const workosAuthenticationEvidenceSha256 = (text) =>
  createHash("sha256").update(text).digest("hex");
export function buildWorkosAuthenticationEvidenceFixture(options = {}) {
  const at = workosAuthenticationEvidenceEpoch;
  const profile = {
    schemaVersion: 1,
    providerId: "workos",
    environmentId: workosAuthenticationEvidenceId("environment", 1),
    applicationId: workosAuthenticationEvidenceId("app", 2),
    clientId: workosAuthenticationEvidenceId("client", 3),
    issuer: `https://api.workos.com/user_management/${workosAuthenticationEvidenceId("client", 3)}`,
    revision: 1,
    audiencePolicy: "absent",
    ...options.profile,
  };
  const claims = {
    iss: profile.issuer,
    client_id: profile.clientId,
    sub: workosAuthenticationEvidenceId("user", 4),
    sid: workosAuthenticationEvidenceId("session", 5),
    iat: at / 1000 - 5,
    exp: at / 1000 + 120,
    ...options.claims,
  };
  const snapshot = {
    schemaVersion: 1,
    profileRevision: profile.revision,
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    observedAtMs: at - 1000,
    expiresAtMs: at + 299000,
    jwks: { keys: [publicJwk] },
    ...options.snapshot,
  };
  const signClaims = (changes = {}, header = {}) => {
    const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input =
      segment({ alg: "RS256", kid: publicJwk.kid, typ: "JWT", ...header }) +
      "." +
      segment({ ...claims, ...changes });
    return (
      input +
      "." +
      sign("RSA-SHA256", Buffer.from(input, "ascii"), privateKey).toString("base64url")
    );
  };
  const session = (changes = {}) => ({
    object: "session",
    id: claims.sid,
    user_id: claims.sub,
    status: "active",
    ended_at: null,
    created_at: new Date(at - 60000).toISOString(),
    updated_at: new Date(at - 1000).toISOString(),
    expires_at: new Date(at + 60000).toISOString(),
    ...changes,
  });
  const page = (rows = [session()], after = null, before = null) =>
    JSON.stringify({ object: "list", data: rows, list_metadata: { before, after } });
  const observationProfile = {
    schemaVersion: 1,
    providerId: "workos",
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    revision: profile.revision,
  };
  return {
    at,
    profile,
    claims,
    snapshot,
    profileJson: JSON.stringify(profile),
    snapshotJson: JSON.stringify(snapshot),
    observationProfileJson: JSON.stringify(observationProfile),
    sign: signClaims,
    token: signClaims(),
    session,
    page,
  };
}
