// The context policy generator (ADR-0041 item 12; harness contracts, H6). It reads
// docs/decisions/context-policy.json, refuses it unless every row is a valid ContextPolicy@1
// and every inspection below passes, and writes the data-only module
// packages/policy/src/generated/context-policy.ts: each version's status and rows, each row
// with the digest a run manifest pins (sha256 of the row's RFC 8785 text).
// The inspections are the preconditions ADR-0041 item 11 needs for a new epoch to converge
// (every section has a budget and the tail can shrink to nothing), the progress guard, the
// hard guard and the cache rules of item 10. A version is proposed until one reviewed commit
// makes it active with its eval record (item 37); no Worker reads the module yet (H7d).
// `--check` compares the committed file byte for byte and runs the inspections
// (verify:boundaries). Nothing here compiles a schema at runtime.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { repositoryRoot } from "./artifacts.mjs";

export const contextPolicyPath = "docs/decisions/context-policy.json";
export const generatedContextPolicyPath = "packages/policy/src/generated/context-policy.ts";
const validatorsPath = "packages/contracts/src/generated/runtime-validators.mjs";

// The largest max_tokens a catalogue entry may set (the CHECK range, ADR-0041 item 8): the hard
// guard must hold a compaction request at the compaction threshold with a full turn of results.
export const maxOutputTokensRange = 128000;
// The byte estimate per token for the stored-message check (ADR-0041 item 12: 384 KiB holds the
// per-turn budget and a full turn of previews).
export const bytesPerTokenEstimate = 4;

const refuse = (code) => {
  throw Error("CONTEXT_POLICY_" + code);
};
// RFC 8785 (JCS) text of plain JSON data: sorted keys, no whitespace.
export const jcs = (value) =>
  Array.isArray(value)
    ? "[" + value.map(jcs).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + jcs(value[key]))
          .join(",") +
        "}"
      : JSON.stringify(value);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** A row's digest: what a run manifest pins as contextPolicyDigest. */
export const contextPolicyDigest = (row) => sha256(jcs(row));

const share = (basisPoints, window) => Math.floor((basisPoints * window) / 10000);

/**
 * The invariants of one row, beyond its schema (ADR-0041 items 10 to 12). Returns problems;
 * an empty list passes. Every value is a token count or basis points of W unless named.
 */
export function inspectContextPolicyRow(row) {
  const errors = [];
  const fail = (text) => errors.push(`${row?.model}/${row?.effort}: ${text}`);
  const W = row.workingWindowTokens;
  const hardGuard = share(row.hardGuardBasisPoints, row.modelWindowTokens);
  if (W > hardGuard) fail("the working window must fit inside the hard guard");
  if (!(row.clear.minimumBasisPoints <= row.clear.fromBasisPoints))
    fail("clearing must clear no more than it starts from");
  if (!(row.clear.fromBasisPoints < row.compact.atBasisPoints))
    fail("clearing starts before compaction");
  const background = row.compact.backgroundFromBasisPoints;
  if (
    background !== null &&
    !(background >= row.clear.fromBasisPoints && background < row.compact.atBasisPoints)
  )
    fail("background compaction starts between clearing and compaction");
  if (!(row.newEpoch.targetBasisPoints < row.compact.atBasisPoints))
    fail("a new epoch starts below the compaction threshold");
  // The progress guard: compacting from the threshold to the target cuts at least the minimum.
  if (
    (row.compact.atBasisPoints - row.newEpoch.targetBasisPoints) * 10000 <
    row.compact.minimumCutBasisPoints * row.compact.atBasisPoints
  )
    fail("a compaction from the threshold to the target must cut the minimum share");
  if (!(row.newEpoch.keptTailBasisPoints <= row.newEpoch.targetBasisPoints))
    fail("the kept tail fits inside the new epoch's target");
  // Convergence: the fixed opening budgets, the ledger, the checkpoint and the kept tail fit
  // the target, so a new epoch always reaches it (each section falls back to pointers and the
  // tail may shrink to nothing; H7d's property test proves the rest).
  const o = row.opening;
  const fixed =
    o.factsTokens +
    o.teammatesTokens +
    o.pinnedKnowledgeTokens +
    o.personMemoryTokens +
    o.knowledgeIndexTokens +
    o.notebookIndexTokens +
    o.conversationSummariesTokens;
  const epochBudget =
    fixed +
    share(o.ledgerBasisPoints, W) +
    share(o.checkpointBasisPoints, W) +
    share(row.newEpoch.keptTailBasisPoints, W);
  if (epochBudget > share(row.newEpoch.targetBasisPoints, W))
    fail(`the opening budgets (${epochBudget} tokens) must fit the new epoch's target`);
  const perTurn = share(row.results.perTurnBasisPoints, W);
  if (row.results.inlineTokens > perTurn) fail("one inline result fits the per-turn budget");
  if (row.results.previewTokens > row.results.inlineTokens)
    fail("a preview is below the inline bound");
  if (
    !(row.newEpoch.targetBasisPoints + row.results.perTurnBasisPoints < row.compact.atBasisPoints)
  )
    fail("a new epoch plus one turn of results stays below the compaction threshold");
  // The hard guard holds a compaction request: input at the threshold plus a turn of results
  // plus the largest max_tokens.
  if (share(row.compact.atBasisPoints, W) + perTurn + maxOutputTokensRange > hardGuard)
    fail("the hard guard must hold a compaction request with a full turn and max_tokens");
  if (row.toolCalls.inFlight > row.toolCalls.perTurn)
    fail("in-flight calls are a subset of a turn's");
  if (
    (perTurn + row.toolCalls.perTurn * row.results.previewTokens) * bytesPerTokenEstimate >
    row.storedMessageBytes
  )
    fail("a stored message must hold the per-turn budget and a full turn of previews");
  // ADR-0041 item 10: one hour on BP1 everywhere; conversations and jobs, which wait on a
  // person, one hour on every breakpoint.
  for (const scope of ["conversation", "job", "call", "upkeep"])
    if (row.cache[scope].system !== "1h") fail(`${scope}: one hour on the system breakpoint`);
  for (const scope of ["conversation", "job"])
    if (row.cache[scope].rest !== "1h") fail(`${scope}: one hour on every breakpoint`);
  return errors;
}

/** The file's own rules: versions, statuses, eval records and rows (with `validate`). */
export function inspectContextPolicy(file, validate) {
  const errors = [];
  const keys = (value) =>
    Object.keys(value ?? {})
      .sort()
      .join(",");
  if (
    keys(file) !== "active_version,contract,schema_version,scope,versions" ||
    file.schema_version !== 1 ||
    file.contract !== "ContextPolicy@1" ||
    typeof file.scope !== "string" ||
    !Array.isArray(file.versions) ||
    file.versions.length < 1
  )
    return ["context-policy.json: malformed"];
  let previous = 0;
  const active = [];
  for (const entry of file.versions) {
    const at = (text) => errors.push(`version ${entry?.version}: ${text}`);
    if (keys(entry) !== "eval_record,rows,status,version") {
      at("malformed");
      continue;
    }
    if (!Number.isInteger(entry.version) || entry.version <= previous)
      at("versions ascend from 1 without repeats");
    previous = entry.version;
    if (!["proposed", "active", "retired"].includes(entry.status)) at("unknown status");
    if (entry.status === "active") active.push(entry.version);
    const evalled = entry.status !== "proposed";
    if (evalled !== (typeof entry.eval_record === "string" && entry.eval_record !== ""))
      at("an active or retired version names its eval record; a proposed one has none");
    if (!Array.isArray(entry.rows) || entry.rows.length < 1) {
      at("at least one row");
      continue;
    }
    const pairs = new Set();
    for (const row of entry.rows) {
      if (!validate(row)) {
        at("a row is not a valid ContextPolicy@1");
        continue;
      }
      if (row.version !== entry.version) at("a row names its version");
      if (row.evalRecord !== entry.eval_record) at("each row names the version's eval record");
      const pair = row.model + "/" + row.effort;
      if (pairs.has(pair)) at("one row per model and effort: " + pair);
      pairs.add(pair);
      errors.push(
        ...inspectContextPolicyRow(row).map((problem) => `version ${entry.version}: ${problem}`),
      );
    }
  }
  if (active.length > 1) errors.push("at most one active version");
  if ((active[0] ?? null) !== file.active_version)
    errors.push("active_version names the active version, or null while none is active");
  return errors;
}

/** The generated data: versions with each row's digest. */
export function contextPolicyData(file) {
  return {
    schemaVersion: 1,
    activeVersion: file.active_version,
    versions: file.versions.map((entry) => ({
      version: entry.version,
      status: entry.status,
      evalRecord: entry.eval_record,
      rows: entry.rows.map((row) => ({ ...row, digest: contextPolicyDigest(row) })),
    })),
  };
}

async function format(root, path, text) {
  const options = (await prettier.resolveConfig(resolve(root, path))) ?? {};
  return prettier.format(text, { ...options, parser: "typescript" });
}

/** Inspects the policy file and returns the generated module; throws with every problem. */
export async function generateContextPolicy(root = repositoryRoot) {
  const file = JSON.parse(readFileSync(resolve(root, contextPolicyPath), "utf8"));
  const { validators, currentDefinitionSelectors } = await import(resolve(root, validatorsPath));
  const validate = (value) =>
    validators[currentDefinitionSelectors.ContextPolicy]?.(value) === true;
  const errors = inspectContextPolicy(file, validate);
  if (errors.length) refuse("INVALID: " + errors.join("; "));
  const text = await format(
    root,
    generatedContextPolicyPath,
    "// Generated by scripts/generate-context-policy.mjs from docs/decisions/context-policy.json\n" +
      "// (ContextPolicy@1; ADR-0041 item 12). Do not edit; run `npm run contracts:generate`.\n" +
      "// Data only: each version's status and rows. A row's digest is sha256 of its RFC 8785\n" +
      "// text; a run manifest pins the version and the digest. Version 1 is proposed: the\n" +
      "// context-fill sweep sets the values before any version is active.\n" +
      "export const generatedContextPolicy = " +
      JSON.stringify(contextPolicyData(file), null, 2) +
      " as const;\n",
  );
  return { [generatedContextPolicyPath]: text };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputs = await generateContextPolicy();
  for (const [path, text] of Object.entries(outputs)) {
    const target = resolve(repositoryRoot, path);
    if (process.argv.includes("--check")) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== text)
        throw Error("CONTEXT_POLICY_DRIFT: " + path);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      console.log("Generated " + path + ".");
    }
  }
  if (process.argv.includes("--check"))
    console.log("PASS: the context policy reproduces and inspects clean.");
}
