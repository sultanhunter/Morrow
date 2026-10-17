import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { writeArtifact } from "./artifacts.mjs";

// Independent native RSA signer/oracle; only synthetic tokens reach local workerd.
const now = Date.UTC(2026, 9, 15, 12, 0, 0);
const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
const first = pair(),
  second = pair();
const key = {
  ...first.publicKey.export({ format: "jwk" }),
  kid: "synthetic-first",
  alg: "RS256",
  use: "sig",
};
const nextKey = {
  ...second.publicKey.export({ format: "jwk" }),
  kid: "synthetic-next",
  alg: "RS256",
  use: "sig",
};
const evenModulus = Buffer.from(key.n, "base64url");
evenModulus[evenModulus.length - 1] &= 0xfe;
const evenKey = { ...key, n: evenModulus.toString("base64url") };
const profile = {
  schemaVersion: 1,
  providerId: "workos",
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  issuer: "https://api.workos.com/user_management/client_" + "C".repeat(26),
  revision: 1,
  audiencePolicy: "absent",
};
const snapshot = {
  schemaVersion: 1,
  profileRevision: 1,
  environmentId: profile.environmentId,
  applicationId: profile.applicationId,
  clientId: profile.clientId,
  observedAtMs: now - 1000,
  expiresAtMs: now + 299000,
  jwks: { keys: [key] },
};
const claims = {
  iss: profile.issuer,
  client_id: profile.clientId,
  sub: "user_" + "D".repeat(26),
  sid: "session_" + "E".repeat(26),
  iat: now / 1000 - 10,
  exp: now / 1000 + 120,
};
const header = { alg: "RS256", kid: key.kid, typ: "JWT" };
const b64 = (value) => Buffer.from(value).toString("base64url");
function rawToken(headerText, payloadText, privateKey = first.privateKey) {
  const input = b64(headerText) + "." + b64(payloadText);
  const signature = sign("RSA-SHA256", Buffer.from(input), privateKey);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(input),
      privateKey === first.privateKey ? first.publicKey : second.publicKey,
      signature,
    ),
    true,
  );
  return input + "." + signature.toString("base64url");
}
const token = (change = {}, headers = {}) =>
  rawToken(JSON.stringify({ ...header, ...headers }), JSON.stringify({ ...claims, ...change }));
const cases = [];
const add = (name, value, expected = false, options = {}) =>
  cases.push({
    name,
    token: value,
    expected,
    now,
    profileJson: JSON.stringify(profile),
    snapshotJson: JSON.stringify(snapshot),
    ...options,
  });
add("exact_signed_default_session", token(), true, { later: claims.exp * 1000 });
add(
  "signed_optional_metadata_confers_no_local_grants",
  token({
    org_id: "org_" + "F".repeat(26),
    roles: ["admin"],
    permissions: ["all"],
    email: "synthetic@example.test",
  }),
  true,
);
add("wrong_signature", rawToken(JSON.stringify(header), JSON.stringify(claims), second.privateKey));
add("wrong_issuer", token({ iss: "https://api.workos.com" }));
add("issuer_slash_alias", token({ iss: profile.issuer + "/" }));
add("wrong_client", token({ client_id: "client_" + "Z".repeat(26) }));
add(
  "missing_client",
  rawToken(
    JSON.stringify(header),
    JSON.stringify(Object.fromEntries(Object.entries(claims).filter(([k]) => k !== "client_id"))),
  ),
);
add("unexpected_audience", token({ aud: profile.clientId }));
add("unexpected_audience_array", token({ aud: [profile.clientId] }));
add("nonhuman_subject", token({ sub: "client_" + "D".repeat(26) }));
add("missing_session", token({ sid: null }));
add("impersonation", token({ act: { sub: "user_impersonator" } }));
add("expired_at_exact_boundary", token({ exp: now / 1000 }));
add("future_issued", token({ iat: now / 1000 + 31 }));
add("future_not_before", token({ nbf: now / 1000 + 31 }));
add("fractional_issued", token({ iat: now / 1000 - 0.5 }));
add("reversed_lifetime", token({ exp: claims.iat - 1 }));
add("excessive_lifetime", token({ exp: claims.iat + 3601 }));
add("unknown_kid", token({}, { kid: "unconfigured" }));
add("algorithm_none", token({}, { alg: "none" }));
add("algorithm_hmac", token({}, { alg: "HS256" }));
for (const [name, extra] of Object.entries({
  jku: "https://foreign.example.test/jwks",
  x5u: "https://foreign.example.test/cert",
  crit: ["custom"],
  b64: false,
}))
  add("header_" + name, token({}, { [name]: extra }));
add(
  "duplicate_header_key",
  rawToken('{"alg":"RS256","kid":"unconfigured","kid":"synthetic-first"}', JSON.stringify(claims)),
);
add(
  "duplicate_payload_key",
  rawToken(
    JSON.stringify(header),
    JSON.stringify(claims).slice(0, -1) + ',"client_id":"' + profile.clientId + '"}',
  ),
);
add("invalid_payload_utf8", rawToken(JSON.stringify(header), Buffer.from([0xff])));
add("noncanonical_segment", token().replace(".", "=."));
add("oversized_token", "A".repeat(16385));
add("untrusted_object_input", { verified: true, claims });
add("stale_snapshot", token(), false, {
  snapshotJson: JSON.stringify({ ...snapshot, expiresAtMs: now }),
});
add("excessive_snapshot_lease", token(), false, {
  snapshotJson: JSON.stringify({ ...snapshot, expiresAtMs: snapshot.observedAtMs + 300001 }),
});
add("profile_revision_drift", token(), false, {
  snapshotJson: JSON.stringify({ ...snapshot, profileRevision: 2 }),
});
for (const field of ["environmentId", "applicationId", "clientId"])
  add("snapshot_binding_" + field, token(), false, {
    snapshotJson: JSON.stringify({ ...snapshot, [field]: profile[field].slice(0, -1) + "Z" }),
  });
add("duplicate_key_ids", token(), false, {
  snapshotJson: JSON.stringify({ ...snapshot, jwks: { keys: [key, key] } }),
});
add("private_key_material", token(), false, {
  snapshotJson: JSON.stringify({
    ...snapshot,
    jwks: { keys: [{ ...key, d: "PRIVATE_SYNTHETIC" }] },
  }),
});
add("invalid_even_rsa_modulus", token(), false, {
  snapshotJson: JSON.stringify({ ...snapshot, jwks: { keys: [evenKey] } }),
});
add("unselected_invalid_rsa_key", token(), false, {
  snapshotJson: JSON.stringify({
    ...snapshot,
    jwks: { keys: [key, { ...evenKey, kid: "invalid-unselected" }] },
  }),
});
add("rotation_overlap_old", token(), true, {
  snapshotJson: JSON.stringify({ ...snapshot, jwks: { keys: [key, nextKey] } }),
});
add(
  "rotation_overlap_new",
  rawToken(
    JSON.stringify({ ...header, kid: nextKey.kid }),
    JSON.stringify(claims),
    second.privateKey,
  ),
  true,
  { snapshotJson: JSON.stringify({ ...snapshot, jwks: { keys: [key, nextKey] } }) },
);
add("removed_old_key", token(), false, {
  snapshotJson: JSON.stringify({ ...snapshot, jwks: { keys: [nextKey] } }),
});
add("expiry_during_async_work", token(), false, { clockSequence: [now, now + 500000] });
add("clock_regression", token(), false, { clockSequence: [now, now - 1] });
add("token_expiry_after_crypto_started", token(), false, {
  advanceDuringCrypto: claims.exp * 1000,
});
add("snapshot_expiry_after_crypto_started", token({ exp: now / 1000 + 1800 }), false, {
  advanceDuringCrypto: snapshot.expiresAtMs,
});

const bundle = await build({
  entryPoints: ["scripts/fixtures/workos-session-token-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  metafile: true,
});
assert.equal(
  Object.values(bundle.metafile.outputs).some((output) => output.imports.length),
  false,
);
let outbound = 0;
const runtime = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  log: new Log(LogLevel.ERROR),
  outboundService: () => {
    outbound++;
    return new Response(null, { status: 502 });
  },
});
try {
  const response = await runtime.dispatchFetch("http://morrow.local/synthetic-token-verifier", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cases }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.checks.length > cases.length);
  for (const check of result.checks) assert.equal(check.passed, true, check.name);
  assert.equal(outbound, 0);
  result.checks.push({ name: "zero_outbound_requests", passed: true });
  const paths = [
    "packages/identity/src/workos-session-token.ts",
    "packages/identity/package.json",
    "scripts/fixtures/workos-session-token-worker.ts",
    "scripts/workos-session-token-workers-lab.mjs",
    "package-lock.json",
  ];
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  writeArtifact(
    "labs/workos-session-token-workers.json",
    JSON.stringify(
      {
        task: "P05.T01f",
        observed_at: new Date().toISOString(),
        scope:
          "Actual pinned local workerd; independent native synthetic RSA signer; no real provider token, keyset, network, session, membership or grant",
        runtime: "miniflare4.20260730.0",
        compatibility_date: "2026-07-30",
        cases: cases.length,
        outbound_requests: outbound,
        bundle_sha256: sha(bundle.outputFiles[0].text),
        input_digests: Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))])),
        checks: result.checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `WorkOS session verifier: ${result.checks.length} actual local Workers checks passed; zero outbound requests.`,
  );
} finally {
  await runtime.dispose();
}
