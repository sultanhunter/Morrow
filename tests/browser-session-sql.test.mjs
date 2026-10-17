import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (p) => readFileSync(p, "utf8");
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const migration = read("migrations/0008.browser-session-admission.sql");
const manifest = JSON.parse(read("migrations/manifest.json"));

// Published-migration immutability is pinned in tests/migration-history.test.mjs.
test("browser admission is migration8 inside one transaction without session table rewrites", () => {
  for (const entry of manifest.migrations)
    assert.equal(hash("migrations/" + entry.file), entry.sha256);
  assert.equal(manifest.migrations[7].sequence, 8);
  assert.equal(manifest.migrations[7].file, "0008.browser-session-admission.sql");
  assert.match(migration, /^BEGIN;[\s\S]+COMMIT;\s*$/);
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP)\s+TABLE\s+morrow_identity\.sessions\b/i);
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
