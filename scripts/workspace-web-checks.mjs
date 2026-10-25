// `npm run verify:workspace-web` (P14.T01a §4.11 b, AC13, AC19), run after `build`.
// The production dist must hold no fixture page or canary, no absolute URL outside an
// exact allowlist, no inline script or style, no Vite manifest, and an entry script of
// at most 150 KB gzip. The Vite module report (written outside dist) must list no
// fixture, axe-core, Playwright or runtime-validator module, and must describe this dist.
// Each JS entry of @morrow/workspace-ui is also bundled for the browser on its own and
// held to the same module denials (P05.T01y: the session keeper, before P14.T01a wires it).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
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
  // The validator table, directly or through the modules that import it. The generated
  // per-definition modules (`packages/contracts/src/generated/validators/`) are allowed.
  ["runtime_validators", /runtime-validators/],
  ["validator_table_entry", /(^|\/)packages\/contracts\/src\/(validation|client)\.ts$/],
];
const urlPattern = /https?:\/\/[^\s"'`)<>\\]+/g;
// v1 PR 4: the screens that load as their own chunk (packages/workspace-ui/src/screens/
// lazy.tsx) and keep the entry within its budget. A static import that pulls one into an
// entry chunk is named here rather than surfacing later as an entry over its size.
export const lazyModules = Object.freeze([
  "packages/workspace-ui/src/screens/review.tsx",
  "packages/workspace-ui/src/screens/ask.tsx",
  "packages/workspace-ui/src/screens/product-picker.tsx",
]);

/** The web build's module report: each lazy screen is bundled, and never into an entry. */
export function inspectLazyChunks(report) {
  const chunks = Array.isArray(report?.chunks) ? report.chunks : [];
  const problems = [];
  for (const id of lazyModules) {
    const holders = chunks.filter((c) => Array.isArray(c.moduleIds) && c.moduleIds.includes(id));
    if (holders.length === 0) problems.push("MODULE_LAZY_MISSING:" + id);
    else if (holders.some((c) => c.isEntry === true)) problems.push("MODULE_LAZY_IN_ENTRY:" + id);
  }
  return problems;
}

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

// With its per-definition validator the keeper is about 3 KB gzip; with the validator
// table it was 147 KB.
export const sessionKeeperGzipLimit = 16 * 1024;
const sessionKeeperEntry = "@morrow/workspace-ui/session-keeper";

/** Bundles each JS entry of @morrow/workspace-ui for the browser, as the web build would. */
export async function probeUiEntries({ root = repositoryRoot } = {}) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "packages/workspace-ui/package.json"), "utf8"),
  );
  const entries = [],
    problems = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (!/\.tsx?$/.test(target)) continue;
    const entry = "@morrow/workspace-ui" + subpath.slice(1);
    const result = await build({
      entryPoints: [resolve(root, "packages/workspace-ui", target)],
      absWorkingDir: root,
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      minify: true,
      legalComments: "none",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const text = result.outputFiles[0].contents;
    const modules = Object.keys(result.metafile.inputs).sort();
    const gzipBytes = gzipSync(text).length;
    for (const problem of inspectModuleReport({
      chunks: [{ fileName: entry, isEntry: true, moduleIds: modules }],
    }))
      problems.push(`UI_ENTRY:${entry}:${problem}`);
    if (entry === sessionKeeperEntry && gzipBytes > sessionKeeperGzipLimit)
      problems.push(`UI_ENTRY_TOO_LARGE:${entry}:${gzipBytes}`);
    entries.push({ entry, bytes: text.length, gzip_bytes: gzipBytes, modules });
  }
  if (!entries.some((e) => e.entry === sessionKeeperEntry))
    problems.push("UI_ENTRY_MISSING:" + sessionKeeperEntry);
  return { entries, problems };
}

// Deliberate failures the UI entry probe must detect, through the probe itself: planted
// @morrow/workspace-ui roots (temporary, removed afterwards) whose entries import the
// validator table, outgrow the keeper's cap or drop the keeper entry. Each planted root
// must yield exactly the expected problems.
export async function uiEntryNegativeChecks() {
  const keeper = "@morrow/workspace-ui/session-keeper";
  const manifest = (exports) => JSON.stringify({ name: "@morrow/workspace-ui", exports });
  const both = manifest({
    ".": "./src/index.ts",
    "./session-keeper": "./src/session-keeper.ts",
    "./styles.css": "./src/styles.css",
  });
  const stubs = {
    "packages/workspace-ui/src/styles.css": "a{color:red}\n",
    "packages/contracts/src/validation.ts":
      "export const validateCurrentDefinition = (name: string, value: unknown) => name === String(value);\n",
    "packages/contracts/src/generated/runtime-validators.mjs":
      "export const validators = Object.freeze({ v0: (value) => value === 0 });\n",
    "packages/contracts/src/generated/validators/SessionRotationResult.mjs":
      "export const validateSessionRotationResult = (value) => value === 1;\n",
  };
  // Incompressible, deterministic: gzip keeps it well above the keeper's cap.
  const blob = Array.from({ length: 1000 }, (_, i) =>
    createHash("sha256").update(String(i)).digest("base64"),
  ).join("");
  const cases = [
    [
      "ui_entry_validator_table",
      {
        "packages/workspace-ui/package.json": both,
        "packages/workspace-ui/src/index.ts": "export const ready = true;\n",
        "packages/workspace-ui/src/session-keeper.ts":
          'export { validateCurrentDefinition } from "../../contracts/src/validation.ts";\n',
      },
      [
        `UI_ENTRY:${keeper}:MODULE_DENIED:validator_table_entry:packages/contracts/src/validation.ts`,
      ],
    ],
    [
      "ui_entry_table_module",
      {
        "packages/workspace-ui/package.json": both,
        "packages/workspace-ui/src/index.ts":
          'export { validators } from "../../contracts/src/generated/runtime-validators.mjs";\n',
        "packages/workspace-ui/src/session-keeper.ts":
          'export { validateSessionRotationResult } from "../../contracts/src/generated/validators/SessionRotationResult.mjs";\n',
      },
      [
        "UI_ENTRY:@morrow/workspace-ui:MODULE_DENIED:runtime_validators:packages/contracts/src/generated/runtime-validators.mjs",
      ],
    ],
    [
      "ui_entry_too_large",
      {
        "packages/workspace-ui/package.json": both,
        "packages/workspace-ui/src/index.ts": "export const ready = true;\n",
        "packages/workspace-ui/src/session-keeper.ts": `export const blob = ${JSON.stringify(blob)};\n`,
      },
      [/^UI_ENTRY_TOO_LARGE:@morrow\/workspace-ui\/session-keeper:[0-9]+$/],
    ],
    [
      "ui_entry_missing",
      {
        "packages/workspace-ui/package.json": manifest({ ".": "./src/index.ts" }),
        "packages/workspace-ui/src/index.ts": "export const ready = true;\n",
      },
      [`UI_ENTRY_MISSING:${keeper}`],
    ],
  ];
  const checks = [];
  for (const [name, files, expected] of cases) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-ui-entries-")));
    try {
      for (const [path, text] of Object.entries({ ...stubs, ...files })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const { problems } = await probeUiEntries({ root });
      const passed =
        problems.length === expected.length &&
        expected.every((want, i) =>
          typeof want === "string" ? problems[i] === want : want.test(problems[i]),
        );
      checks.push({ name, passed });
    } catch {
      checks.push({ name, passed: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return checks;
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
    const report = JSON.parse(readFileSync(modulesPath, "utf8"));
    problems.push(...inspectModuleReport(report, scripts), ...inspectLazyChunks(report));
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
      "validator_table_module",
      inspectModuleReport({
        chunks: [
          {
            ...report.chunks[0],
            moduleIds: ["packages/contracts/src/generated/runtime-validators.mjs"],
          },
        ],
      }).length === 1,
    ],
    [
      "validation_module",
      inspectModuleReport({
        chunks: [{ ...report.chunks[0], moduleIds: ["packages/contracts/src/validation.ts"] }],
      }).length === 1,
    ],
    [
      "browser_validator_allowed",
      inspectModuleReport({
        chunks: [
          {
            ...report.chunks[0],
            moduleIds: ["packages/contracts/src/generated/validators/SessionRotationResult.mjs"],
          },
        ],
      }).length === 0,
    ],
    [
      "lazy_screen_in_entry",
      (() => {
        const split = { fileName: "assets/lazy.js", isEntry: false, moduleIds: [...lazyModules] };
        const entry = report.chunks[0];
        const inEntry = { ...entry, moduleIds: [...entry.moduleIds, lazyModules[0]] };
        const missing = { ...split, moduleIds: lazyModules.slice(1) };
        return (
          inspectLazyChunks({ chunks: [entry, split] }).length === 0 &&
          inspectLazyChunks({ chunks: [inEntry, split] }).join() ===
            "MODULE_LAZY_IN_ENTRY:" + lazyModules[0] &&
          inspectLazyChunks({ chunks: [entry, missing] }).join() ===
            "MODULE_LAZY_MISSING:" + lazyModules[0]
        );
      })(),
    ],
    [
      "stale_report",
      inspectModuleReport(report, ["assets/main.js", "assets/other.js"]).length === 1,
    ],
  ].map(([name, passed]) => ({ name, passed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyWorkspaceDist();
  const ui = await probeUiEntries();
  const negatives = [...negativeChecks(), ...(await uiEntryNegativeChecks())];
  const failedNegatives = negatives
    .filter((n) => !n.passed)
    .map((n) => "NEGATIVE_NOT_DETECTED:" + n.name);
  const problems = [...result.problems, ...ui.problems, ...failedNegatives];
  writeArtifact("workspace-web/verify.json", {
    generated_at: new Date().toISOString(),
    scope:
      "Production dist of apps/workspace-web: fixture isolation, URL allowlist, inline code, manifest, entry size and module report (P14.T01a AC13, AC19); each @morrow/workspace-ui JS entry bundled alone by esbuild against the same module denials, and the session keeper's size (P05.T01y). Not a browser or accessibility check.",
    entry_gzip_bytes: result.entryGzipBytes,
    entry_gzip_limit: entryGzipLimit,
    files: result.files ?? 0,
    ui_entries: ui.entries,
    session_keeper_gzip_limit: sessionKeeperGzipLimit,
    negative_checks: negatives,
    problems,
  });
  if (problems.length) throw Error(problems.join("\n"));
  const keeper = ui.entries.find((e) => e.entry === sessionKeeperEntry);
  console.log(
    `PASS: workspace dist clean (${result.files} files, entry ${result.entryGzipBytes} B gzip, ${negatives.length} deliberate failures detected); ${ui.entries.length} UI entries clean, session keeper ${keeper.bytes} B (${keeper.gzip_bytes} B gzip).`,
  );
}
