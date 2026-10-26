// Every statement the knowledge and notebook routes send (PR 20; migration 0052), merged into
// workStatements so WorkTx.run accepts no other text. Source fixed: values travel only as bind
// parameters, and every selected column is text. Reads run as morrow_work_api under tenant_read;
// the work API filters every row per viewer by its read tags in code (ADR-0031 item 6) before
// anything leaves the server, so read_tags is selected with every row that holds content.

// An installation's agent's notebook rows (H12a: keyed by the agent principal).
const notebookOf = (alias: string) =>
  `JOIN morrow_work.agent_installations i ON i.organization_id=${alias}.organization_id AND i.workspace_id=${alias}.workspace_id AND i.agent_principal_id=${alias}.agent_principal_id`;
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const pageColumns = `p.id::text AS id,p.kind,p.title,p.current_version::text AS version,p.read_tags::text AS read_tags,${utc("p.created_at")} AS created_at,${utc("p.updated_at")} AS updated_at`;
const versionColumns = `v.page_id::text AS page_id,v.version::text AS version,v.title,v.body,v.sources::text AS sources,v.read_tags::text AS read_tags,v.author_kind,v.author_principal_id::text AS author_principal_id,v.author_installation_id::text AS author_installation_id,v.accepted_by_principal_id::text AS accepted_by_principal_id,v.proposal_id::text AS proposal_id,${utc("v.created_at")} AS created_at`;
const proposalColumns = `q.id::text AS id,q.page_id::text AS page_id,q.base_version::text AS base_version,q.kind,q.title,q.body,q.sources::text AS sources,q.digest::text AS digest,q.read_tags::text AS read_tags,q.context_taint,q.installation_id::text AS installation_id,${utc("q.created_at")} AS created_at`;

export const knowledgeStatements = Object.freeze({
  beginKnowledgeCommand:
    "SELECT outcome,aggregate_type,aggregate_id,result FROM morrow_work.begin_knowledge_command($1,$2,$3)",
  cmdKnowledgeWrite:
    "SELECT outcome,result FROM morrow_work.cmd_knowledge_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
  cmdKnowledgeAccept:
    "SELECT outcome,result FROM morrow_work.cmd_knowledge_accept($1,$2,$3,$4,$5,$6)",
  cmdKnowledgeReject: "SELECT outcome,result FROM morrow_work.cmd_knowledge_reject($1,$2,$3,$4,$5)",
  cmdKnowledgeDelete: "SELECT outcome,result FROM morrow_work.cmd_knowledge_delete($1,$2,$3,$4,$5)",
  // At the notebook revision read before the clearer's per-viewer check (notebookRevision); the
  // notebook is the installation's agent principal's (H12a, 0057).
  cmdNotebookClear: "SELECT outcome,result FROM morrow_work.cmd_notebook_clear_v2($1,$2,$3,$4,$5)",
  // Live pages, most recently changed first (at most 500 live pages exist; one more is read as
  // a guard).
  knowledgePages: `SELECT ${pageColumns},left(v.body,280) AS excerpt FROM morrow_work.knowledge_pages p JOIN morrow_work.knowledge_versions v ON v.organization_id=p.organization_id AND v.workspace_id=p.workspace_id AND v.page_id=p.id AND v.version=p.current_version WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC,p.id::text COLLATE "C" LIMIT 501`,
  knowledgePage: `SELECT ${pageColumns} FROM morrow_work.knowledge_pages p WHERE p.id=$1::text AND p.deleted_at IS NULL`,
  // One version, live or erased (an erased version's title, text and sources are null).
  knowledgeVersion: `SELECT ${versionColumns} FROM morrow_work.knowledge_versions v WHERE v.page_id=$1::text AND v.version=$2::integer`,
  // A page's latest versions (at most 100), newest first, without their text.
  knowledgeVersionList: `SELECT v.version::text AS version,v.author_kind,v.author_principal_id::text AS author_principal_id,v.author_installation_id::text AS author_installation_id,v.accepted_by_principal_id::text AS accepted_by_principal_id,v.proposal_id::text AS proposal_id,${utc("v.created_at")} AS created_at FROM morrow_work.knowledge_versions v WHERE v.page_id=$1::text ORDER BY v.version DESC LIMIT 100`,
  // Pending proposals, oldest first (at most 50 can be pending; one more is read as a guard).
  knowledgeProposalsPending: `SELECT ${proposalColumns} FROM morrow_work.knowledge_proposals q WHERE q.status='pending' ORDER BY q.created_at,q.id::text COLLATE "C" LIMIT 51`,
  knowledgeProposal: `SELECT ${proposalColumns},q.status FROM morrow_work.knowledge_proposals q WHERE q.id=$1::text`,
  // Full-text candidates, best first (at most 200), with the page's tags; the API keeps the
  // viewer's own and returns at most 20.
  knowledgeSearch: `SELECT p.id::text AS id,p.kind,p.title,p.current_version::text AS version,s.read_tags::text AS read_tags,left(v.body,200) AS snippet FROM morrow_work.knowledge_search_entries s JOIN morrow_work.knowledge_pages p ON p.organization_id=s.organization_id AND p.workspace_id=s.workspace_id AND p.id=s.page_id AND p.deleted_at IS NULL JOIN morrow_work.knowledge_versions v ON v.organization_id=p.organization_id AND v.workspace_id=p.workspace_id AND v.page_id=p.id AND v.version=p.current_version AND v.erased_at IS NULL WHERE s.erased_at IS NULL AND s.document @@ websearch_to_tsquery('simple'::regconfig,$1::text) ORDER BY ts_rank(s.document,websearch_to_tsquery('simple'::regconfig,$1::text)) DESC,p.id::text COLLATE "C" LIMIT 200`,
  // An installation of this workspace (tenant_read), if any.
  knowledgeInstallation:
    "SELECT i.id::text AS id,i.status,i.store_id::text AS store_id,i.connection_id::text AS connection_id FROM morrow_work.agent_installations i WHERE i.id=$1::text",
  // An installation's notebook revision (every write, renewal, retire and erasure bumps it),
  // if its agent has one. Notebooks are keyed by agent principal (H12a, 0057); an installation
  // names its agent. The clear reads it before the entries, so an entry committed after this
  // read is a revision_conflict at cmd_notebook_clear_v2's lock, never erased unseen.
  notebookRevision: `SELECT n.revision::text AS revision FROM morrow_work.agent_notebooks n ${notebookOf("n")} WHERE i.id=$1::text`,
  // Every live notebook entry's scope (read tags, audience and source subjects; no text),
  // newest first: at most 1,000 live (one more is read as a guard). The clear checks them all.
  notebookEntryScopes: `SELECT e.id::text AS id,e.sequence::text AS sequence,e.read_tags::text AS read_tags,e.audience::text AS audience,e.source_subjects::text AS source_subjects,(e.expires_at>clock_timestamp())::text AS current FROM morrow_work.agent_notebook_entries e ${notebookOf("e")} WHERE i.id=$1::text AND e.erased_at IS NULL ORDER BY e.sequence DESC LIMIT 1001`,
  // The text of the entries the viewer may see (at most 100 ids, a JSON array), newest first.
  notebookEntryTexts: `SELECT e.id::text AS id,e.sequence::text AS sequence,e.body,${utc("e.created_at")} AS created_at FROM morrow_work.agent_notebook_entries e ${notebookOf("e")} WHERE i.id=$1::text AND e.erased_at IS NULL AND e.expires_at>clock_timestamp() AND e.id::text IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY e.sequence DESC LIMIT 100`,
} as const);
export type KnowledgeStatementName = keyof typeof knowledgeStatements;
