import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (p) => readFileSync(p, "utf8");
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const migration = read("migrations/0008.browser-session-admission.sql");
const manifest = JSON.parse(read("migrations/manifest.json"));

test("browser admission appends migration8 without rewriting the seven published migrations", () => {
  const previous = JSON.parse(
    read("docs/history/workos-authentication-operator-80/migrations/manifest.json"),
  );
  assert.equal(manifest.migrations.length, 8);
  assert.deepEqual(manifest.migrations.slice(0, 7), previous.migrations);
  for (const entry of manifest.migrations)
    assert.equal(hash("migrations/" + entry.file), entry.sha256);
  assert.equal(manifest.migrations[7].sequence, 8);
  assert.equal(manifest.migrations[7].file, "0008.browser-session-admission.sql");
  assert.equal(manifest.migrations[7].reviewRef, "docs/evidence/P05.T01m/review.json");
  assert.match(migration, /^BEGIN;[\s\S]+COMMIT;\s*$/);
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP)\s+TABLE\s+morrow_identity\.sessions\b/i);
});

test("admission preserves the qualified evidence and nonauthorizing selection boundaries", () => {
  const protectedModules = {
    "workos-session-token.ts": "198228864379483a4bdcd7fbba5982c429a20def7f189f66b2f1c8efb9ce7966",
    "workos-session-status-json.ts":
      "9b18639cca3a0ff7d2743171f1afbc605801b0b272622dccb934f4775ead48cb",
    "workos-session-status.ts": "babe11c985ed80ce0f64e0f4a7042c440f1c60c78483db6d70aeb835d145564e",
    "workos-authentication-evidence.ts":
      "5c83d68b63474f85e6121bbbb55540280e742c66022fa9c481e37305a0568b90",
    "workos-workspace-selection.ts":
      "22f99e2a8c260996d60bbe0daf7694a2f2ec844e1ba718812b3bae0ed7f6d77e",
  };
  for (const [file, digest] of Object.entries(protectedModules))
    assert.equal(hash("packages/identity/src/" + file), digest);
});

// These writers carry independently qualified receipt/grant/proof fences.
// Their deliberate session integration must preserve all other source bytes;
// actual PostgreSQL tests separately exercise the replacement behavior.
test("migration8 retains every non-session revocation and linking guard", () => {
  const body = (text, name) => {
    const match = text.match(
      new RegExp(
        "CREATE (?:OR REPLACE )?FUNCTION morrow_identity\\." + name + "\\([\\s\\S]*?END \\$\\$;",
      ),
    );
    assert.ok(match, "qualified writer must remain present");
    return match[0];
  };
  const revoke = body(
    read("migrations/0004.workspace-access-revocation.sql"),
    "revoke_workspace_access",
  )
    .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
    .replace(
      "  PERFORM 1 FROM morrow_identity.principals WHERE id=receipt.actor_principal_id FOR UPDATE;\n  PERFORM 1 FROM morrow_identity.sessions WHERE session_digest=receipt.actor_session_digest FOR UPDATE;",
      "  PERFORM morrow_identity.lock_session_eligibility(receipt.actor_session_digest,receipt.workspace_id::text,receipt.actor_principal_id::text,receipt.organization_id::text);\n  PERFORM 1 FROM morrow_identity.principals WHERE id=receipt.actor_principal_id FOR UPDATE;",
    )
    .replace(
      "    JOIN morrow_identity.sessions s ON s.principal_id=p.id AND s.organization_id=receipt.organization_id AND s.session_digest=receipt.actor_session_digest\n    WHERE p.id=receipt.actor_principal_id AND p.active AND p.kind='human' AND s.revoked_at IS NULL AND s.expires_at>now_at);",
      "    JOIN morrow_identity.session_eligibility(receipt.actor_session_digest,receipt.workspace_id::text) s ON s.principal_id=p.id::text AND s.organization_id=receipt.organization_id::text AND s.membership_id=receipt.actor_membership_id::text\n    WHERE p.id=receipt.actor_principal_id AND p.active AND p.kind='human');",
    );
  assert.equal(body(migration, "revoke_workspace_access"), revoke);
  const link = body(read("migrations/0005.workspace-store-linking.sql"), "link_workspace_store")
    .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
    .replace(
      " PERFORM 1 FROM morrow_identity.principals WHERE id=h.actor_principal_id FOR UPDATE;\n PERFORM 1 FROM morrow_identity.sessions WHERE session_digest=h.session_digest FOR UPDATE;",
      " PERFORM morrow_identity.lock_session_eligibility(h.session_digest,h.workspace_id::text,h.actor_principal_id::text,h.organization_id::text);\n PERFORM 1 FROM morrow_identity.principals WHERE id=h.actor_principal_id FOR UPDATE;",
    )
    .replace(
      "   JOIN morrow_identity.sessions s ON s.session_digest=h.session_digest AND s.principal_id=p.id AND s.organization_id=o.id AND s.revoked_at IS NULL AND s.expires_at>at_time",
      "   JOIN morrow_identity.session_eligibility(h.session_digest,h.workspace_id::text) s ON s.principal_id=p.id::text AND s.organization_id=o.id::text AND s.membership_id=h.actor_membership_id::text",
    );
  assert.equal(body(migration, "link_workspace_store"), link);
});
