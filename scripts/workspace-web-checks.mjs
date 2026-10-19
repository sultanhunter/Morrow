// `npm run verify:workspace-web` (P14.T01a §4.11 b, AC13, AC19), run after `build`.
// The production dist must hold no fixture page or canary, no absolute URL outside an
// exact allowlist, no inline script or style, no Vite manifest, and an entry script of
// at most 150 KB gzip. The Vite module report (written outside dist) must list no
// fixture, axe-core, Playwright or runtime-validator module, and must describe this dist.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { artifactPath, repositoryRoot, writeArtifact } from "./artifacts.mjs";

export const fixtureCanary = "MORROW_FIXTURE_BUILD_CANARY";
export const allowedUrls = Object.freeze([
  "https://api.workos.com/user_management/authorize",
  // P05.T01ab: the Turnstile script, explicit rendering only (the CSP allows its origin).
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/1998/Math/MathML",
  "https://reactjs.org/docs/error-decoder.html?invariant=",
]);
// The CSP sources `_headers` may name (P05.T01ab: the Turnstile script and frame origin);
// only `_headers`, and only as a CSP source, never in code.
export const allowedCspSources = Object.freeze(["https://challenges.cloudflare.com"]);
export const entryGzipLimit = 150 * 1024;
const deniedModules = [
  ["fixture", /(^|\/)apps\/workspace-web\/src\/fixtures\//],
  ["axe_core", /(^|\/)node_modules\/axe-core\//],
  ["playwright", /(^|\/)node_modules\/playwright(-core)?\//],
  ["runtime_validators", /runtime-validators/],
];
const urlPattern = /https?:\/\/[^\s"'`)<>\\]+/g;

/** `files`: [{path (relative to dist), text}]. Returns problem codes. */
export function inspectDistFiles(files) {
  const problems = [];
  for (const { path, text } of files) {
    const name = path.split("/").at(-1);
    if (name === "fixture.html") problems.push("DIST_FIXTURE_PAGE:" + path);
    if (/(^|\/)\.vite\//.test(path) || name === "manifest.json")
      problems.push("DIST_MANIFEST:" + path);
    if (text.includes(fixtureCanary)) problems.push("DIST_FIXTURE_CANARY:" + path);
    for (const [url] of text.matchAll(urlPattern))
      if (
        !allowedUrls.includes(url) &&
        !(path === "_headers" && allowedCspSources.includes(url.replace(/;$/, "")))
      )
        problems.push("DIST_UNLISTED_URL:" + path + ":" + url.slice(0, 120));
    if (name.endsWith(".html")) {
      for (const tag of text.matchAll(/<script\b[^>]*>/gi))
        if (!/\ssrc=/i.test(tag[0])) problems.push("DIST_INLINE_SCRIPT:" + path);
      if (/<style\b/i.test(text) || /\sstyle=/i.test(text))
        problems.push("DIST_INLINE_STYLE:" + path);
    }
  }
  return problems;
}

/** The Vite module report: denied modules, and agreement with the dist's scripts. */
export function inspectModuleReport(report, distScripts = null) {
  const problems = [];
  const chunks = Array.isArray(report?.chunks) ? report.chunks : null;
  if (!chunks || !chunks.some((c) => c.isEntry === true)) return ["MODULE_REPORT_INVALID"];
  for (const chunk of chunks)
    for (const id of Array.isArray(chunk.moduleIds) ? chunk.moduleIds : [])
      for (const [label, pattern] of deniedModules)
        if (pattern.test(String(id).replace(/^\0/, "")))
          problems.push(`MODULE_DENIED:${label}:${String(id).slice(0, 160)}`);
  if (distScripts) {
    const reported = new Set(chunks.map((c) => c.fileName));
    for (const script of distScripts)
      if (!reported.has(script)) problems.push("MODULE_REPORT_STALE:" + script);
    for (const name of reported)
      if (!distScripts.includes(name)) problems.push("MODULE_REPORT_STALE:" + name);
  }
  return problems;
}

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return files.sort();
}

export function verifyWorkspaceDist({
  dist = resolve(repositoryRoot, "apps/workspace-web/dist"),
  modulesPath = artifactPath("workspace-web/modules.json"),
} = {}) {
  const problems = [];
  if (!existsSync(join(dist, "index.html")))
    return { problems: ["DIST_MISSING"], entryGzipBytes: null };
  const names = listFiles(dist);
  const files = names.map((path) => ({ path, text: readFileSync(join(dist, path), "utf8") }));
  problems.push(...inspectDistFiles(files));
  const index = readFileSync(join(dist, "index.html"), "utf8");
  const entry = /<script\b[^>]*\bsrc="\/(assets\/[^"]+\.js)"/.exec(index)?.[1] ?? null;
  let entryGzipBytes = null;
  if (!entry || !existsSync(join(dist, entry))) problems.push("DIST_ENTRY_MISSING");
  else {
    entryGzipBytes = gzipSync(readFileSync(join(dist, entry))).length;
    if (entryGzipBytes > entryGzipLimit) problems.push("DIST_ENTRY_TOO_LARGE:" + entryGzipBytes);
  }
  if (!existsSync(modulesPath)) problems.push("MODULE_REPORT_MISSING");
  else {
    const scripts = names.filter((n) => n.endsWith(".js"));
    problems.push(...inspectModuleReport(JSON.parse(readFileSync(modulesPath, "utf8")), scripts));
  }
  return { problems, entryGzipBytes, files: names.length };
}

// Deliberate failures the checks must detect (AC13).
export function negativeChecks() {
  const base = [{ path: "assets/main.js", text: 'const ns="http://www.w3.org/2000/svg";' }];
  const report = {
    chunks: [
      { fileName: "assets/main.js", isEntry: true, moduleIds: ["apps/workspace-web/src/main.tsx"] },
    ],
  };
  return [
    [
      "clean_input_passes",
      inspectDistFiles(base).length === 0 && inspectModuleReport(report).length === 0,
    ],
    [
      "planted_canary",
      inspectDistFiles([{ path: "assets/x.js", text: `"${fixtureCanary}"` }]).length === 1,
    ],
    ["fixture_page", inspectDistFiles([{ path: "fixture.html", text: "" }]).length === 1],
    [
      "unlisted_url",
      inspectDistFiles([{ path: "assets/x.js", text: '"https://evil.example/x"' }]).length === 1,
    ],
    [
      "near_miss_url",
      inspectDistFiles([{ path: "assets/x.js", text: '"https://api.workos.com/other"' }]).length ===
        1,
    ],
    [
      "near_miss_turnstile_url",
      inspectDistFiles([
        { path: "assets/x.js", text: '"https://challenges.cloudflare.com/turnstile/v0/api.js"' },
      ]).length === 1 &&
        inspectDistFiles([
          {
            path: "assets/x.js",
            text: '"https://challenges.cloudflare.com/turnstile/v0/siteverify"',
          },
        ]).length === 1,
    ],
    [
      "csp_source_only_in_headers",
      inspectDistFiles([
        {
          path: "_headers",
          text: "script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com;",
        },
      ]).length === 0 &&
        inspectDistFiles([{ path: "_headers", text: "script-src https://evil.example;" }])
          .length === 1 &&
        inspectDistFiles([{ path: "assets/x.js", text: '"https://challenges.cloudflare.com"' }])
          .length === 1,
    ],
    [
      "inline_script",
      inspectDistFiles([{ path: "index.html", text: "<script>x()</script>" }]).length === 1,
    ],
    ["vite_manifest", inspectDistFiles([{ path: ".vite/manifest.json", text: "{}" }]).length === 1],
    [
      "fixture_module",
      inspectModuleReport({
        chunks: [
          { ...report.chunks[0], moduleIds: ["apps/workspace-web/src/fixtures/adapter.ts"] },
        ],
      }).length === 1,
    ],
    [
      "axe_module",
      inspectModuleReport({
        chunks: [{ ...report.chunks[0], moduleIds: ["node_modules/axe-core/axe.js"] }],
      }).length === 1,
    ],
    [
      "stale_report",
      inspectModuleReport(report, ["assets/main.js", "assets/other.js"]).length === 1,
    ],
  ].map(([name, passed]) => ({ name, passed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyWorkspaceDist();
  const negatives = negativeChecks();
  const failedNegatives = negatives
    .filter((n) => !n.passed)
    .map((n) => "NEGATIVE_NOT_DETECTED:" + n.name);
  const problems = [...result.problems, ...failedNegatives];
  writeArtifact("workspace-web/verify.json", {
    generated_at: new Date().toISOString(),
    scope:
      "Production dist of apps/workspace-web: fixture isolation, URL allowlist, inline code, manifest, entry size and module report (P14.T01a AC13, AC19). Not a browser or accessibility check.",
    entry_gzip_bytes: result.entryGzipBytes,
    entry_gzip_limit: entryGzipLimit,
    files: result.files ?? 0,
    negative_checks: negatives,
    problems,
  });
  if (problems.length) throw Error(problems.join("\n"));
  console.log(
    `PASS: workspace dist clean (${result.files} files, entry ${result.entryGzipBytes} B gzip, ${negatives.length} deliberate failures detected).`,
  );
}
