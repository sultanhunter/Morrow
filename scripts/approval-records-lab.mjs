// P06.T01b PostgreSQL 17 acceptance laboratory (PR-1): AC01-AC19 and AC21-AC24
// through @morrow/work/approvals, an isolated network-none engine and the full
// migration manifest (applied with `executeAs`, a fresh connection per
// migration). AC16's S1-S6/P1-P6 run in lab:tenant-conformance; AC20 and the
// routes are PR-2 (workerd). Each case has its own workspace or organization, so
// review policies never leak between cases (the P03.T04e PR-B template-database
// harness is not merged yet). Owner-seeded synthetic fixtures only; no provider,
// credential or merchant data. Runs in the CI pg-core group.
// MORROW_APPROVAL_LAB_ONLY=AC01,AC04 runs a subset. MORROW_APPROVAL_RACE_ROUNDS=n
// (1-20, default 1; no CI job sets it) repeats the AC17 races on fresh records.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import canonicalize from "canonicalize";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  canonicalDigest,
  confirmationPhrase,
  effectiveRule,
  previewSelection,
  proposalDigest,
  proposalRef,
  riskClassFor,
} from "../packages/policy/src/review.ts";
import * as ap from "../packages/work/src/approvals/index.ts";
import { workRequestDigest } from "../packages/work/src/digest.ts";
import { WorkOutcomeUnknown } from "../packages/work/src/connection.ts";
import {
  asApi,
  asCommandRole,
  literal,
  sleep,
  withWorkDatabase,
} from "../tests/tenant-conformance/harness.mjs";
import { approvalProducers } from "../tests/fixtures/approval-producers.mjs";
import {
  actorRef,
  backdatedRevocationSql,
  capabilitiesAfter0018,
  catalogueAt0018,
  defaults,
  grant,
  grantSql,
  reviewerGrants,
  seedApprovalFixtures,
  transactions,
  workspaceResource,
} from "../tests/fixtures/approval-records-fixtures.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const transitionsJson = JSON.parse(readFileSync("docs/contracts/state-transitions.json", "utf8"));
const capabilityOf = (id) => catalogue.capabilities.find((c) => c.id === id);
const same = (a, b) => isDeepStrictEqual(a, b);
const plusSeconds = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();

export async function runApprovalRecordsLab(db, options = {}) {
  const checks = [];
  const failures = [];
  const print = options.print ?? console.log;
  function check(name, passed, detail) {
    checks.push({ name, passed: passed === true });
    if (passed !== true) {
      failures.push(name);
      if (options.verbose && detail !== undefined)
        print("CHECK_FAILED " + name + " " + JSON.stringify(detail));
    }
    return passed === true;
  }
  const stats = { retries: 0 };
  const inTx = transactions(db, stats);
  const only = options.only ?? null;
  const raceRounds = options.raceRounds ?? 1;
  async function section(name, body) {
    if (only && !only.includes(name)) return;
    const started = Date.now();
    try {
      await body();
    } catch (error) {
      check(name + ":completed", false);
      print(
        "SECTION_FAILED " +
          name +
          " " +
          (error instanceof Error ? (error.stack ?? error.message) : "unknown"),
      );
    }
    if (options.verbose) print("SECTION " + name + " " + (Date.now() - started) + "ms");
  }

  // ---------------------------------------------------------------------------
  // Fixtures and the laboratory claim consumer.
  const F = seedApprovalFixtures(db);
  const consumer = readFileSync("tests/fixtures/approval-claim-consumer.sql", "utf8").split(
    "-- PART 2 (morrow_work_owner)",
  );
  db.admin(consumer[0]);
  db.workOwner(consumer[1]);
  const { A, B, C, D, R, X, V, Y } = F.people;
  const at = F.at;
  const dbNow = () =>
    db.sql(
      `SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`,
    );

  // ---------------------------------------------------------------------------
  // Command helpers: exactly the module calls a producer route or PR-2 route makes.
  const grantsBody = (beneficiary, taskId) => ({
    capabilityId: "governance.grants.revise",
    taskId,
    parameters: { beneficiaryPrincipalId: beneficiary.principal ?? beneficiary },
  });
  const eraseBody = (subjects, taskId) => ({
    capabilityId: "governance.privacy.erase",
    taskId,
    parameters: { subjects },
  });
  async function submit(p, body, o = {}) {
    const commandId = o.commandId ?? randomUUID();
    const requestDigest =
      o.requestDigest ?? (await workRequestDigest("proposal.submit", p.workspace, [], body));
    return inTx(
      p,
      (tx, a) =>
        ap.submitProposal(tx, a, o.producers ?? approvalProducers, {
          commandId,
          requestDigest,
          ...body,
        }),
      o,
    );
  }
  async function applied(p, body, o = {}) {
    const r = await submit(p, body, o);
    if (r.outcome !== "applied") throw Error("FIXTURE_SUBMIT_" + r.outcome);
    return r;
  }
  const decision = (digest, o = {}) => ({
    decision: "approve",
    selectedTargetIndexes: null,
    expectedDecisionDigest: digest,
    soloOwnerConfirmation: null,
    comment: null,
    ...o,
  });
  async function decide(p, proposalId, body, expectedRevision, o = {}) {
    const request = { decision: body, expectedRevision };
    const commandId = o.commandId ?? randomUUID();
    const requestDigest =
      o.requestDigest ??
      (await workRequestDigest("approval.decide", p.workspace, [proposalId], request));
    return inTx(
      p,
      (tx, a) => ap.decideApproval(tx, a, { commandId, requestDigest, proposalId, body: request }),
      o,
    );
  }
  async function withdraw(p, proposalId, expectedRevision, o = {}) {
    const commandId = o.commandId ?? randomUUID();
    const requestDigest =
      o.requestDigest ??
      (await workRequestDigest("approval.withdraw", p.workspace, [proposalId], {
        expectedRevision,
      }));
    return inTx(
      p,
      (tx, a) =>
        ap.withdrawProposal(tx, a, { commandId, requestDigest, proposalId, expectedRevision }),
      o,
    );
  }
  const read = (p, id, selected = null) =>
    inTx(p, (tx, a) => ap.readProposal(tx, a, id, selected), { readOnly: true });
  const list = (p, after, limit) =>
    inTx(p, (tx, a) => ap.listApprovals(tx, a, { after, limit }), { readOnly: true });
  // The claim consumer contract: prepare in TS, then the consumer's own definer
  // (prelude with the exclusive organization lock, approval_claim, identity effect).
  // The consumer names its capability (grants revise unless the refs say otherwise);
  // o.capability overrides only the value sent to SQL. A fixed o.commandId with the
  // same prepared values is the read-back of an unknown commit.
  async function claim(p, refs, o = {}) {
    const consumerRefs = { capabilityId: "governance.grants.revise", ...refs };
    const commandId = o.commandId ?? randomUUID();
    // A retry after an unknown outcome resends the same prepared values and command
    // ID (no new prepare), as the consumer contract requires.
    let kept = o.prepared ?? null;
    return inTx(
      p,
      async (tx, a, connection) => {
        const prepared = kept ?? (await ap.prepareApprovalClaim(tx, a, consumerRefs));
        if ("code" in prepared) {
          tx.rollbackOnly();
          return { outcome: prepared.code, stage: "prepare" };
        }
        kept = prepared;
        const values = [
          commandId,
          "c".repeat(64),
          prepared.approvalId,
          String(prepared.approvalRevision),
          o.approvalDigest ?? prepared.approvalDigest,
          prepared.proposalId,
          o.proposalDigest ?? prepared.proposalDigest,
          o.capability ?? prepared.capabilityId,
          o.countedJson ?? prepared.countedJson,
          o.fail ? "fail" : "ok",
        ];
        if (o.revision !== undefined) values[3] = String(o.revision);
        tx.markSubmitted();
        if (o.beforeConsumer) await o.beforeConsumer();
        const rows = (
          await connection.query(
            "SELECT outcome,effect_id FROM morrow_work.lab_claim_consumer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            values,
            new AbortController().signal,
          )
        ).rows;
        if (rows[0]?.outcome !== "applied") tx.rollbackOnly();
        if (o.afterConsumer) await o.afterConsumer();
        return { ...rows[0], stage: "sql" };
      },
      o,
    );
  }
  // TypeScript bypassed: one SQL call in the actor's own context, as the api role.
  const apiCall = (p, call, end = "ROLLBACK") =>
    db
      .sql(asApi(p, "SELECT outcome FROM " + call + ";", { end }), { user: "morrow_api_worker" })
      .split("\n")
      .at(-1);
  const args = (values) => values.map(literal).join(",");
  const counted = (at, reviewers = []) => canonicalize({ evaluatedAt: at, reviewers });
  const tables = [
    "review_policies",
    "proposal_parameters",
    "proposals",
    "approvals",
    "approval_decisions",
    "approval_claims",
    "commands",
    "outbox_events",
  ];
  const snapshot = (ws) =>
    db.rows(
      "SELECT " +
        tables
          .map(
            (t) =>
              `(SELECT count(*) FROM morrow_work.${t} WHERE workspace_id=${literal(ws)})::int AS ${t}`,
          )
          .join(","),
    )[0];
  const approvalRow = (id) =>
    db.rows(
      `SELECT a.*, to_char(a.effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_text, to_char(a.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_text, to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_text FROM morrow_work.approvals a WHERE a.id=${literal(id)}`,
    )[0];
  const proposalRowOf = (id) =>
    db.rows(
      `SELECT p.*, to_char(p.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_text, to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_text FROM morrow_work.proposals p WHERE p.id=${literal(id)}`,
    )[0];
  // Workspace-scoped 0004-equivalent removal (owner maintenance with its lock order
  // and effects: interlock, organization FOR UPDATE, membership off, grants revoked,
  // revision bumped), and the restore.
  const interlock = (org) =>
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',${literal(org)}::text)::text,0));`;
  const removeSql = (p) => `BEGIN; SET LOCAL ROLE morrow_identity_owner;
${interlock(p.org)}
SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(p.org)} FOR UPDATE;
UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(p.workspace)} AND membership_id=${literal(p.membership)};
UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE workspace_id=${literal(p.workspace)} AND membership_id=${literal(p.membership)} AND payload->'revokedAt'='null'::jsonb;
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(p.org)};
COMMIT;`;
  const restoreSql = (p) => `BEGIN; SET LOCAL ROLE morrow_identity_owner;
${interlock(p.org)}
SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(p.org)} FOR UPDATE;
UPDATE morrow_identity.workspace_memberships SET active=true WHERE workspace_id=${literal(p.workspace)} AND membership_id=${literal(p.membership)};
UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}','null'::jsonb) WHERE workspace_id=${literal(p.workspace)} AND membership_id=${literal(p.membership)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(p.org)};
COMMIT;`;
  // ReviewPolicy documents installed by owner SQL (fixture revisions).
  function policyDoc(org, ws, revision, createdAt, rules) {
    return {
      schemaVersion: 1,
      id: "review-policy",
      organizationId: org,
      workspaceId: ws,
      storeId: null,
      revision,
      createdAt,
      updatedAt: createdAt,
      rules,
    };
  }
  function installPolicy(org, ws, revision, rules, createdAt = dbNow()) {
    const doc = policyDoc(org, ws, revision, createdAt, rules);
    const text = canonicalize(doc);
    db.workOwner(
      `INSERT INTO morrow_work.workspace_streams VALUES(${literal(org)},${literal(ws)},0,clock_timestamp()) ON CONFLICT DO NOTHING;
INSERT INTO morrow_work.review_policies VALUES(${literal(org)},${literal(ws)},'review-policy',${revision},${literal(JSON.stringify(rules))}::jsonb,${literal(text)},${literal(sha(text))},${literal(createdAt)}::timestamptz);`,
    );
    return { doc, canonical: text, digest: sha(text) };
  }
  const rulesWith = (patch) => {
    const rules = structuredClone(defaults.rules);
    for (const [k, v] of Object.entries(patch)) rules[k] = { ...rules[k], ...v };
    return rules;
  };
  // A Proposal@2 built exactly as submit builds it, for owner-inserted fixtures
  // (back-dated, bulk) that a live submit cannot produce.
  function storedProposal({
    org,
    ws,
    proposer,
    requester = proposer,
    taskId,
    capabilityId,
    targets,
    beneficiaries = [],
    partialApproval = "all_or_nothing",
    policy,
    createdAt,
    parameters = { fixture: randomUUID() },
  }) {
    const risk = riskClassFor(capabilityId);
    const irreversible = capabilityOf(capabilityId).irreversible;
    const rule = effectiveRule(policy.doc.rules, risk, irreversible);
    const parametersCanonical = canonicalize(parameters);
    const parametersDigest = sha(parametersCanonical);
    const parametersId = randomUUID();
    const W = workspaceResource(org, ws);
    const scope = {
      organizationId: org,
      workspaceId: ws,
      storeIds: [],
      accountIds: [],
      resources: [W],
      fields: [...new Set(targets.flatMap((t) => t.fields))].sort(),
    };
    const credits = targets.reduce((s, t) => s + BigInt(t.maximumCredits), 0n).toString();
    const content = {
      schemaVersion: 2,
      id: randomUUID(),
      organizationId: org,
      workspaceId: ws,
      storeId: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      taskId,
      capabilityId,
      scope,
      targets,
      parametersRef: {
        organizationId: org,
        workspaceId: ws,
        storeId: null,
        kind: "artifact",
        id: parametersId,
        revision: 1,
        digest: parametersDigest,
      },
      parametersDigest,
      maximumCredits: credits,
      maximumCost: null,
      risk,
      irreversible,
      reviewPolicyRef: {
        organizationId: org,
        workspaceId: ws,
        storeId: null,
        kind: "policy",
        id: "review-policy",
        revision: policy.doc.revision,
        digest: policy.digest,
      },
      proposedBy: actorRef({ ...proposer, workspace: ws }),
      requestedBy: actorRef({ ...requester, workspace: ws }),
      beneficiaryPrincipalIds: beneficiaries,
      contextTaint: "none",
      partialApproval,
      derivedFrom: null,
      proposalDigest: "0".repeat(64),
      expiresAt: plusSeconds(
        createdAt,
        rule.pendingExpirySeconds +
          policy.doc.rules.soloOwner.coolDownSeconds +
          rule.approvedValiditySeconds,
      ),
    };
    const doc = { ...content, proposalDigest: proposalDigest(content) };
    const { proposalDigest: digest, ...withoutDigest } = doc;
    return {
      doc,
      digest,
      canonical: canonicalize(withoutDigest),
      scopeCanonical: canonicalize(scope),
      parametersId,
      parametersCanonical,
      parametersDigest,
      approvalId: randomUUID(),
      rule,
      policy,
      approvalExpiresAt: plusSeconds(createdAt, rule.pendingExpirySeconds),
      proposer,
      requester,
    };
  }
  // A stored fixture with a mutated document that stays self-consistent (the row
  // columns, canonical text and digests all follow the mutation), so a refusal comes
  // from the catalogue binding, the triggers or the document CHECK, not a mismatch.
  function forgeStored(s, mutate, extra = {}) {
    const { proposalDigest: _omitted, ...content } = structuredClone(s.doc);
    mutate(content);
    const canonical = canonicalize(content);
    const digest = extra.digest ?? sha(canonical);
    return {
      ...s,
      doc: { ...content, proposalDigest: digest },
      digest,
      canonical,
      scopeCanonical: canonicalize(content.scope),
      // The approval row follows a forged createdAt too (approval_bind's formula).
      approvalExpiresAt: plusSeconds(content.createdAt, s.rule.pendingExpirySeconds),
    };
  }
  const arrayLiteral = (values) =>
    values === null
      ? "NULL"
      : values.length
        ? "ARRAY[" + values.map(literal).join(",") + "]::text[]"
        : "'{}'::text[]";
  // The parameters and proposal rows alone (no approval): a refusal is proposal_bind's
  // or a proposals CHECK, never approval_bind's.
  const proposalOnlySql = (s, org, ws) =>
    storedProposalSql(s, org, ws).split("\nINSERT INTO morrow_work.approvals")[0];
  function storedProposalSql(s, org, ws) {
    const d = s.doc;
    return `INSERT INTO morrow_work.proposal_parameters VALUES(${literal(org)},${literal(ws)},${literal(s.parametersId)},${literal(s.parametersCanonical)},${literal(s.parametersDigest)},${literal(d.createdAt)}::timestamptz);
INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at) VALUES(${literal(org)},${literal(ws)},${literal(d.id)},1,${literal(d.id)},NULL,NULL,NULL,${literal(d.taskId)},${literal(d.capabilityId)},${literal(d.risk)},${d.irreversible},${literal(d.partialApproval)},${d.targets.length},${d.maximumCredits},${literal(s.proposer.principal)},${literal(s.proposer.membership)},${literal(s.requester.principal)},${literal(s.requester.membership)},${arrayLiteral(d.beneficiaryPrincipalIds)},'review-policy',${s.policy.doc.revision},${literal(s.policy.digest)},${literal(s.parametersId)},${literal(s.parametersDigest)},${literal(s.canonical)},${literal(s.digest)},${literal(s.scopeCanonical)},${literal(sha(s.scopeCanonical))},${literal(d.expiresAt)}::timestamptz,${literal(d.createdAt)}::timestamptz);
INSERT INTO morrow_work.approvals(organization_id,workspace_id,id,revision,proposal_id,proposal_digest,family_root_id,status,required_approvals,self_approval,pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,counted_reviewer_principal_ids,scope_digest,review_policy_revision,policy_revision,effective_at,expires_at,invalidation_reason,created_at,updated_at) VALUES(${literal(org)},${literal(ws)},${literal(s.approvalId)},1,${literal(d.id)},${literal(s.digest)},${literal(d.id)},'pending',${s.rule.requiredApprovals},${literal(s.rule.selfApproval)},${s.rule.pendingExpirySeconds},${s.rule.approvedValiditySeconds},${s.policy.doc.rules.soloOwner.coolDownSeconds},${s.policy.doc.rules.soloOwner.quietPeriodSeconds},${arrayLiteral(s.rule.eligibleReviewerPrincipalIds)},NULL,${literal(sha(s.scopeCanonical))},${s.policy.doc.revision},1,NULL,${literal(s.approvalExpiresAt)}::timestamptz,NULL,${literal(d.createdAt)}::timestamptz,${literal(d.createdAt)}::timestamptz);`;
  }
  const grantsTarget = (org, ws, beneficiary) => [
    {
      resource: workspaceResource(org, ws),
      expectedSourceRevision: "grants:" + beneficiary,
      fields: ["approvalRef", "proposalRef"],
      maximumCredits: "0",
      maximumCost: null,
    },
  ];
  // A TS-built submit whose command-function arguments are captured, not sent.
  async function captureSubmit(p, body) {
    let captured = null;
    await inTx(p, async (tx, a) => {
      const wrapped = {
        run: async (name, values) => {
          if (name === "cmdProposalSubmit") {
            captured = [...values];
            return [{ outcome: "invalid", result: null }];
          }
          return tx.run(name, values);
        },
        markSubmitted() {},
        rollbackOnly: tx.rollbackOnly,
      };
      return ap.submitProposal(wrapped, a, approvalProducers, {
        commandId: randomUUID(),
        requestDigest: "f".repeat(64),
        ...body,
      });
    });
    if (!captured) throw Error("CAPTURE_FAILED");
    return captured;
  }
  const submitCall = (values) => "morrow_work.cmd_proposal_submit(" + args(values) + ")";
  const decideCall = (values) => "morrow_work.cmd_approval_decide(" + args(values) + ")";
  const reviewerRef = (p) => ({ principalId: p.principal });
  const W = (k) => F.W[k];
  const atW = (p, k) => at(p, W(k));

  // ===========================================================================
  await section("AC01", async () => {
    const ws = W("W");
    const a = atW(A, "W");
    const before = snapshot(ws);
    const startedAt = dbNow();
    const r = await submit(a, grantsBody(C, F.task("a", ws)));
    check("AC01:applied", r.outcome === "applied", r);
    const after = snapshot(ws);
    check(
      "AC01:one_commit",
      after.review_policies === before.review_policies + 1 &&
        after.proposal_parameters === before.proposal_parameters + 1 &&
        after.proposals === before.proposals + 1 &&
        after.approvals === before.approvals + 1 &&
        after.commands === before.commands + 1 &&
        after.outbox_events === before.outbox_events + 1,
      { before, after },
    );
    const [policy] = db.rows(
      `SELECT revision::int AS revision, rules FROM morrow_work.review_policies WHERE workspace_id=${literal(ws)}`,
    );
    check(
      "AC01:policy_revision_1_defaults",
      policy?.revision === 1 && same(policy.rules, defaults.rules),
    );
    const p = proposalRowOf(r.proposalRef.id);
    const doc = { ...JSON.parse(p.canonical), proposalDigest: p.digest };
    check(
      "AC01:library_digest",
      proposalDigest(doc) === p.digest && r.proposalRef.digest === p.digest,
    );
    check("AC01:valid_proposal", validateCurrentDefinition("Proposal", doc));
    check(
      "AC01:server_fields",
      doc.risk === "access_change" &&
        doc.irreversible === false &&
        doc.contextTaint === "none" &&
        same(doc.requestedBy, actorRef(a)) &&
        same(doc.beneficiaryPrincipalIds, [C.principal]),
    );
    check(
      "AC01:scope",
      same(doc.scope, {
        organizationId: F.O,
        workspaceId: ws,
        storeIds: [],
        accountIds: [],
        resources: [workspaceResource(F.O, ws)],
        fields: ["approvalRef", "proposalRef"],
      }),
    );
    check(
      "AC01:created_in_transaction",
      Date.parse(p.created_text) >= Date.parse(startedAt) &&
        Date.parse(p.created_text) <= Date.parse(dbNow()),
    );
    check(
      "AC01:expires_90300s",
      Date.parse(p.expires_text) - Date.parse(p.created_text) === 90300 * 1000,
    );
    const ap1 = approvalRow(r.approvalRef.id);
    check(
      "AC01:approval_snapshot",
      ap1.status === "pending" &&
        ap1.required_approvals === 1 &&
        ap1.self_approval === "solo_owner_typed_confirmation" &&
        ap1.pending_expiry_seconds === 86400 &&
        ap1.approved_validity_seconds === 3600 &&
        ap1.cool_down_seconds === 300 &&
        ap1.quiet_period_seconds === 86400,
      ap1,
    );
    check(
      "AC01:approval_expiry_24h",
      Date.parse(ap1.expires_text) - Date.parse(ap1.created_text) === 86400 * 1000 &&
        ap1.created_text === p.created_text,
    );
    check(
      "AC01:scope_digest",
      ap1.scope_digest === canonicalDigest(doc.scope) &&
        ap1.scope_digest === ap.scopeDigest(doc.scope),
    );
    const events = db.rows(
      `SELECT event_type, payload FROM morrow_work.outbox_events WHERE aggregate_id=${literal(r.proposalRef.id)}`,
    );
    check(
      "AC01:one_event",
      events.length === 1 &&
        events[0].event_type === "proposal.submitted" &&
        same(events[0].payload, {
          approvalId: r.approvalRef.id,
          risk: "access_change",
          targetCount: 1,
        }),
      events,
    );
    // A second submit reuses revision 1.
    await applied(a, grantsBody(D, F.task("a", ws)));
    check(
      "AC01:policy_reused",
      Number(
        db.sql(
          `SELECT count(*) FROM morrow_work.review_policies WHERE workspace_id=${literal(ws)};`,
        ),
      ) === 1,
    );
  });

  // ===========================================================================
  await section("AC02", async () => {
    const ws = W("W2");
    const a = atW(A, "W2");
    await applied(a, grantsBody(C, F.task("a", ws)));
    const before = snapshot(ws);
    const outcome = async (p, body) => (await submit(p, body)).outcome;
    check(
      "AC02:producer_missing",
      (await outcome(a, {
        capabilityId: "governance.membership.invite",
        taskId: null,
        parameters: {},
      })) === "producer_missing",
    );
    check(
      "AC02:x_denied",
      (await outcome(atW(X, "W2"), grantsBody(C, F.task("a", ws)))) === "denied",
    );
    check(
      "AC02:other_task_without_administer",
      (await outcome(a, grantsBody(C, F.task("b", ws)))) === "denied",
    );
    check(
      "AC02:foreign_target_invalid",
      (await outcome(a, {
        capabilityId: "governance.budget.revise",
        taskId: F.task("a", ws),
        parameters: { workspaceId: W("W3") },
      })) === "invalid",
    );
    check(
      "AC02:101_targets_invalid",
      (await outcome(
        a,
        eraseBody(
          Array.from({ length: 101 }, (_, i) => "s" + i),
          F.task("a", ws),
        ),
      )) === "invalid",
    );
    // No reachable quorum once every eligible reviewer is removed.
    const reviewers = [B, D, R, V].map((p) => atW(p, "W2"));
    for (const p of reviewers) db.sql(removeSql(p));
    try {
      check(
        "AC02:quorum_unreachable",
        (await outcome(a, grantsBody(C, F.task("a", ws)))) === "quorum_unreachable",
      );
    } finally {
      for (const p of reviewers) db.sql(restoreSql(p));
    }
    check("AC02:nothing_written", same(snapshot(ws), before), snapshot(ws));
    // Direct cmd_proposal_submit calls with forged documents: each is invalid.
    const base = await captureSubmit(a, grantsBody(C, F.task("a", ws)));
    const doc = JSON.parse(base[10]);
    const forged = (mutate, extra = {}) => {
      const d = structuredClone(doc);
      mutate(d);
      const text = canonicalize(d);
      const values = [...base];
      values[0] = randomUUID();
      values[10] = text;
      values[11] = extra.digest ?? sha(text);
      if (extra.scope) values[12] = extra.scope;
      if (extra.policy) {
        values[6] = extra.policy;
        values[7] = sha(extra.policy);
      }
      return apiCall(a, submitCall(values), "COMMIT");
    };
    const now = dbNow();
    const [w2policy] = db.rows(
      `SELECT canonical, digest FROM morrow_work.review_policies WHERE workspace_id=${literal(ws)} ORDER BY revision DESC LIMIT 1`,
    );
    const cases = {
      forged_risk: () => forged((d) => (d.risk = "internal")),
      forged_irreversible: () => forged((d) => (d.irreversible = true)),
      unreviewed_capability: () => forged((d) => (d.capabilityId = "workspace.task.create")),
      kill_switch: () => forged((d) => (d.capabilityId = "governance.membership.revoke")),
      connect: () => forged((d) => (d.capabilityId = "governance.connection.connect")),
      store: () => forged((d) => (d.storeId = "store_x")),
      policy_rules: () => "deferred",
      forward_dated: () =>
        forged((d) => {
          d.createdAt = d.updatedAt = plusSeconds(now, 3600);
          d.expiresAt = plusSeconds(d.createdAt, 90300);
        }),
      expires_off_formula: () => forged((d) => (d.expiresAt = plusSeconds(d.expiresAt, 1))),
      scope_not_derived: () => {
        const scope = { ...JSON.parse(base[12]), fields: ["approvalRef", "proposalRef", "zz"] };
        return forged((d) => (d.scope = scope), { scope: canonicalize(scope) });
      },
      parameters_ref_not_derived: () => forged((d) => (d.parametersRef.digest = "0".repeat(64))),
      canonical_digest_mismatch: () => forged(() => {}, { digest: "1".repeat(64) }),
    };
    for (const [name, run] of Object.entries(cases))
      if (name !== "policy_rules") check("AC02:direct_" + name, run() === "invalid", name);
    // A revision 1 whose rules are not the defaults, in a workspace with no policy yet.
    const ws13 = W("W13");
    const a13 = atW(A, "W13");
    const fresh = await captureSubmit(a13, grantsBody(C, F.task("a", ws13)));
    const forgedPolicy = JSON.parse(fresh[6]);
    forgedPolicy.rules.access_change.requiredApprovals = 2;
    const forgedText = canonicalize(forgedPolicy);
    const freshDoc = JSON.parse(fresh[10]);
    freshDoc.reviewPolicyRef.digest = sha(forgedText);
    const freshText = canonicalize(freshDoc);
    const policyValues = [...fresh];
    policyValues[0] = randomUUID();
    policyValues[6] = forgedText;
    policyValues[7] = sha(forgedText);
    policyValues[10] = freshText;
    policyValues[11] = sha(freshText);
    const before13 = snapshot(ws13);
    check(
      "AC02:direct_policy_rules",
      apiCall(a13, submitCall(policyValues), "COMMIT") === "invalid",
    );
    check("AC02:direct_policy_nothing_written", same(snapshot(ws13), before13));
    check("AC02:direct_nothing_written", same(snapshot(ws), before), snapshot(ws));
    // The same forgeries inserted as owner or command role fail a CHECK or a trigger.
    const s = storedProposal({
      org: F.O,
      ws,
      proposer: A,
      taskId: F.task("a", ws),
      capabilityId: "governance.grants.revise",
      targets: grantsTarget(F.O, ws, C.principal),
      beneficiaries: [C.principal],
      policy: { doc: JSON.parse(w2policy.canonical), digest: w2policy.digest },
      createdAt: dbNow(),
    });
    const ownerInsert = (sql) =>
      db.tryRun("SET ROLE morrow_work_owner;\nBEGIN;\n" + sql + "\nROLLBACK;");
    check("AC02:owner_valid_insert_ok", ownerInsert(storedProposalSql(s, F.O, ws)).ok);
    const later = plusSeconds(dbNow(), 3600);
    const ownerCases = {
      forged_risk: (d) => (d.risk = "internal"),
      forged_irreversible: (d) => (d.irreversible = true),
      unreviewed_capability: (d) => {
        d.capabilityId = "workspace.task.create";
        d.risk = "internal";
      },
      kill_switch: (d) => (d.capabilityId = "governance.membership.revoke"),
      connect: (d) => (d.capabilityId = "governance.connection.connect"),
      store: (d) => (d.storeId = "store_x"),
      forward_dated: (d) => {
        d.expiresAt = plusSeconds(
          later,
          (Date.parse(d.expiresAt) - Date.parse(d.createdAt)) / 1000,
        );
        d.createdAt = d.updatedAt = later;
      },
      expires_off_formula: (d) => (d.expiresAt = plusSeconds(d.expiresAt, 1)),
      scope_not_derived: (d) => (d.scope = { ...d.scope, fields: [...d.scope.fields, "zz"] }),
      parameters_ref_not_derived: (d) => (d.parametersRef.digest = "0".repeat(64)),
    };
    for (const [name, mutate] of Object.entries(ownerCases))
      check(
        "AC02:owner_" + name + "_fails",
        !ownerInsert(storedProposalSql(forgeStored(s, mutate), F.O, ws)).ok,
        name,
      );
    check(
      "AC02:owner_canonical_digest_mismatch_fails",
      !ownerInsert(
        storedProposalSql(
          forgeStored(s, () => {}, { digest: "1".repeat(64) }),
          F.O,
          ws,
        ),
      ).ok,
    );
    // The command role, in A's own tenant context, hits the same bindings.
    for (const name of ["forged_risk", "kill_switch", "forward_dated"])
      check(
        "AC02:command_role_" + name + "_fails",
        !db.tryRun(asCommandRole(a, storedProposalSql(forgeStored(s, ownerCases[name]), F.O, ws)))
          .ok,
        name,
      );
    // The forward-date rule is proposal_bind's own: the parameters and proposal rows
    // alone (no approval row, so approval_bind never runs) fail there, for the owner
    // and the command role, while the same rows of the unforged fixture insert.
    const forward = forgeStored(s, ownerCases.forward_dated);
    const fromBind = (r) =>
      !r.ok &&
      /APPROVAL_RECORD_INVALID/.test(r.stderr) &&
      /PL\/pgSQL function (morrow_work\.)?proposal_bind\(\) line \d+ at RAISE/.test(r.stderr);
    const ownerForward = ownerInsert(proposalOnlySql(forward, F.O, ws));
    const commandForward = db.tryRun(asCommandRole(a, proposalOnlySql(forward, F.O, ws)));
    check(
      "AC02:forward_dated_refused_by_proposal_bind",
      ownerInsert(proposalOnlySql(s, F.O, ws)).ok &&
        db.tryRun(asCommandRole(a, proposalOnlySql(s, F.O, ws))).ok &&
        fromBind(ownerForward) &&
        fromBind(commandForward),
      { owner: ownerForward.stderr, command: commandForward.stderr },
    );
    check("AC02:owner_and_command_nothing_written", same(snapshot(ws), before), snapshot(ws));
  });

  // ===========================================================================
  await section("AC03", async () => {
    const ws = W("W3");
    const a = atW(A, "W3");
    const body = grantsBody(C, F.task("a", ws));
    const commandId = randomUUID();
    const first = await submit(a, body, { commandId });
    const reordered = {
      parameters: body.parameters,
      taskId: body.taskId,
      capabilityId: body.capabilityId,
    };
    const replay = await submit(a, reordered, { commandId });
    check(
      "AC03:applied_then_replayed",
      first.outcome === "applied" &&
        replay.outcome === "replayed" &&
        same(replay.proposalRef, first.proposalRef) &&
        same(replay.approvalRef, first.approvalRef),
      { first, replay },
    );
    const other = await submit(a, grantsBody(D, F.task("a", ws)), { commandId });
    check("AC03:other_body_conflict", other.outcome === "command_conflict", other);
    // The same key on two connections: one effect and one replay.
    const key = randomUUID();
    const before = snapshot(ws);
    const [x, y] = await Promise.all([
      submit(a, body, { commandId: key }),
      submit(a, body, { commandId: key }),
    ]);
    const outcomes = [x.outcome, y.outcome].sort();
    check(
      "AC03:concurrent_one_effect",
      same(outcomes, ["applied", "replayed"]) && snapshot(ws).proposals === before.proposals + 1,
      outcomes,
    );
    // Two first submits racing on revision 1 (fresh workspace W9b has no policy yet).
    const ws2 = W("W9b");
    const a2 = atW(A, "W9b");
    let arrivals = 0,
      release;
    const both = new Promise((resolve) => (release = resolve));
    const hooks = {
      async afterQuery(record) {
        if (record.text.includes("review_context(")) {
          arrivals++;
          if (arrivals === 2) release();
          await Promise.race([both, sleep(20000)]);
        }
      },
    };
    const keyA = randomUUID(),
      keyB = randomUUID();
    const raced = await Promise.all([
      submit(a2, grantsBody(C, F.task("a", ws2)), { commandId: keyA, hooks, retry: false }),
      submit(a2, grantsBody(D, F.task("a", ws2)), { commandId: keyB, hooks, retry: false }),
    ]);
    const kinds = raced.map((r) => r.outcome).sort();
    check("AC03:policy_race_one_stale", same(kinds, ["applied", "stale_authority"]), kinds);
    const loser = raced[0].outcome === "stale_authority" ? [keyA, C] : [keyB, D];
    const retried = await submit(a2, grantsBody(loser[1], F.task("a", ws2)), {
      commandId: loser[0],
    });
    const bound = retried.outcome === "applied" ? proposalRowOf(retried.proposalRef.id) : null;
    check(
      "AC03:retry_binds_revision_1",
      retried.outcome === "applied" && bound?.review_policy_revision === 1,
      retried,
    );
    check(
      "AC03:one_policy",
      Number(
        db.sql(
          `SELECT count(*) FROM morrow_work.review_policies WHERE workspace_id=${literal(ws2)};`,
        ),
      ) === 1,
    );
  });

  // ===========================================================================
  await section("AC04", async () => {
    const ws = W("W4");
    const a = atW(A, "W4"),
      b = atW(B, "W4");
    const s = await applied(a, grantsBody(C, F.task("a", ws)));
    const before = snapshot(ws);
    const r = await decide(b, s.proposalRef.id, decision(s.proposalRef.digest), 1);
    check(
      "AC04:approved",
      r.outcome === "applied" && r.status === "approved" && r.approvalRef.revision === 2,
      r,
    );
    const row = approvalRow(s.approvalRef.id);
    const [d] = db.rows(
      `SELECT to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided FROM morrow_work.approval_decisions WHERE approval_id=${literal(s.approvalRef.id)}`,
    );
    const p = proposalRowOf(s.proposalRef.id);
    check(
      "AC04:counted_b",
      same(row.counted_reviewer_principal_ids, [B.principal]) && row.revision === 2,
    );
    check("AC04:effective_is_decided", row.effective_text === d?.decided);
    check(
      "AC04:expiry_min",
      Date.parse(row.expires_text) ===
        Math.min(Date.parse(p.expires_text), Date.parse(row.effective_text) + 3600 * 1000),
    );
    const after = snapshot(ws);
    check(
      "AC04:one_decision_two_events",
      after.approval_decisions === before.approval_decisions + 1 &&
        after.outbox_events === before.outbox_events + 2,
    );
    const events = db.rows(
      `SELECT event_type, actor_principal_id FROM morrow_work.outbox_events WHERE aggregate_id=${literal(s.approvalRef.id)} ORDER BY position`,
    );
    check(
      "AC04:events_by_b",
      same(
        events.map((e) => e.event_type),
        ["approval.decided", "approval.status_changed"],
      ) && events.every((e) => e.actor_principal_id === B.principal),
      events,
    );
    const view = await read(b, s.proposalRef.id);
    check(
      "AC04:read_valid",
      validateCurrentDefinition("Proposal", view.proposal) &&
        validateCurrentDefinition("Approval", view.approval) &&
        view.approval.status === "approved",
    );
    const sqlDigest = db.sql(
      `SELECT morrow_work.approval_ref_digest(organization_id,workspace_id,id,revision,proposal_digest,scope_digest,status,effective_at,expires_at) FROM morrow_work.approvals WHERE id=${literal(s.approvalRef.id)};`,
    );
    check(
      "AC04:approval_ref_digest_sql",
      view.approvalRef.digest === sqlDigest && r.approvalRef.digest === sqlDigest,
    );
  });

  // ===========================================================================
  await section("AC05", async () => {
    const ws = W("W5");
    const a = atW(A, "W5"),
      c = atW(C, "W5");
    const s = await applied(a, grantsBody(C, F.task("a", ws)));
    const before = snapshot(ws);
    const byA = await decide(a, s.proposalRef.id, decision(s.proposalRef.digest), 1);
    const byC = await decide(c, s.proposalRef.id, decision(s.proposalRef.digest), 1);
    check(
      "AC05:route_self_approval_denied",
      byA.code === "SELF_APPROVAL_DENIED" && byC.code === "SELF_APPROVAL_DENIED",
      { byA, byC },
    );
    for (const [p, name] of [
      [a, "a"],
      [c, "c"],
    ]) {
      const out = apiCall(
        p,
        decideCall([
          randomUUID(),
          "d".repeat(64),
          "corr",
          s.proposalRef.id,
          "1",
          "approve",
          null,
          s.proposalRef.digest,
          null,
          null,
          null,
          null,
          null,
          counted(dbNow()),
        ]),
        "COMMIT",
      );
      check("AC05:direct_refused_" + name, out === "SELF_APPROVAL_DENIED", out);
    }
    check("AC05:nothing_written", same(snapshot(ws), before));
    // Owner SQL cannot record a conflicted approval either (decision_bind).
    const owner = db.tryRun(
      `SET ROLE morrow_work_owner; INSERT INTO morrow_work.approval_decisions VALUES(${literal(F.O)},${literal(ws)},${literal(s.approvalRef.id)},1,${literal(A.principal)},${literal(A.membership)},'approve',${literal(s.proposalRef.digest)},date_trunc('milliseconds',clock_timestamp()),${literal(randomUUID())},${literal("d".repeat(64))},NULL,NULL,NULL);`,
    );
    check("AC05:owner_conflicted_decision_fails", !owner.ok);
  });

  // ===========================================================================
  await section("AC06", async () => {
    const phrase = "approve 1 change for 0 credits";
    const soloSubmit = async (o) => applied(o.S, grantsBody(o.S, o.task));
    const soloDecide = (o, s, text) =>
      decide(
        o.S,
        s.proposalRef.id,
        decision(s.proposalRef.digest, { soloOwnerConfirmation: text }),
        1,
      );
    const O1 = F.soloOrganization("o1");
    const s1 = await soloSubmit(O1);
    const wrong = await soloDecide(O1, s1, "approve 1 changes for 0 credits");
    check("AC06:wrong_phrase", wrong.code === "CONFIRMATION_MISMATCH", wrong);
    // A direct call with the digest of another proposal's phrase is refused.
    const direct = apiCall(
      O1.S,
      decideCall([
        randomUUID(),
        "d".repeat(64),
        "corr",
        s1.proposalRef.id,
        "1",
        "approve",
        null,
        s1.proposalRef.digest,
        null,
        null,
        null,
        sha("approve 2 changes for 0 credits"),
        null,
        counted(dbNow()),
      ]),
      "COMMIT",
    );
    check("AC06:direct_other_phrase", direct === "CONFIRMATION_MISMATCH", direct);
    const ok = await soloDecide(O1, s1, phrase);
    const row = approvalRow(s1.approvalRef.id);
    const [d] = db.rows(
      `SELECT solo_phrase_digest, solo_cool_down_seconds, to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided FROM morrow_work.approval_decisions WHERE approval_id=${literal(s1.approvalRef.id)}`,
    );
    check("AC06:solo_approved", ok.outcome === "applied" && ok.status === "approved", ok);
    check("AC06:cool_down_300", Date.parse(row.effective_text) - Date.parse(d.decided) === 300000);
    check(
      "AC06:phrase_digest_only",
      d.solo_phrase_digest === sha(phrase) && d.solo_cool_down_seconds === 300,
    );
    check(
      "AC06:no_phrase_stored",
      !db
        .sql("SELECT string_agg(row_to_json(x)::text,'') FROM morrow_work.approval_decisions x;")
        .includes(phrase),
    );
    // A back-dated 0004 result 23 h old denies solo; 25 h old allows it.
    for (const [name, age, allowed] of [
      ["o1a", "interval '23 hours'", false],
      ["o1b", "interval '25 hours'", true],
    ]) {
      const o = F.soloOrganization(name, { members: [{ name: "z_" + name, workspace: true }] });
      const s = await soloSubmit(o);
      const z = o.members[0];
      db.admin(
        `UPDATE morrow_identity.workspace_memberships SET active=false WHERE membership_id=${literal(z.membership)}; UPDATE morrow_identity.memberships SET active=false WHERE id=${literal(z.membership)};`,
      );
      db.sql(backdatedRevocationSql(o.S, z, o.ws, age));
      const r = await soloDecide(o, s, phrase);
      check(
        "AC06:quiet_period_" + name,
        allowed ? r.outcome === "applied" : r.code === "SELF_APPROVAL_DENIED",
        r,
      );
    }
    // A second active human member of the organization, outside the workspace.
    const oc = F.soloOrganization("o1c");
    const sc = await soloSubmit(oc);
    F.addMember("m_o1c", oc.org);
    check(
      "AC06:org_level_count",
      (await soloDecide(oc, sc, phrase)).code === "SELF_APPROVAL_DENIED",
    );
    // An inactive signup-owner membership with another sole member.
    const od = F.soloOrganization("o1d", { members: [{ name: "m_o1d", workspace: true }] });
    const m = od.members[0];
    db.admin(
      `INSERT INTO morrow_identity.grants SELECT 'g_m_o1d_'||capability_id,${literal(od.org)},${literal(od.ws)},${literal(m.membership)},${literal(m.principal)},jsonb_build_object('id','g_m_o1d_'||capability_id,'principal',${literal(JSON.stringify(actorRef(m)))}::jsonb,'capabilityId',capability_id,'verbs','["execute","approve"]'::jsonb,'scope',jsonb_build_object('organizationId',${literal(od.org)},'workspaceId',${literal(od.ws)},'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,'resources',jsonb_build_array(${literal(JSON.stringify(workspaceResource(od.org, od.ws)))}::jsonb),'fields','["proposalRef","approvalRef"]'::jsonb),'issuedBy',${literal(JSON.stringify(actorRef(m)))}::jsonb,'validFrom','2026-01-01T00:00:00.000Z','expiresAt',NULL,'revokedAt',NULL,'policyRevision',1) FROM (VALUES ('governance.grants.revise')) v(capability_id);`,
    );
    const sd = await applied(m, grantsBody(m, null));
    db.admin(
      `UPDATE morrow_identity.memberships SET active=false WHERE id=${literal(od.S.membership)};`,
    );
    check(
      "AC06:inactive_owner",
      (
        await decide(
          m,
          sd.proposalRef.id,
          decision(sd.proposalRef.digest, { soloOwnerConfirmation: phrase }),
          1,
        )
      ).code === "SELF_APPROVAL_DENIED",
    );
    // An owner-seeded organization without a signup row.
    const oe = F.soloOrganization("o1e", {
      signup: false,
      members: [{ name: "n_o1e", workspace: true }],
    });
    const se = await soloSubmit(oe);
    db.admin(
      `UPDATE morrow_identity.memberships SET active=false WHERE id=${literal(oe.members[0].membership)};`,
    );
    check("AC06:no_signup_row", (await soloDecide(oe, se, phrase)).code === "SELF_APPROVAL_DENIED");
  });

  // ===========================================================================
  await section("AC07", async () => {
    const o = F.soloOrganization("o7");
    installPolicy(o.org, o.ws, 1, rulesWith({ soloOwner: { coolDownSeconds: 60 } }));
    const phrase = "approve 1 change for 0 credits";
    const solo = async () => {
      const s = await applied(o.S, grantsBody(o.S, o.task));
      const r = await decide(
        o.S,
        s.proposalRef.id,
        decision(s.proposalRef.digest, { soloOwnerConfirmation: phrase }),
        1,
      );
      if (r.outcome !== "applied") throw Error("AC07_SOLO_" + (r.code ?? r.outcome));
      return r;
    };
    const first = await solo();
    const second = await solo();
    const third = await solo();
    const before = snapshot(o.ws);
    const early = await claim(o.S, first);
    check("AC07:not_effective", early.outcome === "APPROVAL_NOT_EFFECTIVE", early);
    check("AC07:not_effective_nothing_written", same(snapshot(o.ws), before));
    const cancelled = await decide(
      o.S,
      second.proposalRef.id,
      decision(second.proposalRef.digest, { decision: "cancel_before_effective" }),
      2,
    );
    check(
      "AC07:cancel_before_effective",
      cancelled.outcome === "applied" && cancelled.status === "cancelled",
      cancelled,
    );
    const firstRow = approvalRow(first.approvalRef.id);
    await sleep(Math.max(0, Date.parse(firstRow.effective_text) - Date.parse(dbNow())) + 1000);
    const late = await decide(
      o.S,
      first.proposalRef.id,
      decision(first.proposalRef.digest, { decision: "cancel_before_effective" }),
      2,
    );
    check("AC07:cancel_after_effective", late.code === "CANCEL_NOT_ALLOWED", late);
    const claimed = await claim(o.S, first);
    check("AC07:claim_after_effective", claimed.outcome === "applied", claimed);
    // A member added after the third decision: solo status is lost at once.
    F.addMember("late_o7", o.org, o.ws);
    const view = await read(o.S, third.proposalRef.id);
    check(
      "AC07:read_projects_lost",
      view.approval?.status === "invalidated",
      view.approval?.status,
    );
    const lost = await claim(o.S, third);
    check("AC07:claim_lost", lost.outcome === "SOLO_OWNER_STATUS_LOST", lost);
    check("AC07:stored_stays_approved", approvalRow(third.approvalRef.id).status === "approved");
    const thirdRow = approvalRow(third.approvalRef.id);
    const projectedAt = (instant) =>
      db.sql(
        `SELECT status||'|'||COALESCE(code,'') FROM morrow_work.approval_projection('approved',${literal(thirdRow.expires_text)}::timestamptz,1,1,false,${literal(o.S.principal)},${literal(thirdRow.effective_text)}::timestamptz-interval '60 seconds',86400,${literal(o.S.principal)},2,NULL,${literal(instant)}::timestamptz);`,
      );
    check(
      "AC07:lost_before_and_after_effective",
      projectedAt(plusSeconds(thirdRow.effective_text, -30)) ===
        "invalidated|SOLO_OWNER_STATUS_LOST" &&
        projectedAt(plusSeconds(thirdRow.effective_text, 30)) ===
          "invalidated|SOLO_OWNER_STATUS_LOST",
    );
  });

  // ===========================================================================
  await section("AC08", async () => {
    const ws = W("W8");
    installPolicy(F.O, ws, 1, structuredClone(defaults.rules));
    installPolicy(F.O, ws, 2, rulesWith({ access_change: { requiredApprovals: 2 } }));
    const a = atW(A, "W8"),
      b = atW(B, "W8"),
      d = atW(D, "W8"),
      r = atW(R, "W8");
    const s = await applied(a, grantsBody(C, F.task("a", ws)));
    const key = randomUUID();
    const first = await decide(
      b,
      s.proposalRef.id,
      decision(s.proposalRef.digest, { comment: "first" }),
      1,
      { commandId: key },
    );
    check(
      "AC08:b_pending",
      first.outcome === "applied" && first.status === "pending" && first.approvalRef.revision === 2,
      first,
    );
    const replay = await decide(
      b,
      s.proposalRef.id,
      decision(s.proposalRef.digest, { comment: "first" }),
      1,
      { commandId: key },
    );
    check(
      "AC08:replay_identical",
      replay.outcome === "replayed" && same({ ...replay, outcome: "applied" }, first),
      replay,
    );
    const conflict = await decide(
      b,
      s.proposalRef.id,
      decision(s.proposalRef.digest, { comment: "other" }),
      1,
      { commandId: key },
    );
    check("AC08:command_conflict", conflict.code === "COMMAND_CONFLICT", conflict);
    const duplicate = await decide(b, s.proposalRef.id, decision(s.proposalRef.digest), 2);
    check("AC08:duplicate_reviewer", duplicate.code === "DUPLICATE_REVIEWER", duplicate);
    const second = await decide(d, s.proposalRef.id, decision(s.proposalRef.digest), 2);
    check(
      "AC08:d_approves",
      second.status === "approved" &&
        same(approvalRow(s.approvalRef.id).counted_reviewer_principal_ids, [
          B.principal,
          D.principal,
        ]),
      second,
    );
    // Stored decisions equal the attempts the fold recorded.
    const view = await read(a, s.proposalRef.id);
    check(
      "AC08:decisions_recorded",
      same(
        view.approval.decisions.map((x) => [x.reviewer.principalId, x.decision, x.comment]),
        [
          [B.principal, "approve", "first"],
          [D.principal, "approve", null],
        ],
      ) && view.approval.decisions[0].commandId === key,
    );
    // A stale earlier approver stops counting.
    const s2 = await applied(a, grantsBody(C, F.task("a", ws)));
    await decide(b, s2.proposalRef.id, decision(s2.proposalRef.digest), 1);
    db.sql(removeSql(b));
    try {
      const byD = await decide(d, s2.proposalRef.id, decision(s2.proposalRef.digest), 2);
      check("AC08:stale_approver_pending", byD.status === "pending", byD);
      const byR = await decide(r, s2.proposalRef.id, decision(s2.proposalRef.digest), 3);
      check(
        "AC08:r_approves_counted_dr",
        byR.status === "approved" &&
          same(approvalRow(s2.approvalRef.id).counted_reviewer_principal_ids, [
            D.principal,
            R.principal,
          ]),
        byR,
      );
    } finally {
      db.sql(restoreSql(b));
    }
    // A counted approver's grant expires between reviewer_snapshot and the command:
    // the expiry is set before the snapshot (same grants digest), and the command
    // is held until database time passes it. A load-delayed snapshot that already
    // sees the grant expired is inconclusive and retried with a longer expiry.
    const gid = "g_b_" + ws + "_governance_approval_decide";
    let expired = null;
    for (const lead of [1500, 3000, 4500]) {
      const s3 = await applied(a, grantsBody(C, F.task("a", ws)));
      await decide(b, s3.proposalRef.id, decision(s3.proposalRef.digest), 1);
      const expiry = db.sql(
        `SELECT to_char((date_trunc('milliseconds',clock_timestamp())+interval '${lead} milliseconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`,
      );
      db.admin(
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{expiresAt}',${literal(JSON.stringify(expiry))}::jsonb) WHERE id=${literal(gid)};`,
      );
      let snapshotAt = null;
      const hooks = {
        async afterQuery(record, _connection, rows) {
          if (record.text.includes("reviewer_snapshot("))
            snapshotAt = rows[0]?.evaluated_at ?? null;
        },
        async beforeQuery(record) {
          if (record.text.includes("cmd_approval_decide("))
            while (Date.parse(dbNow()) <= Date.parse(expiry)) await sleep(100);
        },
      };
      expired = await decide(d, s3.proposalRef.id, decision(s3.proposalRef.digest), 2, {
        hooks,
        retry: false,
      }).catch((e) => ({ error: e?.name }));
      db.admin(
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{expiresAt}','null'::jsonb) WHERE id=${literal(gid)};`,
      );
      if (snapshotAt !== null && Date.parse(snapshotAt) < Date.parse(expiry)) break;
      expired = { inconclusive: true, snapshotAt, expiry };
    }
    check("AC08:grant_expiry_window_stale", expired?.code === "stale_authority", expired);
    // Reject; a stale expectedRevision.
    const s4 = await applied(a, grantsBody(C, F.task("a", ws)));
    const stale = await decide(
      b,
      s4.proposalRef.id,
      decision(s4.proposalRef.digest, { decision: "reject" }),
      3,
    );
    check(
      "AC08:stale_revision",
      stale.code === "STALE_REVISION" || stale.code === "revision_conflict",
      stale,
    );
    const rejected = await decide(
      b,
      s4.proposalRef.id,
      decision(s4.proposalRef.digest, { decision: "reject" }),
      1,
    );
    check("AC08:rejected", rejected.status === "rejected", rejected);

    // counted_current in SQL alone (TypeScript bypassed): D decides a pending
    // approval B approved, naming the counted earlier approvers itself. Each call is
    // a direct cmd_approval_decide in D's freshly entered context (so the prelude is
    // current and only the counted check can refuse), rolled back.
    const s6 = await applied(a, grantsBody(C, F.task("a", ws)));
    await decide(b, s6.proposalRef.id, decision(s6.proposalRef.digest), 1);
    const snapshotOf = (p, ids) =>
      inTx(
        p,
        (tx) => tx.run("reviewerSnapshot", ["governance.grants.revise", JSON.stringify(ids)]),
        { readOnly: true },
      );
    const entry = (row, patch = {}) => ({
      principalId: row.principal_id,
      membershipId: row.membership_id,
      grantsDigest: row.grants_digest,
      ...patch,
    });
    const [bRow] = await snapshotOf(d, [B.principal]);
    const [dRow] = await snapshotOf(d, [D.principal]);
    const [rRow] = await snapshotOf(d, [R.principal]);
    const decideD = (reviewers, evaluatedAt = bRow.evaluated_at) =>
      apiCall(
        d,
        decideCall([
          randomUUID(),
          "d".repeat(64),
          "corr",
          s6.proposalRef.id,
          "2",
          "approve",
          null,
          s6.proposalRef.digest,
          null,
          null,
          null,
          null,
          null,
          counted(evaluatedAt, reviewers),
        ]),
      );
    const bGrant = "g_b_" + ws + "_governance_grants_revise";
    const editGrant = (validFrom) =>
      db.admin(
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{validFrom}',${literal(JSON.stringify(validFrom))}::jsonb) WHERE id=${literal(bGrant)};`,
      );
    const before6 = snapshot(ws);
    const sqlCounted = {
      control_current: [decideD([entry(bRow)]), "applied"],
      wrong_grants_digest: [
        decideD([entry(bRow, { grantsDigest: "0".repeat(64) })]),
        "stale_authority",
      ],
      wrong_membership: [
        decideD([entry(bRow, { membershipId: R.membership })]),
        "REVIEWER_AUTHORITY_LOST",
      ],
      no_approve_decision: [decideD([entry(rRow)]), "invalid"],
      decider_counted: [decideD([entry(bRow), entry(dRow)]), "invalid"],
      duplicate_reviewer: [decideD([entry(bRow), entry(bRow)]), "invalid"],
      evaluated_in_future: [decideD([entry(bRow)], plusSeconds(dbNow(), 3600)), "stale_authority"],
    };
    // A counted reviewer's grant edited after the snapshot, with no organization
    // revision bump: its grants digest no longer matches.
    editGrant("2025-12-31T00:00:00.000Z");
    try {
      sqlCounted.grant_edited_after_snapshot = [decideD([entry(bRow)]), "stale_authority"];
    } finally {
      editGrant("2026-01-01T00:00:00.000Z");
    }
    for (const [name, [got, want]] of Object.entries(sqlCounted))
      check("AC08:sql_counted_" + name, got === want, { got, want });
    check("AC08:sql_counted_nothing_written", same(snapshot(ws), before6), snapshot(ws));
    // The same edit through the module: it lands between reviewer_snapshot and the
    // command, so the Worker counted B on the old digest and SQL refuses.
    let edited = false;
    const editedRun = await decide(d, s6.proposalRef.id, decision(s6.proposalRef.digest), 2, {
      retry: false,
      hooks: {
        async afterQuery(record) {
          if (!edited && record.text.includes("reviewer_snapshot(")) {
            edited = true;
            editGrant("2025-12-31T00:00:00.000Z");
          }
        },
      },
    }).catch((e) => ({ error: e?.name }));
    editGrant("2026-01-01T00:00:00.000Z");
    const afterEdit = await decide(d, s6.proposalRef.id, decision(s6.proposalRef.digest), 2);
    check(
      "AC08:grant_edited_after_snapshot_stale",
      edited &&
        editedRun.code === "stale_authority" &&
        afterEdit.status === "approved" &&
        same(approvalRow(s6.approvalRef.id).counted_reviewer_principal_ids, [
          B.principal,
          D.principal,
        ]),
      { editedRun, afterEdit },
    );

    // approval_claim's counted set must equal the stored one exactly: A claims the
    // first proposal (counted [B, D]); TypeScript prepares, then each variant of the
    // counted set goes to SQL.
    const sRefs = {
      proposalRef: second.proposalRef,
      approvalRef: second.approvalRef,
      capabilityId: "governance.grants.revise",
    };
    const prepared8 = await inTx(a, (tx, x) => ap.prepareApprovalClaim(tx, x, sRefs), {
      readOnly: true,
    });
    const bClaim = prepared8.counted?.reviewers.find((x) => x.principalId === B.principal);
    const dClaim = prepared8.counted?.reviewers.find((x) => x.principalId === D.principal);
    const [rClaim] = await snapshotOf(a, [R.principal]);
    const withCounted = (reviewers) =>
      claim(a, sRefs, {
        prepared: prepared8,
        countedJson: counted(prepared8.counted.evaluatedAt, reviewers),
      });
    const claimCounted = {
      strict_subset: [await withCounted([bClaim]), "invalid"],
      strict_superset: [await withCounted([bClaim, dClaim, entry(rClaim)]), "invalid"],
      other_set: [await withCounted([bClaim, entry(rClaim)]), "invalid"],
      wrong_grants_digest: [
        await withCounted([bClaim, { ...dClaim, grantsDigest: "0".repeat(64) }]),
        "stale_authority",
      ],
    };
    for (const [name, [got, want]] of Object.entries(claimCounted))
      check("AC08:claim_counted_" + name, got.outcome === want && got.stage === "sql", {
        got,
        want,
      });
    const exact = await claim(a, sRefs, { prepared: prepared8 });
    check("AC08:claim_counted_exact_applies", exact.outcome === "applied", exact);
  });

  // ===========================================================================
  await section("AC09", async () => {
    const ws = W("W9");
    installPolicy(
      F.O,
      ws,
      1,
      rulesWith({ irreversible: { pendingExpirySeconds: 43200, approvedValiditySeconds: 1800 } }),
    );
    const a = atW(A, "W9"),
      b = atW(B, "W9");
    const s = await applied(a, eraseBody(["s1", "s2", "s3"], F.task("a", ws)));
    const parentRow = approvalRow(s.approvalRef.id);
    check(
      "AC09:merged_snapshot",
      parentRow.pending_expiry_seconds === 43200 && parentRow.approved_validity_seconds === 1800,
    );
    const parentView = await read(b, s.proposalRef.id);
    const preview = await read(b, s.proposalRef.id, [0, 1]);
    const derivedId = preview.proposal.id;
    check(
      "AC09:preview_unstored",
      preview.approval === null &&
        derivedId === ap.derivedProposalId(proposalRef(parentView.proposal), [0, 1]),
    );
    const sqlId = db.sql(
      `SELECT morrow_work.derived_proposal_id(${literal(F.O)},${literal(ws)},${literal(s.proposalRef.id)},${literal(s.proposalRef.digest)},ARRAY[0,1]);`,
    );
    check("AC09:derived_id_sql", sqlId === derivedId);
    const key = randomUUID();
    const sel = decision(preview.proposal.proposalDigest, { selectedTargetIndexes: [0, 1] });
    const r = await decide(b, s.proposalRef.id, sel, 1, { commandId: key });
    check(
      "AC09:derived_approved",
      r.outcome === "applied" && r.status === "approved" && r.proposalRef.id === derivedId,
      r,
    );
    const again = await decide(b, s.proposalRef.id, sel, 1, { commandId: key });
    check(
      "AC09:derivation_idempotent",
      again.outcome === "replayed" &&
        Number(
          db.sql(`SELECT count(*) FROM morrow_work.proposals WHERE id=${literal(derivedId)};`),
        ) === 1,
    );
    const stored = await read(b, s.proposalRef.id, [0, 1]);
    check(
      "AC09:byte_identical_to_preview",
      canonicalize(stored.proposal) === canonicalize(preview.proposal) &&
        stored.approval?.status === "approved",
    );
    check(
      "AC09:parent_superseded",
      approvalRow("approval_" + derivedId)?.status === "approved" &&
        approvalRow(s.approvalRef.id).status === "invalidated" &&
        approvalRow(s.approvalRef.id).invalidation_reason === "superseded_by_partial_approval",
    );
    const [inherited] = db.rows(
      `SELECT (SELECT expires_at FROM morrow_work.approvals WHERE id=${literal(s.approvalRef.id)})=(SELECT created_at+make_interval(secs=>43200) FROM morrow_work.approvals WHERE id=${literal(s.approvalRef.id)}) AS root_pending`,
    );
    check("AC09:root_pending_formula", inherited?.root_pending === true);
    const parentAgain = await decide(b, s.proposalRef.id, decision(s.proposalRef.digest), 2);
    check("AC09:parent_family_conflict", parentAgain.code === "FAMILY_CONFLICT", parentAgain);
    const p2 = previewSelection(parentView.proposal, [2]).proposal;
    const derive2 = await decide(
      b,
      s.proposalRef.id,
      decision(p2.proposalDigest, { selectedTargetIndexes: [2] }),
      2,
    );
    check("AC09:derive_after_approved_conflict", derive2.code === "FAMILY_CONFLICT", derive2);
    const mismatch = await decide(
      b,
      s.proposalRef.id,
      decision(preview.proposal.proposalDigest, { selectedTargetIndexes: [0] }),
      2,
    );
    check("AC09:digest_mismatch", mismatch.code === "DIGEST_MISMATCH", mismatch);
    // Invalid selections on a fresh family.
    const f = await applied(a, eraseBody(["t1", "t2", "t3"], F.task("a", ws)));
    for (const [name, selection, codes] of [
      ["reversed", [1, 0], ["SELECTION_INVALID"]],
      ["duplicate", [0, 0], ["SELECTION_INVALID", "invalid"]],
      ["out_of_range", [3], ["SELECTION_INVALID"]],
      ["not_strict", [0, 1, 2], ["SELECTION_INVALID"]],
    ]) {
      const out = await decide(
        b,
        f.proposalRef.id,
        decision(f.proposalRef.digest, { selectedTargetIndexes: selection }),
        1,
      );
      check("AC09:selection_" + name, codes.includes(out.code), out);
    }
    const ofDerived = await decide(
      b,
      derivedId,
      decision(preview.proposal.proposalDigest, { selectedTargetIndexes: [0] }),
      2,
    );
    check(
      "AC09:derivation_of_derivation",
      ["SELECTION_INVALID", "invalid"].includes(ofDerived.code),
      ofDerived,
    );
    const g = await applied(a, grantsBody(C, F.task("a", ws)));
    const whole = await decide(
      b,
      g.proposalRef.id,
      decision(g.proposalRef.digest, { selectedTargetIndexes: [0] }),
      1,
    );
    check(
      "AC09:all_or_nothing",
      ["PARTIAL_APPROVAL_NOT_ALLOWED", "SELECTION_INVALID"].includes(whole.code),
      whole,
    );
    // With quorum 2: a pending derivation, then the root rejected closes the family.
    const ws2 = W("W19");
    installPolicy(F.O, ws2, 1, rulesWith({ irreversible: { requiredApprovals: 2 } }));
    const a2 = atW(A, "W19"),
      b2 = atW(B, "W19"),
      d2 = atW(D, "W19");
    const q = await applied(a2, eraseBody(["u1", "u2", "u3"], F.task("a", ws2)));
    const qv = (await read(b2, q.proposalRef.id)).proposal;
    const q0 = previewSelection(qv, [0]).proposal;
    const pend = await decide(
      b2,
      q.proposalRef.id,
      decision(q0.proposalDigest, { selectedTargetIndexes: [0] }),
      1,
    );
    check(
      "AC09:quorum2_derived_pending",
      pend.status === "pending" && pend.proposalRef.id === q0.id,
      pend,
    );
    // While pending, the derived approval carries the root approval's creation and
    // expiry: a selection never extends the pending window.
    const q0Row = approvalRow("approval_" + q0.id);
    const qRootRow = approvalRow(q.approvalRef.id);
    check(
      "AC09:inherits_expiry",
      q0Row?.status === "pending" &&
        q0Row.expires_text === qRootRow.expires_text &&
        q0Row.created_text === qRootRow.created_text &&
        pend.expiresAt === qRootRow.expires_text,
      { derived: q0Row?.expires_text, root: qRootRow?.expires_text },
    );
    const rej = await decide(
      d2,
      q.proposalRef.id,
      decision(q.proposalRef.digest, { decision: "reject" }),
      1,
    );
    const closed = approvalRow("approval_" + q0.id);
    check(
      "AC09:root_rejected_family_closed",
      rej.status === "rejected" &&
        closed.status === "invalidated" &&
        closed.invalidation_reason === "family_closed",
      { rej, closed: closed?.status },
    );
    // A later derivation of the rejected root: no member is approved, so the review
    // library's fold says APPROVAL_NOT_PENDING, and SQL (TypeScript bypassed) agrees.
    const q1 = previewSelection(qv, [1]).proposal;
    const later = await decide(
      d2,
      q.proposalRef.id,
      decision(q1.proposalDigest, { selectedTargetIndexes: [1] }),
      2,
    );
    const derivedArgs = (proposal) => {
      const { proposalDigest: digest, ...content } = proposal;
      return [canonicalize(content), digest, canonicalize(proposal.scope)];
    };
    const [q1text, q1digest, q1scope] = derivedArgs(q1);
    const laterSql = apiCall(
      d2,
      decideCall([
        randomUUID(),
        "d".repeat(64),
        "corr",
        q.proposalRef.id,
        "2",
        "approve",
        "[1]",
        q1digest,
        q1text,
        q1digest,
        q1scope,
        null,
        null,
        counted(dbNow()),
      ]),
    );
    check(
      "AC09:later_derivation_not_pending",
      later.code === "APPROVAL_NOT_PENDING" && laterSql === "APPROVAL_NOT_PENDING",
      { later, laterSql },
    );
    // Owner SQL: a derived approval with a later expiry fails approval_bind; a
    // second approved member violates approvals_one_approved_per_family.
    const fDoc = (await read(b, f.proposalRef.id)).proposal;
    const f0 = previewSelection(fDoc, [0]).proposal;
    const { proposalDigest: f0digest, ...f0content } = f0;
    const f0text = canonicalize(f0content);
    const fRow = proposalRowOf(f.proposalRef.id);
    const derivedInsert = `INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at) SELECT organization_id,workspace_id,${literal(f0.id)},1,id,id,digest,ARRAY[0],task_id,capability_id,risk,irreversible,'all_or_nothing',1,${f0.maximumCredits},proposer_principal_id,proposer_membership_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,parameters_id,parameters_digest,${literal(f0text)},${literal(f0digest)},${literal(canonicalize(f0.scope))},${literal(sha(canonicalize(f0.scope)))},expires_at,created_at FROM morrow_work.proposals WHERE id=${literal(f.proposalRef.id)};`;
    const derivedApproval = (shift) =>
      `INSERT INTO morrow_work.approvals SELECT organization_id,workspace_id,${literal("approval_" + f0.id)},1,${literal(f0.id)},${literal(f0digest)},family_root_id,'pending',required_approvals,self_approval,pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,NULL,${literal(sha(canonicalize(f0.scope)))},review_policy_revision,policy_revision,NULL,expires_at+interval '${shift} second',NULL,created_at,updated_at FROM morrow_work.approvals WHERE proposal_id=${literal(f.proposalRef.id)};`;
    const control = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; ${derivedInsert} ${derivedApproval(0)} ROLLBACK;`,
    );
    const lateExpiry = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; ${derivedInsert} ${derivedApproval(1)} ROLLBACK;`,
    );
    check("AC09:owner_derived_control_ok", control.ok && fRow.target_count === 3, control.stderr);
    check(
      "AC09:owner_later_expiry_fails",
      !lateExpiry.ok && /APPROVAL_RECORD_INVALID/.test(lateExpiry.stderr),
    );
    const twoApproved = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; ALTER TABLE morrow_work.approvals DISABLE TRIGGER enforce_status; UPDATE morrow_work.approvals SET status='approved',invalidation_reason=NULL,effective_at=updated_at,counted_reviewer_principal_ids=ARRAY['person_b'],revision=revision+1 WHERE id=${literal(s.approvalRef.id)}; ROLLBACK;`,
    );
    check(
      "AC09:owner_second_approved_unique",
      !twoApproved.ok && /approvals_one_approved_per_family/.test(twoApproved.stderr),
    );

    // The published family cap: with quorum 2 every derivation stays pending, so a
    // reviewer could otherwise derive every subset. A family holds at most 25
    // derived proposals; the 26th is limit_reached in TypeScript and, with
    // TypeScript bypassed, in SQL under the root lock; nothing is written.
    const ws3 = W("W9c");
    installPolicy(F.O, ws3, 1, rulesWith({ irreversible: { requiredApprovals: 2 } }));
    const a3 = atW(A, "W9c"),
      b3 = atW(B, "W9c");
    const capped = await applied(a3, eraseBody(["c1", "c2", "c3", "c4", "c5"], F.task("a", ws3)));
    const cappedView = (await read(b3, capped.proposalRef.id)).proposal;
    const subsets = [];
    for (let mask = 1; mask < 31; mask++)
      subsets.push([0, 1, 2, 3, 4].filter((i) => mask & (1 << i)));
    let derivedCount = 0;
    for (const selection of subsets.slice(0, ap.approvalCaps.familyDerivations)) {
      const r = await decide(
        b3,
        capped.proposalRef.id,
        decision(previewSelection(cappedView, selection).proposal.proposalDigest, {
          selectedTargetIndexes: selection,
        }),
        1,
      );
      if (r.outcome === "applied" && r.status === "pending") derivedCount++;
    }
    const beforeCap = snapshot(ws3);
    const overTs = subsets[ap.approvalCaps.familyDerivations];
    const capTs = await decide(
      b3,
      capped.proposalRef.id,
      decision(previewSelection(cappedView, overTs).proposal.proposalDigest, {
        selectedTargetIndexes: overTs,
      }),
      1,
    );
    const overSql = subsets[ap.approvalCaps.familyDerivations + 1];
    const [capText, capDigest, capScope] = derivedArgs(
      previewSelection(cappedView, overSql).proposal,
    );
    const capSql = apiCall(
      b3,
      decideCall([
        randomUUID(),
        "d".repeat(64),
        "corr",
        capped.proposalRef.id,
        "1",
        "approve",
        JSON.stringify(overSql),
        capDigest,
        capText,
        capDigest,
        capScope,
        null,
        null,
        counted(dbNow()),
      ]),
      "COMMIT",
    );
    check(
      "AC09:family_derivation_cap",
      ap.approvalCaps.familyDerivations === 25 &&
        derivedCount === 25 &&
        capTs.code === "limit_reached" &&
        capSql === "limit_reached" &&
        same(snapshot(ws3), beforeCap),
      { derivedCount, capTs, capSql },
    );
  });

  // ===========================================================================
  await section("AC10", async () => {
    const ws = W("W10");
    const created = plusSeconds(dbNow(), -(86400 + 1));
    const policy = installPolicy(
      F.O,
      ws,
      1,
      structuredClone(defaults.rules),
      plusSeconds(created, -10),
    );
    const a = atW(A, "W10"),
      b = atW(B, "W10");
    const s = storedProposal({
      org: F.O,
      ws,
      proposer: A,
      taskId: F.task("a", ws),
      capabilityId: "governance.grants.revise",
      targets: grantsTarget(F.O, ws, C.principal),
      beneficiaries: [C.principal],
      policy,
      createdAt: created,
    });
    db.workOwner(storedProposalSql(s, F.O, ws));
    const view = await read(b, s.doc.id);
    check("AC10:read_expired", view.approval?.status === "expired", view.approval?.status);
    const listed = await list(b, null, 25);
    check("AC10:not_listed", !listed.items.some((i) => i.proposalRef.id === s.doc.id));
    const before = snapshot(ws);
    const decided = await decide(b, s.doc.id, decision(s.digest), 1);
    const withdrawn = await withdraw(a, s.doc.id, 1);
    check(
      "AC10:decide_expired",
      decided.code === "APPROVAL_EXPIRED" &&
        ap.approvalErrors.APPROVAL_EXPIRED.code === "approval_expired",
      decided,
    );
    check("AC10:withdraw_expired", withdrawn.code === "APPROVAL_EXPIRED", withdrawn);
    check(
      "AC10:nothing_written",
      same(snapshot(ws), before) && approvalRow(s.approvalId).status === "pending",
    );
    const exp = approvalRow(s.approvalId).expires_text;
    const proj = (instant) =>
      db.sql(
        `SELECT status||'|'||COALESCE(code,'') FROM morrow_work.approval_projection('pending',${literal(exp)}::timestamptz,1,1,false,NULL,NULL,86400,NULL,1,NULL,${literal(instant)}::timestamptz);`,
      );
    check(
      "AC10:projection_boundary",
      proj(new Date(Date.parse(exp) - 1).toISOString()) === "pending|" &&
        proj(exp) === "expired|APPROVAL_EXPIRED",
    );
    // A back-dated approved approval past its expiry cannot be claimed.
    const t = storedProposal({
      org: F.O,
      ws,
      proposer: A,
      taskId: F.task("a", ws),
      capabilityId: "governance.grants.revise",
      targets: grantsTarget(F.O, ws, C.principal),
      beneficiaries: [C.principal],
      policy,
      createdAt: plusSeconds(dbNow(), -7200),
    });
    db.workOwner(
      storedProposalSql(t, F.O, ws) +
        `
INSERT INTO morrow_work.approval_decisions VALUES(${literal(F.O)},${literal(ws)},${literal(t.approvalId)},1,${literal(B.principal)},${literal(B.membership)},'approve',${literal(t.digest)},${literal(plusSeconds(t.doc.createdAt, 60))}::timestamptz,${literal(randomUUID())},${literal("d".repeat(64))},NULL,NULL,NULL);
UPDATE morrow_work.approvals SET status='approved',revision=2,updated_at=${literal(plusSeconds(t.doc.createdAt, 60))}::timestamptz,effective_at=${literal(plusSeconds(t.doc.createdAt, 60))}::timestamptz,expires_at=${literal(plusSeconds(t.doc.createdAt, 3660))}::timestamptz,counted_reviewer_principal_ids=ARRAY[${literal(B.principal)}] WHERE id=${literal(t.approvalId)};`,
    );
    const refs = { proposalRef: proposalRef(t.doc), approvalRef: null };
    const stored = approvalRow(t.approvalId);
    refs.approvalRef = {
      organizationId: F.O,
      workspaceId: ws,
      storeId: null,
      kind: "approval",
      id: t.approvalId,
      revision: 2,
      digest: ap.approvalRefDigest({
        organizationId: F.O,
        workspaceId: ws,
        id: t.approvalId,
        revision: 2,
        proposalDigest: t.digest,
        scopeDigest: stored.scope_digest,
        status: "approved",
        effectiveAt: stored.effective_text,
        expiresAt: stored.expires_text,
      }),
    };
    const c1 = await claim(a, refs);
    check("AC10:claim_expired_ts", c1.outcome === "APPROVAL_EXPIRED", c1);
    const prepared = {
      approvalId: t.approvalId,
      approvalRevision: 2,
      approvalDigest: refs.approvalRef.digest,
      proposalId: t.doc.id,
      proposalDigest: t.digest,
      capabilityId: "governance.grants.revise",
      countedJson: counted(dbNow(), []),
    };
    const c2 = await claim(a, refs, { prepared });
    check("AC10:claim_expired_sql", c2.outcome === "APPROVAL_EXPIRED", c2);
  });

  // ===========================================================================
  await section("AC11", async () => {
    const ws = W("W11");
    const a = atW(A, "W11"),
      b = atW(B, "W11");
    const s = await applied(a, grantsBody(C, F.task("a", ws)));
    installPolicy(F.O, ws, 2, structuredClone(defaults.rules));
    const before = snapshot(ws);
    const r = await decide(b, s.proposalRef.id, decision(s.proposalRef.digest), 1);
    check("AC11:not_current", r.code === "REVIEW_POLICY_NOT_CURRENT", r);
    check("AC11:nothing_written", same(snapshot(ws), before));
    const view = await read(b, s.proposalRef.id);
    check("AC11:read_invalidated", view.approval.status === "invalidated");
    check(
      "AC11:not_listed",
      !(await list(b, null, 25)).items.some((i) => i.proposalRef.id === s.proposalRef.id),
    );
    const n = await applied(a, grantsBody(C, F.task("a", ws)));
    check("AC11:new_binds_rev2", proposalRowOf(n.proposalRef.id).review_policy_revision === 2);
  });

  // ===========================================================================
  await section("AC12", async () => {
    const ws = W("W12");
    const a = atW(A, "W12"),
      b = atW(B, "W12");
    const s = await applied(a, grantsBody(C, F.task("a", ws)));
    const d = await decide(b, s.proposalRef.id, decision(s.proposalRef.digest), 1);
    // The consumer's refs name the capability it executes (governance.grants.revise).
    const refs = {
      proposalRef: d.proposalRef,
      approvalRef: d.approvalRef,
      capabilityId: "governance.grants.revise",
    };
    // Refusals first: wrong refs, a claimant without execute, an effect error.
    const wrongRev = await claim(a, { ...refs, approvalRef: { ...refs.approvalRef, revision: 1 } });
    const wrongDigest = await claim(a, {
      ...refs,
      approvalRef: { ...refs.approvalRef, digest: "0".repeat(64) },
    });
    const wrongProposal = await claim(a, {
      ...refs,
      proposalRef: { ...refs.proposalRef, digest: "0".repeat(64) },
    });
    check(
      "AC12:digest_mismatch_ts",
      [wrongRev, wrongDigest, wrongProposal].every((x) => x.outcome === "DIGEST_MISMATCH"),
      [wrongRev, wrongDigest, wrongProposal],
    );
    const prepared = await inTx(a, (tx, x) => ap.prepareApprovalClaim(tx, x, refs), {
      readOnly: true,
    });
    const sqlDigest = await claim(a, refs, { prepared, approvalDigest: "0".repeat(64) });
    const sqlRevision = await claim(a, refs, { prepared, revision: 1 });
    const sqlProposal = await claim(a, refs, { prepared, proposalDigest: "0".repeat(64) });
    check(
      "AC12:digest_mismatch_sql",
      [sqlDigest, sqlRevision, sqlProposal].every((x) => x.outcome === "DIGEST_MISMATCH"),
      [sqlDigest, sqlRevision, sqlProposal],
    );
    // A consumer of another capability cannot spend this approval: the TS prepare
    // and approval_claim (with prepared values for the right refs) both refuse.
    const otherCapabilityTs = await claim(a, { ...refs, capabilityId: "governance.privacy.erase" });
    const otherCapabilitySql = await claim(a, refs, {
      prepared,
      capability: "governance.privacy.erase",
    });
    check(
      "AC12:capability_mismatch",
      otherCapabilityTs.outcome === "DIGEST_MISMATCH" &&
        otherCapabilityTs.stage === "prepare" &&
        otherCapabilitySql.outcome === "DIGEST_MISMATCH" &&
        otherCapabilitySql.stage === "sql",
      { otherCapabilityTs, otherCapabilitySql },
    );
    check("AC12:claimant_without_execute", (await claim(b, refs)).outcome === "denied");
    const failed = await claim(a, refs, { fail: true, retry: false }).catch((e) => ({
      outcome: "error:" + e?.name,
    }));
    const noRows = Number(
      db.sql(
        `SELECT (SELECT count(*) FROM morrow_work.approval_claims WHERE workspace_id=${literal(ws)})+(SELECT count(*) FROM morrow_identity.lab_effects WHERE workspace_id=${literal(ws)});`,
      ),
    );
    check("AC12:effect_error_leaves_nothing", failed.outcome !== "applied" && noRows === 0, failed);
    // A counted reviewer removed: refused (kernel) and rolled back. The SQL half runs
    // in A's freshly entered context, so its prelude is current and approval_claim's
    // counted check alone refuses (the reviewer is no longer a member).
    db.sql(removeSql(b));
    try {
      const lost = await claim(a, refs);
      check("AC12:reviewer_authority_lost", lost.outcome === "REVIEWER_AUTHORITY_LOST", lost);
      const sqlLost = await claim(a, refs, { prepared });
      check(
        "AC12:reviewer_authority_lost_sql",
        sqlLost.outcome === "REVIEWER_AUTHORITY_LOST" && sqlLost.stage === "sql",
        sqlLost,
      );
    } finally {
      db.sql(restoreSql(b));
    }
    // The claim: one row, one effect from the stored parameters, one event. Its
    // COMMIT reply is lost (an unknown outcome); the consumer reads it back by
    // resending the same prepared values and command ID: `replayed`, the same
    // effect, nothing written.
    const fresh = await inTx(a, (tx, x) => ap.prepareApprovalClaim(tx, x, refs), {
      readOnly: true,
    });
    const before = approvalRow(s.approvalRef.id);
    const claimKey = randomUUID();
    let loseCommit = true;
    const unknown = await claim(a, refs, {
      prepared: fresh,
      commandId: claimKey,
      retry: false,
      hooks: {
        async afterQuery(record, connection) {
          if (loseCommit && record.text === "COMMIT") {
            loseCommit = false;
            await connection.loseReply();
          }
        },
      },
    }).catch((e) => ({ outcome: e instanceof WorkOutcomeUnknown ? "uncertain" : e?.name }));
    const c = await claim(a, refs, { prepared: fresh, commandId: claimKey });
    const committedEffect = db.sql(
      `SELECT id FROM morrow_identity.lab_effects WHERE consumer_command_id=${literal(claimKey)};`,
    );
    check(
      "AC12:claimed_unknown_commit_read_back",
      unknown.outcome === "uncertain" &&
        c.outcome === "replayed" &&
        c.effect_id === committedEffect &&
        committedEffect.length > 0,
      { unknown, c },
    );
    // The read-back belongs to that claimant alone.
    const otherClaimant = await claim(b, refs, { prepared: fresh, commandId: claimKey });
    check(
      "AC12:read_back_other_claimant_refused",
      otherClaimant.outcome === "APPROVAL_ALREADY_CLAIMED",
      otherClaimant,
    );
    const [row] = db.rows(
      `SELECT family_root_id, consumer FROM morrow_work.approval_claims WHERE approval_id=${literal(s.approvalRef.id)}`,
    );
    const effects = db.rows(
      `SELECT detail AS beneficiary_principal_id FROM morrow_identity.lab_effects WHERE workspace_id=${literal(ws)} AND capability_id='governance.grants.revise'`,
    );
    const claimedEvents = db.rows(
      `SELECT payload FROM morrow_work.outbox_events WHERE event_type='approval.claimed' AND aggregate_id=${literal(s.approvalRef.id)}`,
    );
    check(
      "AC12:one_claim_family_root",
      row?.family_root_id === s.proposalRef.id && row.consumer === "lab.consumer",
    );
    check(
      "AC12:effect_from_stored_parameters",
      effects.length === 1 && effects[0].beneficiary_principal_id === C.principal,
    );
    check(
      "AC12:one_claimed_event",
      claimedEvents.length === 1 && same(claimedEvents[0].payload, { consumer: "lab.consumer" }),
    );
    const after = approvalRow(s.approvalRef.id);
    check(
      "AC12:status_revision_unchanged",
      after.status === before.status && after.revision === before.revision,
    );
    const again = await claim(a, refs);
    const againSql = await claim(a, refs, { prepared: fresh });
    check(
      "AC12:second_claim_refused",
      again.outcome === "APPROVAL_ALREADY_CLAIMED" &&
        againSql.outcome === "APPROVAL_ALREADY_CLAIMED",
      { again, againSql },
    );
    check(
      "AC12:no_second_effect",
      Number(
        db.sql(
          `SELECT count(*) FROM morrow_identity.lab_effects WHERE workspace_id=${literal(ws)} AND capability_id='governance.grants.revise';`,
        ),
      ) === 1,
    );
    // Withdrawing the claimed root is a command on a consumed family.
    const beforeWithdraw = snapshot(ws);
    const withdrawn = await withdraw(a, s.proposalRef.id, Number(before.revision));
    check(
      "AC12:withdraw_claimed_family_conflict",
      withdrawn.code === "FAMILY_CONFLICT" && same(snapshot(ws), beforeWithdraw),
      withdrawn,
    );
    check(
      "AC12:update_of_claimed_raises",
      !db.tryRun(
        `SET ROLE morrow_work_owner; UPDATE morrow_work.approvals SET revision=revision+1,updated_at=updated_at WHERE id=${literal(s.approvalRef.id)};`,
      ).ok,
    );
    check(
      "AC12:owner_second_claim_unique",
      !db.tryRun(
        `SET ROLE morrow_work_owner; INSERT INTO morrow_work.approval_claims VALUES(${literal(F.O)},${literal(ws)},${literal(s.approvalRef.id)},${literal(s.proposalRef.id)},${literal(A.principal)},${literal(A.membership)},'lab.other',${literal(randomUUID())},date_trunc('milliseconds',clock_timestamp()));`,
      ).ok,
    );
    check(
      "AC12:api_cannot_call_claim",
      /permission denied/.test(
        db.tryRun(
          asApi(
            a,
            `SELECT * FROM morrow_work.approval_claim('x','1','${"a".repeat(64)}','p','${"a".repeat(64)}','governance.grants.revise','lab.x','${randomUUID()}','{}');`,
          ),
          { user: "morrow_api_worker" },
        ).stderr,
      ),
    );
    // A claimed family of a partial approval: no member can be claimed again, and
    // no decision or derivation in it succeeds.
    const e = await applied(a, eraseBody(["v1", "v2", "v3"], F.task("a", ws)));
    const ev = (await read(b, e.proposalRef.id)).proposal;
    const e01 = previewSelection(ev, [0, 1]).proposal;
    const de = await decide(
      b,
      e.proposalRef.id,
      decision(e01.proposalDigest, { selectedTargetIndexes: [0, 1] }),
      1,
    );
    const ce = await claim(a, {
      proposalRef: de.proposalRef,
      approvalRef: de.approvalRef,
      capabilityId: "governance.privacy.erase",
    });
    check("AC12:derived_claimed", ce.outcome === "applied", ce);
    // The derived proposal's effect covers only its own (selected) targets.
    const erased = db.sql(
      `SELECT detail FROM morrow_identity.lab_effects WHERE workspace_id=${literal(ws)} AND capability_id='governance.privacy.erase';`,
    );
    check(
      "AC12:derived_effect_selected_targets_only",
      erased === '["subject:v1", "subject:v2"]',
      erased,
    );
    // The root (invalidated by the derivation, its family claimed): the claim is
    // checked first in TS and SQL alike, before any projection or status.
    const parentRef = {
      proposalRef: e.proposalRef,
      approvalRef: (await read(b, e.proposalRef.id)).approvalRef,
      capabilityId: "governance.privacy.erase",
    };
    const cp = await claim(a, parentRef);
    const cpSql = await claim(a, parentRef, {
      prepared: {
        approvalId: parentRef.approvalRef.id,
        approvalRevision: parentRef.approvalRef.revision,
        approvalDigest: parentRef.approvalRef.digest,
        proposalId: e.proposalRef.id,
        proposalDigest: e.proposalRef.digest,
        capabilityId: "governance.privacy.erase",
        countedJson: counted(dbNow(), []),
      },
    });
    check(
      "AC12:family_member_claim_refused",
      cp.outcome === "APPROVAL_ALREADY_CLAIMED" &&
        cp.stage === "prepare" &&
        cpSql.outcome === "APPROVAL_ALREADY_CLAIMED" &&
        cpSql.stage === "sql",
      { cp, cpSql },
    );
    const rootWithdraw = await withdraw(a, e.proposalRef.id, parentRef.approvalRef.revision);
    check(
      "AC12:withdraw_claimed_root_family_conflict",
      rootWithdraw.code === "FAMILY_CONFLICT",
      rootWithdraw,
    );
    const after2 = await decide(
      b,
      e.proposalRef.id,
      decision(previewSelection(ev, [2]).proposal.proposalDigest, { selectedTargetIndexes: [2] }),
      2,
    );
    check("AC12:claimed_family_closed", after2.code === "FAMILY_CONFLICT", after2);
    // After its expiry a claimed approval stays consumed: an owner-built family
    // (a three-target erase root approved two hours ago, expired an hour ago, then
    // claimed) admits no decision or derivation, through the module or directly.
    const [w12policy] = db.rows(
      `SELECT canonical, digest FROM morrow_work.review_policies WHERE workspace_id=${literal(ws)} ORDER BY revision DESC LIMIT 1`,
    );
    const old = storedProposal({
      org: F.O,
      ws,
      proposer: A,
      taskId: F.task("a", ws),
      capabilityId: "governance.privacy.erase",
      targets: ["o1", "o2", "o3"].map((subject, i) => ({
        resource: workspaceResource(F.O, ws),
        expectedSourceRevision: "subject:" + subject,
        fields: ["subjectRef"],
        maximumCredits: String(i + 1),
        maximumCost: null,
      })),
      partialApproval: "allowed",
      policy: { doc: JSON.parse(w12policy.canonical), digest: w12policy.digest },
      createdAt: plusSeconds(dbNow(), -7200),
    });
    const oldDecided = plusSeconds(old.doc.createdAt, 60);
    db.workOwner(
      storedProposalSql(old, F.O, ws) +
        `
INSERT INTO morrow_work.approval_decisions VALUES(${literal(F.O)},${literal(ws)},${literal(old.approvalId)},1,${literal(B.principal)},${literal(B.membership)},'approve',${literal(old.digest)},${literal(oldDecided)}::timestamptz,${literal(randomUUID())},${literal("d".repeat(64))},NULL,NULL,NULL);
UPDATE morrow_work.approvals SET status='approved',revision=2,updated_at=${literal(oldDecided)}::timestamptz,effective_at=${literal(oldDecided)}::timestamptz,expires_at=${literal(plusSeconds(oldDecided, old.rule.approvedValiditySeconds))}::timestamptz,counted_reviewer_principal_ids=ARRAY[${literal(B.principal)}] WHERE id=${literal(old.approvalId)};
INSERT INTO morrow_work.approval_claims VALUES(${literal(F.O)},${literal(ws)},${literal(old.approvalId)},${literal(old.doc.id)},${literal(A.principal)},${literal(A.membership)},'lab.consumer',${literal(randomUUID())},${literal(plusSeconds(oldDecided, 60))}::timestamptz);`,
    );
    const oldView = await read(b, old.doc.id);
    const beforeExpired = snapshot(ws);
    const oldRoot = await decide(b, old.doc.id, decision(old.digest), 2);
    const oldDerive = await decide(
      b,
      old.doc.id,
      decision(previewSelection(oldView.proposal, [2]).proposal.proposalDigest, {
        selectedTargetIndexes: [2],
      }),
      2,
    );
    const oldDirect = apiCall(
      b,
      decideCall([
        randomUUID(),
        "d".repeat(64),
        "corr",
        old.doc.id,
        "2",
        "approve",
        null,
        old.digest,
        null,
        null,
        null,
        null,
        null,
        counted(dbNow()),
      ]),
      "COMMIT",
    );
    check(
      "AC12:claimed_family_closed_after_expiry",
      oldView.approval?.status === "approved" &&
        oldRoot.code === "FAMILY_CONFLICT" &&
        oldDerive.code === "FAMILY_CONFLICT" &&
        oldDirect === "FAMILY_CONFLICT" &&
        same(snapshot(ws), beforeExpired),
      { status: oldView.approval?.status, oldRoot, oldDerive, oldDirect },
    );
    // A 0004 revocation in O waits on the consumer's exclusive organization lock.
    const s5 = await applied(a, grantsBody(D, F.task("a", ws)));
    const d5 = await decide(b, s5.proposalRef.id, decision(s5.proposalRef.digest), 1);
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let waited = null;
    const holding = claim(
      a,
      { proposalRef: d5.proposalRef, approvalRef: d5.approvalRef },
      {
        retry: false,
        afterConsumer: async () => {
          const revocation = db.runAsync(removeSql(atW(R, "W12")), {
            applicationName: "approval_lab_revocation",
          });
          waited = await db.waitForLockWait("application_name='approval_lab_revocation'");
          release(revocation);
        },
      },
    );
    const revocation = await held;
    const holder = await holding;
    const revoked = await revocation;
    check(
      "AC12:revocation_waits_on_consumer",
      waited === true && holder.outcome === "applied" && revoked.ok,
      { waited, holder },
    );
    db.sql(restoreSql(atW(R, "W12")));
  });

  // ===========================================================================
  await section("AC13", async () => {
    const ws = W("W13");
    const a = atW(A, "W13"),
      b = atW(B, "W13");
    for (const [name, target] of [
      ["function_reply", "cmd_approval_decide("],
      ["commit_reply", "COMMIT"],
    ]) {
      const s = await applied(a, grantsBody(C, F.task("a", ws)));
      let armed = true;
      const hooks = {
        async afterQuery(record, connection) {
          if (
            armed &&
            (target === "COMMIT" ? record.text === "COMMIT" : record.text.includes(target))
          ) {
            armed = false;
            await connection.loseReply();
          }
        },
      };
      const key = randomUUID();
      const lost = await decide(b, s.proposalRef.id, decision(s.proposalRef.digest), 1, {
        commandId: key,
        hooks,
        retry: false,
      }).catch((e) => ({ error: e instanceof WorkOutcomeUnknown ? "uncertain" : e?.name }));
      check("AC13:" + name + "_uncertain", lost.error === "uncertain", lost);
      const retry = await decide(b, s.proposalRef.id, decision(s.proposalRef.digest), 1, {
        commandId: key,
      });
      const expected = target === "COMMIT" ? "replayed" : "applied";
      check(
        "AC13:" + name + "_retry_" + expected,
        retry.outcome === expected && retry.status === "approved",
        retry,
      );
      check(
        "AC13:" + name + "_one_decision",
        Number(
          db.sql(
            `SELECT count(*) FROM morrow_work.approval_decisions WHERE command_id=${literal(key)};`,
          ),
        ) === 1,
      );
    }
  });

  // ===========================================================================
  await section("AC14", async () => {
    const ws = W("W14");
    installPolicy(F.O, ws, 1, rulesWith({ irreversible: { requiredApprovals: 2 } }));
    const a = atW(A, "W14"),
      b = atW(B, "W14");
    const e = await applied(a, eraseBody(["w1", "w2", "w3"], F.task("a", ws)));
    const ev = (await read(b, e.proposalRef.id)).proposal;
    const e0 = previewSelection(ev, [0]).proposal;
    const pend = await decide(
      b,
      e.proposalRef.id,
      decision(e0.proposalDigest, { selectedTargetIndexes: [0] }),
      1,
    );
    check("AC14:derived_pending", pend.status === "pending", pend);
    check("AC14:not_proposer_denied", (await withdraw(b, e.proposalRef.id, 1)).code === "denied");
    const key = randomUUID();
    const w = await withdraw(a, e.proposalRef.id, 1, { commandId: key });
    const derived = approvalRow("approval_" + e0.id);
    check(
      "AC14:withdrawn",
      w.outcome === "applied" &&
        w.status === "cancelled" &&
        derived.status === "invalidated" &&
        derived.invalidation_reason === "family_closed",
      { w, derived: derived?.status },
    );
    const g = await applied(a, grantsBody(C, F.task("a", ws)));
    await decide(b, g.proposalRef.id, decision(g.proposalRef.digest), 1);
    check(
      "AC14:after_approval_state_conflict",
      ["state_conflict"].includes((await withdraw(a, g.proposalRef.id, 2)).code),
    );
    // Replay after the proposer loses its erase grant (no own read, no reviewer read).
    const gid = "g_a_" + ws + "_governance_privacy_erase";
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id=${literal(gid)};`,
    );
    try {
      const replay = await withdraw(a, e.proposalRef.id, 1, { commandId: key });
      check("AC14:replay_without_read_not_found", replay.code === "not_found", replay);
    } finally {
      db.admin(
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}','null'::jsonb) WHERE id=${literal(gid)};`,
      );
    }
  });

  // ===========================================================================
  await section("AC15", async () => {
    const ws = W("W15");
    const a = atW(A, "W15"),
      b = atW(B, "W15");
    const old = plusSeconds(dbNow(), -3 * 86400);
    const p1 = installPolicy(F.O, ws, 1, structuredClone(defaults.rules), old);
    const now = dbNow();
    const build = (createdAt, policy, beneficiary = C) =>
      storedProposal({
        org: F.O,
        ws,
        proposer: A,
        taskId: F.task("a", ws),
        capabilityId: "governance.grants.revise",
        targets: grantsTarget(F.O, ws, beneficiary.principal),
        beneficiaries: [beneficiary.principal],
        policy,
        createdAt,
      });
    const stale = Array.from({ length: 30 }, () => build(now, p1));
    db.workOwner(
      "BEGIN;\n" + stale.map((s) => storedProposalSql(s, F.O, ws)).join("\n") + "\nCOMMIT;",
    );
    const p2 = installPolicy(F.O, ws, 2, structuredClone(defaults.rules), now);
    const expired = Array.from({ length: 30 }, () => build(plusSeconds(now, -(86400 + 60)), p2));
    const live = Array.from({ length: 120 }, (_, i) => build(plusSeconds(now, -i), p2));
    for (const batch of [expired, live.slice(0, 60), live.slice(60)])
      db.workOwner(
        "BEGIN;\n" + batch.map((s) => storedProposalSql(s, F.O, ws)).join("\n") + "\nCOMMIT;",
      );
    // One proposal for a grant-less beneficiary (X).
    const forX = await applied(a, grantsBody(X, F.task("a", ws)));
    const absent = await read(b, "proposal_absent_" + randomUUID());
    check("AC15:absent_not_found", absent === "not_found");
    for (const [name, p] of [
      ["x", atW(X, "W15")],
      ["blind_reviewer", atW(V, "W15")],
    ])
      check("AC15:" + name + "_not_found", (await read(p, forX.proposalRef.id)) === "not_found");
    const y = await read(at(Y, "ws_ap_p"), forX.proposalRef.id);
    check("AC15:y_not_found", y === "not_found");
    check(
      "AC15:beneficiary_without_grants_not_found",
      (await read(atW(X, "W15"), forX.proposalRef.id)) === "not_found",
    );
    check(
      "AC15:a_and_b_read",
      (await read(a, forX.proposalRef.id)).viewerRole === "reviewer" &&
        (await read(b, forX.proposalRef.id)).viewerRole === "reviewer",
    );
    const seen = [];
    let after = null,
      pages = 0,
      maxItems = 0;
    do {
      const page = await list(b, after, 25);
      if (page === "invalid") break;
      maxItems = Math.max(maxItems, page.items.length);
      seen.push(...page.items.map((i) => i.approvalRef.id));
      after = page.next;
      pages++;
    } while (after && pages < 50);
    const liveIds = new Set([...live.map((s) => s.approvalId), forX.approvalRef.id]);
    check(
      "AC15:list_exactly_live",
      seen.length === liveIds.size &&
        seen.every((id) => liveIds.has(id)) &&
        new Set(seen).size === seen.length,
      { seen: seen.length, live: liveIds.size },
    );
    check("AC15:list_page_bound", maxItems <= 25);
    const ordered = db
      .rows(
        `SELECT id FROM morrow_work.approvals WHERE workspace_id=${literal(ws)} AND status='pending' AND review_policy_revision=2 AND expires_at>clock_timestamp() ORDER BY expires_at, id COLLATE "C"`,
      )
      .map((r) => r.id);
    check(
      "AC15:list_order",
      same(
        seen,
        ordered.filter((id) => liveIds.has(id)),
      ),
    );
    const xList = await list(atW(X, "W15"), null, 25);
    check("AC15:x_lists_nothing", xList.items.length === 0);
    const text = JSON.stringify([await read(b, forX.proposalRef.id), await list(b, null, 25)]);
    check("AC15:no_grants_in_responses", !/"verbs"|g_[a-z]+_ws_ap/.test(text));
  });

  // ===========================================================================
  await section("AC16", async () => {
    // W2-scoped records seen from W: commands, reads and claims are not found;
    // composite keys make cross-workspace derivations and claims unrepresentable.
    const a = atW(A, "W"),
      b2 = atW(B, "W2");
    const foreign = await applied(atW(A, "W2"), grantsBody(C, F.task("a", W("W2"))));
    const fd = await decide(b2, foreign.proposalRef.id, decision(foreign.proposalRef.digest), 1);
    check(
      "AC16:decide_foreign_not_found",
      (await decide(atW(B, "W"), foreign.proposalRef.id, decision(foreign.proposalRef.digest), 1))
        .code === "not_found",
    );
    check(
      "AC16:withdraw_foreign_not_found",
      (await withdraw(a, foreign.proposalRef.id, 1)).code === "not_found",
    );
    check(
      "AC16:read_foreign_not_found",
      (await read(atW(B, "W"), foreign.proposalRef.id)) === "not_found",
    );
    check(
      "AC16:claim_foreign_not_found",
      (await claim(a, { proposalRef: fd.proposalRef, approvalRef: fd.approvalRef })).outcome ===
        "not_found",
    );
    for (const [name, call] of [
      [
        "decide",
        decideCall([
          randomUUID(),
          "d".repeat(64),
          "corr",
          foreign.proposalRef.id,
          "1",
          "approve",
          null,
          foreign.proposalRef.digest,
          null,
          null,
          null,
          null,
          null,
          counted(dbNow()),
        ]),
      ],
      [
        "withdraw",
        "morrow_work.cmd_approval_withdraw(" +
          args([randomUUID(), "d".repeat(64), "corr", foreign.proposalRef.id, "1"]) +
          ")",
      ],
    ])
      check("AC16:direct_" + name + "_not_found", apiCall(a, call, "COMMIT") === "not_found");
    const insert = db.tryRun(
      asCommandRole(
        a,
        `INSERT INTO morrow_work.approval_claims VALUES(${literal(F.O)},${literal(W("W2"))},${literal(fd.approvalRef.id)},${literal(foreign.proposalRef.id)},${literal(A.principal)},${literal(A.membership)},'lab.x',${literal(randomUUID())},date_trunc('milliseconds',clock_timestamp()));`,
      ),
    );
    check(
      "AC16:command_role_foreign_insert_fails",
      !insert.ok && /row-level security/.test(insert.stderr),
    );
    const crossClaim = db.tryRun(
      `SET ROLE morrow_work_owner; INSERT INTO morrow_work.approval_claims VALUES(${literal(F.O)},${literal(W("W"))},${literal(fd.approvalRef.id)},${literal(foreign.proposalRef.id)},${literal(A.principal)},${literal(A.membership)},'lab.x',${literal(randomUUID())},date_trunc('milliseconds',clock_timestamp()));`,
    );
    check(
      "AC16:cross_workspace_claim_unrepresentable",
      !crossClaim.ok && /foreign key/.test(crossClaim.stderr),
    );
  });

  // ===========================================================================
  await section("AC17", async () => {
    // The reduced pull-request race set. Each race pauses one transaction at a
    // fixed point with a hook and lets the other side commit first, in both orders
    // where the packet names two outcomes, so the result is forced, not sampled.
    // A paused request transaction lives at most 5 s (transaction_timeout), so a
    // load-induced timeout of the paused side is retried on fresh records and only
    // a decided outcome counts.
    const ws = W("W17");
    const a = atW(A, "W17"),
      b = atW(B, "W17"),
      d = atW(D, "W17");
    const gate = () => {
      let open, arrive;
      const opened = new Promise((resolve) => (open = resolve));
      const arrived = new Promise((resolve) => (arrive = resolve));
      return { opened, arrived, open, wait: () => (arrive(), opened) };
    };
    const decisionsOf = (approvalId) =>
      Number(
        db.sql(
          `SELECT count(*) FROM morrow_work.approval_decisions WHERE approval_id=${literal(approvalId)};`,
        ),
      );
    const claimsOf = (approvalId) =>
      Number(
        db.sql(
          `SELECT (SELECT count(*) FROM morrow_work.approval_claims WHERE approval_id=${literal(approvalId)})+(SELECT count(*) FROM morrow_identity.lab_effects e JOIN morrow_work.approval_claims c ON c.consumer_command_id=e.consumer_command_id WHERE c.approval_id=${literal(approvalId)});`,
        ),
      );
    // Runs `paused` until its hook reaches `statement` (before it is sent), runs
    // `other` to completion, then releases the paused side.
    async function pauseBefore(statement, paused, other, attempts = 3) {
      for (let attempt = 1; ; attempt++) {
        const hold = gate();
        let armed = true;
        const hooks = {
          async beforeQuery(record) {
            if (armed && record.text.includes(statement)) {
              armed = false;
              await hold.wait();
            }
          },
        };
        const first = paused(hooks).catch((e) => ({ error: e?.name ?? "error" }));
        const reached = await Promise.race([
          hold.arrived.then(() => true),
          first.then(() => false),
        ]);
        const second = reached ? await other() : null;
        hold.open();
        const result = await first;
        if (reached && !result.error) return { first: result, second };
        if (attempt >= attempts) return { first: result, second, inconclusive: true };
      }
    }
    // Polls a pg_stat_activity condition from inside the engine (10 ms, with a fresh
    // statistics snapshot each time) until it holds, for at most `seconds`.
    const seen = (condition, seconds) =>
      db
        .runAsync(
          `DO $$ BEGIN FOR i IN 1..${seconds * 100} LOOP PERFORM pg_stat_clear_snapshot(); IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${condition}) THEN RETURN; END IF; PERFORM pg_sleep(0.01); END LOOP; RAISE EXCEPTION 'CONDITION_NOT_SEEN'; END $$;`,
        )
        .then((r) => r.ok);
    // The command functions under lock, with TypeScript bypassed (the property is
    // the SQL lock order and the READ COMMITTED re-read after a wait): the first
    // session's cmd_approval_decide returns and the session then holds its stream
    // lock and family rows (pg_sleep before COMMIT); the second session's command
    // is seen waiting on a lock, then re-reads after the first commits. Neither
    // raw session carries the request prologue's 1 s lock_timeout, so the hold
    // grows on a slow host until the wait is observed.
    async function holdSql(setup) {
      let last = null;
      for (const hold of [3, 6, 12]) {
        const { first, second, firstCall, secondCall } = await setup();
        const one = db.runAsync(
          asApi(first, `SELECT outcome FROM ${firstCall};\nSELECT pg_sleep(${hold});`, {
            end: "COMMIT",
          }),
          { user: "morrow_api_worker", applicationName: "approval_lab_hold_first" },
        );
        const holding = await seen(
          "application_name='approval_lab_hold_first' AND state='active' AND query LIKE 'SELECT pg_sleep(%'",
          hold,
        );
        const two = db.runAsync(
          asApi(second, `SELECT outcome FROM ${secondCall};`, { end: "COMMIT" }),
          {
            user: "morrow_api_worker",
            applicationName: "approval_lab_hold_second",
          },
        );
        const waited =
          holding &&
          (await seen(
            "application_name='approval_lab_hold_second' AND wait_event_type='Lock'",
            hold,
          ));
        const [r1, r2] = await Promise.all([one, two]);
        last = {
          holding,
          waited,
          first: r1.ok ? r1.stdout.split("\n").at(-1) : "error",
          second: r2.ok ? r2.stdout.split("\n").at(-1) : "error",
        };
        if (holding && waited) return last;
      }
      return { ...last, inconclusive: true };
    }
    const derivedValues = (proposal) => {
      const { proposalDigest: digest, ...content } = proposal;
      return [digest, canonicalize(content), digest, canonicalize(proposal.scope)];
    };
    const directDecide = (proposalId, revision, digest, selection = null, derived = null) =>
      decideCall([
        randomUUID(),
        "d".repeat(64),
        "corr",
        proposalId,
        String(revision),
        "approve",
        selection === null ? null : JSON.stringify(selection),
        ...(derived ?? [digest, null, null, null]),
        null,
        null,
        counted(dbNow()),
      ]);

    // The races run once per pull request; MORROW_APPROVAL_RACE_ROUNDS repeats them
    // on fresh records (the repeated-round matrix, run by hand).
    async function races(tag) {
      // (1) Two quorum-1 approvals: B pauses before its command function, D approves
      // and commits; B's command then sees revision 2 under lock.
      let s1;
      const r1 = await pauseBefore(
        "cmd_approval_decide(",
        async (hooks) => {
          s1 = await applied(a, grantsBody(C, F.task("a", ws)));
          return decide(b, s1.proposalRef.id, decision(s1.proposalRef.digest), 1, {
            hooks,
            retry: false,
          });
        },
        () => decide(d, s1.proposalRef.id, decision(s1.proposalRef.digest), 1),
      );
      check(
        "AC17:two_approvals_one_wins" + tag,
        !r1.inconclusive &&
          r1.second?.status === "approved" &&
          r1.first.code === "revision_conflict" &&
          decisionsOf(s1.approvalRef.id) === 1,
        r1,
      );

      // (2) Two different partial selections: B ([0]) pauses before its command
      // function, D ([1]) derives and approves. Under lock B's expected revision is
      // already stale (D's approval invalidated the root), so B gets the stale
      // revision first, as the library's fold orders STALE_REVISION before
      // FAMILY_CONFLICT; B's re-read retry at the current revision is FAMILY_CONFLICT.
      let e2, e2view;
      const sel = (proposal, i) =>
        decision(previewSelection(proposal, i).proposal.proposalDigest, {
          selectedTargetIndexes: i,
        });
      const r2 = await pauseBefore(
        "cmd_approval_decide(",
        async (hooks) => {
          e2 = await applied(a, eraseBody(["x1", "x2", "x3"], F.task("a", ws)));
          e2view = (await read(b, e2.proposalRef.id)).proposal;
          return decide(b, e2.proposalRef.id, sel(e2view, [0]), 1, { hooks, retry: false });
        },
        () => decide(d, e2.proposalRef.id, sel(e2view, [1]), 1),
      );
      const reread = r2.inconclusive
        ? null
        : await decide(b, e2.proposalRef.id, sel(e2view, [0]), 2);
      check(
        "AC17:two_selections_one_member" + tag,
        !r2.inconclusive &&
          r2.second?.status === "approved" &&
          r2.first.code === "revision_conflict" &&
          reread?.code === "FAMILY_CONFLICT" &&
          Number(
            db.sql(
              `SELECT count(*) FROM morrow_work.approvals WHERE family_root_id=${literal(e2.proposalRef.id)} AND status='approved';`,
            ),
          ) === 1 &&
          Number(
            db.sql(
              `SELECT count(*) FROM morrow_work.proposals WHERE family_root_id=${literal(e2.proposalRef.id)};`,
            ),
          ) === 2,
        { r2, reread },
      );

      // (1') and (2') under lock: B's command function has returned and B holds its
      // locks until COMMIT; D's command waits on them, and after B commits it sees
      // the new revision (revision_conflict), never B's pre-commit state.
      let s1h;
      const r1h = await holdSql(async () => {
        s1h = await applied(a, grantsBody(C, F.task("a", ws)));
        const call = () => directDecide(s1h.proposalRef.id, 1, s1h.proposalRef.digest);
        return { first: b, second: d, firstCall: call(), secondCall: call() };
      });
      check(
        "AC17:two_approvals_second_waits_then_stale" + tag,
        !r1h.inconclusive &&
          r1h.first === "applied" &&
          r1h.second === "revision_conflict" &&
          decisionsOf(s1h.approvalRef.id) === 1 &&
          approvalRow(s1h.approvalRef.id).status === "approved",
        r1h,
      );
      let e2h, e2hview;
      const r2h = await holdSql(async () => {
        e2h = await applied(a, eraseBody(["y1", "y2", "y3"], F.task("a", ws)));
        e2hview = (await read(b, e2h.proposalRef.id)).proposal;
        const part = (i) =>
          directDecide(
            e2h.proposalRef.id,
            1,
            null,
            i,
            derivedValues(previewSelection(e2hview, i).proposal),
          );
        return { first: b, second: d, firstCall: part([0]), secondCall: part([1]) };
      });
      const reread2h = r2h.inconclusive
        ? null
        : await decide(d, e2h.proposalRef.id, sel(e2hview, [1]), 2);
      check(
        "AC17:two_selections_second_waits_then_stale" + tag,
        !r2h.inconclusive &&
          r2h.first === "applied" &&
          r2h.second === "revision_conflict" &&
          reread2h?.code === "FAMILY_CONFLICT" &&
          Number(
            db.sql(
              `SELECT count(*) FROM morrow_work.proposals WHERE family_root_id=${literal(e2h.proposalRef.id)};`,
            ),
          ) === 2,
        { r2h, reread2h },
      );

      // (3) A decision against a 0004 revocation of its reviewer.
      // (a) The decision holds its locks before COMMIT; the revocation waits on the
      // organization interlock, then applies after the decision commits.
      const s3 = await applied(a, grantsBody(C, F.task("a", ws)));
      let revocation3,
        waited3 = null;
      let armed3 = true;
      const committedFirst = await decide(
        b,
        s3.proposalRef.id,
        decision(s3.proposalRef.digest),
        1,
        {
          retry: false,
          hooks: {
            async afterQuery(record) {
              if (armed3 && record.text.includes("cmd_approval_decide(")) {
                armed3 = false;
                revocation3 = db.runAsync(removeSql(b), {
                  applicationName: "approval_lab_ac17_3a",
                });
                waited3 = await db.waitForLockWait("application_name='approval_lab_ac17_3a'");
              }
            },
          },
        },
      ).catch((e) => ({ error: e?.name }));
      const revoked3 = await revocation3;
      check(
        "AC17:decision_commits_before_revocation" + tag,
        waited3 === true &&
          committedFirst.status === "approved" &&
          revoked3?.ok === true &&
          decisionsOf(s3.approvalRef.id) === 1,
        { waited3, committedFirst },
      );
      db.sql(restoreSql(b));
      // (b) The revocation commits while the decision is paused before its command
      // function: the locked recheck finds the reviewer ineligible (401), nothing written.
      const s3b = await applied(a, grantsBody(C, F.task("a", ws)));
      const before3b = snapshot(ws);
      let armed3b = true;
      const revokedFirst = await decide(
        b,
        s3b.proposalRef.id,
        decision(s3b.proposalRef.digest),
        1,
        {
          retry: false,
          hooks: {
            async beforeQuery(record) {
              if (armed3b && record.text.includes("cmd_approval_decide(")) {
                armed3b = false;
                db.sql(removeSql(b));
              }
            },
          },
        },
      ).catch((e) => ({ error: e?.name }));
      check(
        "AC17:revocation_before_decision_refused" + tag,
        ["unauthenticated", "stale_authority"].includes(revokedFirst.code) &&
          same(snapshot(ws), before3b),
        revokedFirst,
      );
      db.sql(restoreSql(b));

      // (4) A claim against a 0004 revocation of a counted reviewer.
      // (a) The consumer holds the organization FOR UPDATE; the revocation waits and
      // applies after the claim commits.
      const g4 = await applied(a, grantsBody(C, F.task("a", ws)));
      const dg4 = await decide(b, g4.proposalRef.id, decision(g4.proposalRef.digest), 1);
      let revocation4,
        waited4 = null;
      const claimedFirst = await claim(
        a,
        { proposalRef: dg4.proposalRef, approvalRef: dg4.approvalRef },
        {
          retry: false,
          afterConsumer: async () => {
            revocation4 = db.runAsync(removeSql(b), { applicationName: "approval_lab_ac17_4a" });
            waited4 = await db.waitForLockWait("application_name='approval_lab_ac17_4a'");
          },
        },
      ).catch((e) => ({ outcome: "error:" + e?.name }));
      const revoked4 = await revocation4;
      check(
        "AC17:claim_commits_before_revocation" + tag,
        waited4 === true &&
          claimedFirst.outcome === "applied" &&
          revoked4?.ok === true &&
          claimsOf(dg4.approvalRef.id) === 2,
        { waited4, claimedFirst },
      );
      db.sql(restoreSql(b));
      // (b) The revocation commits after the claim was prepared and before its
      // consumer runs: the consumer's locked recheck sees the organization revision
      // move (stale_authority) or the counted reviewer gone (REVIEWER_AUTHORITY_LOST);
      // either way nothing is written, and a fresh claim is REVIEWER_AUTHORITY_LOST.
      const g4b = await applied(a, grantsBody(C, F.task("a", ws)));
      const dg4b = await decide(b, g4b.proposalRef.id, decision(g4b.proposalRef.digest), 1);
      const refs4b = { proposalRef: dg4b.proposalRef, approvalRef: dg4b.approvalRef };
      const revokedBeforeClaim = await claim(a, refs4b, {
        retry: false,
        beforeConsumer: async () => db.sql(removeSql(b)),
      }).catch((e) => ({ outcome: "error:" + e?.name }));
      const freshClaim = await claim(a, refs4b);
      check(
        "AC17:revocation_before_claim_refused" + tag,
        ["stale_authority", "REVIEWER_AUTHORITY_LOST"].includes(revokedBeforeClaim.outcome) &&
          freshClaim.outcome === "REVIEWER_AUTHORITY_LOST" &&
          claimsOf(dg4b.approvalRef.id) === 0,
        { revokedBeforeClaim, freshClaim },
      );
      db.sql(restoreSql(b));

      // (5) A solo claim against a member being added under the organization
      // FOR UPDATE. The effective solo approvals are back-dated owner fixtures (a
      // decision 590 s ago with the default 300 s cool-down), so no wait is needed.
      const soloApproval = (o) => {
        const policy = installPolicy(
          o.org,
          o.ws,
          1,
          structuredClone(defaults.rules),
          plusSeconds(dbNow(), -700),
        );
        const created = plusSeconds(dbNow(), -600);
        const s = storedProposal({
          org: o.org,
          ws: o.ws,
          proposer: o.S,
          taskId: o.task,
          capabilityId: "governance.grants.revise",
          targets: grantsTarget(o.org, o.ws, o.S.principal),
          beneficiaries: [o.S.principal],
          policy,
          createdAt: created,
          // The consumer derives its effect only from these stored parameters.
          parameters: { beneficiaryPrincipalId: o.S.principal },
        });
        const decided = plusSeconds(created, 10);
        const effective = plusSeconds(decided, policy.doc.rules.soloOwner.coolDownSeconds);
        const expires = new Date(
          Math.min(
            Date.parse(s.doc.expiresAt),
            Date.parse(effective) + s.rule.approvedValiditySeconds * 1000,
          ),
        ).toISOString();
        db.workOwner(
          storedProposalSql(s, o.org, o.ws) +
            `
  INSERT INTO morrow_work.approval_decisions VALUES(${literal(o.org)},${literal(o.ws)},${literal(s.approvalId)},1,${literal(o.S.principal)},${literal(o.S.membership)},'approve',${literal(s.digest)},${literal(decided)}::timestamptz,${literal(randomUUID())},${literal("d".repeat(64))},NULL,${literal(sha(confirmationPhrase(s.doc)))},${policy.doc.rules.soloOwner.coolDownSeconds});
  UPDATE morrow_work.approvals SET status='approved',revision=2,updated_at=${literal(decided)}::timestamptz,effective_at=${literal(effective)}::timestamptz,expires_at=${literal(expires)}::timestamptz,counted_reviewer_principal_ids=ARRAY[${literal(o.S.principal)}] WHERE id=${literal(s.approvalId)};`,
        );
        const row = approvalRow(s.approvalId);
        return {
          approvalId: s.approvalId,
          refs: {
            proposalRef: proposalRef(s.doc),
            approvalRef: {
              organizationId: o.org,
              workspaceId: o.ws,
              storeId: null,
              kind: "approval",
              id: s.approvalId,
              revision: 2,
              digest: ap.approvalRefDigest({
                organizationId: o.org,
                workspaceId: o.ws,
                id: s.approvalId,
                revision: 2,
                proposalDigest: s.digest,
                scopeDigest: row.scope_digest,
                status: "approved",
                effectiveAt: row.effective_text,
                expiresAt: row.expires_text,
              }),
            },
          },
        };
      };
      const addMemberSql = (org, name) => `BEGIN; SET LOCAL ROLE morrow_identity_owner;
  ${interlock(org)}
  SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(org)} FOR UPDATE;
  INSERT INTO morrow_identity.principals VALUES(${literal("person_" + name)},'human',true);
  INSERT INTO morrow_identity.memberships VALUES(${literal("membership_" + name)},${literal(org)},${literal("person_" + name)},true);
  COMMIT;`;
      // (a) The solo claim holds the organization FOR UPDATE; the addition waits.
      const o5a = F.soloOrganization("o17a" + tag);
      const solo5a = soloApproval(o5a);
      let addition5a,
        waited5a = null;
      const soloFirst = await claim(o5a.S, solo5a.refs, {
        retry: false,
        afterConsumer: async () => {
          addition5a = db.runAsync(addMemberSql(o5a.org, "late_o17a" + tag), {
            applicationName: "approval_lab_ac17_5a",
          });
          waited5a = await db.waitForLockWait("application_name='approval_lab_ac17_5a'");
        },
      }).catch((e) => ({ outcome: "error:" + e?.name }));
      const added5a = await addition5a;
      check(
        "AC17:solo_claim_commits_before_member_added" + tag,
        waited5a === true &&
          soloFirst.outcome === "applied" &&
          added5a?.ok === true &&
          claimsOf(solo5a.approvalId) === 2,
        { waited5a, soloFirst },
      );
      // (b) The member is added after the claim was prepared and before its consumer
      // runs: approval_claim projects SOLO_OWNER_STATUS_LOST and rolls back.
      const o5b = F.soloOrganization("o17b" + tag);
      const solo5b = soloApproval(o5b);
      const addedFirst = await claim(o5b.S, solo5b.refs, {
        retry: false,
        beforeConsumer: async () => db.sql(addMemberSql(o5b.org, "late_o17b" + tag)),
      }).catch((e) => ({ outcome: "error:" + e?.name }));
      check(
        "AC17:member_added_before_solo_claim_refused" + tag,
        addedFirst.outcome === "SOLO_OWNER_STATUS_LOST" &&
          claimsOf(solo5b.approvalId) === 0 &&
          approvalRow(solo5b.approvalId).status === "approved",
        addedFirst,
      );
    }
    for (let round = 0; round < raceRounds; round++) await races(round === 0 ? "" : "_r" + round);
  });

  // ===========================================================================
  await section("AC18", async () => {
    const ws = W("W18");
    const a = atW(A, "W18"),
      b = atW(B, "W18");
    const marker = "MARKER" + randomUUID().replaceAll("-", "").slice(0, 16);
    const s = await applied(a, grantsBody("person_" + marker.toLowerCase(), F.task("a", ws)));
    await decide(
      b,
      s.proposalRef.id,
      decision(s.proposalRef.digest, { comment: "comment " + marker }),
      1,
    );
    const s2 = await applied(a, grantsBody(C, F.task("a", ws)));
    const phrase = await decide(
      a,
      s2.proposalRef.id,
      decision(s2.proposalRef.digest, { soloOwnerConfirmation: "approve " + marker }),
      1,
    );
    check(
      "AC18:phrase_refused",
      ["CONFIRMATION_MISMATCH", "SELF_APPROVAL_DENIED"].includes(phrase.code),
      phrase,
    );
    // Malformed canonical text with a marker, TypeScript bypassed.
    const bad = apiCall(
      a,
      submitCall([
        randomUUID(),
        "d".repeat(64),
        "corr",
        F.task("a", ws),
        "own",
        randomUUID(),
        null,
        "a".repeat(64),
        "{}",
        sha("{}"),
        '{"id":"' + marker + '", broken',
        "a".repeat(64),
        "{}",
      ]),
      "COMMIT",
    );
    check("AC18:malformed_invalid", bad === "invalid", bad);
    // A comment with a NUL is refused before SQL; nothing is written.
    const s3 = await applied(a, grantsBody(C, F.task("a", ws)));
    const beforeNul = snapshot(ws);
    const nul = await decide(
      b,
      s3.proposalRef.id,
      decision(s3.proposalRef.digest, { comment: marker + "\u0000" }),
      1,
    );
    check("AC18:nul_comment_invalid", nul.code === "invalid" && same(snapshot(ws), beforeNul), nul);
    const outbox = db.sql(
      `SELECT COALESCE(string_agg(payload::text,''),'') FROM morrow_work.outbox_events WHERE workspace_id=${literal(ws)};`,
    );
    const results = db.sql(
      `SELECT COALESCE(string_agg(result::text,''),'') FROM morrow_work.commands WHERE workspace_id=${literal(ws)};`,
    );
    const logs = db.logs();
    check(
      "AC18:no_marker_in_outbox_or_results",
      !outbox.includes(marker) &&
        !outbox.toLowerCase().includes(marker.toLowerCase()) &&
        !results.includes(marker),
    );
    check(
      "AC18:no_marker_in_log",
      !logs.includes(marker) && !logs.toLowerCase().includes(marker.toLowerCase()),
    );
    check("AC18:no_failing_row_detail", !logs.includes("Failing row contains"));
  });

  // ===========================================================================
  await section("AC19", async () => {
    const ws = W("W");
    const ownerTry = (sql) => db.tryRun("SET ROLE morrow_work_owner; BEGIN; " + sql + " ROLLBACK;");
    for (const t of [
      "review_policies",
      "proposal_parameters",
      "proposals",
      "approval_decisions",
      "approval_claims",
      "review_capabilities",
      "review_risk_by_effect",
      "review_policy_defaults",
      // 0015's platform table, whose key 0018 rebuilds and into which it inserts the
      // approval rows: its append_only and no_truncate triggers survive.
      "transition_rules",
    ]) {
      const col =
        t === "review_capabilities"
          ? "capability_id"
          : t === "review_risk_by_effect"
            ? "effect"
            : t === "review_policy_defaults"
              ? "version"
              : t === "transition_rules"
                ? "machine"
                : "organization_id";
      check(
        "AC19:update_raises_" + t,
        !ownerTry(`UPDATE morrow_work.${t} SET ${col}=${col};`).ok ||
          Number(db.sql(`SELECT count(*) FROM morrow_work.${t};`)) === 0,
      );
      check(
        "AC19:delete_raises_" + t,
        !ownerTry(`DELETE FROM morrow_work.${t};`).ok ||
          Number(db.sql(`SELECT count(*) FROM morrow_work.${t};`)) === 0,
      );
      check("AC19:truncate_raises_" + t, !ownerTry(`TRUNCATE morrow_work.${t};`).ok);
    }
    check("AC19:approvals_delete_raises", !ownerTry("DELETE FROM morrow_work.approvals;").ok);
    check("AC19:approvals_truncate_raises", !ownerTry("TRUNCATE morrow_work.approvals;").ok);
    const pending = db.rows(
      `SELECT id FROM morrow_work.approvals WHERE status='pending' LIMIT 1`,
    )[0]?.id;
    const approvedId = db.rows(
      `SELECT id FROM morrow_work.approvals a WHERE status='approved' AND NOT EXISTS(SELECT 1 FROM morrow_work.approval_claims c WHERE c.family_root_id=a.family_root_id AND c.workspace_id=a.workspace_id) LIMIT 1`,
    )[0]?.id;
    check(
      "AC19:non_edge_update_raises",
      approvedId &&
        !ownerTry(
          `UPDATE morrow_work.approvals SET status='pending',revision=revision+1 WHERE id=${literal(approvedId)};`,
        ).ok,
    );
    check(
      "AC19:approved_without_decision_raises",
      pending &&
        !ownerTry(
          `UPDATE morrow_work.approvals SET status='approved',revision=revision+1,effective_at=updated_at,counted_reviewer_principal_ids=ARRAY['person_b'] WHERE id=${literal(pending)};`,
        ).ok,
    );
    const rules = db
      .rows(
        "SELECT machine, from_status, to_status, actor, guard FROM morrow_work.transition_rules",
      )
      .map((r) => [r.machine, r.from_status, r.to_status, r.actor, r.guard].join("|"));
    const effective = (machine, version) =>
      transitionsJson.transitions[machine]
        .filter(
          (r) =>
            (r.since === undefined || version === "1.1") &&
            (r.superseded_in === undefined || version !== "1.1"),
        )
        .map((r) => [machine, r.from, r.to, r.actor, r.guard].join("|"));
    const expected = [
      ...effective("approval", "1.1"),
      ...["goal", "task", "question"].flatMap((m) => effective(m, "1")),
      // M2 PR-1 (0020) adds the operation rows, unchanged.
      ...effective("operation", "1"),
    ];
    check("AC19:transition_rules_equal_json", same(rules.sort(), expected.sort()), {
      db: rules.length,
      json: expected.length,
    });
    const caps = db.rows(
      'SELECT capability_id, effect, irreversible, review_required, kill_switch, executor FROM morrow_work.review_capabilities ORDER BY capability_id COLLATE "C"',
    );
    check(
      "AC19:catalogue_equal_json",
      same(
        caps,
        catalogueAt0018(catalogue)
          .map((c) => ({
            capability_id: c.id,
            effect: c.effect,
            irreversible: c.irreversible,
            review_required: c.review_required,
            kill_switch: c.kill_switch,
            executor: c.executor,
          }))
          .sort((x, y) => (x.capability_id < y.capability_id ? -1 : 1)),
      ),
    );
    // The catalogue rows added after 0018 (P01.T02c) are absent, and none is
    // review-required, so no proposal can name one.
    check(
      "AC19:capabilities_after_0018_absent_and_unreviewable",
      capabilitiesAfter0018.every(
        (id) =>
          !caps.some((c) => c.capability_id === id) &&
          catalogue.capabilities.some((c) => c.id === id && !c.review_required && !c.kill_switch),
      ),
    );
    const risk = Object.fromEntries(
      db
        .rows("SELECT effect, risk FROM morrow_work.review_risk_by_effect")
        .map((r) => [r.effect, r.risk]),
    );
    check("AC19:risk_equal_json", same(risk, defaults.riskClassByEffect));
    const [def] = db.rows("SELECT rules, rules_digest FROM morrow_work.review_policy_defaults");
    check(
      "AC19:defaults_equal_json",
      same(def.rules, defaults.rules) && def.rules_digest === canonicalDigest(defaults.rules),
    );
  });

  // ===========================================================================
  await section("AC21", async () => {
    const shape = (signature) =>
      db.sql(`SELECT pg_get_function_result('morrow_identity.${signature}'::regprocedure);`);
    check(
      "AC21:ownership_shape",
      shape("work_ownership_facts(text)") ===
        "TABLE(owner_principal_id text, owner_membership_id text, active_human_membership_count integer, last_membership_change_at timestamp with time zone)",
    );
    const grantShape =
      "TABLE(principal_id text, membership_id text, grants jsonb, grant_count integer, grants_digest text)";
    check(
      "AC21:candidates_shape",
      shape("work_review_candidates(text,text,text,text[],text,integer)") === grantShape,
    );
    check(
      "AC21:reviewer_grants_shape",
      shape("work_reviewer_grants(text,text,text,text[])") === grantShape,
    );
    check(
      "AC21:exclusive_shape",
      shape("work_lock_and_recheck_exclusive(text,text,text,text,text,text,text)") === "text",
    );
    for (const table of ["organization_signups", "workspace_revocation_results", "grants"]) {
      const drop = db.tryRun(
        `BEGIN; SET LOCAL ROLE morrow_identity_owner; DROP TABLE morrow_identity.${table}; ROLLBACK;`,
      );
      check("AC21:drop_blocked_" + table, !drop.ok && /depend/.test(drop.stderr));
    }
    // Candidates are selected by capability id only; the kernel rejects expired grants.
    const ws = W("W21");
    const exp = atW(R, "W21");
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{expiresAt}','"2026-01-02T00:00:00.000Z"') WHERE id=${literal("g_r_" + ws + "_governance_approval_decide")};`,
    );
    const candidates = db.rows(
      `SELECT principal_id, grant_count FROM morrow_identity.work_review_candidates(${literal(F.O)},${literal(ws)},'governance.grants.revise',ARRAY[]::text[],NULL,25)`,
    );
    check(
      "AC21:expired_decide_grant_returned",
      candidates.some((c) => c.principal_id === exp.principal),
    );
    // A 65-row candidate is flagged as overflow.
    const big = atW(D, "W21");
    db.admin(
      `INSERT INTO morrow_identity.grants SELECT 'g_d_extra_'||i,${literal(F.O)},${literal(ws)},${literal(D.membership)},${literal(D.principal)},jsonb_set(payload,'{id}',to_jsonb('g_d_extra_'||i)) FROM morrow_identity.grants, generate_series(1,70) i WHERE id=${literal("g_d_" + ws + "_governance_approval_decide")};`,
    );
    const overflow = db
      .rows(
        `SELECT principal_id, grant_count FROM morrow_identity.work_review_candidates(${literal(F.O)},${literal(ws)},'governance.grants.revise',ARRAY[]::text[],NULL,25)`,
      )
      .find((c) => c.principal_id === big.principal);
    check("AC21:overflow_flagged", overflow?.grant_count === 65);
    // Paging reaches a quorum placed after the first 25 candidates.
    const fillers = Array.from({ length: 27 }, (_, i) =>
      F.addMember("filler_" + String(i).padStart(2, "0"), F.O, ws),
    );
    // Fillers hold decide approve only: candidates, but not eligible for the capability.
    db.admin(
      `DELETE FROM morrow_identity.grants WHERE workspace_id=${literal(ws)} AND principal_id LIKE 'person_filler_%' AND payload->>'capabilityId'<>'governance.approval.decide';`,
    );
    // B (first by id) removed: the only eligible candidate is V, after D, the 27
    // fillers and R, so the scan must page past the first 25 candidates.
    db.sql(removeSql(atW(B, "W21")));
    try {
      const s = await submit(atW(A, "W21"), grantsBody(C, F.task("a", ws)));
      check("AC21:paging_reaches_quorum", s.outcome === "applied", s);
    } finally {
      db.sql(restoreSql(atW(B, "W21")));
    }
    check("AC21:fillers_seeded", fillers.length === 27);
  });

  // ===========================================================================
  await section("AC22", async () => {
    const vectors = [];
    for (const effectiveAt of [null, "2026-10-19T10:00:00.000Z", "2026-10-19T10:00:00.999Z"])
      for (const status of ["pending", "approved", "cancelled"])
        vectors.push({
          organizationId: "org_v",
          workspaceId: "ws_v",
          id: "approval_v",
          revision: 3,
          proposalDigest: "a".repeat(64),
          scopeDigest: "b".repeat(64),
          status,
          effectiveAt,
          expiresAt: "2026-10-19T11:00:00.001Z",
        });
    let ok = true;
    for (const v of vectors) {
      const sqlValue = db.sql(
        `SELECT morrow_work.approval_ref_digest('org_v','ws_v','approval_v',3,${literal(v.proposalDigest)},${literal(v.scopeDigest)},${literal(v.status)},${v.effectiveAt === null ? "NULL" : literal(v.effectiveAt) + "::timestamptz"},${literal(v.expiresAt)}::timestamptz);`,
      );
      ok &&= sqlValue === ap.approvalRefDigest(v);
    }
    check("AC22:approval_ref_digest", ok);
    const parentRef = {
      organizationId: "org_v",
      workspaceId: "ws_v",
      storeId: null,
      kind: "proposal",
      id: "p_v",
      revision: 1,
      digest: "c".repeat(64),
    };
    const wide = Array.from({ length: 999 }, (_, i) => i);
    for (const [name, indexes] of [
      ["single", [0]],
      ["wide", wide],
    ])
      check(
        "AC22:derived_id_" + name,
        db.sql(
          `SELECT morrow_work.derived_proposal_id('org_v','ws_v','p_v',${literal("c".repeat(64))},ARRAY[${indexes.join(",")}]);`,
        ) === ap.derivedProposalId(parentRef, indexes),
      );
    for (const t of [
      "2026-10-19T00:00:00.000Z",
      "2026-10-19T23:59:59.999Z",
      "2028-02-29T12:34:56.789Z",
    ])
      check(
        "AC22:utc_text_" + t,
        db.sql(`SELECT morrow_work.utc_text(${literal(t)}::timestamptz);`) === t,
      );
    const scope = {
      organizationId: "org_v",
      workspaceId: "ws_v",
      storeIds: [],
      accountIds: [],
      resources: [workspaceResource("org_v", "ws_v")],
      fields: ["a", "b"],
    };
    check(
      "AC22:scope_digest",
      db.sql(`SELECT morrow_work.sha256_text(${literal(canonicalize(scope))});`) ===
        ap.scopeDigest(scope),
    );
    // effective_rule and solo_phrase mirrors over every class × irreversible.
    let rulesOk = true;
    const variants = [
      defaults.rules,
      rulesWith({
        irreversible: {
          requiredApprovals: 3,
          selfApproval: "denied",
          pendingExpirySeconds: 600,
          eligibleReviewerPrincipalIds: ["p1", "p2"],
        },
        internal: { eligibleReviewerPrincipalIds: ["p2", "p3"] },
        external: { requiredApprovals: 2 },
      }),
    ];
    for (const rules of variants)
      for (const risk of ["internal", "external", "communication", "financial", "access_change"])
        for (const irreversible of [false, true]) {
          const sqlRule = JSON.parse(
            db.sql(
              `SELECT morrow_work.effective_rule(${literal(JSON.stringify(rules))}::jsonb,${literal(risk)},${irreversible});`,
            ),
          );
          rulesOk &&= same(sqlRule, { ...effectiveRule(rules, risk, irreversible) });
        }
    check("AC22:effective_rule_mirror", rulesOk);
    const phrases = [
      { targets: [{}], maximumCredits: "0", maximumCost: null },
      { targets: [{}, {}], maximumCredits: "12", maximumCost: null },
      {
        targets: [{}, {}, {}],
        maximumCredits: "7",
        maximumCost: { amount: "1.50", currency: "USD" },
      },
    ];
    let phrasesOk = true;
    for (const p of phrases)
      phrasesOk &&=
        db.sql(`SELECT morrow_work.solo_phrase(${literal(JSON.stringify(p))}::jsonb);`) ===
        confirmationPhrase(p);
    check("AC22:solo_phrase_mirror", phrasesOk);
    // approval_projection (SQL) equals projectApproval (TS) over a case matrix.
    let projOk = true;
    const base = {
      status: "approved",
      expiresAt: "2026-10-19T11:00:00.000Z",
      boundPolicyRevision: 1,
      soloReviewerPrincipalId: null,
      soloDecidedAt: null,
      quietPeriodSeconds: 3600,
    };
    const facts = {
      hasClaim: false,
      currentPolicyRevision: 1,
      ownerPrincipalId: "s",
      activeHumanMembershipCount: 1,
      lastMembershipChangeAt: null,
    };
    const rows = [];
    for (const status of ["pending", "approved", "rejected"])
      for (const hasClaim of [false, true])
        for (const atText of ["2026-10-19T10:59:59.999Z", "2026-10-19T11:00:00.000Z"])
          for (const current of [1, 2])
            for (const solo of [null, "s", "t"])
              for (const count of [1, 2])
                for (const last of [null, "2026-10-19T09:30:00.000Z", "2026-10-18T00:00:00.000Z"])
                  rows.push([
                    {
                      ...base,
                      status,
                      soloReviewerPrincipalId: solo,
                      soloDecidedAt: solo ? "2026-10-19T09:00:00.000Z" : null,
                    },
                    {
                      ...facts,
                      hasClaim,
                      currentPolicyRevision: current,
                      activeHumanMembershipCount: count,
                      lastMembershipChangeAt: last,
                    },
                    atText,
                  ]);
    const sqlRows = db.rows(
      rows
        .map(
          ([r, f, t], i) =>
            `SELECT ${i} AS i, x.status, x.code FROM morrow_work.approval_projection(${literal(r.status)},${literal(r.expiresAt)}::timestamptz,${r.boundPolicyRevision},${f.currentPolicyRevision},${f.hasClaim},${r.soloReviewerPrincipalId === null ? "NULL" : literal(r.soloReviewerPrincipalId)},${r.soloDecidedAt === null ? "NULL" : literal(r.soloDecidedAt) + "::timestamptz"},${r.quietPeriodSeconds},${literal(f.ownerPrincipalId)},${f.activeHumanMembershipCount},${f.lastMembershipChangeAt === null ? "NULL" : literal(f.lastMembershipChangeAt) + "::timestamptz"},${literal(t)}::timestamptz) x`,
        )
        .join(" UNION ALL "),
    );
    for (const row of sqlRows) {
      const [r, f, t] = rows[row.i];
      const ts = ap.projectApproval(r, f, Date.parse(t));
      projOk &&= ts.status === row.status && ts.code === row.code;
    }
    check("AC22:projection_mirror", projOk && sqlRows.length === rows.length, sqlRows.length);
  });

  // ===========================================================================
  await section("AC23", async () => {
    const now = dbNow();
    for (const [key, live, expired, outcome] of [
      ["W23", 1000, 0, "limit_reached"],
      ["W24", 999, 1000, "applied"],
    ]) {
      const ws = W(key);
      const policy = installPolicy(
        F.O,
        ws,
        1,
        structuredClone(defaults.rules),
        plusSeconds(now, -3 * 86400),
      );
      const rows = [
        ...Array.from({ length: live }, () =>
          storedProposal({
            org: F.O,
            ws,
            proposer: A,
            taskId: F.task("a", ws),
            capabilityId: "governance.grants.revise",
            targets: grantsTarget(F.O, ws, C.principal),
            beneficiaries: [C.principal],
            policy,
            createdAt: now,
          }),
        ),
        ...Array.from({ length: expired }, () =>
          storedProposal({
            org: F.O,
            ws,
            proposer: A,
            taskId: F.task("a", ws),
            capabilityId: "governance.grants.revise",
            targets: grantsTarget(F.O, ws, C.principal),
            beneficiaries: [C.principal],
            policy,
            createdAt: plusSeconds(now, -2 * 86400),
          }),
        ),
      ];
      for (let i = 0; i < rows.length; i += 250)
        db.workOwner(
          "BEGIN;\n" +
            rows
              .slice(i, i + 250)
              .map((s) => storedProposalSql(s, F.O, ws))
              .join("\n") +
            "\nCOMMIT;",
        );
      const r = await submit(atW(A, key), grantsBody(C, F.task("a", ws)));
      check("AC23:" + key + "_" + outcome, r.outcome === outcome, r);
    }
    // A derivation that stays pending (quorum 2) is a new live pending approval too:
    // with 998 live rows plus a submitted erase root (999), the first derivation
    // applies (1,000) and the next is limit_reached in SQL, nothing written.
    const ws = W("W25");
    const policy = installPolicy(
      F.O,
      ws,
      1,
      rulesWith({ irreversible: { requiredApprovals: 2 } }),
      plusSeconds(now, -3 * 86400),
    );
    const live = Array.from({ length: 998 }, () =>
      storedProposal({
        org: F.O,
        ws,
        proposer: A,
        taskId: F.task("a", ws),
        capabilityId: "governance.grants.revise",
        targets: grantsTarget(F.O, ws, C.principal),
        beneficiaries: [C.principal],
        policy,
        createdAt: now,
      }),
    );
    for (let i = 0; i < live.length; i += 250)
      db.workOwner(
        "BEGIN;\n" +
          live
            .slice(i, i + 250)
            .map((s) => storedProposalSql(s, F.O, ws))
            .join("\n") +
          "\nCOMMIT;",
      );
    const b25 = atW(B, "W25");
    const root = await applied(atW(A, "W25"), eraseBody(["p1", "p2", "p3"], F.task("a", ws)));
    const rootView = (await read(b25, root.proposalRef.id)).proposal;
    const derive = (selection) =>
      decide(
        b25,
        root.proposalRef.id,
        decision(previewSelection(rootView, selection).proposal.proposalDigest, {
          selectedTargetIndexes: selection,
        }),
        1,
      );
    const first = await derive([0]);
    const beforeFull = snapshot(ws);
    const full = await derive([1]);
    check(
      "AC23:derivation_counts_live_pending",
      first.status === "pending" && full.code === "limit_reached" && same(snapshot(ws), beforeFull),
      { first, full },
    );
  });

  // ===========================================================================
  await section("AC24", async () => {
    const ws = W("W");
    const a = atW(A, "W");
    const sent = [];
    const s = await submit(a, grantsBody(C, null), {
      hooks: {
        async beforeQuery(record) {
          sent.push(record.text);
        },
      },
    });
    check("AC24:applied", s.outcome === "applied", s);
    const row = proposalRowOf(s.proposalRef.id);
    const doc = JSON.parse(row.canonical);
    check(
      "AC24:null_task_requested_by_proposer",
      row.task_id === null && same(doc.requestedBy, actorRef(a)) && doc.taskId === null,
    );
    check("AC24:no_task_read", !sent.some((t) => t.includes("FROM morrow_work.tasks")));
    for (const p of [a, atW(C, "W")]) {
      const r = await decide(p, s.proposalRef.id, decision(s.proposalRef.digest), 1);
      check("AC24:self_approval_denied_" + p.name, r.code === "SELF_APPROVAL_DENIED", r);
    }
    // A null task with a capability outside the Governance domain is invalid.
    db.admin(
      grantSql(
        a,
        grant(
          { ...a, key: "a_routine" },
          "workspace.routine.activate",
          ["execute"],
          ["expectedRevision", "mandate", "routineId"],
        ),
      ),
    );
    const catalog = await submit(a, {
      capabilityId: "workspace.routine.activate",
      taskId: null,
      parameters: { routineId: "routine_1" },
    });
    check("AC24:non_governance_null_task_invalid", catalog.outcome === "invalid", catalog);
    const base = await captureSubmit(a, grantsBody(C, null));
    const d = JSON.parse(base[10]);
    d.capabilityId = "workspace.routine.activate";
    const text = canonicalize(d);
    const values = [...base];
    values[0] = randomUUID();
    values[10] = text;
    values[11] = sha(text);
    check(
      "AC24:direct_non_governance_invalid",
      apiCall(a, submitCall(values), "COMMIT") === "invalid",
    );
    // Owner rows: a null task needs a governance capability and requester = proposer.
    const policy = {
      doc: JSON.parse(
        db.sql(
          `SELECT canonical FROM morrow_work.review_policies WHERE workspace_id=${literal(ws)} AND revision=1;`,
        ),
      ),
      digest: db.sql(
        `SELECT digest FROM morrow_work.review_policies WHERE workspace_id=${literal(ws)} AND revision=1;`,
      ),
    };
    const t = storedProposal({
      org: F.O,
      ws,
      proposer: A,
      requester: B,
      taskId: null,
      capabilityId: "governance.grants.revise",
      targets: grantsTarget(F.O, ws, C.principal),
      beneficiaries: [C.principal],
      policy,
      createdAt: dbNow(),
    });
    check(
      "AC24:owner_requester_not_proposer_fails",
      !db.tryRun(
        "SET ROLE morrow_work_owner; BEGIN; " + storedProposalSql(t, F.O, ws) + " ROLLBACK;",
      ).ok,
    );
    const u = storedProposal({
      org: F.O,
      ws,
      proposer: A,
      taskId: null,
      capabilityId: "workspace.routine.activate",
      targets: grantsTarget(F.O, ws, C.principal),
      policy,
      createdAt: dbNow(),
    });
    const check2 = db.tryRun(
      "SET ROLE morrow_work_owner; BEGIN; " + storedProposalSql(u, F.O, ws) + " ROLLBACK;",
    );
    check("AC24:owner_non_governance_null_task_fails", !check2.ok);
  });

  return { checks, failures, retries: stats.retries };
}

async function main() {
  const started = Date.now();
  const print = console.log.bind(console);
  const only = process.env.MORROW_APPROVAL_LAB_ONLY?.split(",") ?? null;
  const rounds = process.env.MORROW_APPROVAL_RACE_ROUNDS ?? "1";
  if (!/^([1-9]|1[0-9]|20)$/.test(rounds)) throw Error("MORROW_APPROVAL_RACE_ROUNDS_INVALID");
  const raceRounds = Number(rounds);
  let result;
  await withWorkDatabase("P06.T01b.approval-records", async (db) => {
    result = await runApprovalRecordsLab(db, {
      only,
      print,
      raceRounds,
      verbose: process.env.MORROW_APPROVAL_LAB_VERBOSE === "1",
    });
  });
  const report = {
    task: "P06.T01b",
    qualification: "local_postgresql17_network_none_approval_records_acceptance",
    mode: raceRounds === 1 ? "pull_request" : "race_rounds_" + raceRounds,
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checks: result.checks,
    unavailableRetries: result.retries,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "Cases are isolated by workspace or organization, not by template-database clones (the P03.T04e PR-B harness is not merged).",
      "0004 revocations are reproduced by owner maintenance with the same lock order and effects; back-dated 0004 results are owner-inserted receipt and result pairs.",
      "The routes, the request guard and the workerd lab are PR-2; AC16's S1-S6 and P1-P6 run in lab:tenant-conformance.",
      "AC17 forces each race once per round in each order by a hook, including two under-lock variants where the second command waits on the first's locks; the repeated-round matrix (MORROW_APPROVAL_RACE_ROUNDS) runs by hand only and is not yet a heavy-faults.yml leg (open, with the P06.T01a soak).",
    ],
  };
  writeArtifact("labs/approval-records.json", report);
  if (result.failures.length) {
    print("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else print(`PASS: ${result.checks.length} P06.T01b approval records checks.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
