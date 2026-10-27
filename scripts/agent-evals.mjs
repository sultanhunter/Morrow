// The agent evals command (ADR-0037 item 10; ADR-0041 item 37; harness plan row H18). Run it
// with `npm run evals -- <command>` (node --import tsx):
//   replay [--arm=<arm>]        Replays the golden set (docs/evals) in the eval world against
//                               its recordings, for one arm or, by default, every arm of the
//                               set; writes each EvalReport@2 and the comparison of each arm
//                               with the primary one (JSON and Markdown) under agent-evals/ in
//                               the artifacts directory. Exits 1 unless every case passes under
//                               the primary arm. No network, model or store:
//                               tests/agent-evals.test.mjs runs the same replay in `npm test`.
//   pin                         Rewrites each recording's basisDigest from its case's inputs,
//                               after a deliberate change to a fixture or the world.
//   compare <a.json> <b.json>   Prints the task-by-task comparison of two EvalReport@2 files.
//   verdict --round=<roundId> --candidate=<report.json> [--baseline=<report.json>]
//                               Grades live reports against the round's pass marks in
//                               docs/evals/thresholds.json; refuses a report pinned to marks
//                               that changed after its round.
//   live --round=<roundId> --side=<candidate|baseline> --repetitions=<n>
//        --bindings=<absolute path> --confirm-draws-workspace-credits
//                               A live round in the deployed environment. It refuses, before it
//                               reads the bindings or sends anything: in CI, without the
//                               confirmation flag, while docs/decisions/agent-evals-live.json is
//                               off (committed off; edge:check refuses it on before the agent
//                               loop and a driver exist), with a bindings file inside the
//                               repository, without a deployed driver (none exists yet), and
//                               when the round's pass marks are unset or written after today.
//   ablate --release=<model release> --bindings=<absolute path> --confirm-draws-workspace-credits
//                               The ablation for a model release (each harness part removed in
//                               turn), gated as a live round.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot, writeArtifact } from "./artifacts.mjs";
import { reviewedLiveEvalsRecord } from "./edge.mjs";

const evals = await import("../packages/policy/src/evals/index.ts");

export const evalsDirectory = "docs/evals";
export const liveSwitchPath = "docs/decisions/agent-evals-live.json";
export const programmeFiles = Object.freeze({
  contextFill: "programme/context-fill-sweep.json",
  compaction: "programme/forced-compaction.json",
  memoryRedTeam: "programme/memory-red-team.json",
  toolSelection: "programme/tool-selection.json",
  ablation: "programme/ablation.json",
});
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const jsonFiles = (directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name));

/** Every file of the golden set, as parsed JSON with its repository-relative path. */
export function readEvalFiles(root = repositoryRoot) {
  const base = join(root, evalsDirectory);
  const read = (sub) =>
    jsonFiles(join(base, sub)).map((path) => ({
      path: path.slice(root.length + 1),
      value: readJson(path),
    }));
  return {
    set: readJson(join(base, "golden-set.json")),
    cases: read("cases"),
    rubrics: read("rubrics"),
    recordings: read("recordings"),
    thresholds: readJson(join(base, "thresholds.json")),
    programme: Object.fromEntries(
      Object.entries(programmeFiles).map(([key, path]) => [key, readJson(join(base, path))]),
    ),
    programmeDirectory: readdirSync(join(base, "programme")).sort(),
    calibration: read("calibration"),
  };
}
/** The parsed, cross-checked library; each file's name must match its id. */
export function loadEvalLibrary(root = repositoryRoot) {
  const files = readEvalFiles(root);
  for (const { path, value } of files.cases)
    if (path !== `${evalsDirectory}/cases/${value?.caseId}.json`)
      throw Error("EVAL_FILE_NAME:" + path);
  for (const { path, value } of files.rubrics)
    if (path !== `${evalsDirectory}/rubrics/${String(value?.rubricId).replace("@", "-")}.json`)
      throw Error("EVAL_FILE_NAME:" + path);
  for (const { path, value } of files.recordings)
    if (
      path !== `${evalsDirectory}/recordings/${evals.recordingFileName(value?.caseId, value?.arm)}`
    )
      throw Error("EVAL_FILE_NAME:" + path);
  for (const { path, value } of files.calibration)
    if (path !== `${evalsDirectory}/calibration/${String(value?.quarter).toLowerCase()}.json`)
      throw Error("EVAL_FILE_NAME:" + path);
  const expected = Object.values(programmeFiles)
    .map((path) => path.slice("programme/".length))
    .sort();
  if (files.programmeDirectory.join() !== expected.join()) throw Error("EVAL_PROGRAMME_FILES");
  return evals.evalLibrary({
    set: files.set,
    cases: files.cases.map((f) => f.value),
    rubrics: files.rubrics.map((f) => f.value),
    recordings: files.recordings.map((f) => f.value),
    thresholds: files.thresholds,
    programme: files.programme,
    calibration: files.calibration.map((f) => f.value),
  });
}

/** Replays each arm and compares every other arm with the primary one. */
export async function replayAll(library, arms = library.set.arms) {
  const reports = new Map();
  for (const arm of arms) reports.set(arm, (await evals.replayRound(library, arm)).report);
  const primary = reports.get(library.set.primaryArm);
  const comparisons = primary
    ? arms
        .filter((arm) => arm !== library.set.primaryArm)
        .map((arm) => evals.compareArms(reports.get(arm), primary))
    : [];
  return { reports, comparisons };
}

async function pin(root = repositoryRoot) {
  const library = loadEvalLibrary(root);
  let changed = 0;
  for (const { path, value } of readEvalFiles(root).recordings) {
    const digest = await evals.recordingBasisDigest(library.cases.get(value.caseId));
    if (value.basisDigest === digest) continue;
    writeFileSync(
      join(root, path),
      JSON.stringify({ ...value, basisDigest: digest }, null, 2) + "\n",
    );
    changed += 1;
  }
  return changed;
}

function options(argv, allowed) {
  const out = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(argument);
    if (!match || !allowed.includes(match[1]) || match[1] in out)
      throw Error("EVALS_USAGE: " + argument);
    out[match[1]] = match[2] ?? true;
  }
  return out;
}

/** The live gate shared by `live` and `ablate`: refuses before anything is read or sent. */
function liveGate(flags) {
  let switchState = "off";
  try {
    switchState = reviewedLiveEvalsRecord(readJson(join(repositoryRoot, liveSwitchPath))).switch;
  } catch {
    switchState = "off";
  }
  const gate = evals.liveRoundGate({
    environment: process.env,
    confirmed: flags["confirm-draws-workspace-credits"] === true,
    switchState,
    bindingsPath: typeof flags.bindings === "string" ? resolve(flags.bindings) : null,
    repositoryRoot,
    // No deployed driver exists until the agent loop (H7), teammate calls (H10) and Morrow's
    // main thread (H11a) land; the PR that adds one wires it here.
    driverAvailable: false,
  });
  if (!gate.ok) throw Error(gate.code);
}

async function live(argv) {
  const flags = options(argv, [
    "round",
    "side",
    "repetitions",
    "bindings",
    "confirm-draws-workspace-credits",
  ]);
  liveGate(flags);
  // The round's pass marks must be set and written on or before today (pre-registration).
  const library = loadEvalLibrary();
  const today = new Date().toISOString().slice(0, 10);
  const start = await evals.evalRoundStart(library.thresholds, String(flags.round), today);
  if (!start.ok) throw Error(start.code);
  throw Error("EVAL_LIVE_DRIVER_UNAVAILABLE");
}

async function ablate(argv) {
  const flags = options(argv, ["release", "bindings", "confirm-draws-workspace-credits"]);
  liveGate(flags);
  throw Error("EVAL_LIVE_DRIVER_UNAVAILABLE");
}

async function verdict(argv) {
  const flags = options(argv, ["round", "candidate", "baseline"]);
  if (typeof flags.round !== "string" || typeof flags.candidate !== "string")
    throw Error("EVALS_USAGE: verdict --round=<id> --candidate=<report.json>");
  const library = loadEvalLibrary();
  const result = await evals.evalRoundVerdict({
    thresholds: library.thresholds,
    roundId: flags.round,
    cases: library.cases,
    candidate: readJson(resolve(flags.candidate)),
    baseline: typeof flags.baseline === "string" ? readJson(resolve(flags.baseline)) : null,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) throw Error("EVALS_ROUND_FAILED");
}

async function main([command, ...rest]) {
  if (command === "replay") {
    const flags = options(rest, ["arm"]);
    const library = loadEvalLibrary();
    const arms = flags.arm ? [flags.arm] : library.set.arms;
    if (arms.some((a) => !library.set.arms.includes(a))) throw Error("EVALS_ARM");
    const { reports, comparisons } = await replayAll(library, arms);
    for (const [arm, report] of reports)
      writeArtifact(`agent-evals/replay-${arm.replace("@", "-")}.json`, report);
    for (const comparison of comparisons) {
      const name = `agent-evals/compare-${comparison.baseline.replace("@", "-")}-${comparison.candidate.replace("@", "-")}`;
      writeArtifact(name + ".json", comparison);
      writeArtifact(name + ".md", evals.renderComparison(comparison));
    }
    for (const [arm, report] of reports) {
      const t = report.totals;
      console.log(
        `${arm}: ${t.pass} pass, ${t.fail} fail, ${t.error} error, ${t.skipped} skipped of ${t.cases}`,
      );
    }
    const primary = reports.get(library.set.primaryArm);
    if (primary && primary.totals.pass !== primary.totals.cases)
      throw Error("EVALS_PRIMARY_ARM_FAILED");
  } else if (command === "pin" && !rest.length) {
    console.log(`pinned ${await pin()} recording(s)`);
  } else if (command === "compare" && rest.length === 2) {
    const [a, b] = rest.map((path) => readJson(resolve(path)));
    console.log(evals.renderComparison(evals.compareArms(a, b)));
  } else if (command === "verdict") {
    await verdict(rest);
  } else if (command === "live") {
    await live(rest);
  } else if (command === "ablate") {
    await ablate(rest);
  } else
    throw Error(
      "EVALS_USAGE: replay [--arm=<a>] | pin | compare <a> <b> | verdict ... | live ... | ablate ...",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exit(1);
  });
