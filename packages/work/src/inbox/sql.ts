// Every statement the Inbox and Activity reads send (v1 PR 15, track T7), merged into
// workStatements so WorkTx.run accepts no other text. Source fixed: values travel only as
// bind parameters, and every selected column is text. They run as morrow_work_api under
// the existing tenant_read policies and column grants (FORCE RLS; no migration): ids,
// statuses, codes and times only. Never a person's stop reason or review comment, a
// product's content, a provider id or a credential.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Keyset on (at DESC, id DESC): $1 is the cursor's microseconds, $2 its id.
const before = (at: string, id: string) =>
  `($1::text IS NULL OR ${at}<timestamptz 'epoch'+($1::text||' microseconds')::interval OR (${at}=timestamptz 'epoch'+($1::text||' microseconds')::interval AND ${id} COLLATE "C"<$2::text COLLATE "C"))`;
// One leg of the activity page: its own keyset and limit ($3), newest first. Every leg has
// the same columns; an entry id is a kind letter and the md5 of its natural key (always a
// valid record id, whatever the length of the ids it hashes).
const leg = (columns: string, from: string, where: string, at: string, id: string) =>
  `(SELECT ${columns} FROM ${from} WHERE ${where ? where + " AND " : ""}${before(at, id)} ORDER BY ${at} DESC,${id} COLLATE "C" DESC LIMIT $3::integer)`;
const columns = (c: {
  kind: string;
  id: string;
  at: string;
  actor?: string;
  proposal?: string;
  task?: string;
  store?: string;
  connection?: string;
  target?: string;
  code?: string;
  reason?: string;
  count?: string;
  drafted?: string;
  failed?: string;
  fields?: string;
}) =>
  [
    `'${c.kind}'::text AS kind`,
    `${c.id} AS id`,
    `${c.at} AS at`,
    `${c.actor ?? "NULL::text"} AS actor_principal_id`,
    `${c.proposal ?? "NULL::text"} AS proposal_id`,
    `${c.task ?? "NULL::text"} AS task_id`,
    `${c.store ?? "NULL::text"} AS store_id`,
    `${c.connection ?? "NULL::text"} AS connection_id`,
    `${c.target ?? "NULL::text"} AS target_id`,
    `${c.code ?? "NULL::text"} AS code`,
    `${c.reason ?? "NULL::text"} AS reason`,
    `${c.count ?? "NULL::text"} AS product_count`,
    `${c.drafted ?? "NULL::text"} AS products_drafted`,
    `${c.failed ?? "NULL::text"} AS products_failed`,
    `${c.fields ?? "NULL::text"} AS fields`,
  ].join(",");

const decisionId = `'d'||md5(d.approval_id::text||'|'||d.sequence::text)`;
const changeId = `'c'||md5(t.operation_id::text||'|'||t.revision::text)`;
const stopId = `'k'||md5(k.id::text)`;
const systemStopId = `'s'||md5(s.id::text)`;
const installationId = `'i'||md5(i.id::text)`;
const runId = `'r'||md5(r.id::text)`;
// The apply outcomes a person reads in the log: applied and checked, not applied, unknown
// (needs attention), and set aside by the person who applied it.
const loggedChanges = `t.to_status IN ('verified','failed','conflict','uncertain','cancel_requested')`;

const activityLegs = [
  // A person's decision on an approval (approve or reject); never their comment.
  leg(
    columns({
      kind: "decision",
      id: decisionId,
      at: "d.decided_at",
      actor: "d.reviewer_principal_id::text",
      proposal: "a.proposal_id::text",
      code: "d.decision",
    }),
    "morrow_work.approval_decisions d JOIN morrow_work.approvals a ON a.organization_id=d.organization_id AND a.workspace_id=d.workspace_id AND a.id=d.approval_id",
    "",
    "d.decided_at",
    decisionId,
  ),
  // The gateway's outcome for one product of an applied change (codes only).
  leg(
    columns({
      kind: "change",
      id: changeId,
      at: "t.occurred_at",
      proposal: "o.proposal_id::text",
      task: "o.task_id::text",
      store: "o.store_id::text",
      target: "o.id::text",
      code: "t.to_status",
      reason: "t.reason",
    }),
    "morrow_work.operation_transitions t JOIN morrow_work.operations o ON o.organization_id=t.organization_id AND o.workspace_id=t.workspace_id AND o.id=t.operation_id",
    `o.kind='catalog_write' AND ${loggedChanges}`,
    "t.occurred_at",
    changeId,
  ),
  // A person's kill switch: Stop AI work (an installation) or Disconnect store.
  leg(
    columns({
      kind: "stop",
      id: stopId,
      at: "k.created_at",
      actor: "k.actor_principal_id::text",
      store: "k.store_id::text",
      connection: "k.connection_id::text",
      target: "k.target_id::text",
      code: "k.capability_id",
      reason: "k.prior_state_observed",
    }),
    "morrow_work.kill_switch_records k",
    "",
    "k.created_at",
    stopId,
  ),
  // Shopify ended the connection (the app uninstalled, or its access scopes changed): the
  // system connection stop's code, never its text.
  leg(
    columns({
      kind: "system_stop",
      id: systemStopId,
      at: "s.created_at",
      store: "s.store_id::text",
      connection: "s.target_id::text",
      target: "s.target_id::text",
      code: "s.reason_code",
    }),
    "morrow_work.stop_controls s",
    "s.organization_id IS NOT NULL AND s.scope='connection' AND s.set_by_kind='system'",
    "s.created_at",
    systemStopId,
  ),
  // An agent added to a store (today the Listings agent), by its owner.
  leg(
    columns({
      kind: "installation",
      id: installationId,
      at: "i.created_at",
      actor: "i.owner_principal_id::text",
      store: "i.store_id::text",
      connection: "i.connection_id::text",
      target: "i.id::text",
      code: "i.release_id::text",
    }),
    "morrow_work.agent_installations i",
    "",
    "i.created_at",
    installationId,
  ),
  // A person asked Listings to draft changes for some products (counts, never product ids).
  leg(
    columns({
      kind: "run",
      id: runId,
      at: "r.created_at",
      actor: "r.requester_principal_id::text",
      task: "r.task_id::text",
      store: "r.store_id::text",
      connection: "r.connection_id::text",
      target: "r.id::text",
      code: "r.status",
      reason: "r.ended_reason",
      count: "r.product_count::text",
      drafted: "r.products_drafted::text",
      failed: "r.products_failed::text",
      fields: "to_jsonb(r.fields)::text",
    }),
    "morrow_work.runs r",
    "",
    "r.created_at",
    runId,
  ),
];

export const inboxStatements = Object.freeze({
  // The Inbox's apply problems (tenant_read on operations and their transitions): unknown
  // outcomes, whenever they happened, and the last seven days' not-applied ones; the reason
  // of the current status and nothing else. At most 101: the read keeps the first 50 the
  // viewer may see from the first 100, and one more row tells the scan's bound from the end.
  inboxOperations: `SELECT o.id::text AS id,o.task_id::text AS task_id,o.store_id::text AS store_id,o.proposal_id::text AS proposal_id,o.status,o.uncertainty_reason,(SELECT t.reason FROM morrow_work.operation_transitions t WHERE t.organization_id=o.organization_id AND t.workspace_id=o.workspace_id AND t.operation_id=o.id AND t.to_status=o.status ORDER BY t.revision DESC LIMIT 1) AS reason,${utc("o.updated_at")} AS updated_at FROM morrow_work.operations o WHERE o.kind='catalog_write' AND (o.status='uncertain' OR (o.status IN ('failed','conflict') AND o.updated_at>clock_timestamp()-interval '7 days')) ORDER BY (o.status='uncertain') DESC,o.updated_at DESC,o.id::text COLLATE "C" DESC LIMIT 101`,
  // Open stops on the workspace's store connections (tenant_read): who set them (a kind) and
  // their code, never a person's reason text. At most 20.
  inboxConnectionStops: `SELECT s.id::text AS id,s.store_id::text AS store_id,s.target_id::text AS connection_id,s.set_by_kind,s.reason_code,${utc("s.created_at")} AS created_at FROM morrow_work.stop_controls s WHERE s.organization_id IS NOT NULL AND s.scope='connection' AND s.lifted_at IS NULL ORDER BY s.created_at DESC,s.id::text COLLATE "C" DESC LIMIT 20`,
  // The activity log: one page across the audit records, newest first, after a (time, id)
  // keyset; each leg is limited before the union, so a page scans at most $3 rows per leg.
  activityPage: `SELECT x.kind,x.id,${utc("x.at")} AS at,(extract(epoch FROM x.at)*1000000)::bigint::text AS cursor_us,x.actor_principal_id,x.proposal_id,x.task_id,x.store_id,x.connection_id,x.target_id,x.code,x.reason,x.product_count,x.products_drafted,x.products_failed,x.fields FROM (${activityLegs.join(" UNION ALL ")}) x ORDER BY x.at DESC,x.id COLLATE "C" DESC LIMIT $3::integer`,
} as const);
export type InboxStatementName = keyof typeof inboxStatements;
