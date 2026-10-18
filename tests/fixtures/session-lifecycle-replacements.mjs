// P05.T01y §2: the reviewed line differences between each function migration 0016
// replaces and its predecessor. The unit test (browser-session-sql) and
// lab:session-lifecycle-sql both derive the expected definition from the predecessor
// migration text with exactly these replacements, so no other byte may change.
const fits = (g, f) =>
  `morrow_identity.browser_generation_fits_family(${g}.created_at,${g}.expires_at,${f}.created_at,${f}.expires_at)`;
const familyAdvance = ` -- P05.T01y family advance: a rotation moves the current generation by exactly one and
 -- changes nothing else. It names the rotated audit of the generation it retires.
 IF TG_TABLE_NAME='browser_session_families' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL THEN
  IF OLD.expires_at<>OLD.created_at+interval '12 hours'
    OR NEW.current_generation<>OLD.current_generation+1 OR NEW.current_generation>1000
    OR NEW.record_revision<>OLD.record_revision+1
    OR (to_jsonb(NEW)-'current_generation'-'record_revision') IS DISTINCT FROM (to_jsonb(OLD)-'current_generation'-'record_revision')
    OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits a
      JOIN morrow_identity.browser_session_generations x ON x.id=a.target_id
      WHERE a.id::text=pg_catalog.current_setting('morrow.browser_revocation_audit',true)
        AND a.kind='generation' AND a.outcome='revoked' AND a.reason='rotated'
        AND x.family_id=OLD.id AND x.generation=OLD.current_generation
        AND x.revoked_at=a.recorded_at AND a.recorded_at<OLD.expires_at) THEN
   RAISE EXCEPTION 'BROWSER_SESSION_ADVANCE_INVALID';
  END IF;
  RETURN NEW;
 END IF;
`;
const signedOut = (time) =>
  `NOT EXISTS(SELECT 1 FROM morrow_identity.organization_session_signouts x WHERE x.organization_id=o.id AND x.principal_id=p.id${time ? " AND x.signed_out_at>=f.created_at" : ""})`;

export const sessionLifecycleReplacements = Object.freeze([
  {
    name: "preserve_browser_session_record",
    from: "migrations/0008.browser-session-admission.sql",
    replacements: [
      [
        " kind_value:=CASE TG_TABLE_NAME WHEN 'provider_session_bindings' THEN 'provider_binding' WHEN 'browser_session_families' THEN 'family' WHEN 'browser_session_generations' THEN 'generation' END;\n",
        " kind_value:=CASE TG_TABLE_NAME WHEN 'provider_session_bindings' THEN 'provider_binding' WHEN 'browser_session_families' THEN 'family' WHEN 'browser_session_generations' THEN 'generation' END;\n" +
          familyAdvance,
      ],
    ],
  },
  {
    name: "session_eligibility",
    from: "migrations/0008.browser-session-admission.sql",
    replacements: [
      [
        "   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()\n",
        "   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()\n   AND " +
          signedOut(false) +
          "\n",
      ],
      [
        "   AND g.created_at=f.created_at AND g.expires_at=f.expires_at\n",
        "   AND " + fits("g", "f") + "\n   AND " + signedOut(true) + "\n",
      ],
    ],
  },
  {
    name: "end_self_browser_family",
    from: "migrations/0011.self-browser-family-logout.sql",
    replacements: [
      [
        " OR g.generation<>f.current_generation\n OR g.created_at<>f.created_at OR g.expires_at<>f.expires_at OR NOT isfinite(pb.created_at)",
        " OR g.generation>f.current_generation\n OR NOT " +
          fits("g", "f") +
          " OR NOT isfinite(pb.created_at)",
      ],
      [
        "   OR g.family_id<>f.id OR f.provider_binding_id<>pb.id OR g.generation<>f.current_generation OR g.created_at<>f.created_at OR g.expires_at<>f.expires_at\n",
        "   OR g.family_id<>f.id OR f.provider_binding_id<>pb.id OR g.generation>f.current_generation OR NOT " +
          fits("g", "f") +
          "\n",
      ],
    ],
  },
  {
    name: "account_session_principal",
    from: "migrations/0013.account-onboarding.sql",
    replacements: [
      [
        "   AND g.created_at=f.created_at AND g.expires_at=f.expires_at\n",
        "   AND " + fits("g", "f") + "\n",
      ],
    ],
  },
  {
    name: "reconcile_login_flow",
    from: "migrations/0013.account-onboarding.sql",
    replacements: [
      [
        " AND g.expires_at=m.expires_at AND bf.expires_at=m.expires_at)) THEN",
        " AND g.generation=1 AND g.expires_at=m.expires_at AND " + fits("g", "bf") + ")) THEN",
      ],
    ],
  },
  {
    name: "admit_account_family",
    from: "migrations/0013.account-onboarding.sql",
    replacements: [
      [
        " reason_code text:='identity_ineligible'; enrollment_kind text; instant timestamptz; expiry timestamptz;\n",
        " reason_code text:='identity_ineligible'; enrollment_kind text; instant timestamptz; expiry timestamptz; family_expiry timestamptz;\n",
      ],
      [
        "   expiry:=instant+interval '15 minutes';\n",
        "   SELECT l.family_expires_at,l.generation_expires_at INTO family_expiry,expiry FROM morrow_identity.browser_new_lifetimes(instant) l;\n",
      ],
      [
        "    VALUES(p_family_id,provider_key,v.record_revision,mapping_revision,binding_revision,instant,expiry);\n",
        "    VALUES(p_family_id,provider_key,v.record_revision,mapping_revision,binding_revision,instant,family_expiry);\n",
      ],
    ],
  },
]);

// One function's whole definition, from CREATE to its closing $$; (plain $$ quoting only).
export function functionDefinition(text, name) {
  const matches = [
    ...text.matchAll(
      new RegExp(
        "CREATE (?:OR REPLACE )?FUNCTION morrow_identity\\." + name + "\\([\\s\\S]*?\\$\\$;\\n?",
        "g",
      ),
    ),
  ];
  if (matches.length !== 1) throw Error("SESSION_LIFECYCLE_DEFINITION_NOT_UNIQUE:" + name);
  return matches[0][0].replace(/\n$/, "");
}

// The predecessor with each reviewed replacement applied exactly once, as CREATE OR REPLACE.
export function expectedReplacement(read, entry) {
  let text = functionDefinition(read(entry.from), entry.name).replace(
    /^CREATE FUNCTION /,
    "CREATE OR REPLACE FUNCTION ",
  );
  for (const [from, to] of entry.replacements) {
    if (text.split(from).length !== 2) throw Error("SESSION_LIFECYCLE_REPLACEMENT:" + entry.name);
    text = text.replace(from, () => to);
  }
  return text;
}
