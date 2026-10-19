import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  expectedReplacement,
  functionDefinition,
  sessionLifecycleReplacements,
} from "./fixtures/session-lifecycle-replacements.mjs";

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

// P05.T01y (migration 0016, ADR-0004): static checks. PostgreSQL behaviour is qualified
// by lab:session-lifecycle-sql.
const lifecycle = read("migrations/0016.browser-session-lifecycle.sql");
test("P05.T01y: 0016 is one owner transaction after 0015 that drops no function", () => {
  const entry = manifest.migrations.find((m) => m.file === "0016.browser-session-lifecycle.sql");
  assert.deepEqual(
    { sequence: entry.sequence, executeAs: entry.executeAs, reviewRef: entry.reviewRef },
    { sequence: 16, executeAs: "morrow_identity_owner", reviewRef: "docs/packets/P05.T01y.md" },
  );
  assert.equal(manifest.migrations[15], entry);
  assert.match(lifecycle, /^BEGIN;[\s\S]+COMMIT;\s*$/);
  assert.equal(lifecycle.match(/^BEGIN;$/gm).length, 1);
  assert.equal(lifecycle.match(/^COMMIT;$/gm).length, 1);
  assert.doesNotMatch(lifecycle, /\bDROP\s+(FUNCTION|TABLE|TRIGGER|POLICY|ROLE)\b/i);
  assert.doesNotMatch(
    lifecycle,
    /\bSET\s+(LOCAL\s+)?ROLE\b|\bSECURITY\s+INVOKER\b|\$[A-Za-z_]\w*\$/,
  );
  assert.doesNotMatch(lifecycle, /\bCREATE\s+ROLE\b|\bALTER\s+ROLE\b|\bGRANT\s+morrow_/i);
  assert.match(lifecycle, /RAISE EXCEPTION 'SESSION_LIFECYCLE_PREREQUISITES_INVALID'/);
  // The only dynamic SQL is the fixed privilege loop over named new functions.
  assert.equal(lifecycle.match(/\bEXECUTE format\(/g).length, 1);
  assert.match(
    lifecycle,
    /GRANT EXECUTE ON FUNCTION morrow_identity\.rotate_self_browser_generation\(text,text,text,text,text,text,text,text,text,text\) TO morrow_identity_logout;\nCOMMIT;\n$/,
  );
  assert.equal(lifecycle.match(/\bGRANT\b/g).length, 1);
});

test("P05.T01y: each replaced body differs from its predecessor only in the reviewed lines", () => {
  const replaced = [
    ...lifecycle.matchAll(/CREATE OR REPLACE FUNCTION morrow_identity\.(\w+)\(/g),
  ].map((m) => m[1]);
  assert.deepEqual(replaced.sort(), sessionLifecycleReplacements.map((e) => e.name).sort());
  for (const entry of sessionLifecycleReplacements)
    assert.equal(
      functionDefinition(lifecycle, entry.name),
      expectedReplacement(read, entry),
      entry.name,
    );
  // The old family-time predicate survives in no replaced or new body (15-minute literals
  // remain only where a legacy-shape family is recognised).
  const bodies = [...lifecycle.matchAll(/CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$;/g)].map((m) =>
    m[0].replace(/\s/g, ""),
  );
  for (const text of bodies)
    assert.doesNotMatch(
      text,
      /g\.created_at(=|<>)f\.created_at|g\.expires_at(=|<>)f\.expires_at|current_generation=1\b/,
    );
});

test("P05.T01y: every new function has a fixed search path; only rotation is a definer", () => {
  const created = [
    ...lifecycle.matchAll(/CREATE FUNCTION morrow_identity\.(\w+)\([\s\S]*?(?:AS \$\$)/g),
  ];
  assert.deepEqual(created.map((m) => m[1]).sort(), [
    "browser_generation_fits_family",
    "browser_new_lifetimes",
    "check_browser_generation_insert",
    "preserve_session_signout_record",
    "record_organization_session_signout",
    "rotate_self_browser_generation",
    "self_session_role_safe",
  ]);
  for (const [header, name] of created) {
    assert.match(header, /SET search_path=pg_catalog,morrow_identity,pg_temp AS \$\$$/, name);
    assert.equal(/SECURITY DEFINER/.test(header), name === "rotate_self_browser_generation", name);
  }
  // Lifetimes: 12-hour families, 30-minute generations, and the 1000-generation cap.
  assert.match(lifecycle, /SELECT p_instant\+interval '12 hours',p_instant\+interval '30 minutes'/);
  assert.match(
    lifecycle,
    /current_generation BETWEEN 1 AND 1000 AND expires_at=created_at\+interval '12 hours'/,
  );
  assert.match(lifecycle, /expires_at<=created_at\+interval '30 minutes'\);/);
  // The sign-out trigger locks the principal FOR SHARE before it takes the watermark, and
  // the watermark is never earlier than any existing family of the principal (a backward
  // wall-clock step cannot let a family committed before the removal escape it).
  const trigger = functionDefinition(lifecycle, "record_organization_session_signout");
  const watermark = "SELECT greatest(clock_timestamp(),max(f.created_at)) INTO instant";
  assert.ok(trigger.indexOf("WHERE id=OLD.principal_id FOR SHARE;") > 0);
  assert.ok(trigger.indexOf("WHERE id=OLD.principal_id FOR SHARE;") < trigger.indexOf(watermark));
  assert.match(trigger, /WHERE sm\.principal_id=OLD\.principal_id;/);
  assert.equal(trigger.match(/clock_timestamp\(\)/g).length, 1);
  assert.match(
    lifecycle,
    /CREATE TRIGGER membership_organization_signout AFTER UPDATE OF active,principal_id,organization_id OR DELETE ON morrow_identity\.memberships/,
  );
});
