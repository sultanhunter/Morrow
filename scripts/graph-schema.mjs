// The closed tables of the project knowledge graph: node types, id shapes, fields, status
// lists, edge rules and check codes. scripts/graph.mjs builds and checks the graph from
// them; docs/graph/README.md shows them (its schema block is generated from this file).
// The owner adopted the graph on 2026-10-23 (decision 10 of the redefined MVP). The graph
// is documentation, never authority: nothing in apps/ or packages/ may import it, and
// every permission, budget and data-class rule stays in code (GRAPH_IMPORTED_BY_CODE).
import { TASK_STATUSES } from "./foundation.mjs";

// Phase 0 builds what already has a home and holds a small hand-written seed. These three
// rules need headers that phase 2 adds in place, so until then they are warnings
// (`graph:check --strict` treats them as errors).
export const PHASE0_WARNINGS = Object.freeze([
  "GRAPH_ORPHAN",
  "GRAPH_UNCLAIMED_DOC",
  "GRAPH_NEW_PACKET",
]);

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const slugId = (prefix) => new RegExp(`^${prefix}-${SLUG}$`);

// Shopify Admin API access scopes an agent release may name (closed list).
export const SHOPIFY_SCOPES = Object.freeze(
  [
    "products",
    "orders",
    "customers",
    "inventory",
    "locations",
    "fulfillments",
    "returns",
    "discounts",
    "price_rules",
    "marketing_events",
    "content",
    "online_store_pages",
    "themes",
    "files",
    "translations",
    "metaobjects",
    "publications",
    "product_listings",
    "legal_policies",
    "reports",
    "shipping",
    "draft_orders",
    "markets",
    "gift_cards",
  ]
    .flatMap((scope) => [`read_${scope}`, `write_${scope}`])
    .concat(["read_all_orders"]),
);

const text = Object.freeze({ kind: "text" });
const list = Object.freeze({ kind: "list" });
const date = Object.freeze({ kind: "date" });
const oneOf = (...values) => Object.freeze({ kind: "enum", values });
const listOf = (values) => Object.freeze({ kind: "enum_list", values });
const shape = (pattern) => Object.freeze({ kind: "pattern", pattern });
const yesNo = ["yes", "no"];

// Fields every node file may carry. `links` maps an edge name to a list of ids; `docs`
// lists auxiliary files (a path, or `codex-archive-f89ad75:<path>` for archived ones).
export const COMMON_FIELDS = Object.freeze(["id", "type", "title", "status", "links", "docs"]);
export const ARCHIVE_PREFIX = "codex-archive-f89ad75:";

// Each type: its id shapes (every shape belongs to exactly one type), whether nodes of it
// are hand-written under docs/graph/<dir>/ (`dir`), its status list (null: as in its source
// registry or none), its extra fields and the fields a hand-written node must carry.
export const NODE_TYPES = Object.freeze({
  vision: {
    shape: "V-<slug>",
    patterns: [slugId("V")],
    dir: "vision",
    stored: "hand-written",
    statuses: ["active"],
    fields: {},
  },
  feature: {
    shape: "F-<slug>",
    patterns: [slugId("F")],
    dir: "features",
    stored: "hand-written",
    statuses: ["proposed", "planned", "active", "done", "dropped"],
    fields: { area: text, must: oneOf("yes", "later") },
  },
  agent: {
    shape: "AG-<slug>",
    patterns: [slugId("AG")],
    dir: "agents",
    stored: "hand-written; later `agents/<id>/agent.json`",
    statuses: ["proposed", "planned", "built", "released", "dropped"],
    fields: {
      kind: oneOf("builtin", "installable", "task_specialist"),
      slip_rank: shape(/^[0-9]$/),
      scopes_required: listOf(SHOPIFY_SCOPES),
      scopes_optional: listOf(SHOPIFY_SCOPES),
      customer_data: oneOf("none", "level1", "level2"),
      computer: oneOf("yes", "no", "fallback"),
      depth: oneOf("0", "1"),
    },
    required: ["kind"],
  },
  skill: {
    shape: "SK-<slug>",
    patterns: [slugId("SK")],
    dir: "skills",
    stored: "hand-written until `skills/<id>/skill.json` exists",
    statuses: ["proposed", "planned", "built", "released", "revoked", "dropped"],
    fields: {
      specialist_eligible: oneOf(...yesNo),
      runtime: oneOf("none", "computer", "computer-optional", "fallback"),
      output_contract: text,
      job_tags: list,
    },
    required: ["specialist_eligible"],
  },
  installation_kind: {
    shape: "IK-<slug>",
    patterns: [slugId("IK")],
    dir: "installation-kinds",
    stored: "hand-written",
    statuses: ["proposed", "planned", "built", "dropped"],
    fields: {
      lifetime: text,
      mandate: oneOf(...yesNo),
      triggers: oneOf(...yesNo),
      started_by: oneOf("owner-admin-install", "owner-start", "member-start"),
      routable: oneOf(...yesNo),
      authority_records: text,
    },
    required: ["mandate", "triggers", "routable"],
  },
  track: {
    shape: "TRK-<slug>",
    patterns: [slugId("TRK")],
    dir: "tracks",
    stored: "hand-written or brief frontmatter",
    statuses: ["proposed", "active", "done", "dropped"],
    fields: { label: shape(/^T[0-9]{1,2}$/), weeks: text, agents: list },
    required: ["label"],
  },
  gate: {
    shape: "GATE-<slug>",
    patterns: [slugId("GATE")],
    dir: "gates",
    stored: "hand-written",
    statuses: ["open", "passed", "waived", "dropped"],
    fields: {
      label: shape(/^G[0-9]{1,2}$/),
      owner_kind: oneOf("owner", "shopify", "provider", "ci", "claude"),
      due_week: shape(/^W[0-9]{1,2}$/),
    },
    required: ["label"],
  },
  data_class: {
    shape: "DC-<slug>",
    patterns: [slugId("DC")],
    dir: "data",
    stored: "hand-written",
    statuses: ["planned", "deletion-ready", "live", "retired"],
    fields: { retention: text, deletion: text, customer: oneOf(...yesNo) },
  },
  // M<n>: the beta milestones (briefs; frozen, the MVP uses tracks). GP<n>: build-plan's
  // golden-path M1 to M5, built from the plan's milestone table under the label M<n>.
  // V1-PR<nn>: the owner-facing v1 build order's PRs 1 to 26 (ADR-0035,
  // docs/plan/v1-build-order.md), each part_of its tracks; a merged pull request whose title
  // starts "v1 PR <n>:" implements it.
  milestone: {
    shape: "M<n> (beta), GP<n> (golden path), V1-PR<nn> (v1 build order)",
    patterns: [/^M[1-9]$/, /^GP[1-9]$/, /^V1-PR[0-9]{2}$/],
    dir: "milestones",
    stored: "brief frontmatter, a file when there is no brief (V1-PR<nn>), or the plan (GP)",
    statuses: ["proposed", "active", "done", "folded", "dropped"],
    fields: { label: shape(/^M[1-9]$/) },
  },
  package: {
    shape: "P<nn>",
    patterns: [/^P[0-9]{2}$/],
    stored: "the plan; acceptance-file frontmatter",
    statuses: null,
    fields: { kind: oneOf("security") },
  },
  task: {
    shape: "P<nn>.T<nn>, P<nn>.T<nn><letters>",
    patterns: [/^P[0-9]{2}\.T[0-9]{2}[a-z]*$/],
    stored: "the plan and `tasks.json`; packet frontmatter",
    statuses: [...TASK_STATUSES, "Dropped"],
    fields: { kind: oneOf("security") },
  },
  acceptance: {
    shape: "P<nn>.A<nn>, <task>-AC<nn>[a-z]",
    patterns: [/^P[0-9]{2}\.A[0-9]{2}$/, /^P[0-9]{2}\.T[0-9]{2}[a-z]*-AC[0-9]{2}[a-z]?$/],
    stored: "the plan, packets and `docs/acceptance/`",
    statuses: ["open", "passed", "deferred"],
    fields: {},
  },
  adr: {
    shape: "ADR-<nnnn>, ADR-draft-<slug>",
    patterns: [/^ADR-[0-9]{4}$/, slugId("ADR-draft")],
    stored: "`docs/decisions/adr/` (header bullets; frontmatter from phase 2)",
    statuses: ["proposed", "accepted", "superseded", "rejected"],
    fields: { date, readme_status: text },
  },
  decision: {
    shape: "OD-<yyyy-mm-dd>-<n>",
    patterns: [/^OD-[0-9]{4}-[0-9]{2}-[0-9]{2}-[1-9][0-9]*$/],
    dir: "decisions",
    stored: "hand-written; the verbatim quote is a blockquote",
    statuses: ["recorded"],
    fields: { date, by: oneOf("owner", "claude"), channel: oneOf("chat", "pr", "call", "email") },
    required: ["by"],
  },
  card: {
    shape: "<env>-card-<n>",
    patterns: [/^[a-z]+-card-[1-9][0-9]*$/],
    stored: "`docs/decisions/approvals/*.json` and their record",
    statuses: ["approved", "expired", "revoked"],
    fields: { approved_on: date, expires_on: date },
  },
  evidence: {
    shape: "<yyyy-mm-dd>-<slug> (the file stem)",
    patterns: [new RegExp(`^[0-9]{4}-[0-9]{2}-[0-9]{2}-${SLUG}$`)],
    stored: "`docs/evidence/live/` (bullets; frontmatter from phase 2)",
    statuses: ["recorded"],
    fields: { unknown_outcome: oneOf("none", "open", "closed") },
  },
  pr: {
    shape: "PR-<n>",
    patterns: [/^PR-[1-9][0-9]*$/],
    stored: "merged pull requests from git history",
    statuses: ["open", "merged", "closed"],
    fields: { commit: shape(/^[0-9a-f]{7,40}$/), date },
  },
  branch: {
    shape: "claude/<slug>",
    patterns: [/^claude\/[a-z0-9]+(?:[-.][a-z0-9]+)*$/],
    dir: "branches",
    stored: "hand-written: the train's branches; a merged one keeps its node, status merged",
    statuses: ["built", "open", "merged", "abandoned"],
    fields: { head: shape(/^[0-9a-f]{7,40}$/) },
  },
  component: {
    shape: "C-<slug>",
    patterns: [slugId("C")],
    dir: "components",
    stored: "`apps/*` and `packages/*`; logical parts hand-written",
    statuses: ["local", "staging", "production"],
    fields: {},
  },
  dependency: {
    shape: "D<nn>",
    patterns: [/^D[0-9]{2}$/],
    stored: "`docs/decisions/dependencies.json`",
    statuses: null,
    fields: {},
  },
  source: {
    shape: "S<nn>, S<nnn>",
    patterns: [/^S[0-9]{2,3}$/],
    stored: "`docs/research/sources.json`",
    statuses: null,
    fields: {},
  },
  capability: {
    shape: "dotted lowercase, e.g. catalog.content.publish",
    patterns: [/^[a-z]+(?:\.[a-z_]+)+$/],
    stored: "`docs/contracts/capabilities.json`",
    statuses: null,
    fields: {},
  },
  question: {
    shape: "Q-<slug>",
    patterns: [slugId("Q")],
    dir: "questions",
    stored: "hand-written",
    statuses: ["open", "answered", "withdrawn"],
    fields: {
      kind: oneOf("decide", "do", "provider"),
      asked_of: oneOf("owner", "claude", "shopify", "provider"),
    },
    required: ["kind", "asked_of"],
  },
  risk: {
    shape: "RISK-<slug>",
    patterns: [slugId("RISK")],
    dir: "risks",
    stored: "hand-written",
    statuses: ["open", "mitigated", "accepted", "closed"],
    fields: {},
  },
  reference: {
    shape: "its path: docs/**.md, CLAUDE.md, AGENTS.md, README.md",
    patterns: [
      /^(?:docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md|CLAUDE\.md|AGENTS\.md|README\.md)$/,
    ],
    stored: "every other doc, by its path",
    statuses: null,
    fields: {},
  },
});

// The statuses after which a work node no longer blocks anything that depends on it.
export const DONE_STATUSES = Object.freeze({
  task: ["Verified", "Self-reviewed", "Dropped"],
  feature: ["done", "dropped"],
  track: ["done", "dropped"],
  milestone: ["done", "folded", "dropped"],
  agent: ["released", "dropped"],
  skill: ["released", "revoked", "dropped"],
  gate: ["passed", "waived", "dropped"],
  installation_kind: ["built", "dropped"],
  pr: ["merged", "closed"],
  branch: ["merged", "abandoned"],
  question: ["answered", "withdrawn"],
});

// Statuses that mark a node as dropped for label uniqueness and coverage.
export const INACTIVE_STATUSES = Object.freeze(["dropped", "Dropped", "superseded", "withdrawn"]);

export const ANY = "*";
const WORK = ["task", "track", "feature", "agent", "skill", "milestone", "gate"];

// Edge name → the [from types, to types] pairs it may connect. Each edge is stored once, on
// its "from" node; views show the inverse as backlinks. `cites` from a dependency is built
// from dependencies.json `sources`.
export const EDGES = Object.freeze({
  part_of: [
    [["task"], ["package", "task"]],
    [["acceptance"], ["task", "package"]],
    [["feature"], ["vision"]],
    [["component"], ["component"]],
    [["milestone"], ["track"]],
  ],
  includes: [
    [
      ["feature", "track", "milestone"],
      ["task", "package"],
    ],
  ],
  // Plan work a feature or track names and leaves until after launch (query uncovered).
  defers: [
    [
      ["feature", "track"],
      ["task", "package"],
    ],
  ],
  delivers: [
    [
      ["track", "milestone"],
      ["feature", "agent", "skill", "installation_kind"],
    ],
  ],
  needs: [
    [
      ["agent", "skill", "feature"],
      ["capability", "component", "feature"],
    ],
  ],
  holds: [[["agent", "skill", "feature"], ["data_class"]]],
  bundles: [[["agent"], ["skill"]]],
  composes: [[["agent"], ["skill"]]],
  delegates_to: [[["agent"], ["agent"]]],
  installs_as: [[["agent"], ["installation_kind"]]],
  may_hold: [[["installation_kind", "agent"], ["capability"]]],
  never_holds: [[["installation_kind", "agent"], ["capability"]]],
  deleted_by: [[["data_class"], ["task", "track", "pr"]]],
  depends_on: [[WORK, [...WORK, "pr", "question"]]],
  waits_on: [[WORK, ["gate"]]],
  governed_by: [[[ANY], ["adr", "decision"]]],
  approved_by: [[["adr", "card", "gate", "feature"], ["decision"]]],
  supersedes: [
    [["adr"], ["adr"]],
    [["decision"], ["decision"]],
  ],
  amends: [
    [["adr"], ["adr"]],
    [["decision"], ["decision"]],
  ],
  refines: [
    [["adr"], ["adr"]],
    [["decision"], ["decision"]],
  ],
  answers: [[["decision"], ["question"]]],
  // The inverse of answers, for a question written after the decision that answered it: an
  // owner decision's file is never edited, so the question carries the link.
  answered_by: [[["question"], ["decision"]]],
  implements: [
    [
      ["pr", "branch"],
      ["task", "track", "milestone"],
    ],
  ],
  from_branch: [[["pr"], ["branch"]]],
  stacked_on: [[["branch"], ["branch"]]],
  verifies: [
    [
      ["evidence", "pr"],
      ["acceptance", "task", "gate"],
    ],
  ],
  authorized_by: [[["evidence"], ["card", "decision"]]],
  touches: [[["pr", "task"], ["component"]]],
  uses: [[["component", "capability"], ["dependency"]]],
  cites: [[["adr", "decision", "reference", "dependency"], ["source"]]],
  raised_by: [
    [
      ["question", "risk"],
      ["decision", "evidence", "adr"],
    ],
  ],
  about: [[["question", "risk"], [ANY]]],
  mitigated_by: [[["risk"], ["task", "track", "adr", "question"]]],
  mentions: [[[ANY], [ANY]]],
});

// Relations that must stay acyclic. depends_on and waits_on are one ordering.
export const ACYCLIC = Object.freeze([["part_of"], ["supersedes"], ["depends_on", "waits_on"]]);

// Body text is scanned only for these unambiguous families. S, D, M, PR-, E and the track
// and gate labels count only inside typed links or as [[S149]], to avoid the "S7", "D9",
// "PR-2" and "T3" traps. A lettered range such as P11.T01a–T03a mentions every id in it.
export const MENTION = new RegExp(
  "(?<![\\w./-])(?:" +
    [
      "OD-[0-9]{4}-[0-9]{2}-[0-9]{2}-[1-9][0-9]*",
      `ADR-(?:[0-9]{4}|draft-${SLUG})`,
      "P[0-9]{2}\\.T[0-9]{2}[a-z]*-AC[0-9]{2}[a-z]?",
      "P[0-9]{2}\\.A[0-9]{2}",
      "P[0-9]{2}\\.T[0-9]{2}[a-z]*",
      `(?:V|F|AG|SK|IK|TRK|GATE|DC|C|Q|RISK)-${SLUG}`,
      "V1-PR[0-9]{2}",
    ].join("|") +
    ")(?![\\w-])",
  "g",
);
export const WIKI_LINK = /\[\[([^\]\s]{1,200})\]\]/g;

// Ids of tenant records: the graph describes kinds, never a merchant's organisations,
// workspaces, installations, runs or grants (principle 7).
export const TENANT_RECORD = Object.freeze([
  /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/i,
  /\b(?:org|user|om|conn|directory|session|ws|wsp|inst|run|grant)_[0-9A-Za-z]{16,}\b/,
  /\bgid:\/\/shopify\//i,
  /\b[a-z0-9][a-z0-9-]*\.myshopify\.com\b/i,
]);
// The domain's first label holds a letter, so a versioned contract field such as
// `ApprovalRecord@2.scopeDigest` is not an address.
export const EMAIL =
  /[A-Za-z0-9._%+-]+@(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

// Packets and acceptance files that exist at phase 0. Any other one must declare
// `kind: security` (GRAPH_NEW_PACKET): new MVP work uses the graph and one-page briefs.
export const LEGACY_PACKETS = Object.freeze(
  (
    "P01.T01 P01.T02 P01.T02a P01.T02c P01.T03 P01.T04 P01.T04a P02.T01 P02.T02 P02.T03 " +
    "P02.T04 P03.T01 P03.T02 P03.T03 P03.T04 P03.T04c P03.T04e P03.T04f P04.T01 P04.T01a " +
    "P04.T01b P04.T01c-daytona-support-draft P04.T01c P04.T01d P04.T01e-daytona-follow-up " +
    "P04.T01e P04.T01f-free-credit-request P04.T01f P04.T01g P04.T01h P04.T01i P04.T01j " +
    "P04.T02 P04.T02a P04.T03 P04.T04 P05.T01 P05.T01b P05.T01c P05.T01d P05.T01e P05.T01f " +
    "P05.T01g P05.T01h P05.T01i P05.T01j P05.T01k P05.T01l P05.T01m P05.T01n P05.T01o " +
    "P05.T01p P05.T01q P05.T01r P05.T01s P05.T01t P05.T01u P05.T01v P05.T01w P05.T01x " +
    "P05.T01y P05.T01z P05.T02 P05.T03a P05.T03b P05.T04a P06.T01a P06.T01b P14.T01a"
  )
    .split(" ")
    .map((stem) => `docs/packets/${stem}.md`)
    .concat(
      ["P01", "P02", "P03", "P04", "P05", "P06", "P14"].map((p) => `docs/acceptance/${p}.md`),
    ),
);

// Week 0 of the redefined MVP's plan (Monday). A gate's due_week W<n> ends 7(n+1) days later.
export const WEEK_ZERO = "2026-10-26";
export const CARD_EXPIRY_WARNING_DAYS = 14;
export const STATUS_MAX_LINES = 80;
export const GITHUB_BLOB = "https://github.com/sultanhunter/Morrow/blob/main/";
export const CYTOSCAPE = "https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.33.1/cytoscape.min.js";

// Every check code. Errors fail `graph:check`; warnings are printed and CI still passes.
export const ERRORS = Object.freeze({
  GRAPH_PARSE: "Frontmatter parses with the failsafe schema: strings, lists and maps only",
  GRAPH_FIELD:
    "Fields are closed per type, required fields are present, closed values come from their lists",
  GRAPH_ID_SHAPE: "An id matches its type's pattern",
  GRAPH_ID_DUPLICATE: "An id is unique across files, the plan, tasks.json and the registries",
  GRAPH_LABEL_DUPLICATE: "Track and gate labels are unique among active nodes",
  GRAPH_LINK_DANGLING: "Every typed link and unambiguous mention resolves",
  GRAPH_EDGE_TYPE: "Each edge connects the types its table allows",
  GRAPH_UNCLAIMED_DOC: "Every governed .md belongs to one node, and every node's doc path exists",
  GRAPH_ORPHAN: "Every node except V-morrow has a typed edge; reference docs need one link in",
  GRAPH_CYCLE: "No cycles in part_of, supersedes, depends_on or waits_on",
  GRAPH_STATUS: "Status values come from the type's list",
  GRAPH_TASK_STATUS_DRIFT: "Parent task statuses equal tasks.json, and both list the same tasks",
  GRAPH_GATE_FIELDS: "An open gate has owner_kind and due_week",
  GRAPH_DATA_CLASS:
    "A live data class has a deleted_by link to a merged PR (without history, a PR link is a warning)",
  GRAPH_SKILL_ELIGIBLE:
    "A skill a task_specialist composes is specialist_eligible and holds no customer data class",
  GRAPH_AGENT_KIND:
    "delegates_to starts at a builtin agent; a task_specialist delegates nothing and never_holds workspace.task.delegate; bundles starts at an installable agent",
  GRAPH_INSTALLATION_KIND:
    "triggers need a mandate; routable needs triggers or a mandate; IK-task-specialist is not routable",
  GRAPH_TENANT_RECORD:
    "No node id or field, and nothing in a hand-written graph file, looks like a tenant record id",
  GRAPH_DECISION_QUOTE: "An owner decision has a date, a channel and a blockquote",
  GRAPH_EVIDENCE_AUTH: "Evidence with a header has authorized_by and an unknown_outcome value",
  GRAPH_ADR_APPROVAL: "An accepted ADR with a header has approved_by",
  GRAPH_NEW_PACKET: "A new packet or acceptance file declares kind: security",
  GRAPH_SECRET: "No known secret pattern in the hand-written graph or any frontmatter",
  GRAPH_EMAIL:
    "No email address in a governed doc or any frontmatter (reserved test domains such as .invalid are allowed)",
  GRAPH_STALE_GENERATED: "Generated blocks (graph README schema, ADR index) are fresh",
  GRAPH_STATUS_LINES: "STATUS.md is at most 80 lines",
  GRAPH_IMPORTED_BY_CODE: "Nothing in apps/ or packages/ imports the graph",
});

export const WARNINGS = Object.freeze({
  GRAPH_WARN_SUPERSEDED_BASIS: "An accepted ADR whose approving decision was superseded",
  GRAPH_WARN_STALE_ACTIVE: "An active node with no recent PR or evidence and no open branch",
  GRAPH_WARN_CARD_EXPIRING: "An approval card expires within 14 days",
  GRAPH_WARN_GATE_OVERDUE: "An open gate past its due week",
  GRAPH_WARN_PLAN_UNCOVERED: "A plan task that no feature or track includes or defers by name",
  GRAPH_WARN_LABEL_COLLISION: "Two milestones share a label (M2 to M5: beta and golden path)",
  GRAPH_WARN_LEGACY_MENTION:
    "A doc without a header mentions an id that does not resolve (an error once it has one)",
  GRAPH_WARN_NO_HISTORY:
    "Git history is shallow or missing, so PR nodes are skipped and PR links are not checked",
  GRAPH_WARN_BRANCH_MERGED: "A merged PR came from a branch node that is not marked merged",
});
