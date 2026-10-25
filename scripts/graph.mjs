// The project knowledge graph (decision 10 of the redefined MVP, approved 2026-10-23;
// docs/graph/README.md). Docs stay where they are and each becomes a node; what already
// has a home (the plan, tasks.json, the registries, ADR and evidence bullets, packets,
// briefs, apps/* and packages/*, git history) is built from it, and only what has no home
// is hand-written under docs/graph/. The closed tables are in scripts/graph-schema.mjs.
//
// Usage: node scripts/graph.mjs <command> [arguments]   (npm run graph -- <command>)
//   check [--strict] [--verbose]           the CI check (npm run graph:check)
//   show <ID> [--depth N] [--json] [--all] fields, edges out, backlinks in
//   query ready | open | gates [--week W] | critical | slip | data | skills <AG-id>
//         | ceiling <IK-id|AG-id> | uncovered | blockers <ID> | impact <ID> | why <ID>
//         | path <A> <B> | stale [--days N] | todo
//   render [--check]                       graph.json and graph.html under the artifacts
//                                          directory, and the generated README blocks
//   view <ID> --mermaid [--depth N]        a Mermaid snippet of a neighbourhood
//   status [--write]                       the live status; --write fills STATUS.md's block
//   add decision --date D --title T --quote-file F [--by owner] [--channel chat]
//   add <type> <ID> --title T [--status S] [--<field> V ...]
//   link <FROM> <edge> <TO>, unlink <FROM> <edge> <TO>
//   set <ID> <field>=<value> ...
// Global flags: --root <dir> (a checkout other than this one), --today YYYY-MM-DD.
// Inputs are closed: an unknown command, flag or value exits 2 with GRAPH_USAGE. Nothing
// here reaches the network; graph.html loads the pinned Cytoscape script when it is opened.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { planInventory, TASK_STATUSES } from "./foundation.mjs";
import { definedLetteredIds, letteredIds } from "./plan-check.mjs";
import { inspectSecrets } from "./delivery-checks.mjs";
import { repositoryRoot, writeArtifact } from "./artifacts.mjs";
import * as schema from "./graph-schema.mjs";

const { NODE_TYPES, EDGES, ANY, ERRORS, WARNINGS, ARCHIVE_PREFIX } = schema;

// ---------------------------------------------------------------------------------------
// Small helpers

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const squash = (text) => String(text).replace(/\s+/g, " ").trim();
const pad2 = (n) => String(n).padStart(2, "0");
const unique = (values) => [...new Set(values)];
const firstHeading = (text) => /^# (.+)$/m.exec(text ?? "")?.[1].trim() ?? null;
const fileOfId = (id) => id.replaceAll("/", "--");
// The local calendar day: the owner's "today", not UTC's.
const isoToday = (now = new Date()) =>
  `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
// A real calendar day: 2026-13-01 and 2026-02-30 are refused, never thrown on.
const validDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
};
const dayNumber = (value) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
const canonical = (value) =>
  JSON.stringify(value, (key, v) =>
    isPlainObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
// Fenced code and generated blocks are examples and tables, not links.
const stripFences = (text) =>
  text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/<!-- graph:([a-z-]+):start -->[\s\S]*?<!-- graph:\1:end -->/g, "");
const short = (text, length = 90) => {
  const value = squash(text ?? "");
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};

export class GraphUsageError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}
const usage = (detail) => new GraphUsageError("GRAPH_USAGE", detail);

// The single type an id's shape belongs to (principle 3), or null.
export function typeOfId(id) {
  if (typeof id !== "string") return null;
  const types = Object.entries(NODE_TYPES).filter(([, spec]) =>
    spec.patterns.some((pattern) => pattern.test(id)),
  );
  return types.length === 1 ? types[0][0] : null;
}

// Parent ranges such as P06.T01-T02 or P11.T01–T03 (hyphen or en dash), expanded.
export function parentRangeIds(text) {
  const ids = new Set();
  for (const [, pkg, a, b] of text.matchAll(
    /(?<![\w./-])(P\d{2})\.T(\d{2})[-–]T(\d{2})(?![a-z\d])/g,
  ))
    for (let n = Number(a); n <= Number(b); n += 1) ids.add(`${pkg}.T${pad2(n)}`);
  return ids;
}

// Task ids a line names: lettered ids and ranges (plan-check's rules), parent ids, and
// parent ranges.
export function planIdsIn(text) {
  const ids = new Set([...letteredIds(text), ...parentRangeIds(text)]);
  for (const m of text.matchAll(/P\d{2}\.T\d{2}(?![a-z\d])/g)) ids.add(m[0]);
  return [...ids].sort();
}

// ---------------------------------------------------------------------------------------
// Headers (YAML frontmatter)

export function splitHeader(text) {
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---\n", 3);
  if (close !== -1) return { raw: text.slice(4, close + 1), body: text.slice(close + 5) };
  if (text.endsWith("\n---")) return { raw: text.slice(4, text.length - 3), body: "" };
  return { raw: text.slice(4), body: "", unterminated: true };
}

// Strings, lists and maps only: the failsafe schema, unique keys and no aliases.
export function parseHeader(raw) {
  const doc = parseDocument(raw, {
    schema: "failsafe",
    uniqueKeys: true,
    maxAliasCount: 0,
    prettyErrors: false,
  });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) return { error: problem.code ?? "YAML" };
  let data;
  try {
    data = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return { error: "ALIAS" };
  }
  if (!isPlainObject(data)) return { error: "NOT_A_MAP" };
  const unsupported = (value) =>
    Array.isArray(value)
      ? value.some(unsupported)
      : isPlainObject(value)
        ? Object.values(value).some(unsupported)
        : typeof value !== "string";
  if (unsupported(data)) return { error: "EMPTY_OR_UNSUPPORTED_VALUE" };
  return { data };
}

const AMBIGUOUS =
  /^(?:y|n|yes|no|true|false|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i;
function scalar(value, flow) {
  const plain = flow
    ? /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(value)
    : value.length > 0 &&
      !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
      !/:\s|\s#|:$|\s$|[\n\t\\]/.test(value);
  return plain && !AMBIGUOUS.test(value) ? value : JSON.stringify(value);
}

// One canonical form, so a command that edits a header changes only what it means to.
export function serializeHeader(data) {
  const spec = NODE_TYPES[data.type];
  const order = [
    "id",
    "type",
    "kind",
    "title",
    "label",
    "status",
    ...Object.keys(spec?.fields ?? {}),
    "docs",
    "links",
  ];
  const lines = [];
  for (const key of unique([...order.filter((k) => k in data), ...Object.keys(data)])) {
    const value = data[key];
    if (key === "links") {
      lines.push("links:");
      for (const edge of unique([...Object.keys(EDGES), ...Object.keys(value)]))
        if (edge in value)
          lines.push(`  ${edge}: [${value[edge].map((v) => scalar(v, true)).join(", ")}]`);
    } else if (Array.isArray(value))
      lines.push(`${key}: [${value.map((v) => scalar(v, true)).join(", ")}]`);
    else lines.push(`${key}: ${scalar(value, false)}`);
  }
  const text = lines.join("\n") + "\n";
  const back = parseHeader(text);
  if (back.error || canonical(back.data) !== canonical(data))
    throw new GraphUsageError("GRAPH_PARSE", "the header does not survive a round trip");
  return text;
}

function fieldProblem(rule, value) {
  switch (rule.kind) {
    case "text":
      return typeof value === "string" && value.trim() ? null : "a non-empty string";
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim())
        ? null
        : "a list of strings";
    case "enum":
      return rule.values.includes(value) ? null : `one of ${rule.values.join(", ")}`;
    case "enum_list":
      return Array.isArray(value) && value.every((v) => rule.values.includes(v))
        ? null
        : "a list from the closed set";
    case "date":
      return validDate(value) ? null : "a date YYYY-MM-DD";
    case "pattern":
      return typeof value === "string" && rule.pattern.test(value) ? null : `${rule.pattern}`;
    default:
      return "an unknown field kind";
  }
}

// A relative path inside the repository: no leading slash, no "." or ".." segment.
const REPOSITORY_PATH = /^(?:(?!\.\.?\/)[A-Za-z0-9_.@-]+\/)*(?!\.\.?$)[A-Za-z0-9_.@-]+$/;
const docPathOk = (doc) =>
  REPOSITORY_PATH.test(doc.startsWith(ARCHIVE_PREFIX) ? doc.slice(ARCHIVE_PREFIX.length) : doc);
// The usable entries of a header's `docs` list; validateHeader reports the others.
const docsOf = (data) =>
  Array.isArray(data?.docs) ? data.docs.filter((d) => typeof d === "string" && docPathOk(d)) : [];

// Checks a header against its type's closed fields. "hand" headers carry a title, a
// status and the type's required fields; "inplace" headers add to a node built elsewhere.
export function validateHeader(data, path, mode, report) {
  const type = data.type;
  const spec = typeof type === "string" ? NODE_TYPES[type] : undefined;
  if (!spec) {
    report("GRAPH_FIELD", path, `unknown type ${JSON.stringify(type)}`);
    return null;
  }
  if (typeOfId(data.id) !== type) {
    report(
      "GRAPH_ID_SHAPE",
      path,
      `${JSON.stringify(data.id)} is not a ${type} id (${spec.shape})`,
    );
    return null;
  }
  for (const key of Object.keys(data))
    if (!schema.COMMON_FIELDS.includes(key) && !(key in spec.fields))
      report("GRAPH_FIELD", path, `${key} is not a ${type} field`);
  for (const key of ["title", "status"])
    if (key in data && (typeof data[key] !== "string" || !data[key].trim()))
      report("GRAPH_FIELD", path, `${key} is a non-empty string`);
  if (mode === "hand")
    for (const key of ["title", "status", ...(spec.required ?? [])])
      if (!(key in data)) report("GRAPH_FIELD", path, `${data.id} needs ${key}`);
  if (typeof data.status === "string" && spec.statuses && !spec.statuses.includes(data.status))
    report("GRAPH_STATUS", path, `${data.status} is not a ${type} status (${spec.statuses})`);
  for (const [key, rule] of Object.entries(spec.fields))
    if (key in data) {
      const problem = fieldProblem(rule, data[key]);
      if (problem) report("GRAPH_FIELD", path, `${key} must be ${problem}`);
    }
  if ("docs" in data && fieldProblem({ kind: "list" }, data.docs))
    report("GRAPH_FIELD", path, "docs is a list of paths");
  else
    for (const doc of data.docs ?? [])
      if (!docPathOk(doc))
        report("GRAPH_FIELD", path, `docs: ${JSON.stringify(doc)} is not a repository path`);
  if ("links" in data) {
    if (!isPlainObject(data.links)) report("GRAPH_FIELD", path, "links is a map of edge lists");
    else
      for (const [edge, targets] of Object.entries(data.links)) {
        if (!(edge in EDGES)) report("GRAPH_EDGE_TYPE", path, `${edge} is not an edge type`);
        else if (!Array.isArray(targets) || targets.some((t) => typeof t !== "string"))
          report("GRAPH_FIELD", path, `links.${edge} is a list of ids`);
        else if (new Set(targets).size !== targets.length)
          report("GRAPH_FIELD", path, `links.${edge} repeats an id`);
      }
  }
  return { id: data.id, type };
}

// ---------------------------------------------------------------------------------------
// Sources: everything the graph is built from, read once. buildGraph is pure over this.

const ROOT_DOCS = ["CLAUDE.md", "AGENTS.md", "README.md"];
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".react-router",
  ".wrangler",
  ".artifacts",
  ".git",
]);
const GOVERNED = [
  "docs/decisions/adr/",
  "docs/packets/",
  "docs/briefs/",
  "docs/evidence/live/",
  "docs/acceptance/",
  "docs/graph/",
];
// Email addresses in a text, except those under the reserved test domains (RFC 2606 and
// RFC 6761), which tests and fixtures use.
const RESERVED_EMAIL_DOMAIN = /\.(?:invalid|test|example|localhost)$/i;
// Placeholder addresses that an owner decision quotes verbatim; none is a mailbox.
// OD-2026-10-23-7 names the shape of a shop's default Morrow sending address.
const QUOTED_PLACEHOLDER_EMAILS = new Set(["usershopname@morrow.com"]);
const emailsIn = (text) =>
  [...text.matchAll(new RegExp(schema.EMAIL.source, "g"))]
    .map((m) => m[0])
    .filter(
      (address) =>
        !RESERVED_EMAIL_DOMAIN.test(address) &&
        !QUOTED_PLACEHOLDER_EMAILS.has(address.toLowerCase()),
    );
// The graph's script, schema and folders; `scripts/graphql…` and `scripts/graphics…` are not.
const GRAPH_REFERENCE =
  /(?:^|[/'"`])(?:scripts\/graph(?:-schema)?(?:\.mjs)?(?![\w-])|docs\/graph\/|\.artifacts\/graph\/|graph-schema\.mjs(?![\w-]))/;

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

// Merged pull requests come from git: first-parent history of HEAD with the files each
// commit changed against its first parent, plus every other ancestor (a branch that merged
// main reaches newer PRs through second parents). A shallow clone skips them. Each commit
// keeps the first line of its body: GitHub's merge commit puts the PR's title there. `refs`
// maps each local or remote-tracking branch name to the date of its newest tip.
export function readHistory(root) {
  const head = git(root, ["rev-parse", "--is-shallow-repository", "--show-toplevel"]);
  if (head === null) return { available: false, reason: "no git repository", commits: [] };
  const [shallow, top] = head.trim().split("\n");
  if (realpathSync(top) !== realpathSync(root))
    return { available: false, reason: "not the repository root", commits: [] };
  if (shallow === "true")
    return { available: false, reason: "shallow clone (CI uses fetch-depth: 0)", commits: [] };
  const first = git(root, [
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--name-only",
    "--date=short",
    "--format=%x1e%H%x1f%ad%x1f%s%x1f%b%x1d",
    "HEAD",
  ]);
  const all = git(root, ["log", "--date=short", "--format=%H%x1f%ad%x1f%s%x1f%b%x1e", "HEAD"]);
  if (first === null || all === null)
    return { available: false, reason: "no commits", commits: [] };
  const firstLine = (body) =>
    (body ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const commits = [];
  const seen = new Set();
  for (const record of first.split("\x1e").slice(1)) {
    const end = record.indexOf("\x1d");
    if (end === -1) continue;
    const [sha, date, subject, body] = record.slice(0, end).split("\x1f");
    const files = record
      .slice(end + 1)
      .split("\n")
      .filter(Boolean);
    commits.push({ sha, date, subject, body: firstLine(body), firstParent: true, files });
    seen.add(sha);
  }
  for (const record of all.split("\x1e")) {
    const [sha, date, subject, body] = record.replace(/^\n/, "").split("\x1f");
    if (sha && subject !== undefined && !seen.has(sha))
      commits.push({ sha, date, subject, body: firstLine(body), firstParent: false, files: [] });
  }
  const refList = git(root, [
    "for-each-ref",
    "--format=%(refname)%1f%(committerdate:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  return { available: true, head: commits[0]?.sha ?? null, commits, refs: branchTips(refList) };
}

// Branch name (refs/heads/<name> or refs/remotes/<remote>/<name>) to its newest tip date.
export function branchTips(refList) {
  const refs = {};
  for (const line of (refList ?? "").split("\n").filter(Boolean)) {
    const [ref, date] = line.split("\x1f");
    const name =
      /^refs\/heads\/(.+)$/.exec(ref)?.[1] ?? /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1];
    if (!name || name === "HEAD" || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    if (!Object.hasOwn(refs, name) || date > refs[name]) refs[name] = date;
  }
  return refs;
}

// A merged pull request from a commit: a squash subject "Title (#n)", or GitHub's merge
// commit "Merge pull request #n from owner/branch" with the PR's title as its body's first
// line. Returns { number, title, branch } or null.
export function pullRequestOf(commit) {
  const squash = /^(.*) \(#([1-9]\d*)\)$/.exec(commit?.subject ?? "");
  if (squash) return { number: squash[2], title: squash[1], branch: null };
  const merge = /^Merge pull request #([1-9]\d*) from [^/\s]+\/(\S+)$/.exec(commit?.subject ?? "");
  if (merge) return { number: merge[1], title: commit.body || merge[2], branch: merge[2] };
  return null;
}

export function readSources(root = repositoryRoot) {
  const files = new Map();
  const paths = new Set();
  const walk = (directory, visit) => {
    let entries = [];
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(path, visit);
      } else if (entry.isFile()) visit(path);
    }
  };
  walk("docs", (path) => {
    paths.add(path);
    if (path.endsWith(".md")) files.set(path, readFileSync(join(root, path), "utf8"));
  });
  for (const name of ROOT_DOCS)
    if (existsSync(join(root, name))) {
      paths.add(name);
      files.set(name, readFileSync(join(root, name), "utf8"));
    }
  const json = (path, fallback) =>
    paths.has(path) ? JSON.parse(readFileSync(join(root, path), "utf8")) : fallback;
  const components = [];
  const code = new Map();
  for (const base of ["apps", "packages"]) {
    let entries = [];
    try {
      entries = readdirSync(join(root, base), { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const manifest = join(root, base, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(manifest))
        components.push({
          path: `${base}/${entry.name}`,
          name: entry.name,
          package: JSON.parse(readFileSync(manifest, "utf8")).name ?? null,
        });
    }
    walk(base, (path) => {
      if (!CODE_FILE.test(path)) return;
      const text = readFileSync(join(root, path), "utf8");
      if (text.includes("graph")) code.set(path, text);
    });
  }
  return {
    root,
    files,
    paths,
    // Whether a file outside docs/ exists, for `docs:` entries such as a script or a
    // package manifest. Header validation has already refused absolute and ".." paths.
    exists: (path) => {
      try {
        return statSync(join(root, path)).isFile();
      } catch {
        return false;
      }
    },
    plan: files.get("docs/plan/build-plan.md") ?? "",
    tasks: json("docs/progress/tasks.json", { tasks: [], acceptance_ids: [] }),
    dependencies: json("docs/decisions/dependencies.json", []),
    sources: json("docs/research/sources.json", []),
    capabilities: json("docs/contracts/capabilities.json", { capabilities: [] }).capabilities ?? [],
    cards: [...paths]
      .filter((p) => /^docs\/decisions\/approvals\/[^/]+\.json$/.test(p))
      .sort()
      .map((path) => ({ path, data: json(path) })),
    components: components.sort((a, b) => a.path.localeCompare(b.path)),
    code,
    history: readHistory(root),
  };
}

// ---------------------------------------------------------------------------------------
// Derivation helpers

// "- Key: text" bullets of an ADR header, with their indented continuation lines.
function headerBullets(text) {
  const bullets = new Map();
  let key = null;
  for (const line of text.split("\n")) {
    const top = /^- ([A-Z][A-Za-z ]{0,40}?):\s?(.*)$/.exec(line);
    if (top) {
      key = top[1];
      bullets.set(key, top[2]);
    } else if (key && /^\s+\S/.test(line)) bullets.set(key, `${bullets.get(key)}\n${line}`);
    else if (!line.trim() || /^#/.test(line)) key = null;
  }
  return bullets;
}

// "- **Label.** text" bullets of an evidence record, with their continuation lines.
function boldBullets(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split("\n")) {
    const top = /^- \*\*([^*]+)\*\*\s*(.*)$/.exec(line);
    if (top) {
      current = { label: top[1].replace(/[.:]\s*$/, ""), text: top[2] };
      blocks.push(current);
    } else if (/^(?:- |#)/.test(line)) current = null;
    else if (current) current.text += `\n${line}`;
  }
  return blocks;
}

function section(text, name) {
  const parts = text.split(/^## /m);
  const match = parts.find((part) => part.startsWith(name));
  return match === undefined ? null : match.slice(name.length);
}

function blockquoteParagraphs(body) {
  const paragraphs = [];
  let current = [];
  const flush = () => {
    if (current.length) paragraphs.push(squash(current.join(" ")));
    current = [];
  };
  for (const line of (body ?? "").split("\n")) {
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote && quote[1].trim()) current.push(quote[1]);
    else flush();
  }
  flush();
  return paragraphs;
}

// An acceptance row's status from its cells after the id: "open" for a cell that starts
// "Open." or "Not done;", "deferred" for one that starts "*Deferred past launch*", otherwise
// null (no claim either way). A cell such as "Open the inbox" is prose, not a status.
export function acceptanceStatus(cells) {
  for (const cell of cells) {
    const text = cell.replace(/^[\s*_]+/, "");
    if (/^(?:open|not done)(?=[*_]*\s*(?:[.;:,(]|$))/i.test(text)) return "open";
    if (/^deferred\b/i.test(text)) return "deferred";
  }
  return null;
}

const DOC_PATH = /(?<![\w/.:-])((?:docs\/[A-Za-z0-9_./-]+?|CLAUDE|AGENTS|README)\.md)(?![\w/])/g;
const RELATIVE_LINK = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;

// Why an edge from FROM to TO is not allowed, as [code, message], or null. A PR id cannot
// be resolved without history; that answer is PR_WITHOUT_HISTORY, which callers tolerate.
export function edgeProblem(nodes, from, edge, to, historyAvailable) {
  const rules = EDGES[edge];
  if (!rules) return ["GRAPH_EDGE_TYPE", `${edge} is not an edge type`];
  if (to.startsWith(ARCHIVE_PREFIX))
    return ["about", "mentions"].includes(edge)
      ? null
      : ["GRAPH_EDGE_TYPE", `${edge} cannot point at an archived path`];
  const toType = typeOfId(to);
  if (!toType) return ["GRAPH_ID_SHAPE", `${to} matches no id shape`];
  if (!nodes.has(to))
    return toType === "pr" && !historyAvailable
      ? ["PR_WITHOUT_HISTORY", to]
      : ["GRAPH_LINK_DANGLING", `${edge} ${to} does not resolve`];
  if (from === to)
    return schema.ACYCLIC.some((group) => group.includes(edge))
      ? ["GRAPH_CYCLE", `${from} ${edge} itself`]
      : ["GRAPH_EDGE_TYPE", `${from} ${edge} itself`];
  const fromType = nodes.get(from)?.type;
  const allowed = rules.some(
    ([f, t]) =>
      (f.includes(ANY) || f.includes(fromType)) && (t.includes(ANY) || t.includes(toType)),
  );
  return allowed ? null : ["GRAPH_EDGE_TYPE", `${edge} cannot connect ${fromType} to ${toType}`];
}

// ---------------------------------------------------------------------------------------
// The graph

export function buildGraph(src, { today = isoToday(), strict = false } = {}) {
  const nodes = new Map();
  const edges = [];
  const issues = [];
  const docOwner = new Map();
  const headers = new Map();
  const bodies = new Map();
  const lenient = new Set(strict ? [] : schema.PHASE0_WARNINGS);
  const report = (code, where, message) =>
    issues.push({
      code,
      severity: code in WARNINGS || lenient.has(code) ? "warning" : "error",
      where,
      message,
    });
  const addNode = (node, where) => {
    const existing = nodes.get(node.id);
    if (existing) {
      report("GRAPH_ID_DUPLICATE", where, `${node.id} is also defined by ${existing.origin}`);
      return null;
    }
    const full = {
      type: typeOfId(node.id),
      title: null,
      status: null,
      label: null,
      doc: null,
      header: false,
      body: null,
      origin: where,
      ...node,
      fields: { ...(node.fields ?? {}) },
      docs: [...(node.docs ?? [])],
    };
    nodes.set(full.id, full);
    return full;
  };
  const claim = (path, id) => {
    if (path && !docOwner.has(path)) docOwner.set(path, id);
  };
  const derived = new Set();
  const derive = (from, edge, to, origin) => {
    const key = `${from}\0${edge}\0${to}`;
    if (from === to || derived.has(key)) return;
    derived.add(key);
    edges.push({ from, edge, to, origin, derived: true });
  };
  const legacy = (where, message) => report("GRAPH_WARN_LEGACY_MENTION", where, message);
  const paths = [...src.files.keys()].sort();

  // Headers first: every derivation reads the body below a header.
  for (const path of paths) {
    const text = src.files.get(path);
    const split = splitHeader(text);
    if (!split) {
      bodies.set(path, text);
      continue;
    }
    bodies.set(path, split.body);
    if (split.unterminated) {
      report("GRAPH_PARSE", path, "the header has no closing ---");
      headers.set(path, { error: "UNTERMINATED" });
      continue;
    }
    const parsed = parseHeader(split.raw);
    if (parsed.error) report("GRAPH_PARSE", path, `the header does not parse (${parsed.error})`);
    headers.set(path, { ...parsed, raw: split.raw, body: split.body });
  }
  const bodyOf = (path) => bodies.get(path) ?? "";

  // The plan: packages, parent and lettered tasks, plan acceptance, golden-path milestones.
  const planPath = "docs/plan/build-plan.md";
  const plan = src.plan;
  const inventory = planInventory(plan);
  for (const m of plan.matchAll(/^## (\d{1,2}) (\S.*)$/gm))
    addNode({ id: `P${pad2(m[1])}`, title: m[2].trim() }, planPath);
  const titles = new Map();
  // "1. **P07.T01 — Versioned artifact contract.**": the title follows an optional dash.
  for (const m of plan.matchAll(
    /^[ \t]*\d+\. \*\*(P\d{2}\.T\d{2})\s+(?:[—–-]\s*)?([^*]+?)\.?\*\*/gm,
  ))
    if (!titles.has(m[1])) titles.set(m[1], m[2].trim());
  for (const id of unique(inventory.tasks)) {
    if (!addNode({ id, title: titles.get(id) ?? null }, planPath)) continue;
    if (nodes.has(id.slice(0, 3))) derive(id, "part_of", id.slice(0, 3), "plan");
  }
  // A lettered span holds ids and a title ("**P05.T01ab Hosted sign-in abuse
  // protection.**"), or only ids ("**P11.T04a + P05.T04b** credit reservations, …"): then
  // the title is the text after the span, to its first sentence end.
  for (const line of plan.split("\n")) {
    const m = /^\s*(?:[-*+]|\d+\.)\s+\*\*(.+?)\*\*(.*)$/.exec(line);
    if (!m) continue;
    const [, span, rest] = m;
    const idsOnly = /^(?:[\s+,:.;—–-]|\b(?:and|then|or)\b)*$/i.test(
      span.replace(/P\d{2}\.T\d{2}[a-z]*(?:\s*[-–]\s*(?:T\d{2})?[a-z]+)?/g, " "),
    );
    const title = squash(
      idsOnly
        ? (/^[\s:.;—–-]*(.*?)(?:[.;](?=\s|$)|$)/.exec(rest)?.[1] ?? "")
        : span
            .replace(
              /^(?:\s*(?:\+|,|and)?\s*P\d{2}\.T\d{2}[a-z]*(?:\s*[-–]\s*(?:T\d{2})?[a-z]+)?)+/,
              "",
            )
            .replace(/^[\s:.,—–-]+|[\s:.,]+$/g, ""),
    );
    for (const id of letteredIds(span))
      if (!titles.has(id)) titles.set(id, short(title, 120) || null);
  }
  for (const id of [...definedLetteredIds(plan)].sort()) {
    if (!addNode({ id, title: titles.get(id) ?? null }, planPath)) continue;
    const parent = id.replace(/[a-z]+$/, "");
    derive(id, "part_of", nodes.has(parent) ? parent : id.slice(0, 3), "plan");
  }
  for (const m of plan.matchAll(/\*\*(P\d{2}\.A\d{2})(?![a-z\d])[*:\s]*([^\n]*)/g)) {
    if (nodes.has(m[1]) || !inventory.cases.includes(m[1])) continue;
    addNode({ id: m[1], title: short(m[2], 110) || null }, planPath);
    if (nodes.has(m[1].slice(0, 3))) derive(m[1], "part_of", m[1].slice(0, 3), "plan");
  }
  for (const m of plan.matchAll(/^\| M([1-9]) ([^|]+?) \| [^|]* \| ([^|]*) \|/gm)) {
    const id = `GP${m[1]}`;
    if (!addNode({ id, title: m[2].trim(), label: `M${m[1]}` }, `${planPath} (golden path)`))
      continue;
    for (const task of planIdsIn(m[3])) if (nodes.has(task)) derive(id, "includes", task, "plan");
  }

  // tasks.json: parent statuses, the same inventory as the plan.
  const listed = new Map();
  for (const task of src.tasks?.tasks ?? []) {
    if (listed.has(task?.id))
      report("GRAPH_ID_DUPLICATE", "docs/progress/tasks.json", `${task.id} is listed twice`);
    listed.set(task?.id, task?.status);
  }
  for (const [id, status] of listed) {
    const node = nodes.get(id);
    if (node?.type !== "task" || !/^P\d{2}\.T\d{2}$/.test(id))
      report("GRAPH_TASK_STATUS_DRIFT", "docs/progress/tasks.json", `${id} is not a plan task`);
    else node.status = status;
  }
  for (const id of unique(inventory.tasks))
    if (!listed.has(id))
      report("GRAPH_TASK_STATUS_DRIFT", "docs/progress/tasks.json", `${id} is missing`);

  // Packets: the body of their task; auxiliary files; acceptance ids, own packet first.
  const packets = [];
  for (const path of paths) {
    const m = /^docs\/packets\/(P\d{2}\.T\d{2}[a-z]*)(?:-([a-z0-9-]+))?\.md$/.exec(path);
    const task = m && nodes.get(m[1]);
    if (!task || task.type !== "task") continue;
    if (m[2]) task.docs.push(path);
    else {
      task.doc = path;
      packets.push([path, task.id]);
    }
    claim(path, task.id);
  }
  const defineAcceptance = (id, title, path) => {
    const task = id.replace(/-AC\d{2}[a-z]?$/, "");
    if (nodes.has(id) || nodes.get(task)?.type !== "task") return;
    addNode({ id, title: squash(title).replace(/[.:]$/, "") || null }, path);
    derive(id, "part_of", task, "packet");
  };
  for (const own of [true, false])
    for (const [path, task] of packets) {
      const body = bodyOf(path);
      for (const a of body.matchAll(
        /\*\*(P\d{2}\.T\d{2}[a-z]*-AC\d{2}[a-z]?)(?![\w])\s*([^*\n]*)/g,
      ))
        if (a[1].startsWith(`${task}-`) === own) defineAcceptance(a[1], a[2], path);
      if (own)
        for (const line of body.split("\n")) {
          const s =
            /^\s*(?:(?:[-*+]|\d+\.)\s+\*\*|\|\s*\*{0,2})(AC\d{2}[a-z]?)(?![\w])\s*([^*|\n]*)/.exec(
              line,
            );
          if (s) defineAcceptance(`${task}-${s[1]}`, s[2], path);
        }
    }

  // Beta milestone briefs: M<n> with the tasks their "Plan IDs" line includes.
  for (const path of paths) {
    const m = /^docs\/briefs\/M([1-9])-[a-z0-9-]+\.md$/.exec(path);
    if (!m) continue;
    const id = `M${m[1]}`;
    const body = bodyOf(path);
    const title = (firstHeading(body) ?? id).replace(/^M[1-9]\s+/, "");
    if (!addNode({ id, title, label: id, doc: path }, path)) continue;
    claim(path, id);
    const line = /^- Plan IDs[^:\n]*:(.*)$/m.exec(body)?.[1] ?? "";
    for (const task of planIdsIn(line))
      if (nodes.has(task)) derive(id, "includes", task, "brief");
      else legacy(path, `Plan IDs names ${task}, which the plan does not define`);
  }

  // ADRs: header bullets give status and the Supersedes, Amends and Refines edges.
  const adrApprovals = new Map();
  const adrLinks = [];
  for (const path of paths) {
    const m = /^docs\/decisions\/adr\/(ADR-\d{4})-[^/]+\.md$/.exec(path);
    if (!m) continue;
    const body = bodyOf(path);
    const bullets = headerBullets(body.split(/^## /m)[0]);
    const statusText = squash(bullets.get("Status") ?? "");
    // The first status word decides, after any qualifier: "Superseded by ADR-0015 (…).
    // Accepted 2026-10-17." is superseded; "Decisions accepted 2026-10-23" is accepted.
    const keyword = /\b(superseded|accepted|proposed|draft|rejected)\b/i
      .exec(statusText)?.[1]
      .toLowerCase();
    const status = keyword === "draft" ? "proposed" : (keyword ?? null);
    const title = (firstHeading(body) ?? m[1]).replace(/^ADR-\d{4}\s+/, "");
    const date = /\d{4}-\d{2}-\d{2}/.exec(bullets.get("Date") ?? "")?.[0];
    const node = addNode(
      { id: m[1], title, status, doc: path, statusText, fields: date ? { date } : {} },
      path,
    );
    if (!node) continue;
    claim(path, m[1]);
    for (const [key, edge] of [
      ["Supersedes", "supersedes"],
      ["Amends", "amends"],
      ["Refines", "refines"],
    ])
      for (const target of unique((bullets.get(key) ?? "").match(/\bADR-\d{4}\b/g) ?? []))
        adrLinks.push([m[1], edge, target, path]);
    adrApprovals.set(m[1], squash(section(body, "Approval") ?? ""));
  }
  for (const [from, edge, to, path] of adrLinks)
    if (nodes.get(to)?.type === "adr") derive(from, edge, to, "adr header");
    else legacy(path, `${edge} names ${to}, which has no record`);

  // Live evidence: the Approval bullet names its card; the outcome bullet its status.
  const evidenceApprovals = new Map();
  const evidenceCards = [];
  for (const path of paths) {
    const m = /^docs\/evidence\/live\/([^/]+)\.md$/.exec(path);
    if (!m || m[1] === "README") continue;
    if (typeOfId(m[1]) !== "evidence") {
      report("GRAPH_ID_SHAPE", path, `${m[1]} is not an evidence id (yyyy-mm-dd-slug)`);
      continue;
    }
    const body = bodyOf(path);
    const blocks = boldBullets(body);
    const outcomes = blocks
      .filter((b) => /unknown outcome/i.test(b.label))
      .map((b) =>
        /reconciled|closed/i.test(b.label)
          ? "closed"
          : /^none\b/i.test(b.text.trim())
            ? "none"
            : "open",
      );
    const outcome = outcomes.includes("open")
      ? "open"
      : outcomes.includes("closed")
        ? "closed"
        : outcomes.length
          ? "none"
          : null;
    const node = addNode(
      {
        id: m[1],
        title: firstHeading(body)?.replace(/^\d{4}-\d{2}-\d{2}\s+/, "") ?? m[1],
        status: "recorded",
        doc: path,
        fields: { date: m[1].slice(0, 10), ...(outcome ? { unknown_outcome: outcome } : {}) },
      },
      path,
    );
    if (!node) continue;
    claim(path, m[1]);
    const approval = blocks
      .filter((b) => /^approval\b/i.test(b.label))
      .map((b) => b.text)
      .join("\n");
    evidenceApprovals.set(m[1], squash(approval));
    for (const card of unique(approval.match(/\b[a-z]+-card-[1-9]\d*\b/g) ?? []))
      evidenceCards.push([m[1], card, path]);
  }

  // Acceptance files: the package's tables. A row's status cell ("Open.", "Not done;",
  // "*Deferred past launch*") gives its status; a row that is neither open nor deferred is
  // verified by the live records it names, and an open or deferred row only cites them.
  const verifications = [];
  const rowStatuses = [];
  for (const path of paths) {
    const m = /^docs\/acceptance\/(P\d{2})\.md$/.exec(path);
    if (!m) continue;
    const pkg = nodes.get(m[1]);
    if (pkg?.type === "package") {
      pkg.docs.push(path);
      claim(path, pkg.id);
    }
    let task = null;
    for (const line of bodyOf(path).split("\n")) {
      const heading = /^#{1,4} (\S+)/.exec(line);
      if (heading) {
        task = /^P\d{2}\.T\d{2}[a-z]*$/.test(heading[1]) ? heading[1] : null;
        continue;
      }
      if (!line.startsWith("|")) continue;
      const [first = "", ...cells] = line
        .replace(/\|\s*$/, "")
        .split("|")
        .slice(1)
        .map((c) => c.trim());
      const full = /^(P\d{2}\.T\d{2}[a-z]*-AC\d{2}[a-z]?|P\d{2}\.A\d{2})(?![\w])/.exec(first)?.[1];
      const shortId = task && /^AC(\d{2}[a-z]?)(?![\w])/.exec(first)?.[1];
      const acceptance = full ?? (shortId ? `${task}-AC${shortId}` : null);
      if (!acceptance) continue;
      const status = acceptanceStatus(cells);
      if (status) rowStatuses.push([acceptance, status]);
      for (const stem of unique(
        [...line.matchAll(/docs\/evidence\/live\/([A-Za-z0-9_.-]+)\.md/g)].map((x) => x[1]),
      ))
        verifications.push([stem, acceptance, path, status]);
    }
  }

  // Approval cards: the JSON record and its Markdown record.
  for (const { path, data } of src.cards) {
    if (!isPlainObject(data) || typeOfId(data.id) !== "card") {
      report("GRAPH_ID_SHAPE", path, `${JSON.stringify(data?.id)} is not a card id`);
      continue;
    }
    const record =
      typeof data.record === "string" && src.files.has(data.record) ? data.record : null;
    const fields = {};
    if (validDate(data.approvedOn)) fields.approved_on = data.approvedOn;
    if (validDate(data.expiresOn)) fields.expires_on = data.expiresOn;
    const node = addNode(
      {
        id: data.id,
        title: record ? firstHeading(bodyOf(record)) : data.id,
        status: typeof data.status === "string" ? data.status : null,
        doc: record,
        fields,
      },
      path,
    );
    if (node) claim(record, data.id);
  }
  for (const [stem, card, path] of evidenceCards)
    if (nodes.get(card)?.type === "card") derive(stem, "authorized_by", card, "evidence");
    else legacy(path, `the Approval bullet names ${card}, which has no record`);
  for (const [acceptance, status] of rowStatuses)
    if (nodes.get(acceptance)?.type === "acceptance" && nodes.get(acceptance).status === null)
      nodes.get(acceptance).status = status;
  for (const [stem, acceptance, path, status] of verifications)
    if (nodes.get(stem)?.type !== "evidence" || nodes.get(acceptance)?.type !== "acceptance")
      legacy(path, `${acceptance} cites ${stem}, and one of them does not resolve`);
    else if (status) derive(acceptance, "mentions", stem, "acceptance table");
    else derive(stem, "verifies", acceptance, "acceptance table");

  // Registries.
  const registry = (rows, path, type, make) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeOfId(row?.id) !== type) {
        report("GRAPH_ID_SHAPE", path, `${JSON.stringify(row?.id)} is not a ${type} id`);
        continue;
      }
      addNode({ id: row.id, ...make(row) }, path);
    }
  };
  registry(src.dependencies, "docs/decisions/dependencies.json", "dependency", (d) => ({
    title: d.decision ?? null,
    status: d.status ?? null,
  }));
  registry(src.sources, "docs/research/sources.json", "source", (s) => ({
    title: short(s.finding ?? s.url, 120),
    status: s.status ?? null,
    extra: { url: s.url },
  }));
  registry(src.capabilities, "docs/contracts/capabilities.json", "capability", (c) => ({
    title: c.name ?? null,
    status: c.status ?? null,
  }));
  for (const d of Array.isArray(src.dependencies) ? src.dependencies : [])
    for (const source of d?.sources ?? [])
      if (nodes.get(source)?.type === "source") derive(d.id, "cites", source, "registry");
  for (const c of src.capabilities)
    if (nodes.get(c?.provider_dependency)?.type === "dependency")
      derive(c.id, "uses", c.provider_dependency, "registry");

  // Components: apps/* and packages/*.
  for (const c of src.components) {
    const id = `C-${c.name}`;
    if (typeOfId(id) === "component")
      addNode({ id, title: c.package ?? c.path, extra: { path: c.path } }, c.path);
  }

  // Merged pull requests: a "(#n)" subject or a GitHub merge commit; its task, milestone and
  // component edges. The v1 build order's steps are hand-written, so "v1 PR <n>:" titles
  // are linked once those files are read (below).
  const history = src.history ?? { available: false, reason: "not read", commits: [] };
  const prSubjects = [];
  const prBranches = [];
  const prBuildSteps = [];
  if (!history.available)
    report(
      "GRAPH_WARN_NO_HISTORY",
      "git",
      `${history.reason}: PR nodes are skipped and PR-<n> links are not resolved`,
    );
  else
    for (const commit of history.commits) {
      const pr = pullRequestOf(commit);
      if (!pr || nodes.has(`PR-${pr.number}`)) continue;
      const id = `PR-${pr.number}`;
      addNode(
        {
          id,
          title: pr.title,
          status: "merged",
          fields: { commit: commit.sha.slice(0, 12), date: commit.date },
          ...(pr.branch ? { extra: { branch: pr.branch } } : {}),
        },
        "git log",
      );
      // The label before the first colon names what the PR implements ("P04.T01i PR-D part
      // 2:", "M2 PR-1:", "v1 PR 18:"); ids later in the subject are mentions.
      const prefix = pr.title.split(": ")[0];
      for (const task of planIdsIn(prefix))
        if (nodes.get(task)?.type === "task") derive(id, "implements", task, "git");
      const label = /^M([1-9])(?=[\s:-])/.exec(prefix);
      if (label && nodes.get(`M${label[1]}`)?.type === "milestone")
        derive(id, "implements", `M${label[1]}`, "git");
      const step = /^v1 PR ([1-9]\d?)[a-z]?(?![\w])/.exec(prefix);
      if (step) prBuildSteps.push([id, `V1-PR${pad2(step[1])}`]);
      if (pr.branch) prBranches.push([id, pr.branch]);
      for (const file of commit.files) {
        const c = /^(?:apps|packages)\/([^/]+)\//.exec(file);
        if (c && nodes.get(`C-${c[1]}`)?.type === "component")
          derive(id, "touches", `C-${c[1]}`, "git");
      }
      prSubjects.push([id, pr.title]);
    }

  // Hand-written nodes under docs/graph/, then headers added in place to other docs.
  const typed = [];
  const fromHeader = (path, header, mode) => {
    const data = header.data;
    const valid = validateHeader(data, path, mode, report);
    if (!valid) return null;
    const spec = NODE_TYPES[valid.type];
    const node = addNode(
      {
        id: valid.id,
        type: valid.type,
        title: data.title ?? null,
        status: data.status ?? null,
        label: data.label ?? null,
        doc: path,
        docs: docsOf(data),
        header: true,
        headerPath: path,
        body: header.body,
        fields: Object.fromEntries(
          Object.keys(spec.fields)
            .filter((k) => k in data)
            .map((k) => [k, data[k]]),
        ),
      },
      path,
    );
    if (!node) return null;
    claim(path, node.id);
    for (const [edge, targets] of Object.entries(isPlainObject(data.links) ? data.links : {}))
      if (edge in EDGES && Array.isArray(targets))
        for (const to of targets)
          if (typeof to === "string") typed.push({ from: node.id, edge, to, origin: path });
    return node;
  };
  // A README in docs/graph/ or any subfolder is a reference doc, not a node file.
  for (const path of paths) {
    if (!path.startsWith("docs/graph/") || posix.basename(path) === "README.md") continue;
    const header = headers.get(path);
    if (!header) {
      report("GRAPH_PARSE", path, "a node file starts with a --- header");
      continue;
    }
    if (!header.data) continue;
    const node = fromHeader(path, header, "hand");
    if (!node) continue;
    const spec = NODE_TYPES[node.type];
    const expected = spec.dir ? `docs/graph/${spec.dir}/${fileOfId(node.id)}.md` : null;
    if (!expected) report("GRAPH_FIELD", path, `${node.type} nodes are built from their source`);
    else if (path !== expected) report("GRAPH_FIELD", path, `${node.id} belongs in ${expected}`);
  }
  for (const path of paths) {
    const header = headers.get(path);
    if (!header?.data || path.startsWith("docs/graph/")) continue;
    const owner = docOwner.get(path);
    if (!owner) {
      const node = fromHeader(path, header, "hand");
      if (node && !NODE_TYPES[node.type].dir && !["track", "milestone"].includes(node.type))
        report("GRAPH_FIELD", path, `${node.type} nodes are built from their source`);
      continue;
    }
    const node = nodes.get(owner);
    const data = header.data;
    const valid = validateHeader(data, path, "inplace", report);
    if (!valid) continue;
    if (valid.id !== owner || valid.type !== node.type) {
      report(
        "GRAPH_FIELD",
        path,
        `the header names ${valid.id}, but this file belongs to ${owner}`,
      );
      continue;
    }
    if (
      node.type === "task" &&
      /^P\d{2}\.T\d{2}$/.test(owner) &&
      "status" in data &&
      data.status !== listed.get(owner)
    )
      report(
        "GRAPH_TASK_STATUS_DRIFT",
        path,
        `${owner} is ${data.status} here and ${listed.get(owner)} in tasks.json`,
      );
    Object.assign(node, {
      header: true,
      headerPath: path,
      body: header.body,
      title: data.title ?? node.title,
      status: data.status ?? node.status,
      label: data.label ?? node.label,
    });
    for (const key of Object.keys(NODE_TYPES[node.type].fields))
      if (key in data) node.fields[key] = data[key];
    node.docs.push(...docsOf(data));
    for (const [edge, targets] of Object.entries(isPlainObject(data.links) ? data.links : {}))
      if (edge in EDGES && Array.isArray(targets))
        for (const to of targets)
          if (typeof to === "string") typed.push({ from: owner, edge, to, origin: path });
  }
  for (const node of nodes.values())
    for (const doc of node.docs)
      if (doc.startsWith(ARCHIVE_PREFIX)) continue;
      else if (!src.paths.has(doc) && !src.exists?.(doc))
        report(
          "GRAPH_UNCLAIMED_DOC",
          node.headerPath ?? node.origin,
          `${node.id} lists ${doc}, which does not exist`,
        );
      else claim(doc, node.id);

  // Every other Markdown file is a reference doc, named by its path.
  for (const path of paths)
    if (!docOwner.has(path) && typeOfId(path) === "reference") {
      addNode({ id: path, title: firstHeading(bodyOf(path)) ?? path, doc: path }, path);
      claim(path, path);
    }

  // Owner decisions whose whole verbatim quote is in an ADR's Approval section approve it;
  // in an evidence record's Approval bullet, they authorize it.
  for (const decision of nodes.values()) {
    if (decision.type !== "decision" || decision.fields.by !== "owner") continue;
    const quote = blockquoteParagraphs(decision.body);
    if (!quote.some((p) => p.length >= 40)) continue;
    for (const [adr, approval] of adrApprovals)
      if (quote.every((p) => approval.includes(p)))
        derive(adr, "approved_by", decision.id, "quote");
    for (const [evidence, approval] of evidenceApprovals)
      if (quote.every((p) => approval.includes(p)))
        derive(evidence, "authorized_by", decision.id, "quote");
  }

  // Typed links from headers: each resolves and connects the types its edge allows. A PR
  // link without history is kept aside (unresolvedPr), so the rules can tell it apart.
  const lenientPr = new Set();
  const unresolvedPr = [];
  for (const e of typed) {
    const problem = edgeProblem(nodes, e.from, e.edge, e.to, history.available);
    if (problem?.[0] === "PR_WITHOUT_HISTORY") {
      lenientPr.add(e.to);
      unresolvedPr.push(e);
    } else if (problem) report(problem[0], e.origin, `${e.from}: ${problem[1]}`);
    else edges.push({ ...e, derived: false });
  }

  // A "v1 PR <n>:" title implements that build-order step. A merged PR from a branch that
  // has a node comes from_branch it and implements what the branch implements.
  for (const [id, step] of prBuildSteps)
    if (nodes.get(step)?.type === "milestone") derive(id, "implements", step, "git");
  for (const [id, branch] of prBranches) {
    if (nodes.get(branch)?.type !== "branch") continue;
    derive(id, "from_branch", branch, "git");
    for (const e of edges.filter((x) => x.from === branch && x.edge === "implements"))
      derive(id, "implements", e.to, "branch");
  }

  // Mentions: unambiguous ids in body text, [[wiki]] links and doc paths. In a doc with a
  // header an unresolved id is an error; in a doc without one (phase 0), a warning.
  const mentioned = new Set();
  const mention = (from, to) => {
    const key = `${from}\0${to}`;
    if (from === to || mentioned.has(key)) return;
    mentioned.add(key);
    edges.push({ from, edge: "mentions", to, origin: "text", derived: true });
  };
  for (const path of paths) {
    const owner = docOwner.get(path);
    if (!owner || !nodes.has(owner)) continue;
    const strictDoc = headers.get(path)?.data !== undefined && nodes.get(owner).headerPath === path;
    const text = stripFences(bodyOf(path));
    const ids = new Set();
    for (const m of text.matchAll(schema.MENTION)) ids.add(m[0]);
    for (const id of letteredIds(text)) ids.add(id);
    for (const id of parentRangeIds(text)) ids.add(id);
    const prose = text.replace(/`[^`\n]*`/g, "");
    const wiki = new Set([...prose.matchAll(schema.WIKI_LINK)].map((m) => m[1]));
    for (const id of [...ids, ...wiki]) {
      if (nodes.has(id)) mention(owner, id);
      else if (!strictDoc) legacy(path, `mentions ${id}, which does not resolve`);
      else if (wiki.has(id) && !typeOfId(id))
        report("GRAPH_ID_SHAPE", path, `[[${id}]] matches no id shape`);
      else if (typeOfId(id) === "pr" && !history.available) lenientPr.add(id);
      else report("GRAPH_LINK_DANGLING", path, `mentions ${id}, which does not resolve`);
    }
    const targets = [...text.matchAll(DOC_PATH)].map((m) => m[1]);
    for (const m of text.matchAll(RELATIVE_LINK))
      if (!/^[a-z]+:/i.test(m[1]))
        targets.push(posix.normalize(posix.join(posix.dirname(path), m[1])));
    for (const target of targets) {
      const to = docOwner.get(target);
      if (to && nodes.has(to)) mention(owner, to);
    }
  }
  for (const [id, subject] of prSubjects)
    for (const to of [
      ...[...subject.matchAll(schema.MENTION)].map((m) => m[0]),
      ...parentRangeIds(subject),
    ])
      if (nodes.has(to) && !edges.some((e) => e.from === id && e.to === to)) mention(id, to);
  if (lenientPr.size)
    report(
      "GRAPH_WARN_NO_HISTORY",
      "git",
      `not resolved without history: ${[...lenientPr].sort().join(", ")}`,
    );

  const graph = indexGraph({
    nodes,
    edges,
    issues,
    docOwner,
    headers,
    src,
    today,
    history,
    unresolvedPr,
  });
  applyRules(graph, report);
  return graph;
}

function indexGraph(graph) {
  const out = new Map();
  const into = new Map();
  for (const id of graph.nodes.keys()) {
    out.set(id, []);
    into.set(id, []);
  }
  for (const e of graph.edges) {
    out.get(e.from)?.push(e);
    into.get(e.to)?.push(e);
  }
  return Object.assign(graph, { out, in: into });
}

const typedOut = (graph, id, edge) =>
  (graph.out.get(id) ?? []).filter((e) => (edge ? e.edge === edge : e.edge !== "mentions"));
const typedIn = (graph, id, edge) =>
  (graph.in.get(id) ?? []).filter((e) => (edge ? e.edge === edge : e.edge !== "mentions"));
const isDone = (node) => !!node && (schema.DONE_STATUSES[node.type] ?? []).includes(node.status);
const weekNumber = (week) => (week ? Number(week.slice(1)) : Number.POSITIVE_INFINITY);

export function supersededBasis(graph) {
  const findings = [];
  for (const adr of graph.nodes.values()) {
    if (adr.type !== "adr" || adr.status !== "accepted") continue;
    for (const approval of typedOut(graph, adr.id, "approved_by")) {
      const successors = typedIn(graph, approval.to, "supersedes").map((e) => e.from);
      if (!successors.length) continue;
      const citedBy = (graph.in.get(adr.id) ?? [])
        .filter((e) => e.edge === "mentions" || e.edge === "about")
        .map((e) => e.from)
        .filter((id) =>
          ["reference", "milestone", "risk", "question"].includes(graph.nodes.get(id)?.type),
        );
      findings.push({
        adr: adr.id,
        decision: approval.to,
        successors,
        citedBy: unique(citedBy).sort(),
      });
    }
  }
  return findings;
}

// Parent tasks that no active feature or track includes or defers, directly, through their
// package, or through every one of their lettered children (P17.T02g included and P17.T02a
// to P17.T02f deferred cover P17.T02). A dropped feature or track covers nothing. A child
// deferred by name is left out of a parent that another node includes.
export function uncoveredTasks(graph) {
  const children = new Map();
  for (const n of graph.nodes.values()) {
    const parent = n.type === "task" ? /^(P\d{2}\.T\d{2})[a-z]+$/.exec(n.id)?.[1] : undefined;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), n.id]);
  }
  const covered = new Set();
  for (const e of graph.edges) {
    const from = graph.nodes.get(e.from);
    if (
      ["includes", "defers"].includes(e.edge) &&
      ["feature", "track"].includes(from?.type) &&
      !schema.INACTIVE_STATUSES.includes(from.status)
    )
      covered.add(e.to);
  }
  return [...graph.nodes.values()].filter(
    (n) =>
      n.type === "task" &&
      /^P\d{2}\.T\d{2}$/.test(n.id) &&
      !covered.has(n.id) &&
      !covered.has(n.id.slice(0, 3)) &&
      !(children.has(n.id) && children.get(n.id).every((c) => covered.has(c))),
  );
}

// Recent work on a node, its parts or the build-order steps that deliver it: a PR or live
// evidence since the date, or an open or built branch node that implements it and whose ref
// (local or remote) has a commit since the date.
const branchTip = (graph, name) => {
  const refs = graph.history?.refs;
  return refs && Object.hasOwn(refs, name) ? refs[name] : null;
};

function activity(graph, id, since) {
  const ids = [
    id,
    ...typedIn(graph, id, "part_of").map((e) => e.from),
    ...typedIn(graph, id, "delivers")
      .filter((e) => graph.nodes.get(e.from)?.type === "milestone")
      .map((e) => e.from),
  ];
  for (const target of ids)
    for (const e of graph.in.get(target) ?? []) {
      const from = graph.nodes.get(e.from);
      if (
        e.edge === "implements" &&
        from?.type === "branch" &&
        ["open", "built"].includes(from.status) &&
        (branchTip(graph, from.id) ?? "") >= since
      )
        return true;
      if (
        (e.edge === "implements" && from?.type === "pr") ||
        (e.edge === "verifies" && from?.type === "evidence")
      )
        if ((from.fields.date ?? "") >= since) return true;
    }
  return false;
}

function applyRules(graph, report) {
  const { nodes, edges, src, today } = graph;
  const field = (node, key) => node?.fields?.[key];

  // Orphans: a typed edge in or out; reference docs need one link or mention in.
  for (const node of nodes.values()) {
    if (node.id === "V-morrow") continue;
    if (node.type === "reference") {
      if (!(graph.in.get(node.id) ?? []).length)
        report("GRAPH_ORPHAN", node.id, "no node links to or mentions this doc");
    } else if (!typedOut(graph, node.id).length && !typedIn(graph, node.id).length)
      report("GRAPH_ORPHAN", node.origin, `${node.id} has no typed edge`);
  }
  // Governed docs belong to a typed node.
  for (const path of [...src.files.keys()].sort())
    if (
      GOVERNED.some((dir) => path.startsWith(dir)) &&
      !path.endsWith("/README.md") &&
      nodes.get(graph.docOwner.get(path))?.type === "reference"
    )
      report("GRAPH_UNCLAIMED_DOC", path, "no typed node claims this doc");
  // Cycles.
  for (const group of schema.ACYCLIC) {
    const next = new Map();
    for (const e of edges)
      if (group.includes(e.edge) && e.from !== e.to)
        next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    const state = new Map();
    const stack = [];
    const visit = (id) => {
      state.set(id, 1);
      stack.push(id);
      for (const to of next.get(id) ?? []) {
        if (state.get(to) === 1)
          report(
            "GRAPH_CYCLE",
            id,
            `${group.join("/")}: ${[...stack.slice(stack.indexOf(to)), to].join(" -> ")}`,
          );
        else if (!state.has(to)) visit(to);
      }
      stack.pop();
      state.set(id, 2);
    };
    for (const id of [...next.keys()].sort()) if (!state.has(id)) visit(id);
  }
  // Status values, labels, gates.
  const labels = new Map();
  for (const node of nodes.values()) {
    const spec = NODE_TYPES[node.type];
    if (
      node.status !== null &&
      spec?.statuses &&
      !spec.statuses.includes(node.status) &&
      !node.header
    )
      report(
        "GRAPH_STATUS",
        node.origin,
        `${node.id}: ${node.status} is not a ${node.type} status`,
      );
    if (
      ["track", "gate"].includes(node.type) &&
      node.label &&
      !schema.INACTIVE_STATUSES.includes(node.status)
    ) {
      const key = `${node.type}\0${node.label}`;
      if (labels.has(key))
        report(
          "GRAPH_LABEL_DUPLICATE",
          node.headerPath ?? node.origin,
          `${node.label}: ${labels.get(key)} and ${node.id}`,
        );
      else labels.set(key, node.id);
    }
    if (node.type === "gate" && node.status === "open") {
      if (!field(node, "owner_kind"))
        report(
          "GRAPH_GATE_FIELDS",
          node.headerPath ?? node.origin,
          `${node.id} is open without owner_kind`,
        );
      if (!field(node, "due_week") && !field(node, "due_when"))
        report(
          "GRAPH_GATE_FIELDS",
          node.headerPath ?? node.origin,
          `${node.id} is open without due_week or due_when`,
        );
    }
  }
  const byLabel = new Map();
  for (const node of nodes.values())
    if (node.type === "milestone" && node.label && !schema.INACTIVE_STATUSES.includes(node.status))
      byLabel.set(node.label, [...(byLabel.get(node.label) ?? []), node]);
  for (const [label, group] of byLabel)
    if (group.length > 1) {
      const sets = group.map((n) => new Set(typedOut(graph, n.id, "includes").map((e) => e.to)));
      const shared = [...sets[0]].filter((id) => sets.slice(1).every((s) => s.has(id)));
      report(
        "GRAPH_WARN_LABEL_COLLISION",
        label,
        `${group.map((n) => `${n.id} (${n.title})`).join(" and ")} share the label ${label}${shared.length ? `; both include ${shared.join(", ")}` : ""}`,
      );
    }
  // Data classes, skills, agents and installation kinds (documentation mirrors of the code).
  for (const node of nodes.values()) {
    const where = node.headerPath ?? node.origin;
    if (node.type === "data_class" && node.status === "live") {
      const merged = typedOut(graph, node.id, "deleted_by").some(
        (e) => nodes.get(e.to)?.type === "pr" && nodes.get(e.to).status === "merged",
      );
      // Without history a PR cannot be read back: a deleted_by PR link is then a warning.
      const unchecked = (graph.unresolvedPr ?? [])
        .filter((e) => e.from === node.id && e.edge === "deleted_by")
        .map((e) => e.to);
      if (!merged && unchecked.length)
        report(
          "GRAPH_WARN_NO_HISTORY",
          where,
          `${node.id} is live; deleted_by ${unchecked.join(", ")} is not checked without history`,
        );
      else if (!merged)
        report("GRAPH_DATA_CLASS", where, `${node.id} is live without deleted_by a merged PR`);
    }
    // Agents (ADR-0037): Morrow, the one builtin agent, calls and hands off to teammates, and
    // a teammate is an installation of either origin that never delegates (depth 1). The
    // run-scoped task_specialist kind is retired: only a dropped node keeps it.
    if (node.type === "agent") {
      const kind = field(node, "kind");
      const origin = field(node, "origin");
      const inactive = schema.INACTIVE_STATUSES.includes(node.status);
      for (const e of typedOut(graph, node.id, "delegates_to")) {
        const to = nodes.get(e.to);
        if (kind !== "builtin")
          report("GRAPH_AGENT_KIND", where, `${node.id} (${kind}) delegates to ${e.to}`);
        else if (
          to &&
          (field(to, "kind") !== "installable" || schema.INACTIVE_STATUSES.includes(to.status))
        )
          report(
            "GRAPH_AGENT_KIND",
            where,
            `${node.id} delegates to ${e.to}, which is not an active teammate`,
          );
      }
      if (kind === "task_specialist" && !inactive)
        report(
          "GRAPH_AGENT_KIND",
          where,
          `${node.id} keeps the task_specialist kind, which ADR-0037 retired; only a dropped node may`,
        );
      if (kind === "installable" && !origin)
        report("GRAPH_AGENT_KIND", where, `${node.id} is a teammate without an origin`);
      if (origin && kind !== "installable")
        report("GRAPH_AGENT_KIND", where, `${node.id} (${kind}) names an origin; only teammates do`);
      if (kind === "installable") {
        const holders = [node.id, ...typedOut(graph, node.id, "installs_as").map((e) => e.to)];
        const denied = holders.some((id) =>
          typedOut(graph, id, "never_holds").some((e) => e.to === "workspace.task.delegate"),
        );
        if (!denied)
          report(
            "GRAPH_AGENT_KIND",
            where,
            `${node.id} is a teammate without never_holds workspace.task.delegate, directly or by its installation kind`,
          );
      }
      if (typedOut(graph, node.id, "bundles").length && origin !== "first-party")
        report(
          "GRAPH_AGENT_KIND",
          where,
          `${node.id} bundles skills; only a first-party teammate does`,
        );
      if (typedOut(graph, node.id, "composes").length && origin !== "workspace")
        report(
          "GRAPH_AGENT_KIND",
          where,
          `${node.id} composes skills; only a workspace-created teammate does`,
        );
      if (field(node, "depth") !== undefined && kind !== "builtin")
        report("GRAPH_AGENT_KIND", where, `${node.id} sets depth, which only a builtin agent has`);
      if (origin === "workspace")
        for (const e of typedOut(graph, node.id, "composes")) {
          const skill = nodes.get(e.to);
          if (skill && field(skill, "card_eligible") !== "yes")
            report(
              "GRAPH_SKILL_ELIGIBLE",
              where,
              `${node.id} composes ${e.to}, which is not card_eligible`,
            );
        }
      for (const e of typedOut(graph, node.id, "installs_as")) {
        const ik = nodes.get(e.to);
        if (!ik) continue;
        if (!inactive && schema.INACTIVE_STATUSES.includes(ik.status))
          report(
            "GRAPH_INSTALLATION_KIND",
            where,
            `${node.id} installs as ${e.to}, which is ${ik.status}`,
          );
        if (origin && !(field(ik, "origins") ?? []).includes(origin))
          report(
            "GRAPH_INSTALLATION_KIND",
            where,
            `${node.id} (${origin}) installs as ${e.to}, whose origins do not include ${origin}`,
          );
      }
    }
    if (node.type === "skill" && field(node, "card_eligible") === "yes") {
      const customer = typedOut(graph, node.id, "holds").filter(
        (h) => field(nodes.get(h.to), "customer") === "yes",
      );
      if (customer.length)
        report(
          "GRAPH_SKILL_ELIGIBLE",
          where,
          `${node.id} is card_eligible but holds ${customer.map((h) => h.to).join(", ")}`,
        );
    }
    if (node.type === "installation_kind") {
      if (field(node, "triggers") === "yes" && field(node, "mandate") !== "yes")
        report("GRAPH_INSTALLATION_KIND", where, `${node.id} has triggers without a mandate`);
      if (
        field(node, "routable") === "yes" &&
        field(node, "triggers") !== "yes" &&
        field(node, "mandate") !== "yes"
      )
        report(
          "GRAPH_INSTALLATION_KIND",
          where,
          `${node.id} is routable without triggers or a mandate`,
        );
    }
    // Headers: tenant records, owner quotes, evidence and ADR approvals. A hand-written
    // file under docs/graph/ is scanned whole, body included, with the secrets below.
    if (node.header && !node.headerPath?.startsWith("docs/graph/")) {
      const values = [node.id, node.title, ...Object.values(node.fields).flat(), ...node.docs];
      const header = graph.headers.get(node.headerPath)?.data;
      for (const targets of Object.values(isPlainObject(header?.links) ? header.links : {}))
        if (Array.isArray(targets)) values.push(...targets);
      for (const value of values)
        if (typeof value === "string" && schema.TENANT_RECORD.some((p) => p.test(value))) {
          report("GRAPH_TENANT_RECORD", where, `${node.id}: a value looks like a tenant record id`);
          break;
        }
    }
    if (node.header) {
      if (node.type === "decision" && field(node, "by") === "owner") {
        const missing = ["date", "channel"].filter((k) => !field(node, k));
        if (!/^>\s*\S/m.test(node.body ?? "")) missing.push("a blockquote with the verbatim words");
        if (missing.length)
          report("GRAPH_DECISION_QUOTE", where, `${node.id} needs ${missing.join(", ")}`);
        if (field(node, "date") && !node.id.startsWith(`OD-${field(node, "date")}-`))
          report("GRAPH_FIELD", where, `${node.id} has date ${field(node, "date")}`);
      }
      if (node.type === "evidence") {
        const missing = [];
        if (!typedOut(graph, node.id, "authorized_by").length) missing.push("authorized_by");
        if (!field(node, "unknown_outcome")) missing.push("unknown_outcome");
        if (missing.length)
          report("GRAPH_EVIDENCE_AUTH", where, `${node.id} needs ${missing.join(" and ")}`);
      }
      if (
        node.type === "adr" &&
        node.status === "accepted" &&
        !typedOut(graph, node.id, "approved_by").length
      )
        report("GRAPH_ADR_APPROVAL", where, `${node.id} is accepted without approved_by`);
    }
  }
  // New packets and acceptance files after phase 0 are security work only.
  for (const path of [...src.files.keys()].sort())
    if (
      /^docs\/(?:packets\/[^/]+|acceptance\/[^/]+)\.md$/.test(path) &&
      !schema.LEGACY_PACKETS.includes(path) &&
      graph.headers.get(path)?.data?.kind !== "security"
    )
      report(
        "GRAPH_NEW_PACKET",
        path,
        "new MVP work uses the graph and a brief; a packet declares kind: security",
      );
  // Secrets: the hand-written graph and every header. Email addresses: the whole text of
  // every governed doc (the graph, ADRs, packets, briefs, evidence, acceptance) and every
  // header. Tenant record ids: the whole text of the hand-written graph (other headers are
  // checked above).
  for (const [path, text] of src.files) {
    const handWritten = path.startsWith("docs/graph/");
    const header = graph.headers.get(path)?.raw;
    const scope = handWritten ? text : header;
    if (scope)
      for (const kind of inspectSecrets(scope))
        report("GRAPH_SECRET", path, `matches the ${kind} pattern`);
    if (emailsIn(GOVERNED.some((dir) => path.startsWith(dir)) ? text : (header ?? "")).length)
      report("GRAPH_EMAIL", path, "holds an email address");
    if (handWritten && schema.TENANT_RECORD.some((p) => p.test(text)))
      report("GRAPH_TENANT_RECORD", path, "a value looks like a tenant record id");
  }
  // Generated blocks.
  const readme = src.files.get("docs/graph/README.md");
  const fresh = readme === undefined ? null : replaceBlock(readme, "schema", renderSchemaBlock());
  if (fresh === null)
    report(
      "GRAPH_STALE_GENERATED",
      "docs/graph/README.md",
      "the schema block is missing; run npm run graph -- render",
    );
  else if (fresh !== readme)
    report(
      "GRAPH_STALE_GENERATED",
      "docs/graph/README.md",
      "the schema block is stale; run npm run graph -- render",
    );
  const index = src.files.get("docs/decisions/adr/README.md");
  const indexFresh =
    index === undefined ? null : replaceBlock(index, "adr-index", renderAdrIndex(graph));
  if (indexFresh !== null && indexFresh !== index)
    report(
      "GRAPH_STALE_GENERATED",
      "docs/decisions/adr/README.md",
      "the ADR index is stale; run npm run graph -- render",
    );
  // STATUS.md length.
  const status = src.files.get("docs/progress/STATUS.md");
  if (status !== undefined) {
    const lines = status.replace(/\n$/, "").split("\n").length;
    if (lines > schema.STATUS_MAX_LINES)
      report(
        "GRAPH_STATUS_LINES",
        "docs/progress/STATUS.md",
        `${lines} lines (at most ${schema.STATUS_MAX_LINES})`,
      );
  }
  // The graph is documentation, never authority.
  for (const [path, text] of [...src.code].sort())
    if (GRAPH_REFERENCE.test(text))
      report("GRAPH_IMPORTED_BY_CODE", path, "names the graph's script or files");
  // Warnings.
  for (const f of supersededBasis(graph))
    report(
      "GRAPH_WARN_SUPERSEDED_BASIS",
      f.adr,
      `${f.adr} approved_by ${f.decision}, superseded by ${f.successors.join(", ")}${f.citedBy.length ? `; still cited by ${f.citedBy.join(", ")}` : ""}`,
    );
  const since = new Date((dayNumber(today) - 7) * 86_400_000).toISOString().slice(0, 10);
  for (const node of nodes.values()) {
    const active =
      (node.type === "task" && ["In progress", "In review"].includes(node.status)) ||
      (["track", "feature", "milestone"].includes(node.type) && node.status === "active");
    if (active && !activity(graph, node.id, since))
      report(
        "GRAPH_WARN_STALE_ACTIVE",
        node.id,
        `${node.id} is ${node.status} with no PR, evidence or branch commit since ${since}`,
      );
    if (node.type === "card" && node.status === "approved" && field(node, "expires_on")) {
      const left = dayNumber(field(node, "expires_on")) - dayNumber(today);
      if (left <= schema.CARD_EXPIRY_WARNING_DAYS)
        report(
          "GRAPH_WARN_CARD_EXPIRING",
          node.id,
          `${node.id} expires ${field(node, "expires_on")} (${left} days)`,
        );
    }
    if (node.type === "gate" && node.status === "open" && field(node, "due_week")) {
      const due = dayNumber(schema.WEEK_ZERO) + 7 * (weekNumber(field(node, "due_week")) + 1);
      if (dayNumber(today) >= due)
        report(
          "GRAPH_WARN_GATE_OVERDUE",
          node.id,
          `${node.id} was due by the end of ${field(node, "due_week")}`,
        );
    }
  }
  for (const e of edges)
    if (
      e.edge === "from_branch" &&
      nodes.get(e.from)?.status === "merged" &&
      nodes.get(e.to)?.status !== "merged"
    )
      report(
        "GRAPH_WARN_BRANCH_MERGED",
        nodes.get(e.to).headerPath ?? e.to,
        `${e.to} is ${nodes.get(e.to).status ?? "without a status"}, but ${e.from} merged it; set status merged`,
      );
  // An open or built branch counts as recent work only while a ref of its name has a recent
  // commit, so an abandoned or squash-merged branch cannot hide stale work.
  if (graph.history.available && graph.history.refs)
    for (const node of nodes.values())
      if (node.type === "branch" && ["open", "built"].includes(node.status)) {
        const tip = branchTip(graph, node.id);
        if ((tip ?? "") < since)
          report(
            "GRAPH_WARN_BRANCH_STALE",
            node.headerPath ?? node.id,
            tip
              ? `${node.id} is ${node.status}, but its newest commit is from ${tip}; push it or set its status`
              : `${node.id} is ${node.status}, but no local or remote branch has that name; push it or set its status`,
          );
      }
  for (const task of uncoveredTasks(graph))
    report(
      "GRAPH_WARN_PLAN_UNCOVERED",
      task.id,
      `${task.id} ${task.title ?? ""}: no feature or track includes or defers it`,
    );
}

// ---------------------------------------------------------------------------------------
// Generated blocks

export function replaceBlock(text, name, content) {
  const start = `<!-- graph:${name}:start -->`;
  const end = `<!-- graph:${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1 || j < i) return null;
  return `${text.slice(0, i + start.length)}\n${content}\n${text.slice(j)}`;
}

export function renderSchemaBlock() {
  const describe = ([name, rule]) => {
    if (rule.kind === "enum") return `\`${name}\` (${rule.values.join(", ")})`;
    if (rule.kind === "enum_list")
      return rule.values === schema.SHOPIFY_SCOPES
        ? `\`${name}\` (list of Shopify scopes)`
        : `\`${name}\` (list of: ${rule.values.join(", ")})`;
    if (rule.kind === "list") return `\`${name}\` (list)`;
    if (rule.kind === "date") return `\`${name}\` (date)`;
    if (rule.kind === "pattern") return `\`${name}\` (\`${rule.pattern.source}\`)`;
    return `\`${name}\``;
  };
  const rows = [
    "<!-- Generated by `npm run graph -- render` from scripts/graph-schema.mjs. Do not edit by hand. -->",
    "",
    "#### Node types",
    "",
    "| Type | Id shape | Stored | Status values | Fields (required in bold) |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [type, spec] of Object.entries(NODE_TYPES)) {
    const fields = Object.entries(spec.fields).map((entry) =>
      (spec.required ?? []).includes(entry[0]) ? `**${describe(entry)}**` : describe(entry),
    );
    rows.push(
      `| ${type} | \`${spec.shape}\` | ${spec.stored}${spec.dir ? ` (\`docs/graph/${spec.dir}/\`)` : ""} | ${spec.statuses ? spec.statuses.join(", ") : "from its source"} | ${fields.join("; ") || "none"} |`,
    );
  }
  rows.push("", "#### Edge types", "", "| Edge | From → to |", "| --- | --- |");
  for (const [edge, rules] of Object.entries(EDGES))
    rows.push(
      `| \`${edge}\` | ${rules.map(([f, t]) => `${f.join(", ").replace(ANY, "any")} → ${t.join(", ").replace(ANY, "any")}`).join("; ")} |`,
    );
  rows.push("", "#### Check codes", "", "| Code | Rule | Phase 0 |", "| --- | --- | --- |");
  for (const [code, rule] of Object.entries(ERRORS))
    rows.push(
      `| \`${code}\` | ${rule} | ${schema.PHASE0_WARNINGS.includes(code) ? "warning" : "error"} |`,
    );
  for (const [code, rule] of Object.entries(WARNINGS))
    rows.push(`| \`${code}\` | ${rule} | warning |`);
  return rows.join("\n");
}

// The ADR index rows, in the exact form tests/migration-history.test.mjs reads. Phase 2
// puts markers around the table in docs/decisions/adr/README.md; until then this is unused.
export function renderAdrIndex(graph) {
  return [...graph.nodes.values()]
    .filter((n) => n.type === "adr" && /^ADR-\d{4}$/.test(n.id) && n.doc)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (n) =>
        `| [${n.id.slice(4)}](${posix.basename(n.doc)}) | ${n.title} | ${n.fields.readme_status ?? n.statusText ?? n.status} |`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------------------
// Views

export function graphJson(graph) {
  const nodes = [...graph.nodes.values()].map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    status: n.status,
    label: n.label,
    fields: n.fields,
    doc: n.doc,
    docs: n.docs,
    header: n.header,
    ...(n.extra ? { extra: n.extra } : {}),
    ...(n.type === "decision" ? { quote: blockquoteParagraphs(n.body).join("\n\n") } : {}),
  }));
  return {
    schema: "morrow-graph/1",
    generated_at: new Date().toISOString(),
    head: graph.history.head ?? null,
    counts: Object.fromEntries(
      Object.keys(NODE_TYPES).map((t) => [t, nodes.filter((n) => n.type === t).length]),
    ),
    nodes,
    edges: graph.edges.map(({ from, edge, to, origin }) => ({ from, edge, to, origin })),
    issues: graph.issues,
  };
}

export function renderHtml(data) {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Morrow project graph</title>
<style>
:root { --bg: #f7f6f3; --panel: #ffffff; --text: #1f1e1c; --muted: #6a6862; --line: #e2e0da; --accent: #2f5bd3; --chip: #efede8; --warn: #9a5b00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #141413; --panel: #1c1c1a; --text: #ecebe6; --muted: #a29f97; --line: #34332f; --accent: #8fabff; --chip: #2a2926; --warn: #f0b45a; } }
:root[data-theme="dark"] { --bg: #141413; --panel: #1c1c1a; --text: #ecebe6; --muted: #a29f97; --line: #34332f; --accent: #8fabff; --chip: #2a2926; --warn: #f0b45a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
h1 { font-size: 17px; margin: 0; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 16px 0 6px; }
.muted { color: var(--muted); }
main { display: grid; grid-template-columns: 260px minmax(0, 1fr) 360px; height: calc(100vh - 49px); }
aside { overflow: auto; padding: 12px 16px; background: var(--panel); }
#filters { border-right: 1px solid var(--line); }
#detail { border-left: 1px solid var(--line); }
#canvas { position: relative; min-height: 360px; }
#cy { position: absolute; inset: 0; }
#fallback { position: absolute; inset: 0; overflow: auto; padding: 12px 16px; }
input[type=search], select { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
button { padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--chip); color: var(--text); font: inherit; cursor: pointer; }
button:hover { border-color: var(--accent); }
.row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.type { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.link { color: var(--accent); cursor: pointer; text-decoration: none; background: none; border: 0; padding: 0; font: inherit; text-align: left; }
.link:hover { text-decoration: underline; }
.result { display: block; padding: 3px 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 8px 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: 4px 0; padding-left: 18px; }
.edge { color: var(--muted); font-size: 12px; }
.issue { color: var(--warn); }
@media (max-width: 900px) { main { grid-template-columns: 1fr; height: auto; } #canvas { height: 60vh; } #filters, #detail { border: 0; border-bottom: 1px solid var(--line); } }
</style>
</head>
<body>
<header><h1>Morrow project graph</h1><span id="summary" class="muted"></span></header>
<main>
<aside id="filters">
<input id="search" type="search" placeholder="Search id or title" aria-label="Search nodes">
<div id="results"></div>
<h2>Status</h2>
<select id="status" aria-label="Status filter"><option value="">Any status</option></select>
<h2>Types</h2>
<div id="types"></div>
<label class="type"><input type="checkbox" id="mentions"> Show mentions</label>
<div class="row"><button id="focus" type="button">Two-hop focus</button><button id="reset" type="button">Show all</button></div>
</aside>
<section id="canvas"><div id="cy" aria-label="Graph"></div><div id="fallback" hidden></div></section>
<aside id="detail"><p class="muted">Select a node to see its fields, edges and backlinks.</p></aside>
</main>
<script>const GRAPH = ${json};</script>
<script src="${schema.CYTOSCAPE}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
(() => {
  const BLOB = ${JSON.stringify(schema.GITHUB_BLOB)};
  const HIDDEN = new Set(["acceptance", "source", "capability", "reference", "dependency"]);
  const palette = ["#2f5bd3", "#c2410c", "#15803d", "#7c3aed", "#b91c1c", "#0e7490", "#a16207", "#be185d", "#4d7c0f", "#475569", "#9333ea", "#0369a1", "#b45309"];
  const byId = new Map(GRAPH.nodes.map((n) => [n.id, n]));
  const out = new Map(), into = new Map();
  for (const e of GRAPH.edges) { (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e); (into.get(e.to) || into.set(e.to, []).get(e.to)).push(e); }
  const types = Object.keys(GRAPH.counts).filter((t) => GRAPH.counts[t] > 0);
  const color = new Map(types.map((t, i) => [t, palette[i % palette.length]]));
  const state = { types: new Set(types.filter((t) => !HIDDEN.has(t))), status: "", mentions: false, focus: null, selected: null };
  const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
  const nodeLink = (id) => el("button", { className: "link", type: "button", textContent: id, onclick: () => select(id, true) });
  document.getElementById("summary").textContent = GRAPH.nodes.length + " nodes, " + GRAPH.edges.length + " edges" + (GRAPH.head ? ", at " + GRAPH.head.slice(0, 7) : "") + ", " + GRAPH.issues.filter((i) => i.severity === "error").length + " errors, " + GRAPH.issues.filter((i) => i.severity === "warning").length + " warnings";
  const typesBox = document.getElementById("types");
  for (const t of types) {
    const box = el("input", { type: "checkbox", checked: state.types.has(t), onchange: (ev) => { ev.target.checked ? state.types.add(t) : state.types.delete(t); draw(); } });
    typesBox.append(el("label", { className: "type" }, box, el("span", { className: "swatch", style: "background:" + color.get(t) }), t + " (" + GRAPH.counts[t] + ")"));
  }
  const statusSelect = document.getElementById("status");
  for (const s of [...new Set(GRAPH.nodes.map((n) => n.status).filter(Boolean))].sort()) statusSelect.append(el("option", { value: s, textContent: s }));
  statusSelect.onchange = () => { state.status = statusSelect.value; draw(); };
  document.getElementById("mentions").onchange = (ev) => { state.mentions = ev.target.checked; draw(); };
  document.getElementById("focus").onclick = () => { if (state.selected) { state.focus = state.selected; draw(); } };
  document.getElementById("reset").onclick = () => { state.focus = null; draw(); };
  const neighbourhood = (id, depth) => {
    const seen = new Set([id]); let frontier = [id];
    for (let d = 0; d < depth; d += 1) {
      const next = [];
      for (const x of frontier) for (const e of [...(out.get(x) || []), ...(into.get(x) || [])]) {
        if (e.edge === "mentions" && !state.mentions) continue;
        const y = e.from === x ? e.to : e.from;
        if (!seen.has(y)) { seen.add(y); next.push(y); }
      }
      frontier = next;
    }
    return seen;
  };
  const visible = () => {
    const focus = state.focus ? neighbourhood(state.focus, 2) : null;
    return GRAPH.nodes.filter((n) => focus ? focus.has(n.id) : state.types.has(n.type) && (!state.status || n.status === state.status));
  };
  let cy = null;
  if (window.cytoscape) {
    cy = window.cytoscape({ container: document.getElementById("cy"), wheelSensitivity: 0.2, style: [
      { selector: "node", style: { "background-color": "data(color)", label: "data(id)", "font-size": 9, color: getComputedStyle(document.body).color, "text-valign": "bottom", "text-margin-y": 3, width: 12, height: 12 } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#f59e0b" } },
      { selector: "edge", style: { width: 1, "line-color": "#9a988f", "target-arrow-color": "#9a988f", "target-arrow-shape": "triangle", "arrow-scale": 0.6, "curve-style": "bezier", opacity: 0.6 } },
      { selector: "edge.mention", style: { "line-style": "dotted", opacity: 0.35 } },
    ] });
    cy.on("tap", "node", (ev) => select(ev.target.id(), false));
  } else {
    document.getElementById("fallback").hidden = false;
  }
  function draw() {
    const shown = visible();
    const ids = new Set(shown.map((n) => n.id));
    const links = GRAPH.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && (state.mentions || e.edge !== "mentions"));
    if (cy) {
      cy.elements().remove();
      cy.add(shown.map((n) => ({ data: { id: n.id, color: color.get(n.type) } })));
      cy.add(links.map((e, i) => ({ data: { id: "e" + i, source: e.from, target: e.to, label: e.edge }, classes: e.edge === "mentions" ? "mention" : "" })));
      cy.layout({ name: shown.length > 700 ? "grid" : "cose", animate: false, nodeDimensionsIncludeLabels: true }).run();
      if (state.selected && ids.has(state.selected)) cy.getElementById(state.selected).select();
    } else {
      const box = document.getElementById("fallback");
      box.replaceChildren(el("p", { className: "muted", textContent: "The Cytoscape script did not load (offline?). Showing a list instead." }));
      for (const t of types) {
        const group = shown.filter((n) => n.type === t);
        if (!group.length) continue;
        box.append(el("h2", { textContent: t + " (" + group.length + ")" }), el("ul", {}, ...group.map((n) => el("li", {}, nodeLink(n.id), " ", n.title || ""))));
      }
    }
  }
  function select(id, center) {
    const n = byId.get(id); if (!n) return;
    state.selected = id;
    const panel = document.getElementById("detail");
    const dl = el("dl", {}, el("dt", { textContent: "type" }), el("dd", { textContent: n.type }));
    for (const [k, v] of [["status", n.status], ["label", n.label], ...Object.entries(n.fields || {}), ...Object.entries(n.extra || {})])
      if (v !== null && v !== undefined && v !== "") dl.append(el("dt", { textContent: k }), el("dd", { textContent: Array.isArray(v) ? v.join(", ") : String(v) }));
    const docs = [n.doc, ...(n.docs || [])].filter(Boolean);
    const edgeList = (list, dir) => {
      const groups = new Map();
      for (const e of list) if (e.edge !== "mentions") (groups.get(e.edge) || groups.set(e.edge, []).get(e.edge)).push(dir === "out" ? e.to : e.from);
      const ul = el("ul");
      for (const [edge, targets] of groups) ul.append(el("li", {}, el("span", { className: "edge", textContent: edge + " " }), ...targets.flatMap((t, i) => i ? [", ", nodeLink(t)] : [nodeLink(t)])));
      return groups.size ? ul : el("p", { className: "muted", textContent: "none" });
    };
    const mentionsIn = (into.get(id) || []).filter((e) => e.edge === "mentions").map((e) => e.from);
    const issues = GRAPH.issues.filter((i) => i.where === id || i.where === n.doc || (i.message || "").startsWith(id + " "));
    panel.replaceChildren(
      el("h1", { textContent: id }), el("p", { textContent: n.title || "" }), dl,
      ...(n.quote ? [el("h2", { textContent: "Quote" }), el("blockquote", { textContent: n.quote })] : []),
      ...(docs.length ? [el("h2", { textContent: "Docs" }), el("ul", {}, ...docs.map((d) => el("li", {}, d.includes(":") ? d : el("a", { href: BLOB + d, textContent: d, target: "_blank", rel: "noopener" }))))] : []),
      el("h2", { textContent: "Edges out" }), edgeList(out.get(id) || [], "out"),
      el("h2", { textContent: "Backlinks" }), edgeList(into.get(id) || [], "in"),
      el("h2", { textContent: "Mentioned by (" + mentionsIn.length + ")" }), el("p", {}, ...mentionsIn.slice(0, 40).flatMap((t, i) => i ? [", ", nodeLink(t)] : [nodeLink(t)])),
      ...(issues.length ? [el("h2", { textContent: "Check findings" }), el("ul", {}, ...issues.map((i) => el("li", { className: "issue", textContent: i.code + ": " + i.message })))] : []),
    );
    if (cy) { cy.$(":selected").unselect(); const node = cy.getElementById(id); if (node.length) { node.select(); if (center) cy.animate({ center: { eles: node }, duration: 200 }); } }
  }
  const search = document.getElementById("search");
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    const results = document.getElementById("results");
    if (!q) { results.replaceChildren(); return; }
    const hits = GRAPH.nodes.filter((n) => n.id.toLowerCase().includes(q) || (n.title || "").toLowerCase().includes(q)).slice(0, 20);
    results.replaceChildren(...hits.map((n) => el("div", { className: "result" }, nodeLink(n.id), el("span", { className: "muted", textContent: " " + (n.title || "").slice(0, 60) }))));
  };
  search.onkeydown = (ev) => { if (ev.key === "Enter") { const first = document.querySelector("#results .link"); if (first) first.click(); } };
  draw();
})();
</script>
</body>
</html>
`;
}

function neighbourhood(graph, id, depth, withMentions = false) {
  const distance = new Map([[id, 0]]);
  let frontier = [id];
  for (let d = 1; d <= depth; d += 1) {
    const next = [];
    for (const x of frontier)
      for (const e of [...(graph.out.get(x) ?? []), ...(graph.in.get(x) ?? [])]) {
        if (e.edge === "mentions" && !withMentions) continue;
        const y = e.from === x ? e.to : e.from;
        if (!distance.has(y)) {
          distance.set(y, d);
          next.push(y);
        }
      }
    frontier = next;
  }
  return distance;
}

export function mermaid(graph, id, depth = 1) {
  const ids = [...neighbourhood(graph, id, depth).keys()];
  const key = new Map(ids.map((x, i) => [x, `n${i}`]));
  const label = (x) => {
    const title = graph.nodes.get(x)?.title;
    return `${x}${title && !graph.nodes.get(x)?.type?.startsWith("reference") ? `<br/>${short(title, 40)}` : ""}`.replace(
      /"/g,
      "#quot;",
    );
  };
  const lines = ["flowchart LR"];
  for (const x of ids) lines.push(`  ${key.get(x)}["${label(x)}"]`);
  for (const e of graph.edges)
    if (e.edge !== "mentions" && key.has(e.from) && key.has(e.to))
      lines.push(`  ${key.get(e.from)} -->|${e.edge}| ${key.get(e.to)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Queries

const line = (node, extra = "") =>
  `${node.id.padEnd(28)} ${(node.status ?? "-").padEnd(13)} ${short(node.title ?? "", 70)}${extra}`;

export function query(graph, name, args, flags) {
  const { nodes } = graph;
  const need = (count) => {
    if (args.length !== count)
      throw usage(`query ${name} takes ${count} argument${count === 1 ? "" : "s"}`);
    for (const id of args)
      if (!nodes.has(id))
        throw new GraphUsageError("GRAPH_LINK_DANGLING", `${id} is not in the graph`);
  };
  const lines = [];
  switch (name) {
    case "ready": {
      need(0);
      const work = ["task", "track", "feature", "agent", "skill", "milestone", "gate"];
      const ready = [...nodes.values()].filter(
        (n) =>
          work.includes(n.type) &&
          n.status &&
          !isDone(n) &&
          n.status !== "Blocked" &&
          typedOut(graph, n.id, "depends_on").every((e) => isDone(nodes.get(e.to))) &&
          typedOut(graph, n.id, "waits_on").every((e) => isDone(nodes.get(e.to))),
      );
      for (const type of work) {
        const group = ready.filter((n) => n.type === type);
        if (group.length)
          lines.push(`${type} (${group.length})`, ...group.map((n) => `  ${line(n)}`));
      }
      if (!lines.length) lines.push("Nothing is ready.");
      break;
    }
    case "open": {
      need(0);
      const questions = [...nodes.values()].filter(
        (n) => n.type === "question" && n.status === "open",
      );
      lines.push(`Open questions (${questions.length})`);
      for (const q of questions)
        lines.push(
          `  ${line(q, `  [${q.fields.kind ?? "?"}, asked of ${q.fields.asked_of ?? "?"}]`)}`,
        );
      const gates = openGates(graph);
      lines.push(`Open gates (${gates.length})`, ...gates.map((g) => `  ${gateLine(graph, g)}`));
      const unknown = [...nodes.values()].filter(
        (n) => n.type === "evidence" && n.fields.unknown_outcome === "open",
      );
      lines.push(`Unknown outcomes (${unknown.length})`, ...unknown.map((n) => `  ${line(n)}`));
      const cards = [...nodes.values()].filter((n) => n.type === "card");
      const expiring = cards.filter(
        (c) =>
          c.fields.expires_on &&
          dayNumber(c.fields.expires_on) - dayNumber(graph.today) <=
            schema.CARD_EXPIRY_WARNING_DAYS,
      );
      lines.push(
        `Cards expiring within ${schema.CARD_EXPIRY_WARNING_DAYS} days (${expiring.length})`,
      );
      for (const c of expiring) lines.push(`  ${line(c, `  expires ${c.fields.expires_on}`)}`);
      for (const c of cards.filter((x) => !expiring.includes(x)))
        lines.push(`  (${c.id} ${c.status ?? ""}, expires ${c.fields.expires_on ?? "?"})`);
      const risks = [...nodes.values()].filter((n) => n.type === "risk" && n.status === "open");
      lines.push(`Open risks (${risks.length})`, ...risks.map((r) => `  ${line(r)}`));
      const basis = supersededBasis(graph);
      lines.push(`ADRs resting on a superseded decision (${basis.length})`);
      for (const f of basis)
        lines.push(
          `  warn GRAPH_WARN_SUPERSEDED_BASIS ${f.adr} approved_by ${f.decision}, superseded by ${f.successors.join(", ")}`,
          ...(f.citedBy.length ? [`       still cited by ${f.citedBy.join(", ")}`] : []),
        );
      break;
    }
    case "gates": {
      need(0);
      const week = flags.get("week");
      // A gate due before an event (due_when) has no week, so every week's list shows it.
      const gates = openGates(graph).filter(
        (g) => !week || !g.fields.due_week || weekNumber(g.fields.due_week) <= weekNumber(week),
      );
      lines.push(...(gates.length ? gates.map((g) => gateLine(graph, g)) : ["No open gates."]));
      for (const f of supersededBasis(graph))
        lines.push(
          `warn ${f.adr} approved_by ${f.decision}, superseded by ${f.successors.join(", ")}`,
        );
      break;
    }
    case "critical": {
      need(0);
      if (!nodes.has("GATE-launch")) {
        lines.push("No GATE-launch node yet: phase 1 adds the MVP's tracks and gates.");
        break;
      }
      const memo = new Map();
      const longest = (id, seen = new Set()) => {
        if (memo.has(id)) return memo.get(id);
        if (seen.has(id)) return [id];
        seen.add(id);
        let best = [];
        for (const e of [
          ...typedOut(graph, id, "depends_on"),
          ...typedOut(graph, id, "waits_on"),
        ]) {
          const chain = longest(e.to, seen);
          if (chain.length > best.length) best = chain;
        }
        seen.delete(id);
        const result = [id, ...best];
        memo.set(id, result);
        return result;
      };
      const chain = longest("GATE-launch").reverse();
      lines.push(`Critical chain to GATE-launch (${chain.length} nodes):`);
      for (const id of chain) lines.push(`  ${line(nodes.get(id))}`);
      break;
    }
    case "slip": {
      need(0);
      const ranked = [...nodes.values()]
        .filter(
          (n) =>
            ["agent", "feature"].includes(n.type) && !schema.INACTIVE_STATUSES.includes(n.status),
        )
        .sort(
          (a, b) =>
            (a.fields.slip_rank ?? "9").localeCompare(b.fields.slip_rank ?? "9") ||
            a.id.localeCompare(b.id),
        );
      for (const n of ranked) lines.push(`${(n.fields.slip_rank ?? "-").padEnd(3)}${line(n)}`);
      if (!ranked.length) lines.push("No agents or features yet: phase 1 adds them.");
      break;
    }
    case "data": {
      need(0);
      const classes = [...nodes.values()].filter((n) => n.type === "data_class");
      for (const n of classes) {
        const holders = typedIn(graph, n.id, "holds").map((e) => e.from);
        const deletion = typedOut(graph, n.id, "deleted_by").map((e) => e.to);
        lines.push(
          line(n),
          `    deletion: ${n.fields.deletion ?? "-"} (deleted_by ${deletion.join(", ") || "none"})`,
          `    retention: ${n.fields.retention ?? "-"}; customer: ${n.fields.customer ?? "-"}; held by ${holders.join(", ") || "none"}`,
        );
      }
      if (!classes.length) lines.push("No data classes yet: phase 1 adds them.");
      break;
    }
    case "skills": {
      need(1);
      for (const e of [
        ...typedOut(graph, args[0], "bundles"),
        ...typedOut(graph, args[0], "composes"),
      ]) {
        const skill = nodes.get(e.to);
        const held = typedOut(graph, e.to, "holds").map((h) => h.to);
        lines.push(
          `${e.edge.padEnd(9)} ${line(skill, `  runtime ${skill.fields.runtime ?? "-"}; card_eligible ${skill.fields.card_eligible ?? "-"}; holds ${held.join(", ") || "none"}`)}`,
        );
      }
      if (!lines.length) lines.push(`${args[0]} bundles or composes no skill.`);
      break;
    }
    case "ceiling": {
      need(1);
      const kinds = [args[0], ...typedOut(graph, args[0], "installs_as").map((e) => e.to)];
      for (const id of kinds)
        for (const edge of ["may_hold", "never_holds"])
          for (const e of typedOut(graph, id, edge))
            lines.push(`${id.padEnd(22)} ${edge.padEnd(12)} ${e.to}`);
      if (!lines.length)
        lines.push(`${args[0]} documents no ceiling. The code's allowlist stays the authority.`);
      break;
    }
    case "uncovered": {
      need(0);
      const tasks = uncoveredTasks(graph);
      for (const t of tasks)
        lines.push(
          `warn ${t.id.padEnd(9)} ${short(t.title ?? "", 60).padEnd(60)} no feature or track includes or defers it`,
        );
      if (!tasks.length) lines.push("Every plan task is included or deferred by name.");
      break;
    }
    case "blockers": {
      need(1);
      const seen = new Set([args[0]]);
      const queue = [[args[0], 0]];
      while (queue.length) {
        const [id, depth] = queue.shift();
        for (const e of [
          ...typedOut(graph, id, "depends_on"),
          ...typedOut(graph, id, "waits_on"),
          ...typedOut(graph, id, "part_of"),
        ]) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          const target = nodes.get(e.to);
          if (e.edge !== "part_of" && !isDone(target))
            lines.push(`${"  ".repeat(depth)}${e.edge} ${line(target)}`);
          queue.push([e.to, depth + 1]);
        }
      }
      if (!lines.length) lines.push(`Nothing blocks ${args[0]}.`);
      break;
    }
    case "impact": {
      need(1);
      const seen = new Set([args[0]]);
      const queue = [[args[0], 1]];
      while (queue.length) {
        const [id, depth] = queue.shift();
        if (depth > 3) continue;
        for (const e of typedIn(graph, id)) {
          if (seen.has(e.from)) continue;
          seen.add(e.from);
          lines.push(
            `${"  ".repeat(depth - 1)}${e.from} ${e.edge} ${id}  ${short(nodes.get(e.from)?.title ?? "", 60)}`,
          );
          queue.push([e.from, depth + 1]);
        }
      }
      const cited = (graph.in.get(args[0]) ?? [])
        .filter((e) => e.edge === "mentions")
        .map((e) => e.from);
      lines.push(`Mentioned by ${cited.length}: ${cited.sort().join(", ") || "none"}`);
      break;
    }
    case "why": {
      need(1);
      const seen = new Set();
      const walk = (id, depth) => {
        for (const e of typedOut(graph, id))
          if (
            [
              "governed_by",
              "approved_by",
              "supersedes",
              "amends",
              "refines",
              "authorized_by",
              "answers",
              "answered_by",
            ].includes(e.edge) &&
            !seen.has(`${id}>${e.to}`)
          ) {
            seen.add(`${id}>${e.to}`);
            lines.push(
              `${"  ".repeat(depth)}${id} ${e.edge} ${e.to}  ${short(nodes.get(e.to)?.title ?? "", 60)}`,
            );
            if (depth < 4) walk(e.to, depth + 1);
          }
        for (const e of typedIn(graph, id, "supersedes"))
          if (!seen.has(`${e.from}>${id}`)) {
            seen.add(`${e.from}>${id}`);
            lines.push(
              `${"  ".repeat(depth)}${id} superseded by ${e.from}  ${short(nodes.get(e.from)?.title ?? "", 60)}`,
            );
          }
      };
      walk(args[0], 0);
      if (!lines.length) lines.push(`No ADR or decision governs ${args[0]} in the graph yet.`);
      break;
    }
    case "path": {
      need(2);
      const find = (withMentions) => {
        const previous = new Map([[args[0], null]]);
        const queue = [args[0]];
        while (queue.length) {
          const id = queue.shift();
          if (id === args[1]) break;
          for (const e of [...(graph.out.get(id) ?? []), ...(graph.in.get(id) ?? [])]) {
            if (e.edge === "mentions" && !withMentions) continue;
            const next = e.from === id ? e.to : e.from;
            if (!previous.has(next)) {
              previous.set(next, [id, e]);
              queue.push(next);
            }
          }
        }
        if (!previous.has(args[1])) return null;
        const steps = [];
        for (let id = args[1]; previous.get(id); id = previous.get(id)[0])
          steps.unshift(previous.get(id)[1]);
        return steps;
      };
      const steps = find(false) ?? find(true);
      if (!steps) lines.push(`No path between ${args[0]} and ${args[1]}.`);
      else for (const e of steps) lines.push(`${e.from} ${e.edge} ${e.to}`);
      break;
    }
    case "stale": {
      need(0);
      const days = Number(flags.get("days") ?? 7);
      const since = new Date((dayNumber(graph.today) - days) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const n of nodes.values()) {
        const active =
          (n.type === "task" && ["In progress", "In review"].includes(n.status)) ||
          (["track", "feature", "milestone"].includes(n.type) && n.status === "active");
        if (active && !activity(graph, n.id, since))
          lines.push(line(n, `  no PR or evidence since ${since}`));
      }
      if (!lines.length) lines.push(`Every active node has a PR or evidence since ${since}.`);
      break;
    }
    case "todo": {
      need(0);
      for (const dir of GOVERNED.filter((d) => d !== "docs/graph/")) {
        const missing = [...graph.src.files.keys()]
          .filter(
            (p) => p.startsWith(dir) && !p.endsWith("/README.md") && !graph.headers.get(p)?.data,
          )
          .sort();
        if (missing.length)
          lines.push(
            `${dir} (${missing.length} without a header): ${missing.map((p) => posix.basename(p, ".md")).join(", ")}`,
          );
      }
      if (!lines.length) lines.push("Every governed doc has a header.");
      break;
    }
    default:
      throw usage(`unknown query ${JSON.stringify(name)}`);
  }
  return lines.join("\n");
}

function openGates(graph) {
  return [...graph.nodes.values()]
    .filter((n) => n.type === "gate" && n.status === "open")
    .sort(
      (a, b) =>
        weekNumber(a.fields.due_week) - weekNumber(b.fields.due_week) ||
        (a.label ?? "").localeCompare(b.label ?? "", "en", { numeric: true }),
    );
}

function gateLine(graph, gate) {
  const blocks = typedIn(graph, gate.id, "waits_on").map((e) => e.from);
  const tail = [
    !gate.fields.due_week && gate.fields.due_when ? `due ${gate.fields.due_when}` : "",
    blocks.length ? `blocks ${blocks.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `${(gate.label ?? "-").padEnd(5)}${gate.id.padEnd(34)}${(gate.fields.owner_kind ?? "-").padEnd(10)}${(gate.fields.due_week ?? "-").padEnd(5)}${tail}`;
}

// ---------------------------------------------------------------------------------------
// show and status

export function show(graph, id, { depth = 1, json = false, all = false } = {}) {
  const node = graph.nodes.get(id);
  if (!node) throw new GraphUsageError("GRAPH_LINK_DANGLING", `${id} is not in the graph`);
  const out = graph.out.get(id) ?? [];
  const into = graph.in.get(id) ?? [];
  const neighbours = [...neighbourhood(graph, id, depth)].filter(([x]) => x !== id);
  if (json)
    return JSON.stringify(
      {
        node: {
          id: node.id,
          type: node.type,
          title: node.title,
          status: node.status,
          label: node.label,
          fields: node.fields,
          doc: node.doc,
          docs: node.docs,
          header: node.header,
        },
        out: out.map(({ edge, to, origin }) => ({ edge, to, origin })),
        in: into.map(({ edge, from, origin }) => ({ edge, from, origin })),
        neighbourhood: neighbours.map(([x, d]) => ({
          id: x,
          distance: d,
          type: graph.nodes.get(x)?.type,
          title: graph.nodes.get(x)?.title,
        })),
      },
      null,
      2,
    );
  const title = (x) => short(graph.nodes.get(x)?.title ?? "", 70);
  const lines = [`${node.id}  ${node.type}  ${node.title ?? ""}`];
  // A track's, gate's or milestone's label is also one of its fields; it is shown once.
  const facts = [
    ["status", node.status],
    ["label", node.label],
    ...Object.entries(node.fields).filter(([k]) => k !== "label"),
  ].filter(([, v]) => v !== null && v !== undefined);
  for (const [k, v] of facts) lines.push(`  ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  if (node.doc) lines.push(`  doc: ${node.doc}${node.header ? "" : " (no header yet)"}`);
  if (node.docs.length) lines.push(`  docs: ${node.docs.join(", ")}`);
  const typedOutEdges = out.filter((e) => e.edge !== "mentions");
  lines.push(
    "out:",
    ...(typedOutEdges.length
      ? typedOutEdges.map((e) => `  ${e.edge.padEnd(14)}${e.to.padEnd(30)}${title(e.to)}`)
      : ["  none"]),
  );
  const children = into.filter((e) => e.edge === "part_of");
  const typedInEdges = into.filter((e) => e.edge !== "mentions" && e.edge !== "part_of");
  lines.push(
    "in:",
    ...(typedInEdges.length
      ? typedInEdges.map((e) => `  ${e.edge.padEnd(14)}${e.from.padEnd(30)}${title(e.from)}`)
      : ["  none"]),
  );
  if (children.length) {
    lines.push(`parts (${children.length}):`);
    for (const e of children) {
      const part = graph.nodes.get(e.from);
      // An open or deferred acceptance row only cites its records; it is never "verified".
      const facts = [
        ...(part?.type === "acceptance" && part.status ? [part.status] : []),
        ...(graph.in.get(e.from) ?? [])
          .filter((x) => x.edge === "verifies" || x.edge === "implements")
          .map((x) => `${x.edge === "verifies" ? "verified" : "implemented"} by ${x.from}`),
        ...(graph.out.get(e.from) ?? [])
          .filter((x) => x.edge === "mentions" && graph.nodes.get(x.to)?.type === "evidence")
          .map((x) => `cites ${x.to}`),
      ];
      lines.push(
        `  ${e.from.padEnd(18)}${short(part?.title ?? "", 50).padEnd(52)}${facts.join("; ")}`.trimEnd(),
      );
    }
  }
  const mentionsOut = out.filter((e) => e.edge === "mentions").map((e) => e.to);
  const mentionsIn = into.filter((e) => e.edge === "mentions").map((e) => e.from);
  const list = (ids) =>
    all || ids.length <= 12
      ? ids.join(", ")
      : `${ids.slice(0, 12).join(", ")}, … (+${ids.length - 12}; --all lists them)`;
  lines.push(`mentions ${mentionsOut.length}: ${list(mentionsOut) || "none"}`);
  lines.push(`mentioned by ${mentionsIn.length}: ${list(mentionsIn) || "none"}`);
  if (depth > 1) {
    lines.push(`neighbourhood to depth ${depth} (typed edges):`);
    for (const [x, d] of neighbours.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])))
      lines.push(`  ${d} ${x.padEnd(30)}${title(x)}`);
  }
  const findings = graph.issues.filter(
    (i) => i.where === id || i.where === node.doc || i.where === node.headerPath,
  );
  for (const f of findings)
    lines.push(`${f.severity === "error" ? "error" : "warn"} ${f.code} ${f.message}`);
  return lines.join("\n");
}

export function liveStatus(graph) {
  const { nodes, today } = graph;
  const lines = [
    `Live status from the graph, ${today}${graph.history.head ? `, at ${graph.history.head.slice(0, 7)}` : ""}.`,
    "",
  ];
  const prs = [...nodes.values()].filter((n) => n.type === "pr" && n.status === "merged");
  prs.sort((a, b) => Number(b.id.slice(3)) - Number(a.id.slice(3)));
  lines.push("### Last merged", "");
  for (const pr of prs.slice(0, 5))
    lines.push(
      `- ${pr.id} (\`${pr.fields.commit.slice(0, 7)}\`, ${pr.fields.date}): ${short(pr.title, 110)}`,
    );
  if (!prs.length) lines.push("- No history read.");
  const questions = [...nodes.values()].filter((n) => n.type === "question" && n.status === "open");
  lines.push("", "### Open questions and actions", "");
  for (const q of questions)
    lines.push(`- ${q.id} (${q.fields.kind}, ${q.fields.asked_of}): ${q.title}`);
  if (!questions.length) lines.push("- None.");
  const gates = openGates(graph);
  lines.push("", "### Open gates", "");
  for (const g of gates)
    lines.push(
      `- ${g.label ?? ""} ${g.id} (${g.fields.owner_kind ?? "?"}, ${g.fields.due_week ?? g.fields.due_when ?? "?"}): ${g.title}`,
    );
  if (!gates.length) lines.push("- None in the graph yet.");
  lines.push("", "### Unknown outcomes", "");
  const unknown = [...nodes.values()].filter(
    (n) => n.type === "evidence" && n.fields.unknown_outcome === "open",
  );
  for (const n of unknown) lines.push(`- ${n.id}: ${n.title}`);
  if (!unknown.length) lines.push("- None open.");
  lines.push("", "### Approval cards", "");
  for (const c of [...nodes.values()].filter((n) => n.type === "card"))
    lines.push(
      `- ${c.id} (${c.status}): approved on ${c.fields.approved_on ?? "?"}, valid until ${c.fields.expires_on ?? "?"}`,
    );
  const since = new Date((dayNumber(today) - 7) * 86_400_000).toISOString().slice(0, 10);
  const decisions = [...nodes.values()]
    .filter((n) => n.type === "decision" && (n.fields.date ?? "") >= since)
    .sort((a, b) => a.id.localeCompare(b.id));
  lines.push("", `### Decisions since ${since}`, "");
  for (const d of decisions) lines.push(`- ${d.id}: ${d.title}`);
  if (!decisions.length) lines.push("- None.");
  const basis = supersededBasis(graph);
  if (basis.length) {
    lines.push("", "### Warnings", "");
    for (const f of basis)
      lines.push(`- ${f.adr} rests on ${f.decision}, superseded by ${f.successors.join(", ")}.`);
  }
  return lines;
}

// Where STATUS.md disagrees with history: its stated head, merged PRs it never names, and
// merged PRs it still lists as in progress.
export function statusDrift(graph) {
  const status = graph.src.files.get("docs/progress/STATUS.md");
  if (status === undefined || !graph.history.available) return [];
  const prs = [...graph.nodes.values()]
    .filter((n) => n.type === "pr" && n.status === "merged")
    .sort((a, b) => Number(b.id.slice(3)) - Number(a.id.slice(3)));
  const findings = [];
  const claimed = /`main` is at `([0-9a-f]{7,40})`/.exec(status)?.[1];
  const latest = graph.history.commits.find((c) => c.firstParent && pullRequestOf(c));
  if (claimed && latest && !latest.sha.startsWith(claimed)) {
    const pr = prs.find((p) => latest.sha.startsWith(p.fields.commit));
    findings.push(
      `STATUS.md says \`main\` is at \`${claimed}\`; the latest merged PR is ${pr?.id ?? "?"} at \`${latest.sha.slice(0, 7)}\` (${latest.date}).`,
    );
  }
  const named = new Set([...status.matchAll(/#(\d+)\b/g)].map((m) => `PR-${m[1]}`));
  for (const [, a, b] of status.matchAll(/#(\d+)\s*[–-]\s*#?(\d+)\b/g))
    for (let n = Number(a); n <= Number(b) && n - Number(a) < 500; n += 1) named.add(`PR-${n}`);
  const unnamed = prs.filter((p) => !named.has(p.id)).map((p) => p.id);
  if (unnamed.length) findings.push(`STATUS.md never names merged ${unnamed.join(", ")}.`);
  const inProgress = /^In progress:\n((?:- .*\n?)+)/m.exec(status)?.[1] ?? "";
  const listed = unique([...inProgress.matchAll(/#(\d+)\b/g)].map((m) => `PR-${m[1]}`)).filter(
    (id) => graph.nodes.get(id)?.status === "merged",
  );
  if (listed.length)
    findings.push(
      `STATUS.md lists ${listed.join(", ")} under "In progress", but ${listed.length === 1 ? "it is" : "they are"} merged.`,
    );
  const updated = /^Updated (\d{4}-\d{2}-\d{2})/m.exec(status)?.[1];
  const after = updated ? prs.filter((p) => p.fields.date > updated).map((p) => p.id) : [];
  if (after.length)
    findings.push(`Merged after STATUS.md's "Updated ${updated}": ${after.join(", ")}.`);
  return findings;
}

// ---------------------------------------------------------------------------------------
// Commands that write node files

function writeNode(root, path, data, body) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\n${serializeHeader(data)}---\n${body}`);
}

function collectProblems(data, path, mode) {
  const problems = [];
  validateHeader(data, path, mode, (code, where, message) => problems.push(`${code}: ${message}`));
  return problems;
}

function refuseIf(problems) {
  if (problems.length) throw new GraphUsageError(problems[0].split(":")[0], problems.join("; "));
}

function addCommand(graph, positional, flags) {
  const [type, id] = positional;
  const root = graph.src.root;
  let data;
  let body = "";
  if (type === "decision") {
    if (id !== undefined) throw usage("add decision picks the next OD-<date>-<n> itself");
    for (const key of flags.keys())
      if (!["date", "title", "quote-file", "by", "channel"].includes(key))
        throw usage(`add decision does not take --${key}`);
    const date = flags.get("date");
    if (!validDate(date)) throw usage("--date YYYY-MM-DD is required");
    if (!flags.get("title")) throw usage("--title is required");
    const quoteFile = flags.get("quote-file");
    if (!quoteFile) throw usage("--quote-file is required (it avoids shell quoting)");
    const quote = readFileSync(resolve(quoteFile), "utf8").replace(/\s+$/, "");
    if (!quote.trim() || quote.length > 20_000)
      throw usage("the quote file is empty or longer than 20,000 characters");
    const taken = [...graph.nodes.keys()]
      .filter((x) => x.startsWith(`OD-${date}-`))
      .map((x) => Number(x.slice(14)));
    data = {
      id: `OD-${date}-${Math.max(0, ...taken) + 1}`,
      type: "decision",
      title: flags.get("title"),
      status: "recorded",
      date,
      by: flags.get("by") ?? "owner",
      channel: flags.get("channel") ?? "chat",
    };
    body = `\n${quote
      .split("\n")
      .map((l) => (l.trim() ? `> ${l}` : ">"))
      .join("\n")}\n`;
  } else {
    const spec = NODE_TYPES[type];
    if (!spec?.dir)
      throw usage(
        `${JSON.stringify(type)} is not a hand-written type (${Object.keys(NODE_TYPES)
          .filter((t) => NODE_TYPES[t].dir)
          .join(", ")})`,
      );
    if (typeOfId(id) !== type)
      throw new GraphUsageError(
        "GRAPH_ID_SHAPE",
        `${JSON.stringify(id)} is not a ${type} id (${spec.shape})`,
      );
    if (graph.nodes.has(id))
      throw new GraphUsageError(
        "GRAPH_ID_DUPLICATE",
        `${id} already exists (${graph.nodes.get(id).origin})`,
      );
    if (!flags.get("title")) throw usage("--title is required");
    data = { id, type, title: flags.get("title"), status: flags.get("status") ?? spec.statuses[0] };
    for (const [key, value] of flags) {
      if (["title", "status"].includes(key)) continue;
      if (key === "label") data.label = value;
      else if (!(key in spec.fields)) throw usage(`--${key} is not a ${type} field`);
      else
        data[key] = ["list", "enum_list"].includes(spec.fields[key].kind)
          ? value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean)
          : value;
    }
  }
  const path = `docs/graph/${NODE_TYPES[data.type].dir}/${fileOfId(data.id)}.md`;
  refuseIf(collectProblems(data, path, "hand"));
  if (existsSync(join(root, path)))
    throw new GraphUsageError("GRAPH_ID_DUPLICATE", `${path} exists`);
  writeNode(root, path, data, body);
  return `${data.id} written to ${path}`;
}

function headerOf(graph, id) {
  const node = graph.nodes.get(id);
  if (!node) throw new GraphUsageError("GRAPH_LINK_DANGLING", `${id} is not in the graph`);
  if (!node.headerPath)
    throw usage(`${id} has no header to hold the change (phase 2 adds headers in place)`);
  const text = readFileSync(join(graph.src.root, node.headerPath), "utf8");
  const split = splitHeader(text);
  const parsed = split && !split.unterminated ? parseHeader(split.raw) : { error: "NO_HEADER" };
  if (parsed.error) throw new GraphUsageError("GRAPH_PARSE", `${node.headerPath}: ${parsed.error}`);
  return { node, data: parsed.data, body: split.body, path: node.headerPath };
}

function linkCommand(graph, [from, edge, to], remove) {
  const { data, body, path } = headerOf(graph, from);
  const links = isPlainObject(data.links) ? data.links : {};
  const targets = links[edge] ?? [];
  if (remove) {
    if (!targets.includes(to)) throw usage(`${from} has no ${edge} ${to} in its header`);
    links[edge] = targets.filter((t) => t !== to);
    if (!links[edge].length) delete links[edge];
  } else {
    if (targets.includes(to)) throw usage(`${from} already has ${edge} ${to}`);
    const problem = edgeProblem(graph.nodes, from, edge, to, graph.history.available);
    if (problem && problem[0] !== "PR_WITHOUT_HISTORY")
      throw new GraphUsageError(problem[0], problem[1]);
    links[edge] = [...targets, to];
  }
  if (Object.keys(links).length) data.links = links;
  else delete data.links;
  writeNode(graph.src.root, path, data, body);
  return `${from} ${remove ? "unlink" : "link"} ${edge} ${to} (${path})`;
}

function setCommand(graph, [id, ...pairs]) {
  if (!pairs.length) throw usage("set <ID> <field>=<value> ...");
  const changes = pairs.map((pair) => {
    const m = /^([a-z_]+)=(.+)$/s.exec(pair);
    if (!m) throw usage(`${JSON.stringify(pair)} is not <field>=<value>`);
    // An id or type change would move the node and strand its backlinks; links and docs
    // are lists that link, unlink and the node file hold.
    if (["id", "type", "links", "docs"].includes(m[1]))
      throw usage(`set does not change ${m[1]}${m[1] === "links" ? " (use link or unlink)" : ""}`);
    return [m[1], m[2]];
  });
  const node = graph.nodes.get(id);
  if (!node) throw new GraphUsageError("GRAPH_LINK_DANGLING", `${id} is not in the graph`);
  const root = graph.src.root;
  if (node.type === "task" && /^P\d{2}\.T\d{2}$/.test(id)) {
    if (changes.length !== 1 || changes[0][0] !== "status")
      throw usage("a parent task takes only status, kept in tasks.json");
    if (!TASK_STATUSES.includes(changes[0][1]))
      throw new GraphUsageError("GRAPH_STATUS", `${changes[0][1]} is not a task status`);
    const path = join(root, "docs/progress/tasks.json");
    const tasks = JSON.parse(readFileSync(path, "utf8"));
    const task = Array.isArray(tasks?.tasks) ? tasks.tasks.find((t) => t?.id === id) : undefined;
    if (!task) throw new GraphUsageError("GRAPH_TASK_STATUS_DRIFT", `${id} is not in tasks.json`);
    task.status = changes[0][1];
    writeFileSync(path, JSON.stringify(tasks, null, 2) + "\n");
    return `${id} status ${changes[0][1]} (docs/progress/tasks.json)`;
  }
  let target;
  if (node.headerPath) target = headerOf(graph, id);
  else if (node.type === "task" && node.doc)
    target = {
      data: { id, type: "task" },
      body: readFileSync(join(root, node.doc), "utf8"),
      path: node.doc,
    };
  else throw usage(`${id} has no header to hold the change (phase 2 adds headers in place)`);
  for (const [key, value] of changes) {
    const rule = NODE_TYPES[node.type].fields[key];
    target.data[key] =
      rule && ["list", "enum_list"].includes(rule.kind)
        ? value.split(",").map((v) => v.trim())
        : value;
  }
  refuseIf(
    collectProblems(
      target.data,
      target.path,
      node.headerPath?.startsWith("docs/graph/") ? "hand" : "inplace",
    ),
  );
  writeNode(root, target.path, target.data, target.body);
  return `${id} ${changes.map(([k, v]) => `${k}=${v}`).join(" ")} (${target.path})`;
}

// ---------------------------------------------------------------------------------------
// The command line

const COMMANDS = {
  check: { flags: { strict: 0, verbose: 0 }, positional: [0, 0] },
  show: { flags: { depth: 1, json: 0, all: 0 }, positional: [1, 1] },
  query: { flags: { week: 1, days: 1 }, positional: [1, 3] },
  render: { flags: { check: 0 }, positional: [0, 0] },
  view: { flags: { mermaid: 0, depth: 1 }, positional: [1, 1] },
  status: { flags: { write: 0 }, positional: [0, 0] },
  add: { flags: null, positional: [1, 2] },
  link: { flags: {}, positional: [3, 3] },
  unlink: { flags: {}, positional: [3, 3] },
  set: { flags: {}, positional: [2, 21] },
};
const GLOBAL_FLAGS = { root: 1, today: 1 };

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec)
    throw usage(
      `unknown command ${JSON.stringify(command ?? "")}; one of ${Object.keys(COMMANDS).join(", ")}`,
    );
  const flags = new Map();
  const globals = new Map();
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const flag = /^--([a-z][a-z_-]*)(?:=(.*))?$/s.exec(arg);
    if (!flag) {
      positional.push(arg);
      continue;
    }
    const [, name, inline] = flag;
    const arity =
      name in GLOBAL_FLAGS ? GLOBAL_FLAGS[name] : spec.flags === null ? 1 : spec.flags[name];
    if (arity === undefined) throw usage(`${command} does not take --${name}`);
    const target = name in GLOBAL_FLAGS ? globals : flags;
    if (target.has(name)) throw usage(`--${name} is given twice`);
    if (arity === 0) {
      if (inline !== undefined) throw usage(`--${name} takes no value`);
      target.set(name, true);
    } else {
      const value = inline ?? rest[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--")))
        throw usage(`--${name} needs a value`);
      target.set(name, value);
    }
  }
  const [min, max] = spec.positional;
  if (positional.length < min || positional.length > max)
    throw usage(`${command} takes ${min === max ? min : `${min} to ${max}`} argument(s)`);
  if (flags.has("depth") && !/^[1-5]$/.test(flags.get("depth"))) throw usage("--depth is 1 to 5");
  if (flags.has("days") && !/^[1-9]\d{0,2}$/.test(flags.get("days")))
    throw usage("--days is 1 to 999");
  if (flags.has("week") && !/^W\d{1,2}$/.test(flags.get("week"))) throw usage("--week is W<n>");
  if (globals.has("today") && !validDate(globals.get("today")))
    throw usage("--today is YYYY-MM-DD");
  if (
    globals.has("root") &&
    !(existsSync(globals.get("root")) && statSync(globals.get("root")).isDirectory())
  )
    throw usage("--root is an existing directory");
  return { command, positional, flags, globals };
}

function printIssues(issues, verbose, write) {
  const groups = new Map();
  for (const issue of issues.filter((i) => i.severity === "warning"))
    groups.set(issue.code, [...(groups.get(issue.code) ?? []), issue]);
  for (const [code, group] of groups) {
    const shown = verbose ? group : group.slice(0, 3);
    write(
      `warn ${code} (${group.length})${shown.length < group.length ? ` first ${shown.length}; --verbose lists all` : ""}\n`,
    );
    for (const i of shown) write(`  ${i.where}: ${i.message}\n`);
  }
}

// Runs one command; returns its exit code. `io.out` and `io.err` receive text.
export function run(
  argv,
  io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) },
) {
  const started = performance.now();
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof GraphUsageError)) throw error;
    io.err(`${error.message}\n`);
    return 2;
  }
  const { command, positional, flags, globals } = parsed;
  const root = resolve(globals.get("root") ?? repositoryRoot);
  const options = { today: globals.get("today") ?? isoToday(), strict: flags.has("strict") };
  try {
    const graph = buildGraph(readSources(root), options);
    const errors = graph.issues.filter((i) => i.severity === "error");
    switch (command) {
      case "check": {
        const seconds = ((performance.now() - started) / 1000).toFixed(2);
        const typedCount = graph.edges.filter((e) => e.edge !== "mentions").length;
        const warnings = graph.issues.length - errors.length;
        if (root === repositoryRoot)
          writeArtifact("graph/check.json", {
            generated_at: new Date().toISOString(),
            head: graph.history.head ?? null,
            nodes: graph.nodes.size,
            edges: graph.edges.length,
            issues: graph.issues,
          });
        printIssues(graph.issues, flags.has("verbose"), io.out);
        if (errors.length) {
          for (const e of errors) io.err(`error ${e.code} ${e.where}: ${e.message}\n`);
          io.err(
            `FAIL: graph check, ${errors.length} error(s) in ${new Set(errors.map((e) => e.code)).size} code(s), ${warnings} warning(s), ${seconds} s.\n`,
          );
          return 1;
        }
        io.out(
          `PASS: graph check, ${graph.nodes.size} nodes, ${graph.edges.length} edges (${typedCount} typed), 0 errors, ${warnings} warnings, ${seconds} s.\n`,
        );
        return 0;
      }
      case "show":
        io.out(
          `${show(graph, positional[0], { depth: Number(flags.get("depth") ?? 1), json: flags.has("json"), all: flags.has("all") })}\n`,
        );
        return 0;
      case "query":
        io.out(`${query(graph, positional[0], positional.slice(1), flags)}\n`);
        return 0;
      case "view":
        if (!flags.has("mermaid")) throw usage("view needs --mermaid");
        if (!graph.nodes.has(positional[0]))
          throw new GraphUsageError("GRAPH_LINK_DANGLING", `${positional[0]} is not in the graph`);
        io.out(`${mermaid(graph, positional[0], Number(flags.get("depth") ?? 1))}\n`);
        return 0;
      case "render":
        return render(graph, flags.has("check"), io);
      case "status": {
        const lines = liveStatus(graph);
        if (flags.has("write")) {
          const path = join(root, "docs/progress/STATUS.md");
          const text = existsSync(path) ? readFileSync(path, "utf8") : "";
          const next = replaceBlock(text, "status", lines.join("\n"));
          if (next === null)
            throw new GraphUsageError(
              "GRAPH_STATUS_MARKERS",
              "STATUS.md has no <!-- graph:status:start --> and <!-- graph:status:end --> markers yet (phase 3 adds them)",
            );
          if (next.replace(/\n$/, "").split("\n").length > schema.STATUS_MAX_LINES)
            throw new GraphUsageError(
              "GRAPH_STATUS_LINES",
              "the written STATUS.md would exceed 80 lines",
            );
          writeFileSync(path, next);
          io.out("STATUS.md fact block written.\n");
          return 0;
        }
        const drift = statusDrift(graph);
        io.out(
          `${[...lines, ...(drift.length ? ["", "### STATUS.md drift", "", ...drift.map((d) => `- ${d}`)] : [])].join("\n")}\n`,
        );
        return 0;
      }
      case "add":
        io.out(`${addCommand(graph, positional, flags)}\n`);
        return 0;
      case "link":
      case "unlink":
        io.out(`${linkCommand(graph, positional, command === "unlink")}\n`);
        return 0;
      case "set":
        io.out(`${setCommand(graph, positional)}\n`);
        return 0;
      default:
        throw usage(command);
    }
  } catch (error) {
    if (!(error instanceof GraphUsageError)) throw error;
    io.err(`${error.message}\n`);
    return 2;
  }
}

function render(graph, check, io) {
  const root = graph.src.root;
  const stale = [];
  for (const [path, name, content] of [
    ["docs/graph/README.md", "schema", renderSchemaBlock()],
    ["docs/decisions/adr/README.md", "adr-index", renderAdrIndex(graph)],
  ]) {
    const text = graph.src.files.get(path);
    const next = text === undefined ? null : replaceBlock(text, name, content);
    if (next === null || next === text) continue;
    if (check) stale.push(path);
    else {
      writeFileSync(join(root, path), next);
      io.out(`updated ${path}\n`);
    }
  }
  if (check) {
    if (stale.length) {
      io.err(`GRAPH_STALE_GENERATED: ${stale.join(", ")}; run npm run graph -- render\n`);
      return 1;
    }
    io.out("Generated blocks are fresh.\n");
    return 0;
  }
  const data = graphJson(graph);
  const jsonPath = writeArtifact("graph/graph.json", data);
  const htmlPath = writeArtifact("graph/graph.html", renderHtml(data));
  io.out(
    `wrote ${jsonPath} (${data.nodes.length} nodes, ${data.edges.length} edges)\nwrote ${htmlPath}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = run(process.argv.slice(2));
