// The project knowledge graph (scripts/graph.mjs, scripts/graph-schema.mjs): one planted
// mistake per error code on a small fixture that is otherwise clean even in strict mode,
// the derivations from each source, the commands that write node files, and the graph of
// this repository itself.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acceptanceStatus,
  buildGraph,
  graphJson,
  mermaid,
  parseHeader,
  planIdsIn,
  query,
  readHistory,
  readSources,
  renderAdrIndex,
  renderHtml,
  renderSchemaBlock,
  replaceBlock,
  run,
  serializeHeader,
  show,
  splitHeader,
  statusDrift,
  typeOfId,
  uncoveredTasks,
} from "../scripts/graph.mjs";
import * as schema from "../scripts/graph-schema.mjs";
import { adrNumbers } from "../scripts/plan-check.mjs";

const TODAY = "2026-10-23";
const QUOTE =
  "ship the smallest useful slice first and keep the security foundation solid for later";
const node = (header, body = "") => `---\n${header.trim()}\n---\n${body}`;

function baseFiles() {
  const files = {
    "docs/plan/build-plan.md": `# Plan

## 1 Contracts

### Package 01 implementation tasks

1. **P01.T01 Catalogue.** Build the catalogue.
2. **P01.T02 — State.** Shared state.
   - **P01.T02a Contract child.** The first slice.
   - **P01.T02d** Text after the span. More text.
   - **P01.T02e + P01.T02f** Shared work; more.

- **P01.A01** Given a catalogue, when it is checked, then it passes.

| Milestone | Working result | Main packets | Demonstration |
| --- | --- | --- | --- |
| M1 Hosted sign-in | Signs in | P01.T02a | After |
| M2 Collaboration | Works together | P01.T01-T02 slices | After |
`,
    "docs/progress/tasks.json": JSON.stringify({
      tasks: [
        { id: "P01.T01", status: "Verified" },
        { id: "P01.T02", status: "In progress" },
      ],
      acceptance_ids: ["P01.A01"],
    }),
    "docs/progress/STATUS.md":
      "# Status\n\nUpdated 2026-10-20. `main` is at `1111111`.\n\nIn progress:\n- PR #2, the first slice.\n",
    "docs/decisions/adr/ADR-0001-plan.md": `# ADR-0001 Plan authority

- Status: Accepted 2026-10-19
- Date: 2026-10-19

## Decision

The plan lives in the repository.

## Approval

Owner, 2026-10-19, in chat: "${QUOTE}".
`,
    "docs/decisions/adr/ADR-0002-next.md": `# ADR-0002 Next step

- Status: Accepted
- Date: 2026-10-20
- Refines:
  - ADR-0001 (the launch plan).

## Decision

Next.
`,
    "docs/decisions/adr/README.md":
      "# Records\n\n| ADR | Title | Status |\n| --- | --- | --- |\n<!-- graph:adr-index:start -->\n<!-- graph:adr-index:end -->\n",
    "docs/packets/P01.T02a.md": `# P01.T02a Contract child

## Acceptance

- **P01.T02a-AC01 Contract shape.** The shape is frozen.
- **P01.T02a-AC02 Fixtures.** Fixtures pass.

It builds on P01.T01 and P01.A01.
`,
    "docs/briefs/M2-connect.md": `# M2 Connect

- Status: brief, 2026-10-19.
- Plan IDs: P01.T02a, P01.T02. Branch \`claude/m2-connect\`; one PR.

## Goal

Connect, under ADR-0001.
`,
    "docs/evidence/live/2026-10-21-probe.md": `# 2026-10-21 Probe passes

- **Approval.** Staging card \`staging-card-1\`, effect E9 (read-only).
- **Exact action.** One request.
- **Unknown outcomes.** None.
`,
    "docs/acceptance/P01.md": `# P01 acceptance

## P01.T02a contract child

| Case | Evidence |
| --- | --- |
| AC01 contract shape | \`docs/evidence/live/2026-10-21-probe.md\` |
| AC02 fixtures | Open. Planned with \`docs/evidence/live/2026-10-21-probe.md\` |
`,
    "docs/decisions/approvals/staging-card.json": JSON.stringify({
      schemaVersion: 1,
      id: "staging-card-1",
      record: "docs/decisions/approvals/staging.md",
      status: "approved",
      approvedOn: "2026-10-19",
      expiresOn: "2026-11-18",
    }),
    "docs/decisions/approvals/staging.md":
      "# Staging approval card `staging-card-1`\n\n- **Status:** Approved 2026-10-19.\n",
    "docs/decisions/dependencies.json": JSON.stringify([
      { id: "D01", decision: "Internal contracts", status: "Design recorded", sources: ["S01"] },
    ]),
    "docs/research/sources.json": JSON.stringify([
      { id: "S01", url: "https://example.invalid/s01", status: "verified", finding: "A finding." },
    ]),
    "docs/contracts/capabilities.json": JSON.stringify({
      capabilities: [
        {
          id: "workspace.task.delegate",
          name: "Delegate",
          status: "Proposed",
          provider_dependency: "D01",
        },
        {
          id: "catalog.content.publish",
          name: "Publish",
          status: "Proposed",
          provider_dependency: "D01",
        },
      ],
    }),
    "docs/graph/vision/V-morrow.md": node(
      "id: V-morrow\ntype: vision\ntitle: The workspace\nstatus: active",
      "\nSee `docs/graph/README.md`, `docs/plan/build-plan.md`, `docs/progress/STATUS.md` and\n[the records](../../decisions/adr/README.md). [[S01]] backs it.\n\n```\nQ-not-a-link P09.T09\n```\n",
    ),
    "docs/graph/decisions/OD-2026-10-19-1.md": node(
      "id: OD-2026-10-19-1\ntype: decision\ntitle: Ship a small slice\nstatus: recorded\ndate: 2026-10-19\nby: owner\nchannel: chat",
      `\n> ${QUOTE}\n`,
    ),
    "docs/graph/decisions/OD-2026-10-22-1.md": node(
      "id: OD-2026-10-22-1\ntype: decision\ntitle: Launch the full workspace\nstatus: recorded\ndate: 2026-10-22\nby: owner\nchannel: chat\nlinks:\n  supersedes: [OD-2026-10-19-1]",
      "\n> drop the small slice and launch the full workspace for shop owners instead\n",
    ),
    "docs/graph/questions/Q-scope.md": node(
      "id: Q-scope\ntype: question\nkind: do\ntitle: Merge the scope record\nstatus: open\nasked_of: claude\nlinks:\n  raised_by: [OD-2026-10-22-1]\n  about: [ADR-0001]",
    ),
    "docs/graph/risks/RISK-drift.md": node(
      "id: RISK-drift\ntype: risk\ntitle: Docs drift\nstatus: open\nlinks:\n  raised_by: [OD-2026-10-22-1]\n  about: [ADR-0001, docs/progress/STATUS.md]\n  mitigated_by: [Q-scope]",
      "\nThe status page lags (P01.T02a–T02a), across P01.T01-T02.\n",
    ),
    "docs/graph/features/F-gateway.md": node(
      'id: F-gateway\ntype: feature\ntitle: Gateway\nstatus: planned\nmust: "yes"\nlinks:\n  part_of: [V-morrow]\n  includes: [P01.T02]\n  depends_on: [Q-scope]',
    ),
    "docs/graph/gates/GATE-launch.md": node(
      "id: GATE-launch\ntype: gate\nlabel: G18\ntitle: Launch\nstatus: open\nowner_kind: owner\ndue_week: W18\nlinks:\n  depends_on: [F-gateway]",
    ),
    "docs/graph/tracks/TRK-privacy.md": node(
      "id: TRK-privacy\ntype: track\ntitle: Privacy\nlabel: T14\nstatus: proposed\nlinks:\n  includes: [P01.T01]",
    ),
    "docs/graph/data/DC-customer-mail.md": node(
      'id: DC-customer-mail\ntype: data_class\ntitle: Customer mail\nstatus: planned\nretention: 90 days\ndeletion: the privacy sweep\ncustomer: "yes"\nlinks:\n  deleted_by: [TRK-privacy]',
    ),
    "docs/graph/agents/AG-coordinator.md": node(
      'id: AG-coordinator\ntype: agent\nkind: builtin\ntitle: Coordinator\nstatus: planned\ndepth: "1"\nlinks:\n  delegates_to: [AG-specialist, AG-listings]',
    ),
    "docs/graph/agents/AG-specialist.md": node(
      'id: AG-specialist\ntype: agent\nkind: task_specialist\ntitle: Specialist\nstatus: proposed\nslip_rank: "1"\nlinks:\n  composes: [SK-listing-content]\n  installs_as: [IK-task-specialist]\n  never_holds: [workspace.task.delegate]',
    ),
    "docs/graph/agents/AG-listings.md": node(
      'id: AG-listings\ntype: agent\nkind: installable\ntitle: Listings\nstatus: planned\nslip_rank: "0"\nscopes_required: [read_products, write_products]\nlinks:\n  needs: [catalog.content.publish]\n  bundles: [SK-listing-content]\n  installs_as: [IK-installed-agent]',
    ),
    "docs/graph/agents/AG-support.md": node(
      "id: AG-support\ntype: agent\nkind: installable\ntitle: Support\nstatus: planned\ncustomer_data: level2\nscopes_optional: [read_orders, read_customers]\nlinks:\n  bundles: [SK-support-replies]\n  holds: [DC-customer-mail]\n  waits_on: [GATE-launch]",
    ),
    "docs/graph/skills/SK-listing-content.md": node(
      'id: SK-listing-content\ntype: skill\ntitle: Listing content\nstatus: planned\nspecialist_eligible: "yes"\nruntime: none',
    ),
    "docs/graph/skills/SK-support-replies.md": node(
      'id: SK-support-replies\ntype: skill\ntitle: Support replies\nstatus: planned\nspecialist_eligible: "no"\nlinks:\n  holds: [DC-customer-mail]',
    ),
    "docs/graph/installation-kinds/IK-task-specialist.md": node(
      'id: IK-task-specialist\ntype: installation_kind\ntitle: Run-scoped specialist\nstatus: proposed\nmandate: "no"\ntriggers: "no"\nstarted_by: owner-start\nroutable: "no"\nlinks:\n  never_holds: [workspace.task.delegate]',
    ),
    "docs/graph/installation-kinds/IK-installed-agent.md": node(
      'id: IK-installed-agent\ntype: installation_kind\ntitle: Installed agent\nstatus: planned\nmandate: "yes"\ntriggers: "yes"\nroutable: "yes"\nlinks:\n  may_hold: [catalog.content.publish]',
    ),
  };
  files["docs/graph/README.md"] =
    "# Graph\n\n<!-- graph:schema:start -->\n<!-- graph:schema:end -->\n";
  files["docs/graph/README.md"] = replaceBlock(
    files["docs/graph/README.md"],
    "schema",
    renderSchemaBlock(),
  );
  const index = files["docs/decisions/adr/README.md"];
  files["docs/decisions/adr/README.md"] = replaceBlock(
    index,
    "adr-index",
    renderAdrIndex(buildGraph(makeSrc(files), { today: TODAY })),
  );
  return files;
}

const HISTORY = {
  available: true,
  head: "b".repeat(40),
  commits: [
    {
      sha: "b".repeat(40),
      date: "2026-10-21",
      subject: "P01.T02a PR-A: contract child, see ADR-0002 (#2)",
      firstParent: true,
      files: ["apps/api/src/index.ts", "docs/packets/P01.T02a.md"],
    },
    {
      sha: "a".repeat(40),
      date: "2026-10-20",
      subject: "Initial import (#1)",
      firstParent: true,
      files: ["apps/api/package.json"],
    },
  ],
};

// The in-memory twin of readSources. `existing` lists files outside docs/ that exist.
function makeSrc(
  files,
  {
    history = HISTORY,
    code = new Map(),
    root = "/nonexistent",
    existing = ["apps/api/package.json"],
  } = {},
) {
  const md = new Map(
    Object.entries(files)
      .filter(([path]) => path.endsWith(".md"))
      .sort(),
  );
  const json = (path, fallback) => (path in files ? JSON.parse(files[path]) : fallback);
  return {
    root,
    files: md,
    paths: new Set(Object.keys(files)),
    exists: (path) => existing.includes(path),
    plan: md.get("docs/plan/build-plan.md") ?? "",
    tasks: json("docs/progress/tasks.json", { tasks: [], acceptance_ids: [] }),
    dependencies: json("docs/decisions/dependencies.json", []),
    sources: json("docs/research/sources.json", []),
    capabilities: json("docs/contracts/capabilities.json", { capabilities: [] }).capabilities,
    cards: Object.keys(files)
      .filter((path) => /^docs\/decisions\/approvals\/[^/]+\.json$/.test(path))
      .sort()
      .map((path) => ({ path, data: JSON.parse(files[path]) })),
    components: [{ path: "apps/api", name: "api", package: "@morrow/api" }],
    code,
    history,
  };
}

const graphOf = (files, options = {}) =>
  buildGraph(makeSrc(files, options), { today: TODAY, strict: options.strict ?? false });
const codes = (graph, severity) =>
  graph.issues.filter((i) => i.severity === severity).map((i) => i.code);
const edgeIn = (graph, from, edge, to) =>
  graph.edges.some((e) => e.from === from && e.edge === edge && e.to === to);

test("the fixture is clean, in strict mode too", () => {
  for (const strict of [false, true]) {
    const graph = graphOf(baseFiles(), { strict });
    assert.deepEqual(
      graph.issues.filter((i) => i.severity === "error"),
      [],
      `strict ${strict}`,
    );
  }
});

// Each planted mistake must return exactly its code as the only error. The three phase-0
// warnings are planted in strict mode, and in the default mode they are warnings.
const PHASE0 = new Set(schema.PHASE0_WARNINGS);
const edit = (files, path, from, to) => {
  assert.ok(files[path].includes(from), `${path} contains ${from}`);
  files[path] = files[path].replace(from, to);
};
const PLANTED = {
  GRAPH_PARSE: (f) => {
    f["docs/graph/risks/RISK-broken.md"] = node("id: RISK-broken\nid: RISK-broken");
  },
  GRAPH_FIELD: (f) =>
    edit(f, "docs/graph/risks/RISK-drift.md", "status: open", "status: open\ncolour: blue"),
  GRAPH_ID_SHAPE: (f) =>
    edit(f, "docs/graph/risks/RISK-drift.md", "about: [ADR-0001,", "about: [Zebra, ADR-0001,"),
  GRAPH_ID_DUPLICATE: (f) => {
    f["docs/graph/components/C-api.md"] = node(
      "id: C-api\ntype: component\ntitle: API\nstatus: local",
    );
  },
  GRAPH_LABEL_DUPLICATE: (f) => {
    f["docs/graph/tracks/TRK-second.md"] = node(
      "id: TRK-second\ntype: track\ntitle: Second\nlabel: T14\nstatus: proposed\nlinks:\n  includes: [P01.T01]",
    );
  },
  GRAPH_LINK_DANGLING: (f) =>
    edit(f, "docs/graph/risks/RISK-drift.md", "about: [ADR-0001,", "about: [ADR-0099, ADR-0001,"),
  GRAPH_EDGE_TYPE: (f) =>
    edit(
      f,
      "docs/graph/risks/RISK-drift.md",
      "  mitigated_by:",
      "  holds: [DC-customer-mail]\n  mitigated_by:",
    ),
  GRAPH_UNCLAIMED_DOC: (f) =>
    edit(
      f,
      "docs/graph/risks/RISK-drift.md",
      "status: open",
      "status: open\ndocs: [docs/missing.md]",
    ),
  GRAPH_ORPHAN: (f) => {
    f["docs/graph/risks/RISK-lonely.md"] = node(
      "id: RISK-lonely\ntype: risk\ntitle: Alone\nstatus: open",
    );
  },
  GRAPH_CYCLE: (f) =>
    edit(
      f,
      "docs/graph/decisions/OD-2026-10-19-1.md",
      "channel: chat",
      "channel: chat\nlinks:\n  supersedes: [OD-2026-10-22-1]",
    ),
  GRAPH_STATUS: (f) => edit(f, "docs/graph/risks/RISK-drift.md", "status: open", "status: pending"),
  GRAPH_TASK_STATUS_DRIFT: (f) => {
    const tasks = JSON.parse(f["docs/progress/tasks.json"]);
    tasks.tasks.push({ id: "P01.T09", status: "Planned" });
    f["docs/progress/tasks.json"] = JSON.stringify(tasks);
  },
  GRAPH_GATE_FIELDS: (f) => edit(f, "docs/graph/gates/GATE-launch.md", "due_week: W18\n", ""),
  GRAPH_DATA_CLASS: (f) =>
    edit(f, "docs/graph/data/DC-customer-mail.md", "status: planned", "status: live"),
  GRAPH_SKILL_ELIGIBLE: (f) => {
    f["docs/graph/skills/SK-alt-text.md"] = node(
      'id: SK-alt-text\ntype: skill\ntitle: Alt text\nstatus: planned\nspecialist_eligible: "no"',
    );
    edit(
      f,
      "docs/graph/agents/AG-specialist.md",
      "composes: [SK-listing-content]",
      "composes: [SK-listing-content, SK-alt-text]",
    );
  },
  GRAPH_AGENT_KIND: (f) =>
    edit(
      f,
      "docs/graph/agents/AG-listings.md",
      "  needs:",
      "  delegates_to: [AG-specialist]\n  needs:",
    ),
  GRAPH_INSTALLATION_KIND: (f) =>
    edit(
      f,
      "docs/graph/installation-kinds/IK-installed-agent.md",
      'mandate: "yes"',
      'mandate: "no"',
    ),
  GRAPH_TENANT_RECORD: (f) =>
    edit(
      f,
      "docs/graph/data/DC-customer-mail.md",
      "retention: 90 days",
      "retention: 90 days for 123e4567-e89b-42d3-a456-426614174000",
    ),
  GRAPH_DECISION_QUOTE: (f) =>
    edit(
      f,
      "docs/graph/decisions/OD-2026-10-22-1.md",
      "\n> drop the small slice",
      "\nParaphrased: drop the small slice",
    ),
  GRAPH_EVIDENCE_AUTH: (f) => {
    f["docs/evidence/live/2026-10-21-probe.md"] = node(
      "id: 2026-10-21-probe\ntype: evidence",
      "\n# 2026-10-21 Probe passes\n\nNo bullets yet.\n",
    );
  },
  GRAPH_ADR_APPROVAL: (f) => {
    f["docs/decisions/adr/ADR-0002-next.md"] = node(
      "id: ADR-0002\ntype: adr",
      f["docs/decisions/adr/ADR-0002-next.md"],
    );
  },
  GRAPH_NEW_PACKET: (f) => {
    f["docs/packets/P01.T02-notes.md"] = "# Notes on P01.T02\n";
  },
  GRAPH_SECRET: (f) => {
    f["docs/graph/risks/RISK-drift.md"] += `\nnpg_${"A".repeat(16)}\n`;
  },
  GRAPH_EMAIL: (f) => {
    f["docs/graph/risks/RISK-drift.md"] += `\nWrite to someone${"@"}example.com.\n`;
  },
  GRAPH_STALE_GENERATED: (f) => edit(f, "docs/graph/README.md", "#### Edge types", "#### Edges"),
  GRAPH_STATUS_LINES: (f) => {
    f["docs/progress/STATUS.md"] += "line\n".repeat(80);
  },
  GRAPH_IMPORTED_BY_CODE: () => {},
};
const PLANTED_CODE = {
  GRAPH_IMPORTED_BY_CODE: new Map([
    ["apps/api/src/graph-view.ts", 'import { buildGraph } from "../../../scripts/graph.mjs";\n'],
  ]),
};

test("every error code has a planted mistake", () => {
  assert.deepEqual(Object.keys(PLANTED).sort(), Object.keys(schema.ERRORS).sort());
});

for (const [code, plant] of Object.entries(PLANTED))
  test(`a planted mistake returns exactly ${code}`, () => {
    const files = baseFiles();
    plant(files);
    const strict = PHASE0.has(code);
    const graph = graphOf(files, { strict, code: PLANTED_CODE[code] });
    const errors = graph.issues.filter((i) => i.severity === "error");
    assert.deepEqual(
      errors.map((i) => i.code),
      [code],
      JSON.stringify(errors),
    );
    if (strict) {
      const relaxed = graphOf(files, { code: PLANTED_CODE[code] });
      assert.deepEqual(codes(relaxed, "error"), [], `${code} is a warning in phase 0`);
      assert.ok(codes(relaxed, "warning").includes(code));
    }
  });

test("ids: every shape belongs to exactly one type", () => {
  const samples = {
    vision: "V-morrow",
    feature: "F-gateway",
    agent: "AG-support",
    skill: "SK-alt-text",
    installation_kind: "IK-task-specialist",
    track: "TRK-privacy",
    gate: "GATE-app-review-submission",
    data_class: "DC-customer-mail",
    milestone: "M3",
    package: "P04",
    task: "P04.T01i",
    acceptance: "P04.T01i-AC12a",
    adr: "ADR-draft-mvp-redefinition",
    decision: "OD-2026-10-22-2",
    card: "staging-card-1",
    evidence: "2026-10-21-cloudflare-m-o1-log-probe",
    pr: "PR-35",
    branch: "claude/m5-billing",
    component: "C-api",
    dependency: "D17",
    source: "S149",
    capability: "catalog.content.publish",
    question: "Q-mvp-scope-adr",
    risk: "RISK-launch-target-drift",
    reference: "docs/plan/mvp.md",
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(schema.NODE_TYPES).sort());
  for (const [type, id] of Object.entries(samples)) assert.equal(typeOfId(id), type, id);
  for (const id of ["GP2", "P04.T01", "P04.A01", "ADR-0021", "CLAUDE.md"])
    assert.ok(typeOfId(id), id);
  for (const id of ["S7x", "D9", "PR-0", "T3", "M10", "Zebra", "OD-2026-10-22-0", "p04"])
    assert.equal(typeOfId(id), null, id);
});

test("headers: failsafe strings, lists and maps; one canonical form that round-trips", () => {
  assert.deepEqual(parseHeader("a: 1\nb: no\nc: [x, y]\n").data, {
    a: "1",
    b: "no",
    c: ["x", "y"],
  });
  assert.equal(parseHeader("a: 1\na: 2\n").error, "DUPLICATE_KEY");
  assert.equal(parseHeader("a: &x y\nb: *x\n").error, "ALIAS");
  assert.equal(parseHeader("- a\n").error, "NOT_A_MAP");
  assert.equal(parseHeader("a: !!int 1\n").error, "TAG_RESOLVE_FAILED");
  assert.equal(splitHeader("no header"), null);
  assert.ok(splitHeader("---\nid: x\n").unterminated);
  const data = {
    id: "AG-support",
    type: "agent",
    kind: "installable",
    title: "Support: replies, with care",
    status: "planned",
    slip_rank: "3",
    computer: "no",
    scopes_optional: ["read_orders"],
    links: {
      waits_on: ["GATE-launch"],
      needs: ["support.reply.send", "codex-archive-f89ad75:docs/x.md"],
    },
  };
  const text = serializeHeader(data);
  assert.deepEqual(parseHeader(text).data, data);
  assert.match(text, /^title: "Support: replies, with care"$/m);
  assert.match(text, /^slip_rank: "3"$/m);
  assert.match(text, /^computer: "no"$/m);
  assert.match(text, /^ {2}needs: \[support\.reply\.send, "codex-archive-f89ad75:docs\/x\.md"\]$/m);
  assert.ok(text.indexOf("needs:") < text.indexOf("waits_on:"), "edges in table order");
});

test("the plan: packages, tasks, lettered children, plan acceptance and golden-path milestones", () => {
  const graph = graphOf(baseFiles());
  const n = (id) => graph.nodes.get(id);
  assert.equal(n("P01").title, "Contracts");
  assert.equal(n("P01.T01").title, "Catalogue");
  assert.equal(n("P01.T01").status, "Verified");
  assert.equal(n("P01.T02a").title, "Contract child");
  assert.equal(n("P01.T02").title, "State", "the dash before a parent title is not the title");
  assert.equal(n("P01.T02d").title, "Text after the span", "a span of ids only");
  assert.equal(n("P01.T02e").title, "Shared work", "ids joined by +");
  assert.equal(n("P01.T02f").title, "Shared work");
  assert.ok(edgeIn(graph, "P01.T02a", "part_of", "P01.T02"));
  assert.ok(edgeIn(graph, "P01.A01", "part_of", "P01"));
  assert.equal(n("GP2").label, "M2");
  assert.ok(
    edgeIn(graph, "GP2", "includes", "P01.T01") && edgeIn(graph, "GP2", "includes", "P01.T02"),
  );
  assert.deepEqual(planIdsIn("P06.T01-T02 slices, P11.T01a–T03a and P14.T01a PR-2"), [
    "P06.T01",
    "P06.T02",
    "P11.T01a",
    "P11.T02a",
    "P11.T03a",
    "P14.T01a",
  ]);
  // A parent range takes a hyphen or an en dash.
  for (const range of ["P11.T01-T03", "P11.T01–T03", "see P11.T01–T03."])
    assert.deepEqual(planIdsIn(range), ["P11.T01", "P11.T02", "P11.T03"], range);
  const collision = graph.issues.find((i) => i.code === "GRAPH_WARN_LABEL_COLLISION");
  assert.match(
    collision.message,
    /GP2 \(Collaboration\) and M2 \(Connect\) share the label M2; both include P01\.T02/,
  );
});

test("packets, briefs, ADR headers, evidence, acceptance tables, cards and registries", () => {
  const files = baseFiles();
  files["docs/evidence/live/2026-10-22-retry.md"] =
    "# 2026-10-22 Retry\n\n- **Approval.** `staging-card-1`.\n- **Unknown outcome, reconciled.** Read back.\n";
  files["docs/evidence/live/2026-10-22-open.md"] =
    "# 2026-10-22 Open\n\n- **Approval.** `staging-card-1`.\n- **Unknown outcomes.** One create timed out.\n";
  const graph = graphOf(files);
  const n = (id) => graph.nodes.get(id);
  assert.equal(n("P01.T02a").doc, "docs/packets/P01.T02a.md");
  assert.equal(n("P01.T02a-AC01").title, "Contract shape");
  assert.ok(edgeIn(graph, "P01.T02a-AC02", "part_of", "P01.T02a"));
  assert.ok(
    edgeIn(graph, "M2", "includes", "P01.T02a") && edgeIn(graph, "M2", "includes", "P01.T02"),
  );
  assert.equal(n("ADR-0001").status, "accepted");
  assert.ok(edgeIn(graph, "ADR-0002", "refines", "ADR-0001"));
  assert.ok(
    edgeIn(graph, "ADR-0001", "approved_by", "OD-2026-10-19-1"),
    "quote in the Approval section",
  );
  assert.ok(!edgeIn(graph, "ADR-0002", "approved_by", "OD-2026-10-19-1"));
  assert.ok(edgeIn(graph, "2026-10-21-probe", "authorized_by", "staging-card-1"));
  assert.ok(
    edgeIn(graph, "2026-10-21-probe", "verifies", "P01.T02a-AC01"),
    "short AC id under its task heading",
  );
  // An Open row only cites the record it names: the acceptance is open, never verified.
  assert.equal(n("P01.T02a-AC02").status, "open");
  assert.equal(n("P01.T02a-AC01").status, null);
  assert.ok(!edgeIn(graph, "2026-10-21-probe", "verifies", "P01.T02a-AC02"));
  assert.ok(edgeIn(graph, "P01.T02a-AC02", "mentions", "2026-10-21-probe"));
  assert.equal(acceptanceStatus(["Open. Planned with `docs/x.md`"]), "open");
  assert.equal(acceptanceStatus(["**Open:** after PR-C"]), "open");
  assert.equal(acceptanceStatus(["Not done; moved to packet PR-3."]), "open");
  assert.equal(
    acceptanceStatus(["`tests/x.test.mjs`", "*Deferred past launch* (ADR-0021)."]),
    "deferred",
  );
  for (const cells of [
    ["Open the inbox from the link"],
    ["Opened by PR-2"],
    ["`tests/x.test.mjs`"],
    [],
  ])
    assert.equal(acceptanceStatus(cells), null, JSON.stringify(cells));
  const deferred = baseFiles();
  edit(
    deferred,
    "docs/acceptance/P01.md",
    "| AC01 contract shape | ",
    "| AC01 contract shape | *Deferred past launch*; ",
  );
  const later = graphOf(deferred);
  assert.equal(later.nodes.get("P01.T02a-AC01").status, "deferred");
  assert.ok(!edgeIn(later, "2026-10-21-probe", "verifies", "P01.T02a-AC01"));
  assert.equal(n("2026-10-21-probe").fields.unknown_outcome, "none");
  assert.equal(n("2026-10-22-retry").fields.unknown_outcome, "closed");
  assert.equal(n("2026-10-22-open").fields.unknown_outcome, "open");
  assert.equal(n("staging-card-1").doc, "docs/decisions/approvals/staging.md");
  assert.equal(n("staging-card-1").fields.expires_on, "2026-11-18");
  assert.ok(
    edgeIn(graph, "D01", "cites", "S01") && edgeIn(graph, "workspace.task.delegate", "uses", "D01"),
  );
  assert.equal(n("docs/progress/STATUS.md").type, "reference");
  assert.ok(n("P01").docs.includes("docs/acceptance/P01.md"));
  const basis = graph.issues.find((i) => i.code === "GRAPH_WARN_SUPERSEDED_BASIS");
  assert.match(
    basis.message,
    /^ADR-0001 approved_by OD-2026-10-19-1, superseded by OD-2026-10-22-1; still cited by M2, Q-scope, RISK-drift/,
  );
  assert.match(query(graph, "open", [], new Map()), /Unknown outcomes \(1\)\n {2}2026-10-22-open/);
});

test("merged PRs: the subject's label implements, later ids are mentions, files touch components", () => {
  const graph = graphOf(baseFiles());
  assert.equal(graph.nodes.get("PR-2").status, "merged");
  assert.equal(graph.nodes.get("PR-2").fields.commit, "b".repeat(12));
  assert.ok(edgeIn(graph, "PR-2", "implements", "P01.T02a"));
  assert.ok(
    edgeIn(graph, "PR-2", "mentions", "ADR-0002") &&
      !edgeIn(graph, "PR-2", "implements", "ADR-0002"),
  );
  assert.ok(edgeIn(graph, "PR-2", "touches", "C-api") && edgeIn(graph, "PR-1", "touches", "C-api"));
  // Without history: no PR nodes, a warning, and PR links resolve leniently.
  const files = baseFiles();
  edit(
    files,
    "docs/graph/data/DC-customer-mail.md",
    "deleted_by: [TRK-privacy]",
    "deleted_by: [TRK-privacy, PR-7]",
  );
  const shallow = graphOf(files, {
    history: { available: false, reason: "shallow clone", commits: [] },
  });
  assert.deepEqual(codes(shallow, "error"), []);
  assert.ok(!shallow.nodes.has("PR-2"));
  assert.ok(
    shallow.issues.some((i) => i.code === "GRAPH_WARN_NO_HISTORY" && i.message.includes("PR-7")),
  );
  assert.deepEqual(codes(graphOf(files), "error"), ["GRAPH_LINK_DANGLING"]);
  // A live data class whose deleted_by PR cannot be read back without history is a
  // warning that names the PR, never GRAPH_DATA_CLASS.
  edit(files, "docs/graph/data/DC-customer-mail.md", "status: planned", "status: live");
  const shallowLive = graphOf(files, {
    history: { available: false, reason: "shallow clone", commits: [] },
  });
  assert.deepEqual(codes(shallowLive, "error"), []);
  assert.ok(
    shallowLive.issues.some(
      (i) =>
        i.code === "GRAPH_WARN_NO_HISTORY" &&
        i.where === "docs/graph/data/DC-customer-mail.md" &&
        /DC-customer-mail is live; deleted_by PR-7 is not checked without history/.test(i.message),
    ),
  );
  // Without any PR link, a live data class is still an error, with or without history.
  const noPr = baseFiles();
  edit(noPr, "docs/graph/data/DC-customer-mail.md", "status: planned", "status: live");
  for (const history of [HISTORY, { available: false, reason: "shallow clone", commits: [] }])
    assert.deepEqual(codes(graphOf(noPr, { history }), "error"), ["GRAPH_DATA_CLASS"]);
  // With history, a merged PR satisfies it.
  edit(
    noPr,
    "docs/graph/data/DC-customer-mail.md",
    "deleted_by: [TRK-privacy]",
    "deleted_by: [TRK-privacy, PR-2]",
  );
  assert.deepEqual(codes(graphOf(noPr), "error"), []);
});

test("mentions: unambiguous ids, ranges, [[wiki]] links and paths; fences and generated blocks are not links", () => {
  const graph = graphOf(baseFiles());
  assert.ok(
    edgeIn(graph, "P01.T02a", "mentions", "P01.T01") &&
      edgeIn(graph, "P01.T02a", "mentions", "P01.A01"),
  );
  assert.ok(edgeIn(graph, "M2", "mentions", "ADR-0001"));
  assert.ok(edgeIn(graph, "RISK-drift", "mentions", "P01.T02a"), "a lettered range");
  assert.ok(
    edgeIn(graph, "RISK-drift", "mentions", "P01.T01") &&
      edgeIn(graph, "RISK-drift", "mentions", "P01.T02"),
    "a parent range in prose",
  );
  const dashed = baseFiles();
  dashed["docs/graph/risks/RISK-drift.md"] = dashed["docs/graph/risks/RISK-drift.md"].replace(
    "across P01.T01-T02.",
    "across P01.T01–T02.",
  );
  assert.ok(edgeIn(graphOf(dashed), "RISK-drift", "mentions", "P01.T02"), "an en-dash range");
  assert.ok(edgeIn(graph, "V-morrow", "mentions", "S01"), "[[S01]]");
  assert.ok(
    edgeIn(graph, "V-morrow", "mentions", "docs/decisions/adr/README.md"),
    "a relative link",
  );
  assert.ok(edgeIn(graph, "V-morrow", "mentions", "docs/plan/build-plan.md"), "a path");
  assert.ok(!graph.issues.some((i) => /Q-not-a-link|P09\.T09/.test(i.message)), "fenced code");
  assert.ok(
    !edgeIn(graph, "docs/graph/README.md", "mentions", "IK-task-specialist"),
    "the generated block",
  );
  // An unresolved id is an error in a doc with a header and a warning in one without.
  const files = baseFiles();
  files["docs/graph/risks/RISK-drift.md"] += "\nSee Q-unknown.\n";
  files["docs/plan/build-plan.md"] += "\nSee Q-unknown and S99.\n";
  const issues = graphOf(files).issues.filter(
    (i) => i.message.includes("Q-unknown") || i.message.includes("S99"),
  );
  assert.deepEqual(issues.map((i) => `${i.code} ${i.where}`).sort(), [
    "GRAPH_LINK_DANGLING docs/graph/risks/RISK-drift.md",
    "GRAPH_WARN_LEGACY_MENTION docs/plan/build-plan.md",
  ]);
});

test("in-place headers: the owner's id, merged fields, parent status drift", () => {
  const files = baseFiles();
  files["docs/packets/P01.T02a.md"] = node(
    "id: P01.T02a\ntype: task\nstatus: Ready",
    files["docs/packets/P01.T02a.md"],
  );
  let graph = graphOf(files);
  assert.deepEqual(codes(graph, "error"), []);
  assert.equal(graph.nodes.get("P01.T02a").status, "Ready");
  assert.ok(graph.nodes.get("P01.T02a").header);
  files["docs/packets/P01.T02a.md"] = files["docs/packets/P01.T02a.md"].replace(
    "id: P01.T02a",
    "id: P01.T01",
  );
  graph = graphOf(files);
  assert.deepEqual(codes(graph, "error"), ["GRAPH_FIELD"]);
  const parent = baseFiles();
  parent["docs/packets/P01.T01.md"] = node(
    "id: P01.T01\ntype: task\nstatus: Planned",
    "# P01.T01\n",
  );
  assert.deepEqual(codes(graphOf(parent), "error"), ["GRAPH_TASK_STATUS_DRIFT"]);
});

test("queries: open, ready, gates, critical, slip, data, skills, ceiling, uncovered, why, path", () => {
  const graph = graphOf(baseFiles());
  const q = (name, args = [], flags = new Map()) => query(graph, name, args, flags);
  const open = q("open");
  assert.match(open, /Open questions \(1\)\n {2}Q-scope .*\[do, asked of claude\]/);
  assert.match(open, /Open gates \(1\)\n {2}G18 {2}GATE-launch/);
  assert.match(
    open,
    /warn GRAPH_WARN_SUPERSEDED_BASIS ADR-0001 approved_by OD-2026-10-19-1, superseded by OD-2026-10-22-1/,
  );
  assert.match(open, /Cards expiring within 14 days \(0\)/);
  assert.match(
    query(buildGraph(makeSrc(baseFiles()), { today: "2026-11-10" }), "open", [], new Map()),
    /Cards expiring within 14 days \(1\)/,
  );
  const ready = q("ready");
  assert.match(ready, /P01\.T02 /);
  assert.doesNotMatch(ready, /F-gateway/, "it waits on an open question and gate");
  assert.match(q("gates", [], new Map([["week", "W18"]])), /GATE-launch/);
  assert.match(q("gates", [], new Map([["week", "W3"]])), /No open gates/);
  assert.match(
    q("critical"),
    /Critical chain to GATE-launch \(3 nodes\):\n {2}Q-scope[^\n]*\n {2}F-gateway[^\n]*\n {2}GATE-launch/,
  );
  assert.match(q("slip"), /^0 {2}AG-listings[\s\S]*\n1 {2}AG-specialist/);
  assert.match(
    q("data"),
    /DC-customer-mail[\s\S]*deleted_by TRK-privacy[\s\S]*held by AG-support, SK-support-replies/,
  );
  assert.match(q("skills", ["AG-specialist"]), /composes {2}SK-listing-content/);
  assert.match(
    q("ceiling", ["AG-specialist"]),
    /IK-task-specialist {5,}never_holds +workspace\.task\.delegate/,
  );
  assert.match(q("uncovered"), /Every plan task is included or deferred by name/);
  assert.match(
    q("why", ["ADR-0001"]),
    /ADR-0001 approved_by OD-2026-10-19-1[\s\S]*superseded by OD-2026-10-22-1/,
  );
  assert.equal(
    q("path", ["PR-2", "2026-10-21-probe"]),
    "PR-2 implements P01.T02a\nP01.T02a-AC01 part_of P01.T02a\n2026-10-21-probe verifies P01.T02a-AC01",
  );
  assert.match(q("impact", ["ADR-0001"]), /Mentioned by \d+: .*M2/);
  assert.match(q("todo"), /docs\/decisions\/adr\/ \(2 without a header\)/);
  assert.throws(() => q("nope"), /GRAPH_USAGE/);
  assert.throws(() => q("skills"), /GRAPH_USAGE/);
  const shown = show(graph, "P01.T02a");
  assert.match(shown, /implements +PR-2/);
  assert.match(shown, /P01\.T02a-AC01 +Contract shape +verified by 2026-10-21-probe/);
  assert.match(shown, /P01\.T02a-AC02 +Fixtures +open; cites 2026-10-21-probe$/m);
  assert.doesNotMatch(shown, /P01\.T02a-AC02[^\n]*verified/);
  assert.match(show(graph, "TRK-privacy"), /^ {2}label: T14$/m);
  assert.equal(show(graph, "TRK-privacy").match(/^ {2}label:/gm).length, 1, "the label once");
  assert.match(mermaid(graph, "OD-2026-10-22-1"), /^flowchart LR\n[\s\S]*-->\|supersedes\|/);
  const drift = statusDrift(graph).join("\n");
  assert.match(drift, /says `main` is at `1111111`; the latest merged PR is PR-2 at `bbbbbbb`/);
  assert.match(drift, /never names merged PR-1\./);
  assert.match(drift, /lists PR-2 under "In progress", but it is merged/);
});

test("query uncovered: a dropped feature or track covers nothing; defers covers by name", () => {
  const files = baseFiles();
  const uncovered = (graph) => uncoveredTasks(graph).map((n) => n.id);
  assert.deepEqual(uncovered(graphOf(files)), []);
  edit(files, "docs/graph/features/F-gateway.md", "status: planned", "status: dropped");
  let graph = graphOf(files);
  assert.deepEqual(codes(graph, "error"), []);
  assert.deepEqual(uncovered(graph), ["P01.T02"]);
  assert.match(query(graph, "uncovered", [], new Map()), /P01\.T02/);
  edit(
    files,
    "docs/graph/tracks/TRK-privacy.md",
    "includes: [P01.T01]",
    "includes: [P01.T01]\n  defers: [P01.T02]",
  );
  graph = graphOf(files);
  assert.deepEqual(codes(graph, "error"), []);
  assert.ok(edgeIn(graph, "TRK-privacy", "defers", "P01.T02"));
  assert.deepEqual(uncovered(graph), []);
  assert.match(
    query(graph, "uncovered", [], new Map()),
    /Every plan task is included or deferred by name/,
  );
  // A package named by an active track covers its tasks.
  edit(files, "docs/graph/tracks/TRK-privacy.md", "defers: [P01.T02]", "defers: [P01]");
  assert.deepEqual(uncovered(graphOf(files)), []);
  edit(files, "docs/graph/tracks/TRK-privacy.md", "status: proposed", "status: dropped");
  assert.deepEqual(uncovered(graphOf(files)), ["P01.T01", "P01.T02"]);
});

test("warnings at their boundaries: stale work, expiring cards, overdue gates, uncovered tasks", () => {
  const at = (today, files = baseFiles()) => buildGraph(makeSrc(files), { today });
  const warned = (graph, code, where) =>
    graph.issues.some((i) => i.code === code && i.where === where && i.severity === "warning");
  for (const code of [
    "GRAPH_WARN_STALE_ACTIVE",
    "GRAPH_WARN_CARD_EXPIRING",
    "GRAPH_WARN_GATE_OVERDUE",
    "GRAPH_WARN_PLAN_UNCOVERED",
  ])
    assert.ok(!at(TODAY).issues.some((i) => i.code === code), `the fixture has no ${code}`);
  // P01.T02 is In progress; PR-2 implements its child P01.T02a on 2026-10-21.
  assert.ok(!warned(at("2026-10-28"), "GRAPH_WARN_STALE_ACTIVE", "P01.T02"), "7 days");
  assert.ok(warned(at("2026-10-29"), "GRAPH_WARN_STALE_ACTIVE", "P01.T02"), "8 days");
  assert.match(
    at("2026-10-29").issues.find((i) => i.code === "GRAPH_WARN_STALE_ACTIVE").message,
    /^P01\.T02 is In progress with no PR or evidence since 2026-10-22$/,
  );
  // staging-card-1 is approved and expires 2026-11-18.
  assert.ok(!warned(at("2026-11-03"), "GRAPH_WARN_CARD_EXPIRING", "staging-card-1"), "15 days");
  assert.ok(warned(at("2026-11-04"), "GRAPH_WARN_CARD_EXPIRING", "staging-card-1"), "14 days");
  const revoked = baseFiles();
  edit(revoked, "docs/decisions/approvals/staging-card.json", '"approved"', '"revoked"');
  assert.ok(!warned(at("2026-11-04", revoked), "GRAPH_WARN_CARD_EXPIRING", "staging-card-1"));
  // A gate due W0 (the week from WEEK_ZERO, Monday 2026-10-26) is overdue from 2026-11-02.
  assert.equal(schema.WEEK_ZERO, "2026-10-26");
  const gate = baseFiles();
  edit(gate, "docs/graph/gates/GATE-launch.md", "due_week: W18", "due_week: W0");
  assert.ok(!warned(at("2026-11-01", gate), "GRAPH_WARN_GATE_OVERDUE", "GATE-launch"));
  assert.ok(warned(at("2026-11-02", gate), "GRAPH_WARN_GATE_OVERDUE", "GATE-launch"));
  edit(gate, "docs/graph/gates/GATE-launch.md", "status: open", "status: passed");
  assert.ok(!warned(at("2026-11-02", gate), "GRAPH_WARN_GATE_OVERDUE", "GATE-launch"));
  // A plan task no feature or track includes.
  const plan = baseFiles();
  edit(plan, "docs/graph/tracks/TRK-privacy.md", "\nlinks:\n  includes: [P01.T01]", "");
  const graph = at(TODAY, plan);
  assert.deepEqual(codes(graph, "error"), []);
  assert.ok(warned(graph, "GRAPH_WARN_PLAN_UNCOVERED", "P01.T01"));
  assert.ok(!warned(graph, "GRAPH_WARN_PLAN_UNCOVERED", "P01.T02"));
});

test("docs entries: repository paths only; a file outside docs/ that exists is claimed", () => {
  const withDocs = (value) => {
    const files = baseFiles();
    edit(files, "docs/graph/risks/RISK-drift.md", "status: open", `status: open\n${value}`);
    return files;
  };
  let graph = graphOf(withDocs("docs: [apps/api/package.json]"), { strict: true });
  assert.deepEqual(codes(graph, "error"), []);
  assert.deepEqual(graph.nodes.get("RISK-drift").docs, ["apps/api/package.json"]);
  graph = graphOf(withDocs("docs: [apps/api/missing.json]"), { strict: true });
  assert.deepEqual(codes(graph, "error"), ["GRAPH_UNCLAIMED_DOC"]);
  for (const value of [
    "docs: [../outside.md]",
    "docs: [/etc/hosts]",
    "docs: [docs/../CLAUDE.md]",
    "docs: [docs/a b.md]",
    "docs: some/path.md",
    "docs:\n  a: b",
  ]) {
    graph = graphOf(withDocs(value), { strict: true });
    assert.deepEqual(codes(graph, "error"), ["GRAPH_FIELD"], value);
    assert.deepEqual(graph.nodes.get("RISK-drift").docs, [], value);
  }
  // On disk, readSources answers for files outside docs/.
  const dir = mkdtempSync(join(tmpdir(), "morrow-graph-docs-"));
  try {
    writeTree(dir, { "apps/api/package.json": "{}\n", "docs/x.md": "# X\n" });
    const src = readSources(dir);
    assert.equal(src.exists("apps/api/package.json"), true);
    assert.equal(src.exists("apps/api"), false, "a directory is not a doc");
    assert.equal(src.exists("apps/api/missing.json"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("README files in docs/evidence/live/ and in docs/graph/ folders are reference docs", () => {
  const files = baseFiles();
  files["docs/evidence/live/README.md"] = "# Live records\n\nOne file per live effect.\n";
  files["docs/graph/decisions/README.md"] = "# Owner decisions\n\nOne file per decision.\n";
  files["docs/graph/vision/V-morrow.md"] +=
    "\nThe indexes: `docs/evidence/live/README.md` and `docs/graph/decisions/README.md`.\n";
  for (const strict of [false, true])
    assert.deepEqual(codes(graphOf(files, { strict }), "error"), [], `strict ${strict}`);
  const graph = graphOf(files);
  for (const path of ["docs/evidence/live/README.md", "docs/graph/decisions/README.md"])
    assert.equal(graph.nodes.get(path)?.type, "reference", path);
});

test("GRAPH_IMPORTED_BY_CODE: the graph's own script and folders only", () => {
  const unrelated = new Map([
    [
      "apps/api/src/codegen.ts",
      'import "../scripts/graphql-codegen.mjs";\nconst a = "scripts/graphics.ts";\nconst b = "../../scripts/graphql/";\nconst c = "my-graph-schema.mjs.bak";\n',
    ],
  ]);
  assert.deepEqual(codes(graphOf(baseFiles(), { code: unrelated }), "error"), []);
  for (const reference of [
    '"../../scripts/graph.mjs"',
    '"../scripts/graph"',
    "'scripts/graph-schema.mjs'",
    "`../docs/graph/agents`",
    '".artifacts/graph/graph.json"',
    '"graph-schema.mjs"',
  ]) {
    const code = new Map([["packages/work/src/view.ts", `export const p = ${reference};\n`]]);
    assert.deepEqual(
      codes(graphOf(baseFiles(), { code }), "error"),
      ["GRAPH_IMPORTED_BY_CODE"],
      reference,
    );
  }
});

test("dates: an impossible calendar day is a field or usage error, never a crash", () => {
  const files = baseFiles();
  edit(files, "docs/graph/decisions/OD-2026-10-22-1.md", "date: 2026-10-22", "date: 2026-13-01");
  const errors = codes(graphOf(files), "error");
  assert.ok(errors.length > 0 && errors.every((c) => c === "GRAPH_FIELD"), errors.join());
  const card = baseFiles();
  edit(card, "docs/decisions/approvals/staging-card.json", "2026-11-18", "2026-11-32");
  const graph = graphOf(card);
  assert.equal(graph.nodes.get("staging-card-1").fields.expires_on, undefined);
  for (const today of ["2026-13-01", "2026-00-10", "2026-10-32", "2026-02-30", "26-10-23"]) {
    let err = "";
    const code = run(["check", "--today", today], { out: () => {}, err: (t) => (err += t) });
    assert.equal(code, 2, today);
    assert.match(err, /^GRAPH_USAGE: --today is YYYY-MM-DD/, today);
  }
});

test("the hand-written graph is scanned whole for tenant records; governed docs for addresses", () => {
  for (const body of [
    "\nSeen on acme.myshopify.com.\n",
    "\nThe product gid://shopify/Product/123.\n",
    "\nWorkspace 123e4567-e89b-42d3-a456-426614174000.\n",
  ]) {
    const files = baseFiles();
    files["docs/graph/risks/RISK-drift.md"] += body;
    assert.deepEqual(codes(graphOf(files), "error"), ["GRAPH_TENANT_RECORD"], body);
  }
  // Email addresses: the body of every governed doc, not only the graph and headers.
  const mail = (address) => {
    const files = baseFiles();
    files["docs/evidence/live/2026-10-21-probe.md"] += `\nSigned in as ${address}.\n`;
    files["docs/decisions/adr/ADR-0002-next.md"] += "\nThe `ApprovalRecord@2.scopeDigest` field.\n";
    return codes(graphOf(files), "error");
  };
  assert.deepEqual(mail(`someone${"@"}mail.example.com`), ["GRAPH_EMAIL"]);
  for (const address of ["probe@example.invalid", "x@lab.test", "a@b.example", "c@localhost"])
    assert.deepEqual(mail(address), [], address);
  // The one placeholder an owner decision quotes passes; its neighbours do not.
  assert.deepEqual(mail(`usershopname${"@"}morrow.com`), []);
  for (const address of [`someone${"@"}morrow.com`, `usershopname${"@"}morrow.co`])
    assert.deepEqual(mail(address), ["GRAPH_EMAIL"], address);
  // Outside the governed folders only a header counts.
  const reference = baseFiles();
  reference["docs/references/notes.md"] = `# Notes\n\nWrite to someone${"@"}mail.example.com.\n`;
  reference["docs/graph/vision/V-morrow.md"] += "\nSee `docs/references/notes.md`.\n";
  assert.deepEqual(codes(graphOf(reference), "error"), []);
});

test("graph.json and graph.html: inline data, the pinned script, nothing that closes the script", () => {
  const files = baseFiles();
  edit(
    files,
    "docs/graph/risks/RISK-drift.md",
    "title: Docs drift",
    'title: "Docs drift </script><b>"',
  );
  const data = graphJson(graphOf(files));
  assert.equal(data.schema, "morrow-graph/1");
  assert.ok(data.nodes.some((n) => n.id === "OD-2026-10-19-1" && n.quote === QUOTE));
  const html = renderHtml(data);
  assert.ok(html.includes(`<script src="${schema.CYTOSCAPE}"`));
  assert.match(
    schema.CYTOSCAPE,
    /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/cytoscape\/\d+\.\d+\.\d+\/cytoscape\.min\.js$/,
  );
  assert.equal(html.match(/<\/script>/g).length, 3);
  assert.ok(html.includes("Docs drift \\u003c/script>"));
  assert.match(html, /prefers-color-scheme: dark/);
});

function git(dir, ...args) {
  const result = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=graph-test",
      "-c",
      "user.email=graph-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

test("the command line on a temporary checkout: check, add, link, set, status, render", () => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-graph-"));
  const artifacts = mkdtempSync(join(tmpdir(), "morrow-graph-artifacts-"));
  const previous = process.env.MORROW_ARTIFACTS_DIR;
  process.env.MORROW_ARTIFACTS_DIR = artifacts;
  try {
    const files = baseFiles();
    writeTree(dir, { ...files, "apps/api/package.json": '{ "name": "@morrow/api" }\n' });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Initial import (#1)");
    writeTree(dir, { "apps/api/src/index.ts": "export const graphql = true;\n" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "P01.T02a PR-A: contract child, see ADR-0002 (#2)");
    // readSources on disk equals the in-memory twin.
    const history = readHistory(dir);
    assert.equal(history.available, true);
    assert.deepEqual(
      history.commits.map((c) => c.subject),
      ["P01.T02a PR-A: contract child, see ADR-0002 (#2)", "Initial import (#1)"],
    );
    assert.deepEqual(history.commits[0].files, ["apps/api/src/index.ts"]);
    const disk = buildGraph(readSources(dir), { today: TODAY });
    assert.deepEqual([...disk.nodes.keys()].sort(), [...graphOf(files).nodes.keys()].sort());
    assert.deepEqual(codes(disk, "error"), []);
    const shallow = mkdtempSync(join(tmpdir(), "morrow-graph-shallow-"));
    rmSync(shallow, { recursive: true });
    spawnSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, shallow], {
      encoding: "utf8",
    });
    assert.deepEqual(readHistory(shallow), {
      available: false,
      reason: "shallow clone (CI uses fetch-depth: 0)",
      commits: [],
    });
    rmSync(shallow, { recursive: true, force: true });

    let out = "";
    let err = "";
    const cli = (...args) => {
      out = "";
      err = "";
      return run([...args, "--root", dir, "--today", TODAY], {
        out: (t) => (out += t),
        err: (t) => (err += t),
      });
    };
    assert.equal(cli("check"), 0, err);
    assert.match(out, /^PASS: graph check, \d+ nodes/m);
    assert.equal(cli("check", "--bogus"), 2);
    assert.match(err, /^GRAPH_USAGE: check does not take --bogus/);
    assert.equal(cli("nope"), 2);
    assert.equal(cli("show", "P01.T02a", "--depth", "9"), 2);

    assert.equal(cli("add", "risk", "RISK-new", "--title", "A new risk"), 0, err);
    const risk = splitHeader(readFileSync(join(dir, "docs/graph/risks/RISK-new.md"), "utf8"));
    assert.deepEqual(parseHeader(risk.raw).data, {
      id: "RISK-new",
      type: "risk",
      title: "A new risk",
      status: "open",
    });
    assert.equal(cli("add", "risk", "risk-new", "--title", "x"), 2);
    assert.match(err, /^GRAPH_ID_SHAPE/);
    assert.equal(cli("add", "risk", "RISK-new", "--title", "x"), 2);
    assert.match(err, /^GRAPH_ID_DUPLICATE/);
    assert.equal(cli("add", "gate", "GATE-x", "--title", "x", "--owner_kind", "nobody"), 2);
    assert.match(err, /^GRAPH_FIELD/);
    assert.ok(!existsSync(join(dir, "docs/graph/gates/GATE-x.md")), "a refused add writes nothing");
    assert.equal(cli("link", "RISK-new", "about", "ADR-0001"), 0, err);
    assert.equal(cli("link", "RISK-new", "holds", "DC-customer-mail"), 2);
    assert.match(err, /^GRAPH_EDGE_TYPE/);
    assert.equal(cli("link", "RISK-new", "about", "ADR-0098"), 2);
    assert.match(err, /^GRAPH_LINK_DANGLING/);
    assert.equal(cli("link", "ADR-0002", "about", "ADR-0001"), 2, "no header to hold it");
    assert.equal(cli("link", "RISK-new", "mitigated_by", "Q-scope"), 0, err);
    assert.equal(cli("unlink", "RISK-new", "mitigated_by", "Q-scope"), 0, err);
    assert.deepEqual(
      parseHeader(splitHeader(readFileSync(join(dir, "docs/graph/risks/RISK-new.md"), "utf8")).raw)
        .data.links,
      { about: ["ADR-0001"] },
    );

    const quote = join(dir, "quote.txt");
    writeFileSync(quote, "keep going with the full workspace\n\nand ship it");
    assert.equal(
      cli(
        "add",
        "decision",
        "--date",
        "2026-10-22",
        "--title",
        "Keep going",
        "--quote-file",
        quote,
      ),
      0,
      err,
    );
    assert.match(out, /^OD-2026-10-22-2 written to docs\/graph\/decisions\/OD-2026-10-22-2\.md/);
    assert.match(
      readFileSync(join(dir, "docs/graph/decisions/OD-2026-10-22-2.md"), "utf8"),
      /\n> keep going with the full workspace\n>\n> and ship it\n$/,
    );

    assert.equal(cli("set", "P01.T01", "status=Ready"), 0, err);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "docs/progress/tasks.json"), "utf8")).tasks[0].status,
      "Ready",
    );
    assert.equal(cli("set", "P01.T01", "status=Done"), 2);
    assert.equal(cli("set", "P01.T02a", "status=In review"), 0, err);
    assert.match(
      readFileSync(join(dir, "docs/packets/P01.T02a.md"), "utf8"),
      /^---\nid: P01\.T02a\ntype: task\nstatus: In review\n---\n# P01\.T02a Contract child/,
    );
    assert.equal(cli("set", "RISK-new", "status=mitigated"), 0, err);
    assert.equal(cli("set", "RISK-new", "status=gone"), 2);
    assert.match(err, /^GRAPH_STATUS/);
    // set never moves a node or edits its lists: the file stays as it was.
    const riskPath = join(dir, "docs/graph/risks/RISK-new.md");
    const riskBefore = readFileSync(riskPath, "utf8");
    for (const pair of ["id=RISK-other", "type=question", "links=ADR-0001", "docs=docs/x.md"]) {
      assert.equal(cli("set", "RISK-new", "title=Renamed", pair), 2, pair);
      assert.match(err, /^GRAPH_USAGE: set does not change /, pair);
    }
    assert.match(err, /docs$/m);
    assert.equal(cli("set", "RISK-new", "links=ADR-0001"), 2);
    assert.match(err, /use link or unlink/);
    assert.equal(readFileSync(riskPath, "utf8"), riskBefore);
    assert.ok(!existsSync(join(dir, "docs/graph/risks/RISK-other.md")));
    assert.equal(cli("set", "P01.T02a", "id=P01.T02b"), 2);
    // A parent task the plan defines but tasks.json lacks: a fixed code, not a crash.
    const tasksPath = join(dir, "docs/progress/tasks.json");
    const tasksBefore = readFileSync(tasksPath, "utf8");
    const tasks = JSON.parse(tasksBefore);
    tasks.tasks = tasks.tasks.filter((t) => t.id !== "P01.T02");
    writeFileSync(tasksPath, JSON.stringify(tasks));
    assert.equal(cli("set", "P01.T02", "status=Verified"), 2);
    assert.match(err, /^GRAPH_TASK_STATUS_DRIFT: P01\.T02 is not in tasks\.json/);
    assert.equal(readFileSync(tasksPath, "utf8"), JSON.stringify(tasks));
    writeFileSync(tasksPath, tasksBefore);

    assert.equal(cli("status", "--write"), 2);
    assert.match(err, /^GRAPH_STATUS_MARKERS/);
    writeFileSync(
      join(dir, "docs/progress/STATUS.md"),
      "# Status\n\n<!-- graph:status:start -->\n<!-- graph:status:end -->\n",
    );
    assert.equal(cli("status", "--write"), 0, err);
    assert.match(
      readFileSync(join(dir, "docs/progress/STATUS.md"), "utf8"),
      /Live status from the graph, 2026-10-23[\s\S]*- PR-2 \(`/,
    );

    assert.equal(cli("render", "--check"), 0, err);
    assert.equal(cli("render"), 0, err);
    assert.ok(
      existsSync(join(artifacts, "graph/graph.json")) &&
        existsSync(join(artifacts, "graph/graph.html")),
    );
    assert.equal(cli("check"), 0, err);
    writeFileSync(
      join(dir, "docs/graph/README.md"),
      files["docs/graph/README.md"].replace("#### Edge types", "#### Edges"),
    );
    assert.equal(cli("render", "--check"), 1);
    assert.equal(cli("check"), 1);
    assert.match(err, /error GRAPH_STALE_GENERATED/);
    assert.equal(cli("render"), 0, err);
    assert.equal(cli("check"), 0, err);
  } finally {
    if (previous === undefined) delete process.env.MORROW_ARTIFACTS_DIR;
    else process.env.MORROW_ARTIFACTS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

// This repository's own graph.
let repository = null;
const repo = () => (repository ??= buildGraph(readSources(), { today: TODAY }));

test("this repository: graph:check has no errors, and the derived inventory is complete", () => {
  const graph = repo();
  assert.deepEqual(
    graph.issues.filter((i) => i.severity === "error"),
    [],
  );
  const count = (predicate) => [...graph.nodes.values()].filter(predicate).length;
  assert.equal(
    count((n) => n.type === "package"),
    18,
  );
  assert.equal(
    count((n) => n.type === "task" && /^P\d{2}\.T\d{2}$/.test(n.id)),
    80,
  );
  assert.ok(count((n) => n.type === "task" && /[a-z]$/.test(n.id)) >= 93);
  assert.equal(
    count((n) => n.type === "acceptance" && /^P\d{2}\.A\d{2}$/.test(n.id)),
    73,
  );
  // Every ADR file on disk is a node; the count grows with each new record.
  assert.equal(
    count((n) => n.type === "adr" && /^ADR-\d{4}$/.test(n.id)),
    adrNumbers("docs/decisions/adr").size,
  );
  for (const node of graph.nodes.values())
    if (node.type === "adr" && /^ADR-\d{4}$/.test(node.id)) assert.ok(node.status, node.id);
  assert.equal(
    count((n) => n.type === "milestone" && /^GP\d$/.test(n.id)),
    5,
  );
  assert.equal(graph.nodes.get("staging-card-1")?.type, "card");
  for (const id of [
    "V-morrow",
    "OD-2026-10-22-1",
    "OD-2026-10-22-2",
    "OD-2026-10-23-1",
    "OD-2026-10-23-2",
    "OD-2026-10-23-3",
    "Q-mvp-scope-adr",
    "RISK-launch-target-drift",
    "TRK-project-graph",
  ])
    assert.ok(graph.nodes.get(id)?.header, id);
  // Owner quotes are verbatim: each one that ADR-0023's Approval section holds approves it.
  for (const decision of ["OD-2026-10-22-2", "OD-2026-10-23-1", "OD-2026-10-23-3"])
    assert.ok(edgeIn(graph, "ADR-0023", "approved_by", decision), decision);
  // Derived task titles are titles: no leading dash, never just the ids of the span.
  for (const node of graph.nodes.values())
    if (node.type === "task") {
      assert.doesNotMatch(node.title ?? "", /^[—–-]/, node.id);
      assert.doesNotMatch(
        node.title ?? "",
        /^(?:(?:then|and)\s+)?P\d{2}\.T\d{2}[a-z]*(?:\s*[+,]\s*P\d{2}\.T\d{2}[a-z]*)*$/,
        node.id,
      );
    }
  // An Open or Deferred acceptance row cites its records; nothing verifies it.
  const acceptance = [...graph.nodes.values()].filter((n) => n.type === "acceptance");
  assert.ok(acceptance.some((n) => n.status === "open"));
  for (const node of acceptance)
    if (["open", "deferred"].includes(node.status))
      assert.ok(!(graph.in.get(node.id) ?? []).some((e) => e.edge === "verifies"), node.id);
});

test("this repository: P04.T01i shows its PRs, acceptance ids and the M-O1 evidence", () => {
  const graph = repo();
  const shown = show(graph, "P04.T01i");
  assert.match(
    shown,
    /P04\.T01i-AC13 +Redaction +verified by 2026-10-21-cloudflare-m-o1-log-probe/,
  );
  for (const line of shown.split("\n").filter((l) => /^ {2}P04\.T01i-AC/.test(l)))
    assert.doesNotMatch(line, / (?:open|deferred)(?:;|$).*verified by/, line);
  assert.ok(
    edgeIn(graph, "2026-10-21-cloudflare-m-o1-log-probe", "authorized_by", "staging-card-1"),
  );
  if (graph.history.available) assert.match(shown, /implements +PR-35 /);
});

test("this repository: query open lists the MVP ADR question and ADR-0021's superseded basis", () => {
  const graph = repo();
  const open = query(graph, "open", [], new Map());
  assert.match(open, /Q-mvp-scope-adr/);
  assert.match(open, /ADR-0021 approved_by OD-2026-10-19-1, superseded by OD-2026-10-22-2/);
  assert.match(
    open,
    /still cited by .*CLAUDE\.md.*docs\/plan\/mvp\.md.*docs\/progress\/STATUS\.md/,
  );
});

test("this repository: the ADR index renders in the form the README rows take", () => {
  const rows = renderAdrIndex(repo()).split("\n");
  assert.equal(rows.length, adrNumbers("docs/decisions/adr").size);
  for (const row of rows)
    assert.match(
      row,
      /^\| \[(\d{4})\]\(ADR-\1-[a-z0-9-]+\.md\) \| [^|]+ \| [^|]*\b(?:accepted|superseded|proposed|draft|rejected)\b[^|]* \|$/i,
    );
  const readme = readFileSync("docs/decisions/adr/README.md", "utf8");
  for (const row of rows) assert.ok(readme.includes(row.split(" | ")[0]), row);
});
