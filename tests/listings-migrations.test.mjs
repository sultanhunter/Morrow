// M3 PR-1: static checks of this PR's migrations (located by slug, never by number: they
// are renumbered at the final rebase), their manifest rows, the runner contract, explicit
// per-function ACLs, the command-owned definers and the conformance registry. The
// behaviour is proved against PostgreSQL 17 by lab:listings-authority, lab:run-credits and
// lab:tenant-conformance.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import { loadMigrationChain } from "../scripts/migration-chain.mjs";
import {
  billingFunctions,
  billingTables,
  bridgeFunctions,
  executorLogins,
  identityTables,
  vaultFunctions,
  workFunctions,
  workTables,
} from "./tenant-conformance/registry.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const code = (text) => text.replace(/--.*$/gm, "");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const brief = "docs/briefs/M3-listings-agent.md";
// This branch's rows, in order: two branch-local stubs (deleted at rebase), then this PR's
// four migrations.
const slugs = [
  ["m2-store-installations-stub", "morrow_identity_owner", brief + "#branch-local-stubs"],
  ["m5-credit-wallets-stub", "morrow_work_owner", brief + "#branch-local-stubs"],
  ["listings-identity-bridge", "morrow_identity_owner", brief],
  ["listings-authority", "morrow_work_owner", brief],
  ["agent-proposals", "morrow_work_owner", brief],
  ["run-credits", "morrow_work_owner", brief],
];
const rowOf = (slug) => manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const textOf = (slug) => readFileSync("migrations/" + rowOf(slug).file, "utf8");
const texts = Object.fromEntries(slugs.map(([slug]) => [slug, textOf(slug)]));
const own = slugs.slice(2).map(([slug]) => slug);

test("manifest: contiguous rows after the published head, executeAs, digests, no prerequisites", () => {
  const rows = slugs.map(([slug]) => rowOf(slug));
  assert.ok(rows.every(Boolean));
  const first = rows[0].sequence;
  assert.deepEqual(
    rows.map((r) => r.sequence),
    rows.map((_, i) => first + i),
  );
  // Nothing of another milestone sits between them, and they end the chain in this branch.
  assert.equal(rows.at(-1).sequence, manifest.migrations.length);
  for (const [i, [slug, executeAs, reviewRef]] of slugs.entries()) {
    const row = rows[i];
    assert.equal(row.file, String(row.sequence).padStart(4, "0") + "." + slug + ".sql");
    assert.deepEqual([row.executeAs, row.reviewRef], [executeAs, reviewRef], slug);
    assert.equal(row.sha256, sha(texts[slug]), slug);
    assert.equal(row.prerequisites, undefined, slug);
  }
  // The stubs say what they are and that they are never merged.
  for (const [slug] of slugs.slice(0, 2))
    assert.match(texts[slug], /^BEGIN;\n-- BRANCH-LOCAL STUB, never merged/, slug);
  for (const slug of own) assert.doesNotMatch(texts[slug], /BRANCH-LOCAL STUB/, slug);
  // The one chain module the harness and every lab read applies them under those roles.
  const chain = loadMigrationChain();
  for (const row of rows)
    assert.equal(chain.find((e) => e.sequence === row.sequence).executeAs, row.executeAs);
});

test("the runner contract: one transaction, no role switch, no membership catalog, fixed paths", () => {
  for (const [slug, text] of Object.entries(texts)) {
    assert.deepEqual(migrationSqlViolations(text), [], slug);
    assert.equal(text.includes("pg_auth_" + "members"), false, slug);
    // Prerequisites assert objects and definitions with a fixed code, never a number.
    assert.match(text, /RAISE EXCEPTION '[A-Z_]+_PREREQUISITES_INVALID'/, slug);
    assert.doesNotMatch(code(text), /schema_migrations|migration_history|sequence\s*=/i, slug);
    // Every function header (up to its body) pins its search path.
    for (const m of text.matchAll(/CREATE (?:OR REPLACE )?FUNCTION /g)) {
      const rest = text.slice(m.index);
      const header = rest.slice(
        0,
        Math.min(...["$$", "BEGIN ATOMIC"].map((s) => rest.indexOf(s)).filter((i) => i > 0)),
      );
      assert.match(header, /SET search_path=pg_catalog/, slug + ": " + header.slice(0, 80));
    }
    assert.doesNotMatch(code(text), /\bEXECUTE\s+(?!format\(|FUNCTION\b|ON\b)/, slug);
    assert.doesNotMatch(
      code(text),
      /GRANT[^;]*\b(DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*ON/,
      slug,
    );
    assert.doesNotMatch(code(text), /TO PUBLIC/, slug);
    assert.doesNotMatch(code(text), /CREATE ROLE|ALTER ROLE|GRANT morrow_[a-z_]+ TO/, slug);
    assert.doesNotMatch(
      code(text),
      /BYPASSRLS|NO FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL/,
      slug,
    );
  }
});

test("every new function has an explicit PUBLIC revoke and only its registered grantees", () => {
  for (const [slug, text] of Object.entries(texts)) {
    const looped = new Set(
      [...text.matchAll(/p\.proname IN \(([^)]*)\)/g)].flatMap((m) =>
        [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
      ),
    );
    for (const [, schema, name] of text.matchAll(/CREATE FUNCTION ([a-z_]+)\.([a-z_]+)\(/g))
      assert.ok(
        looped.has(name) || new RegExp(`REVOKE ALL ON FUNCTION ${schema}\\.${name}\\(`).test(text),
        `${slug}: ${schema}.${name}`,
      );
  }
  // Each executor login executes exactly its registered definers, chain-wide.
  const chain = loadMigrationChain().map((e) => e.text);
  for (const [login, functions] of Object.entries(executorLogins)) {
    const granted = chain
      .flatMap((text) => [
        ...code(text).matchAll(/GRANT EXECUTE ON FUNCTION ([^;]*?) TO ([a-z_,]+);/g),
      ])
      .filter((m) => m[2].split(",").includes(login))
      .flatMap((m) => m[1].split(/,\s*(?=morrow_)/).map((f) => f.trim().replace(/\s+/g, "")));
    assert.deepEqual(granted.sort(), [...functions].sort(), login);
  }
  assert.ok(
    executorLogins.morrow_vault_broker.includes("morrow_vault.resolve_call(text,text,text,text)"),
  );
  assert.ok(
    executorLogins.morrow_runtime_executor.includes("morrow_work.delegation_facts(text,text,text)"),
  );
  // The api's agent definers, and nothing of this PR reaches the api login otherwise.
  const authority = code(texts["listings-authority"]);
  const apiGrant = authority.match(/GRANT EXECUTE ON FUNCTION ([^;]*?) TO morrow_work_api;/)[1];
  assert.deepEqual([...apiGrant.matchAll(/morrow_work\.([a-z_]+)\(/g)].map((m) => m[1]).sort(), [
    "agent_enable_document",
    "begin_agent_command",
    "cmd_listings_enable",
    "cmd_listings_enable_document",
    "cmd_model_default_revise",
    "cmd_stop_ai_work",
    "store_association",
  ]);
  for (const slug of own.filter((s) => s !== "listings-authority"))
    assert.doesNotMatch(code(texts[slug]), /GRANT EXECUTE[^;]*TO morrow_work_api;/, slug);
});

test("definers: command-owned and final in the work files; identity bridges for the command role only", () => {
  for (const slug of ["listings-authority", "agent-proposals", "run-credits"]) {
    const text = texts[slug];
    const definers = [
      ...text.matchAll(
        /CREATE FUNCTION ([a-z_]+\.[a-z_]+)\(([^)]*)\)[^]*?LANGUAGE [a-z]+(?: STABLE| IMMUTABLE)? SECURITY DEFINER/g,
      ),
    ]
      .map((m) => m[1])
      // A match may span several functions; keep the definer nearest its LANGUAGE line.
      .filter((name, i, all) => all.indexOf(name) === i);
    for (const name of definers) {
      const body = text.slice(text.indexOf("CREATE FUNCTION " + name + "("));
      const header = body.slice(0, body.indexOf("$$"));
      if (!/SECURITY DEFINER/.test(header)) continue;
      assert.match(
        text,
        new RegExp(
          `ALTER FUNCTION ${name.replace(".", "\\.")}\\([^)]*\\) OWNER TO morrow_work_command;`,
        ),
        slug + ": " + name,
      );
    }
    // Owner helpers stay INVOKER (revisable by a later owner migration).
    for (const helper of [
      "listings_store_current",
      "credential_for_connection",
      "parameters_redact_for_store",
      "run_reserve",
      "run_book_cost",
      "run_settle",
      "run_release",
      "unrecovered_allows",
    ]) {
      const at = text.indexOf("." + helper + "(");
      if (at < 0 || !text.slice(at - 40, at).includes("CREATE FUNCTION")) continue;
      const header = text.slice(at, text.indexOf("$$", at));
      assert.doesNotMatch(header, /SECURITY DEFINER/, helper);
      assert.doesNotMatch(text, new RegExp(`ALTER FUNCTION [a-z_]+\\.${helper}\\(`), helper);
    }
  }
  // The nine definers of the authority migration, each command-owned (final), and none in
  // the proposals or credits migrations (their helpers stay revisable).
  const authority = code(texts["listings-authority"]);
  const owned = [
    ...authority.matchAll(
      /ALTER FUNCTION ([a-z_]+\.[a-z_]+)\([^)]*\) OWNER TO morrow_work_command;/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(owned.sort(), [
    "morrow_vault.resolve_call",
    "morrow_work.agent_enable_document",
    "morrow_work.begin_agent_command",
    "morrow_work.cmd_listings_enable",
    "morrow_work.cmd_listings_enable_document",
    "morrow_work.cmd_model_default_revise",
    "morrow_work.cmd_stop_ai_work",
    "morrow_work.delegation_facts",
    "morrow_work.store_association",
  ]);
  assert.equal(authority.match(/SECURITY DEFINER/g).length, owned.length);
  for (const slug of ["agent-proposals", "run-credits"])
    assert.doesNotMatch(code(texts[slug]), /SECURITY DEFINER|OWNER TO/, slug);
  const bridges = texts["listings-identity-bridge"];
  for (const name of [
    "work_agent_principal_ensure",
    "work_agent_grants_issue",
    "work_owner_disable_grant_issue",
    "work_delegation_actor_facts",
  ]) {
    assert.match(bridges, new RegExp(`morrow_identity\\.${name}\\([^]*?SECURITY DEFINER`), name);
    assert.ok(
      bridgeFunctions.some((s) => s.startsWith(name + "(")),
      name,
    );
  }
  assert.match(
    code(bridges),
    /GRANT EXECUTE ON FUNCTION morrow_identity\.work_agent_principal_ensure\(text,text,text,text,text\),\n morrow_identity\.work_agent_grants_issue\(text,text,jsonb\),morrow_identity\.work_owner_disable_grant_issue\(text,text,jsonb\),\n morrow_identity\.work_delegation_actor_facts\(text,text,jsonb\) TO morrow_work_command;/,
  );
  // The session bridges re-derive the actor from the session; the facts bridge serves only
  // the runtime login's lease steps.
  for (const name of [
    "work_agent_principal_ensure",
    "work_agent_grants_issue",
    "work_owner_disable_grant_issue",
  ]) {
    const body = bridges.slice(bridges.indexOf("FUNCTION morrow_identity." + name + "("));
    assert.match(body.slice(0, body.indexOf("END $$")), /work_session_context\(/, name);
  }
  const facts = bridges.slice(
    bridges.indexOf("FUNCTION morrow_identity.work_delegation_actor_facts("),
  );
  assert.match(facts, /work_executor_safe\('morrow_runtime_executor'\)/);
});

test("agent grants: membership null exactly for agents; the allowlist never grants approve or execute on publish", () => {
  const bridges = texts["listings-identity-bridge"];
  assert.match(
    bridges,
    /ALTER TABLE morrow_identity\.grants ALTER COLUMN membership_id DROP NOT NULL/,
  );
  assert.match(
    bridges,
    /WHEN 'human' THEN membership_id IS NOT NULL AND agent_principal_id IS NULL/,
  );
  assert.match(
    bridges,
    /WHEN 'agent' THEN membership_id IS NULL AND agent_principal_id IS NOT NULL AND agent_principal_id::text=principal_id::text/,
  );
  assert.match(bridges, /ELSE false END\) IS TRUE\)/);
  // The installation allowlist: exactly three (capability, verbs) pairs, verbs as one exact
  // array each, and publish is propose only.
  const issue = bridges.slice(
    bridges.indexOf("CREATE FUNCTION morrow_identity.work_agent_grants_issue("),
    bridges.indexOf("CREATE FUNCTION morrow_identity.work_owner_disable_grant_issue("),
  );
  const pairs = [
    ...issue.matchAll(/g->>'capabilityId'='([a-z._]+)' AND g->'verbs'='(\[[^\]]*\])'::jsonb/g),
  ].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, [
    ["catalog.products.read", '["view"]'],
    ["catalog.content.propose", '["execute"]'],
    ["catalog.content.publish", '["propose"]'],
  ]);
  assert.doesNotMatch(issue, /approve/);
  // The issuer is the session's own human; the Coordinator's grant expires within 24 hours.
  assert.match(
    issue,
    /g->'issuedBy' IS DISTINCT FROM jsonb_build_object\('kind','human','principalId',s\.principal_id/,
  );
  assert.match(issue, /v_until>v_from\+interval '24 hours'/);
  // Agent principals are never human, so resolved_context and every human reader skip them.
  assert.match(
    bridges,
    /principal_kind text NOT NULL DEFAULT 'agent' CHECK \(principal_kind='agent'\)/,
  );
  for (const table of ["agent_principals"]) assert.ok(identityTables[table], table);
});

test("enable: the confirm-screen document of the ADR-0022 item 3 amendment, final and checked at commit", () => {
  const authority = texts["listings-authority"];
  const enable = authority.slice(
    authority.indexOf("CREATE FUNCTION morrow_work.cmd_listings_enable("),
    authority.indexOf("CREATE FUNCTION morrow_work.cmd_stop_ai_work("),
  );
  // Bound to the actor and the session, five minutes, single use, by its nonce.
  assert.match(
    authority,
    /CONSTRAINT agent_enable_documents_window CHECK \(expires_at=created_at\+interval '5 minutes'\)/,
  );
  assert.match(authority, /UNIQUE \(nonce_digest\)/);
  for (const needle of [
    "command_prelude_exclusive(",
    "doc.actor_principal_id<>p.principal_id OR doc.actor_membership_id<>p.membership_id",
    "doc.session_digest<>pg_catalog.current_setting('morrow.work_session_digest',true)",
    "doc.consumed_at IS NOT NULL OR doc.expires_at<=v_now OR doc.nonce_digest<>morrow_work.sha256_text(p_nonce)",
    // Re-checked at commit: the store's connection, the stops, the release and the grants.
    "listings_store_current(p.organization_id,p.workspace_id,doc.store_id)",
    "morrow_work.stop_active(p.organization_id,p.workspace_id,'run',doc.connection_id,NULL)",
    "(r.id,r.revision,r.digest)<>(doc.release_id::text,doc.release_revision::bigint,doc.release_digest::text)",
    "IS DISTINCT FROM v_set->v_index",
    "consumed_at=greatest(v_now,x.created_at),consumed_command_id=p_command_id",
    // Audited: the command row with the document digest.
    "'installation.enable',doc.installation_id,v_revision,v_result",
  ])
    assert.ok(enable.includes(needle), needle);
  // Resume lifts only the owner's own installation stop; platform and connection stops are
  // lifted only through their own paths.
  assert.match(
    enable,
    /UPDATE morrow_work\.stop_controls x SET lifted_at=greatest\(v_now,x\.created_at\),lifted_by_kind='human'[^;]*x\.scope='installation' AND x\.target_id=doc\.installation_id\n\s+AND x\.lifted_at IS NULL AND x\.set_by_kind='human';/,
  );
  assert.doesNotMatch(enable, /scope='platform'|scope='connection'/);
  // The command never reads billing or credits; nor does Stop AI work.
  const stop = authority.slice(
    authority.indexOf("CREATE FUNCTION morrow_work.cmd_stop_ai_work("),
    authority.indexOf("CREATE FUNCTION morrow_work.cmd_model_default_revise("),
  );
  for (const body of [enable, stop])
    assert.doesNotMatch(code(body), /morrow_billing|credit|entitlement/);
  // The KillSwitchRecord commits before the stop that names it, in the same transaction.
  assert.ok(
    stop.indexOf("INSERT INTO morrow_work.kill_switch_records") <
      stop.indexOf("INSERT INTO morrow_work.stop_controls"),
  );
  assert.match(
    authority,
    /CONSTRAINT stop_controls_human_record CHECK \(\(set_by_kind='human'\)=\(kill_switch_record_id IS NOT NULL\)\)/,
  );
});

test("resolve_call: broker only, one refusal code on any doubt, its settings cleared", () => {
  const authority = texts["listings-authority"];
  const resolve = authority.slice(
    authority.indexOf("CREATE FUNCTION morrow_vault.resolve_call("),
    authority.indexOf("-- Explicit ACLs per function"),
  );
  assert.match(resolve, /IF NOT morrow_identity\.work_executor_safe\('morrow_vault_broker'\) THEN/);
  assert.match(resolve, /p_purpose NOT IN \('model','shopify_read'\)/);
  for (const outcome of [
    "not_found",
    "ended",
    "expired",
    "member_inactive",
    "purpose_mismatch",
    "subject_mismatch",
    "stopped",
    "installation_inactive",
    "connection_inactive",
    "credential_unavailable",
  ])
    assert.ok(resolve.includes(`v_outcome:='${outcome}'`), outcome);
  // Every setting it writes for its policies is cleared before it returns.
  const cleared = resolve.lastIndexOf("set_config('morrow.vault_resolve_lease','',true)");
  assert.ok(cleared > resolve.lastIndexOf("credential_for_connection("));
  assert.ok(cleared < resolve.indexOf("IF v_outcome<>'resolved' THEN"));
  for (const policy of [
    "lease_broker_resolve",
    "stop_broker_resolve",
    "installation_broker_resolve",
  ])
    assert.match(
      authority,
      new RegExp(
        `CREATE POLICY ${policy} ON [a-z_.]+ FOR SELECT TO morrow_work_command\\n USING \\(session_user='morrow_vault_broker'`,
      ),
    );
  assert.match(
    code(authority),
    /GRANT EXECUTE ON FUNCTION morrow_vault\.resolve_call\(text,text,text,text\) TO morrow_vault_broker;/,
  );
  assert.ok(vaultFunctions["resolve_call(text,text,text,text)"]);
  assert.ok(vaultFunctions["credential_for_connection(text,text,text)"]);
});

test("proposals and redaction: the catalog check, NULL-safe binding, no decision on redacted parameters", () => {
  const proposals = texts["agent-proposals"];
  assert.match(
    proposals,
    /CHECK \(\(proposer_kind='human'\)=\(proposer_membership_id IS NOT NULL\)\n\s+AND \(proposer_kind='agent'\)=\(proposer_installation_id IS NOT NULL\)/,
  );
  assert.match(proposals, /d->'contextTaint' IS DISTINCT FROM '"untrusted_external"'::jsonb/);
  assert.match(proposals, /p_task_id IS NULL/);
  assert.match(
    proposals,
    /AND proposer_kind='human' AND store_id IS NULL AND connection_id IS NULL AND proposer_installation_id IS NULL END\)/,
  );
  assert.match(
    proposals,
    /parent\.proposer_membership_id IS DISTINCT FROM NEW\.proposer_membership_id/,
  );
  assert.match(proposals, /RAISE EXCEPTION 'APPROVAL_PARAMETERS_REDACTED'/);
  assert.match(
    proposals,
    /CREATE TRIGGER claim_parameters_bind BEFORE INSERT ON morrow_work\.approval_claims/,
  );
  assert.match(
    proposals,
    /\(redacted_at IS NULL AND digest::text=morrow_work\.sha256_text\(canonical\)\)\n\s+OR \(redacted_at IS NOT NULL AND canonical='\{\}' AND redacted_at>=created_at\)/,
  );
});

test("registry: every new table and function is registered with its class", () => {
  for (const table of [
    "agent_releases",
    "model_catalogue_versions",
    "model_catalogue_entries",
    "agent_installations",
    "agent_enable_documents",
    "work_envelopes",
    "delegation_hops",
    "kill_switch_records",
    "workspace_model_defaults",
  ]) {
    assert.ok(workTables[table], table);
    assert.match(
      texts["listings-authority"],
      new RegExp(`CREATE TABLE morrow_work\\.${table} \\(`),
    );
  }
  assert.equal(workTables.kill_switch_records.content, "workspace");
  for (const table of [
    "credit_reservations",
    "vendor_cost_reservations",
    "unrecovered_costs",
    "unrecovered_cost_entries",
  ]) {
    assert.ok(billingTables[table], table);
    assert.match(texts["run-credits"], new RegExp(`CREATE TABLE morrow_billing\\.${table} \\(`));
  }
  for (const [slug, schema, registry] of [
    ["listings-authority", "morrow_work", workFunctions],
    ["agent-proposals", "morrow_work", workFunctions],
    ["run-credits", "morrow_billing", billingFunctions],
    ["listings-authority", "morrow_vault", vaultFunctions],
  ])
    for (const [, name] of texts[slug].matchAll(
      new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${schema}\\.([a-z_]+)\\(`, "g"),
    ))
      assert.ok(
        Object.keys(registry).some((signature) => signature.startsWith(name + "(")),
        schema + "." + name,
      );
});
