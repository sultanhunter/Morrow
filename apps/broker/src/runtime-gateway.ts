import { runtimeGatewayLimits } from "../../../packages/identity/src/broker-protocol.js";
import {
  checkRuntimeOutput,
  computerProfile,
  outputPath,
  parseRuntimeJob,
  renderJobInputs,
  runtimeJobCanonical,
  runtimeJobLimits,
  type RuntimeJob,
} from "../../../packages/policy/src/runtime-computer.js";
import {
  BrokerHold,
  brokerCapabilities,
  invokeBrokerMethod,
  type BrokerVault,
} from "./capabilities.js";
import {
  sandboxRefPattern,
  type RuntimeCreateResult,
  type RuntimeExecResult,
  type RuntimeKillResult,
  type RuntimeProvider,
  type RuntimeReadResult,
  type RuntimeStatusResult,
  type RuntimeWriteResult,
  type SandboxHandle,
} from "./runtime-provider.js";

// RuntimeBroker.runtimeExecute and runtimeSweep (ADR-0029 items 1 to 5, 8 and 9; build order
// PR 7): the one door for every computer job. Order, each step refusing before the next:
//   1. The reviewed runtime switch (docs/decisions/runtime-staging.json): execute needs "on",
//      the sweep "on" or "cleanup_only"; off (no MORROW_RUNTIME_SWITCH, no E2B key, no vault,
//      no composed adapter or, for execute, no pinned template) holds every call with
//      RUNTIME_UNAVAILABLE before any input, database or provider access.
//   2. The closed inputs: a lease UUID and generation, a budget, and RuntimeJob@1 checked by
//      hand (packages/policy/src/runtime-computer.ts). The minimised inputs are checked cell
//      by cell against their kind's fixed columns; a URL, a shop domain or an email refuses
//      the job before anything else happens.
//   3. The send mark (morrow_vault.runtime_operation_begin, its own committed transaction):
//      the lease resolves as for a model call, the run's installation's package declares
//      runtime.execution.use, no runtime hold is active, the monthly runtime budget, the
//      concurrency and the per-workspace caps hold, and the run's vendor reservation books
//      the sandbox's worst case (`sandbox_compute`). Only then does a create leave the broker.
//      The same run and call key again never creates: it answers `unknown` (replayed).
//   4. One create, never retried. Anything but `created` (or a malformed reply) after the send
//      is `unknown_effect`: recorded with a runtime hold that only a person lifts. `not_sent`
//      alone proves nothing exists.
//   5. The job: the input files, the script, the profile's one command, the declared outputs,
//      each within its slice of the budget, always leaving time to kill.
//   6. The kill, always. `killed` settles the operation; `not_found` and `unknown` leave it
//      `unknown_effect` with a hold, never counted as deleted.
//   7. The outputs, checked by content (PNG, CSV with formula cells escaped, XLSX without
//      macros, links or objects) and returned as RuntimeResult@1: no sandbox id, provider id,
//      token or credential.
// The sweep reconciles stale operations by their metadata alone: a sandbox still running is
// killed, and one the provider does not find counts as absent only on a qualified profile
// after its deadline plus the grace; it never creates and no hold or stop blocks it.
// Build order PR 8 (ADR-0029 items 3 and 9; migration 0047):
//   * The sandbox's envd token goes from the create's reply straight into a sealed vault
//     record (ledger.tokenPut) before the job starts; each call to the sandbox opens that
//     record (ledger.tokenGet); the operation's settlement, whatever it is, destroys it in the
//     same transaction. A job whose token cannot be stored or opened stops there (unknown) and
//     its sandbox is still killed. The open also reads the run's stops and lease: once a stop
//     covers the run (or its lease has ended or expired) it answers `stopped`, so the job ends
//     at its next call with the code `stopped` and its own kill follows at once.
//   * A reply the adapter marks `broken` (the provider's documented protocol did not hold)
//     records the operation `unknown_effect` with reason reply_invalid before the kill, so a
//     runtime hold stays until a person lifts it, even when the kill then succeeds. Until
//     that write commits (it is retried once after the kill) the operation is never settled
//     `killed`: it stays open for the stale sweep, which records it unknown.
//   * Stops: the sweep's list also carries operations a stop (platform, connection or
//     installation), an ended lease or an expired one has cut off (`stopped`), stale or not.
//     The sweep kills such a sandbox at once (its settlement destroys the token, so a job still
//     running stops at its next call), and leaves one it cannot see yet to a later pass: only
//     a stale operation is ever recorded unknown or absent.

export type RuntimeOperationStatus =
  | "sending"
  | "created"
  | "unknown_effect"
  | "killed"
  | "absent_verified"
  | "not_created";
/** Why an operation is `unknown_effect` (each one sets or keeps a runtime hold). */
export type RuntimeUnknownReason =
  | "create_unknown"
  | "quota_exhausted"
  | "billing_blocked"
  | "reply_invalid"
  | "kill_unknown"
  | "kill_not_found"
  | "status_unknown"
  | "not_found_unverified"
  | "paused_found";
export type RuntimeBeginRefusal =
  | "runtime_held"
  | "monthly_budget"
  | "concurrency_limit"
  | "workspace_limit"
  | "reservation_exhausted"
  | "capability_missing";
export type RuntimeBegin =
  | { readonly outcome: "begun"; readonly operationId: string; readonly deadlineAtMs: number }
  | { readonly outcome: "replay"; readonly operationId: string }
  | { readonly outcome: "refused"; readonly code: RuntimeBeginRefusal }
  /** The lease, its run, its stops or its installation refused: BROKER_HELD. */
  | { readonly outcome: "lease_refused" };
export interface RuntimeOpenOperation {
  readonly operationId: string;
  readonly provider: string;
  readonly sandboxRef: string | null;
  readonly status: "sending" | "created" | "unknown_effect";
  readonly deadlineAtMs: number;
  /** Past the longest execute: no job of the broker's can still be working on it. */
  readonly stale: boolean;
  /** Past its deadline plus the profile's absent grace. */
  readonly pastGrace: boolean;
  /** A stop covers its run, or its lease ended or expired: its sandbox is killed now. */
  readonly stopped: boolean;
}
/**
 * The operation ledger (migration 0043: morrow_work's tables behind morrow_vault's broker
 * definers): each call is its own committed transaction on the broker's login, so the
 * send mark exists before any create. A false
 * answer means the write did not commit (or was refused); the gateway then treats the
 * sandbox as unknown and leaves it to the sweep.
 */
export interface RuntimeLedger {
  begin(request: {
    readonly leaseId: string;
    readonly generation: number;
    readonly callKey: string;
    readonly jobDigest: string;
    readonly provider: string;
  }): Promise<RuntimeBegin>;
  created(operationId: string, sandboxRef: string): Promise<boolean>;
  settle(
    operationId: string,
    status: "killed" | "not_created" | "absent_verified",
  ): Promise<boolean>;
  unknown(operationId: string, reason: RuntimeUnknownReason): Promise<boolean>;
  open(limit: number): Promise<readonly RuntimeOpenOperation[]>;
  /**
   * Seals the sandbox's envd token into its vault record: once per operation, only while it
   * is `created`. False when it did not commit (the job then never starts).
   */
  tokenPut(operationId: string, token: string): Promise<boolean>;
  /**
   * Opens it for one call. `stopped` while a stop covers the run or its lease has ended or
   * expired (the job ends there and its sandbox is killed at once); `unavailable` once the
   * operation has settled, or on any doubt.
   */
  tokenGet(operationId: string): Promise<RuntimeTokenRead>;
}
export type RuntimeTokenRead =
  | { readonly outcome: "active"; readonly token: string }
  | { readonly outcome: "stopped" }
  | { readonly outcome: "unavailable" };
export interface RuntimeGatewaySeams {
  readonly ledger: (vault: Readonly<BrokerVault>) => RuntimeLedger;
  /** The adapter of the configured provider, by name ("e2b": runtime-e2b.ts since PR 8). */
  readonly providers: Readonly<Record<string, RuntimeProvider>>;
  readonly now: () => number;
  /** The pinned template the profile creates from (ADR-0029 item 1); null holds every create. */
  readonly template: string | null;
  /**
   * Qualification (ADR-0029 item 11): until it is recorded, a sandbox the provider does not
   * find is never counted as absent.
   */
  readonly qualified: boolean;
}

/** Each step's ceiling inside one execute; the kill and its record always keep theirs. */
export const runtimeTiming = Object.freeze({
  ledgerMaxMs: 10_000,
  createMaxMs: 30_000,
  writeMaxMs: 15_000,
  execMarginMs: 15_000,
  readMaxMs: 15_000,
  killReserveMs: 25_000,
  statusMaxMs: 15_000,
});

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hold = (code: ConstructorParameters<typeof BrokerHold>[0]) => new BrokerHold(code);
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
// An adapter promise never throws by contract; a throw is that operation's unknown outcome.
async function safely<T>(call: () => Promise<T>, unknown: T): Promise<T> {
  try {
    return await call();
  } catch {
    return unknown;
  }
}

interface ResultOutput {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly sha256: string;
  readonly base64: string;
}
/** RuntimeResult@1 text. */
function runtimeResult(fields: {
  readonly outcome: "completed" | "failed" | "timed_out" | "refused" | "unknown";
  readonly code?: string | null;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputs?: readonly ResultOutput[];
  readonly rejected?: readonly { readonly name: string; readonly code: string }[];
  readonly operationId?: string | null;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    outcome: fields.outcome,
    code: fields.code ?? null,
    exitCode: fields.exitCode ?? null,
    stdout: fields.stdout ?? "",
    stderr: fields.stderr ?? "",
    outputs: fields.outputs ?? [],
    rejected: fields.rejected ?? [],
    traceRef:
      fields.operationId === null || fields.operationId === undefined
        ? null
        : { kind: "runtime_operation", id: fields.operationId },
  });
}
const cut = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= runtimeJobLimits.logBytesMax
    ? text
    : new TextDecoder().decode(bytes.subarray(0, runtimeJobLimits.logBytesMax)).replace(/�+$/, "");
};

export function createRuntimeGateway(seams: Readonly<RuntimeGatewaySeams>) {
  async function execute(
    env: unknown,
    leaseId: unknown,
    generation: unknown,
    jobJson: unknown,
    budgetMs: unknown,
  ): Promise<string> {
    // 1. The switch, before anything else.
    const capabilities = await brokerCapabilities(env);
    const runtime = capabilities.computer;
    const vault = capabilities.vault;
    const adapter = runtime === null ? undefined : seams.providers[runtime.provider];
    const template = seams.template;
    if (
      capabilities.computerMode !== "on" ||
      runtime === null ||
      vault === null ||
      !adapter ||
      template === null
    )
      throw hold("RUNTIME_UNAVAILABLE");
    // 2. The closed inputs.
    if (
      typeof leaseId !== "string" ||
      !uuid.test(leaseId) ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < runtimeGatewayLimits.executeBudgetMinMs ||
      budgetMs > runtimeGatewayLimits.executeBudgetMaxMs
    )
      throw hold("INPUT_INVALID");
    const job: RuntimeJob | null = parseRuntimeJob(jobJson);
    if (job === null) throw hold("INPUT_INVALID");
    const deadline = seams.now() + budgetMs;
    const left = () => deadline - seams.now();
    const slice = (ceiling: number) =>
      Math.max(1_000, Math.min(ceiling, left() - runtimeTiming.killReserveMs));
    const inputs = renderJobInputs(job);
    if (!inputs.ok) return runtimeResult({ outcome: "refused", code: inputs.code });
    const script = new TextEncoder().encode(job.script);
    const jobDigest = await sha256(new TextEncoder().encode(runtimeJobCanonical(job)));
    // 3. The send mark, committed before any create.
    const ledger = seams.ledger(vault);
    const begun = await ledger.begin({
      leaseId,
      generation,
      callKey: job.callKey,
      jobDigest,
      provider: adapter.provider,
    });
    if (begun.outcome === "lease_refused") throw hold("STATE_INVALID");
    if (begun.outcome === "refused") return runtimeResult({ outcome: "refused", code: begun.code });
    if (begun.outcome === "replay")
      return runtimeResult({
        outcome: "unknown",
        code: "replayed",
        operationId: begun.operationId,
      });
    const operationId = begun.operationId;
    // 4. One create.
    const created: RuntimeCreateResult = await safely(
      () =>
        adapter.create(
          {
            operationId,
            template,
            timeoutSeconds: computerProfile.sandboxTimeoutSeconds,
            internet: false,
            metadata: { operation: operationId },
          },
          runtime.apiKey,
          slice(runtimeTiming.createMaxMs),
        ),
      { outcome: "unknown_effect" },
    );
    if (created.outcome === "not_sent") {
      await ledger.settle(operationId, "not_created");
      return runtimeResult({ outcome: "refused", code: "create_not_sent", operationId });
    }
    if (
      created.outcome !== "created" ||
      typeof created.sandboxRef !== "string" ||
      !sandboxRefPattern.test(created.sandboxRef) ||
      (created.accessToken !== null && typeof created.accessToken !== "string")
    ) {
      const reason: RuntimeUnknownReason =
        created.outcome === "quota_exhausted"
          ? "quota_exhausted"
          : created.outcome === "billing_blocked"
            ? "billing_blocked"
            : created.outcome === "created" ||
                (created.outcome === "unknown_effect" && created.broken === true)
              ? "reply_invalid"
              : "create_unknown";
      await ledger.unknown(operationId, reason);
      return runtimeResult({ outcome: "unknown", code: reason, operationId });
    }
    const sandboxRef = created.sandboxRef;
    const tokenHeld = created.accessToken !== null;
    // 5. The job; 6. the kill, whatever happened.
    let outcome: Parameters<typeof runtimeResult>[0] = {
      outcome: "unknown",
      code: "ledger_unrecorded",
      operationId,
    };
    // False only while a broken reply's hold is not committed: the operation then never
    // settles `killed` (which would end it with no hold), whatever the kill says.
    let held = true;
    try {
      if (await ledger.created(operationId, sandboxRef)) {
        // The envd token's only home from here on is its vault record.
        if (tokenHeld && !(await ledger.tokenPut(operationId, created.accessToken as string)))
          outcome = { outcome: "unknown", code: "token_unrecorded", operationId };
        else {
          const sandbox = async (): Promise<SandboxHandle | "stopped" | null> => {
            if (!tokenHeld) return Object.freeze({ sandboxRef, accessToken: null });
            const read = await ledger.tokenGet(operationId);
            if (read.outcome === "stopped") return "stopped";
            return read.outcome === "active"
              ? Object.freeze({ sandboxRef, accessToken: read.token })
              : null;
          };
          outcome = await work(
            adapter,
            sandbox,
            job,
            inputs.files,
            script,
            operationId,
            left,
            slice,
          );
          // A reply that broke the provider's protocol leaves a hold, whatever the kill says.
          if (outcome.code === "reply_invalid")
            held = await ledger.unknown(operationId, "reply_invalid");
        }
      }
    } finally {
      const killed: RuntimeKillResult = await safely(
        () =>
          adapter.kill(
            sandboxRef,
            runtime.apiKey,
            Math.max(1_000, Math.min(runtimeTiming.statusMaxMs, left())),
          ),
        { outcome: "unknown" },
      );
      if (killed.outcome === "killed") {
        // The hold is retried once. If it still did not commit, the operation stays open
        // (never `killed` without its hold), and the stale sweep, finding no sandbox, records
        // it not_found_unverified, which holds.
        if (!held) held = await ledger.unknown(operationId, "reply_invalid");
        if (held) await ledger.settle(operationId, "killed");
      } else
        await ledger.unknown(
          operationId,
          killed.outcome === "not_found" ? "kill_not_found" : "kill_unknown",
        );
    }
    return runtimeResult(outcome);
  }

  async function work(
    adapter: RuntimeProvider,
    sandbox: () => Promise<SandboxHandle | "stopped" | null>,
    job: RuntimeJob,
    files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
    script: Uint8Array,
    operationId: string,
    left: () => number,
    slice: (ceiling: number) => number,
  ): Promise<Parameters<typeof runtimeResult>[0]> {
    const broken = { outcome: "unknown" as const, code: "reply_invalid", operationId };
    // The token is opened for each call; once a stop covers the run, or the operation has
    // settled (a stop's sweep, say), there is none, and the job ends here.
    const tokenGone = (handle: "stopped" | null) =>
      handle === "stopped"
        ? { outcome: "unknown" as const, code: "stopped", operationId }
        : { outcome: "unknown" as const, code: "token_unavailable", operationId };
    for (const file of [...files, { path: computerProfile.jobPath, bytes: script }]) {
      if (left() < runtimeTiming.killReserveMs + 1_000)
        return { outcome: "unknown", code: "budget_spent", operationId };
      const handle = await sandbox();
      if (handle === null || handle === "stopped") return tokenGone(handle);
      const written: RuntimeWriteResult = await safely(
        () => adapter.writeFile(handle, file.path, file.bytes, slice(runtimeTiming.writeMaxMs)),
        { outcome: "unknown" },
      );
      if (written.outcome !== "written")
        return written.broken === true
          ? broken
          : { outcome: "unknown", code: "write_unknown", operationId };
    }
    const execBudget = computerProfile.execTimeoutSeconds * 1000 + runtimeTiming.execMarginMs;
    if (left() < runtimeTiming.killReserveMs + execBudget)
      return { outcome: "unknown", code: "budget_spent", operationId };
    const runner = await sandbox();
    if (runner === null || runner === "stopped") return tokenGone(runner);
    const ran: RuntimeExecResult = await safely(
      () =>
        adapter.exec(
          runner,
          {
            argv: computerProfile.command,
            cwd: computerProfile.workDirectory,
            user: computerProfile.user,
            timeoutSeconds: computerProfile.execTimeoutSeconds,
          },
          execBudget,
        ),
      { outcome: "unknown" },
    );
    if (ran.outcome === "timed_out") return { outcome: "timed_out", operationId };
    if (ran.outcome === "unknown" && ran.broken === true) return broken;
    if (
      ran.outcome !== "exited" ||
      !Number.isSafeInteger(ran.exitCode) ||
      typeof ran.stdout !== "string" ||
      typeof ran.stderr !== "string"
    )
      return { outcome: "unknown", code: "exec_unknown", operationId };
    const stdout = cut(ran.stdout);
    const stderr = cut(ran.stderr);
    if (ran.exitCode !== 0)
      return {
        outcome: "failed",
        code: "exit_nonzero",
        exitCode: ran.exitCode,
        stdout,
        stderr,
        operationId,
      };
    const outputs: ResultOutput[] = [];
    const rejected: { name: string; code: string }[] = [];
    let total = 0;
    for (const output of job.outputs) {
      if (left() < runtimeTiming.killReserveMs + 1_000) {
        rejected.push({ name: output.name, code: "budget_spent" });
        continue;
      }
      const reader = await sandbox();
      if (reader === null || reader === "stopped") return tokenGone(reader);
      const max = runtimeJobLimits.outputBytesMax[output.type];
      const read: RuntimeReadResult = await safely(
        () => adapter.readFile(reader, outputPath(output), max, slice(runtimeTiming.readMaxMs)),
        { outcome: "unknown" },
      );
      if (read.outcome === "unknown" && read.broken === true) return broken;
      if (read.outcome !== "read") {
        rejected.push({
          name: output.name,
          code:
            read.outcome === "missing"
              ? "output_missing"
              : read.outcome === "too_large"
                ? "output_too_large"
                : "read_unknown",
        });
        continue;
      }
      const checked = await checkRuntimeOutput(output.type, read.bytes);
      if (checked.outcome === "rejected") {
        rejected.push({ name: output.name, code: checked.code });
        continue;
      }
      if (total + checked.bytes.length > runtimeJobLimits.outputsBytesMax) {
        rejected.push({ name: output.name, code: "output_too_large" });
        continue;
      }
      total += checked.bytes.length;
      outputs.push(
        Object.freeze({
          name: output.name,
          type: output.type,
          size: checked.bytes.length,
          sha256: await sha256(checked.bytes),
          base64: base64(checked.bytes),
        }),
      );
    }
    return { outcome: "completed", exitCode: 0, stdout, stderr, outputs, rejected, operationId };
  }

  async function sweep(env: unknown, budgetMs: unknown): Promise<string> {
    const capabilities = await brokerCapabilities(env);
    const runtime = capabilities.computer;
    const vault = capabilities.vault;
    if (
      (capabilities.computerMode !== "on" && capabilities.computerMode !== "cleanup_only") ||
      runtime === null ||
      vault === null
    )
      throw hold("RUNTIME_UNAVAILABLE");
    if (
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < runtimeGatewayLimits.sweepBudgetMinMs ||
      budgetMs > runtimeGatewayLimits.sweepBudgetMaxMs
    )
      throw hold("INPUT_INVALID");
    const deadline = seams.now() + budgetMs;
    const left = () => deadline - seams.now();
    const ledger = seams.ledger(vault);
    const open = await ledger.open(runtimeGatewayLimits.sweepBatch);
    const counts = { examined: 0, killed: 0, absentVerified: 0, unknown: 0, skipped: 0 };
    for (const op of open) {
      if (!op.stale && !op.stopped) {
        counts.skipped++;
        continue;
      }
      if (left() < 2 * runtimeTiming.statusMaxMs) break;
      counts.examined++;
      const adapter = Object.values(seams.providers).find((p) => p.provider === op.provider);
      if (!adapter) {
        counts.unknown++;
        continue;
      }
      const found: RuntimeStatusResult = await safely(
        () =>
          adapter.status(op.operationId, op.sandboxRef, runtime.apiKey, runtimeTiming.statusMaxMs),
        { outcome: "unknown" },
      );
      // A stopped operation that is not stale yet may still have its create in flight or its
      // job running: its sandbox is killed when the provider shows it, and anything else waits
      // for a later pass (never recorded unknown or absent this early).
      if (!op.stale && found.outcome !== "running" && found.outcome !== "paused") {
        counts.skipped++;
        continue;
      }
      if (found.outcome === "running" || found.outcome === "paused") {
        if (found.outcome === "paused") await ledger.unknown(op.operationId, "paused_found");
        const killed: RuntimeKillResult = await safely(
          () => adapter.kill(found.sandboxRef, runtime.apiKey, runtimeTiming.statusMaxMs),
          { outcome: "unknown" },
        );
        if (killed.outcome === "killed" && (await ledger.settle(op.operationId, "killed")))
          counts.killed++;
        else {
          await ledger.unknown(
            op.operationId,
            killed.outcome === "not_found" ? "kill_not_found" : "kill_unknown",
          );
          counts.unknown++;
        }
      } else if (found.outcome === "not_found") {
        // Absence is proved only on a qualified profile, after the deadline and the grace.
        if (
          seams.qualified &&
          op.pastGrace &&
          (await ledger.settle(op.operationId, "absent_verified"))
        )
          counts.absentVerified++;
        else {
          await ledger.unknown(op.operationId, "not_found_unverified");
          counts.unknown++;
        }
      } else {
        await ledger.unknown(op.operationId, "status_unknown");
        counts.unknown++;
      }
    }
    return JSON.stringify({ schemaVersion: 1, ...counts });
  }

  return Object.freeze({
    runtimeExecute(
      env: unknown,
      leaseId: unknown,
      generation: unknown,
      jobJson: unknown,
      budgetMs: unknown,
    ): Promise<string> {
      return invokeBrokerMethod(
        "runtimeExecute",
        () => execute(env, leaseId, generation, jobJson, budgetMs),
        "RuntimeBroker",
      );
    },
    runtimeSweep(env: unknown, budgetMs: unknown): Promise<string> {
      return invokeBrokerMethod("runtimeSweep", () => sweep(env, budgetMs), "RuntimeBroker");
    },
  });
}
