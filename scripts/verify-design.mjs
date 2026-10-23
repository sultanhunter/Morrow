import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { writeArtifact } from "./artifacts.mjs";
import { checkUiTokens, inspectColourLiterals, inspectBreakpoints } from "./generate-ui-tokens.mjs";
const read = (p) => readFileSync(p, "utf8");
const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const tokens = JSON.parse(read("docs/design/tokens.json"));
const linear = (h) => {
  const v = parseInt(h, 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (h) =>
  h
    .slice(1)
    .match(/../g)
    .map(linear)
    .reduce((n, x, i) => n + x * [0.2126, 0.7152, 0.0722][i], 0);
// ADR-0032 item 5: text pairs need 4.5:1, control edges and focus rings 3:1. A pair names
// two opaque (six-digit) colours; a token with its own alpha is never a contrast pair.
const opaque = (name) => /^#[0-9A-Fa-f]{6}$/.test(tokens.color[name] ?? "");
const contrasts = tokens.contrast_pairs.map(([foreground, background, minimum]) => {
  if (!opaque(foreground) || !opaque(background) || ![3, 4.5].includes(minimum))
    throw Error(`Contrast pair is not two opaque tokens with a floor of 3 or 4.5: ${foreground}/${background}`);
  const a = luminance(tokens.color[foreground]),
    b = luminance(tokens.color[background]);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  if (ratio < minimum) throw Error(`Insufficient contrast: ${foreground}/${background}: ${ratio}`);
  return { foreground, background, minimum, ratio };
});
const html = read("docs/design/prototype.html");
for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
if (/<script[^>]+src=|<link[^>]+href=["']https?:|\bfetch\s*\(/i.test(html))
  throw Error("Unexpected external prototype dependency");
const browser = JSON.parse(read("docs/design/browser-checks.json"));
if (
  browser.checks.length !== 54 ||
  browser.checks.some((x) => x.passed !== true) ||
  new Set(browser.checks.map((x) => x.name)).size !== 54
)
  throw Error("Browser receipt incomplete");
if (
  browser.manual_screen_reader !== "not_run" ||
  browser.representative_merchant_testing !== "not_run"
)
  throw Error("Reconcile actual qualification before changing these claims");
// P14.T01a AC01: the ported stylesheet tokens equal the generator output, no colour
// literal exists outside tokens.css, and the CSS breakpoints are the token breakpoints.
const uiProblems = [...checkUiTokens(), ...inspectBreakpoints()];
const plantedLiteral =
  inspectColourLiterals(
    "packages/workspace-ui/src/styles/components.css",
    ".x { color: #202223; }\n",
  ).length === 1 &&
  inspectColourLiterals(
    "packages/workspace-ui/src/styles/components.css",
    ".x { color: rgb(0 0 0); }\n",
  ).length === 1;
if (uiProblems.length || !plantedLiteral)
  throw Error(
    "UI token check failed\n" +
      uiProblems.join("\n") +
      (plantedLiteral ? "" : "\nPlanted colour literal not detected"),
  );
const paths = [
  "docs/design/prototype.html",
  "docs/design/tokens.json",
  "docs/design/component-baseline.md",
  "docs/design/prototype-guide.md",
  "docs/acceptance/P02.md",
  "docs/design/browser-checks.json",
];
const report = {
  generated_at: new Date().toISOString(),
  ui_tokens: { drift: 0, colour_literals: 0, planted_literal_detected: plantedLiteral },
  scope:
    "Candidate artifact integrity, JavaScript syntax and specified contrast pairs; browser receipt is retained evidence, not rerun by this command. Not full accessibility or usability qualification.",
  contrasts,
  browser_cases: 54,
  baseline_qualification: "pending_real_participants_and_reviewer",
  input_digests: Object.fromEntries(paths.map((p) => [p, digest(p)])),
};
writeArtifact("verify/design.json", report);
console.log(
  `PASS: ${contrasts.length} specified contrasts, syntax, 54 recorded browser checks and the generated UI tokens. Human qualification remains pending.`,
);
