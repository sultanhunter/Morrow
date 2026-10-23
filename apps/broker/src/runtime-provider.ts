// The runtime provider port (ADR-0029 item 2; P12.T01's RuntimeProviderPort; build order
// PR 7). Callers never see it: the orchestrator sends RuntimeJob@1 to
// RuntimeBroker.runtimeExecute and receives RuntimeResult@1. Inside the broker the runtime
// gateway (runtime-gateway.ts) drives one adapter through this closed set of operations:
// create one fresh sandbox, write a file, run the profile's one command, read a file back,
// look a sandbox up by its operation, and kill it. There is no connect, resume, pause,
// snapshot, network, environment or template choice: nothing here can give a sandbox the
// internet, a credential or a longer life.
//
// Every operation answers a closed outcome and never throws; the gateway treats a throw as
// the operation's unknown outcome. Outcomes are never flattened: `not_found` is not
// `killed`, and every failure after a request may have left the provider's side is
// `unknown_effect` (create) or `unknown` (the rest), which the gateway records, holds and
// reconciles before anything is retried. An adapter decides no authority, computes no cost
// and keeps no state between calls: the operation ledger in SQL is the only record.
//
// Every adapter passes tests/runtime-port-conformance.test.mjs (the suite in
// tests/fixtures/runtime-conformance.mjs). The deterministic fake (runtime-fake.ts) is the
// reference; the E2B adapter (build order PR 8, hand-written fetch with no SDK) joins it.

/** One create, exactly as the gateway builds it from the profile; nothing comes from a caller. */
export interface SandboxCreateRequest {
  /** The ledger's operation id (a UUID): the sandbox's only metadata and its lookup key. */
  readonly operationId: string;
  /** The pinned template (ADR-0029 item 1), never a caller's. */
  readonly template: string;
  /** The profile's lifetime; the provider kills the sandbox at it without pausing. */
  readonly timeoutSeconds: number;
  /** Always false: internet off at creation, outside the guest. */
  readonly internet: false;
  readonly metadata: { readonly operation: string };
}
/** A created sandbox: its provider-scoped opaque id and its own access token, if any. */
export interface SandboxHandle {
  readonly sandboxRef: string;
  /**
   * The sandbox's own access token (E2B's envd token), held by the broker only for the
   * life of one job and never written into the guest (ADR-0029 item 3).
   */
  readonly accessToken: string | null;
}
/** The profile's one command: fixed argv, directory, user and timeout; no environment. */
export interface SandboxCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly user: "agent";
  readonly timeoutSeconds: number;
}

export type RuntimeCreateResult =
  | {
      readonly outcome: "created";
      readonly sandboxRef: string;
      readonly accessToken: string | null;
    }
  /** Refused before any request left the adapter: nothing can exist. */
  | { readonly outcome: "not_sent" }
  /** The provider answered that its quota or concurrency is spent (a runtime hold). */
  | { readonly outcome: "quota_exhausted" }
  /** The provider answered that the account's billing blocks creates (a runtime hold). */
  | { readonly outcome: "billing_blocked" }
  /** Anything else after the send: a sandbox may exist. */
  | { readonly outcome: "unknown_effect" };
export type RuntimeStatusResult =
  | { readonly outcome: "running"; readonly sandboxRef: string }
  /** The profile never pauses; a paused sandbox is a profile violation, killed at once. */
  | { readonly outcome: "paused"; readonly sandboxRef: string }
  /** The provider lists no such sandbox: never, alone, proof that it is gone. */
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unknown" };
export type RuntimeKillResult =
  | { readonly outcome: "killed" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unknown" };
export type RuntimeWriteResult = { readonly outcome: "written" } | { readonly outcome: "unknown" };
export type RuntimeExecResult =
  | {
      readonly outcome: "exited";
      readonly exitCode: number;
      /** At most runtimeJobLimits.logBytesMax bytes each, already cut by the adapter. */
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly outcome: "timed_out" }
  | { readonly outcome: "unknown" };
export type RuntimeReadResult =
  | { readonly outcome: "read"; readonly bytes: Uint8Array }
  | { readonly outcome: "missing" }
  | { readonly outcome: "too_large" }
  | { readonly outcome: "unknown" };

export interface RuntimeProvider {
  /** The ledger's provider name ("e2b"; "fake" only in tests). */
  readonly provider: string;
  /** One create: never retried by the adapter, never under another operation id. */
  create(
    request: SandboxCreateRequest,
    credential: string,
    budgetMs: number,
  ): Promise<RuntimeCreateResult>;
  /** Read-only lookup by the operation's metadata (and its ref when known): never resumes. */
  status(
    operationId: string,
    sandboxRef: string | null,
    credential: string,
    budgetMs: number,
  ): Promise<RuntimeStatusResult>;
  writeFile(
    sandbox: SandboxHandle,
    path: string,
    bytes: Uint8Array,
    budgetMs: number,
  ): Promise<RuntimeWriteResult>;
  exec(
    sandbox: SandboxHandle,
    command: SandboxCommand,
    budgetMs: number,
  ): Promise<RuntimeExecResult>;
  readFile(
    sandbox: SandboxHandle,
    path: string,
    maxBytes: number,
    budgetMs: number,
  ): Promise<RuntimeReadResult>;
  kill(sandboxRef: string, credential: string, budgetMs: number): Promise<RuntimeKillResult>;
}

/** The provider-scoped opaque sandbox id the ledger accepts (bounded, no separators). */
export const sandboxRefPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
