import type {
  RuntimeCreateResult,
  RuntimeExecResult,
  RuntimeKillResult,
  RuntimeProvider,
  RuntimeReadResult,
  RuntimeStatusResult,
  RuntimeWriteResult,
  SandboxCommand,
  SandboxCreateRequest,
  SandboxHandle,
} from "./runtime-provider.js";

// The deterministic fake runtime provider (build order PR 7): the reference adapter of the
// conformance suite (tests/runtime-port-conformance.test.mjs) and the provider of every
// gateway test. Never composed in the deployed broker (index.ts composes the E2B adapter of
// build order PR 8 and nothing else; tests/broker-runtime.test.mjs pins that).
//
// It models a strict provider: one sandbox per create, alive until killed or until its
// timeout passes on the injected clock (then gone, never paused), looked up by its
// operation's metadata, with files and one command. Its "interpreter" runs no code: a job
// script drives it through `#!fake` directives, one per line, so tests choose the outputs:
//   #!fake write <path> <base64>   writes the bytes at <path> (inside the sandbox)
//   #!fake stdout <text>           appends a line to stdout
//   #!fake stderr <text>           appends a line to stderr
//   #!fake exit <code>             the exit code (default 0)
//   #!fake hang                    runs past the command's timeout (timed_out)
// Faults are queued per operation kind; each one answers once, in order, and may say what
// really happened on the provider's side (a sandbox created or killed although the reply
// was lost), so reconciliation can be tested against the truth.
//
// Every request a sandbox could observe is recorded in `guest`: the create's shape, the
// files written, the commands run (argv, directory, user) and the environment it was given
// (always empty: the port has no environment). The conformance suite asserts that no
// credential, token, URL or shop domain ever reaches it.

export type FakeFault =
  | {
      readonly op: "create";
      readonly outcome: "not_sent" | "quota_exhausted" | "billing_blocked" | "unknown_effect";
      /** True: the sandbox exists although the reply says otherwise (a lost reply). */
      readonly created?: boolean;
    }
  | { readonly op: "status"; readonly outcome: "unknown" | "paused" }
  | { readonly op: "kill"; readonly outcome: "unknown"; readonly killed?: boolean }
  | { readonly op: "write" | "exec" | "read"; readonly outcome: "unknown" };

export interface FakeGuestView {
  readonly creates: {
    readonly template: string;
    readonly timeoutSeconds: number;
    readonly internet: boolean;
    readonly metadata: Readonly<Record<string, string>>;
  }[];
  readonly files: {
    readonly sandboxRef: string;
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
  readonly commands: {
    readonly sandboxRef: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly user: string;
    readonly environment: Readonly<Record<string, string>>;
  }[];
}
interface FakeSandbox {
  readonly ref: string;
  readonly operationId: string;
  readonly token: string;
  readonly expiresAtMs: number;
  readonly files: Map<string, Uint8Array>;
  killed: boolean;
}
export interface FakeRuntimeOptions {
  /** The only credential the fake accepts. */
  readonly credential: string;
  readonly now: () => number;
  /** Templates the fake knows; any other is refused as a lost create would be. */
  readonly templates?: readonly string[];
}
export interface FakeRuntime extends RuntimeProvider {
  readonly guest: FakeGuestView;
  /** Every call, in order: the operation kind and the operation id or sandbox ref. */
  readonly calls: { readonly op: string; readonly key: string }[];
  fault(fault: FakeFault): void;
  /** The provider's truth: sandboxes alive now (not killed, not past their timeout). */
  alive(): readonly { readonly ref: string; readonly operationId: string }[];
  /** Sandboxes ever created, killed or not. */
  created(): number;
}

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const pathPattern = /^\/home\/agent\/(work|input|output)\/[a-z][a-z0-9_]{0,31}\.(py|csv|png|xlsx)$/;

export function createFakeRuntime(options: Readonly<FakeRuntimeOptions>): FakeRuntime {
  const templates = new Set(options.templates ?? ["morrow-computer-fake-v1"]);
  const sandboxes = new Map<string, FakeSandbox>();
  const faults: FakeFault[] = [];
  const calls: { op: string; key: string }[] = [];
  const guest: {
    creates: FakeGuestView["creates"][number][];
    files: FakeGuestView["files"][number][];
    commands: FakeGuestView["commands"][number][];
  } = {
    creates: [],
    files: [],
    commands: [],
  };
  let sequence = 0;
  const take = (op: FakeFault["op"]): FakeFault | null => {
    const index = faults.findIndex((f) => f.op === op);
    return index < 0 ? null : (faults.splice(index, 1)[0] ?? null);
  };
  const live = (ref: string): FakeSandbox | null => {
    const sandbox = sandboxes.get(ref);
    return sandbox && !sandbox.killed && options.now() < sandbox.expiresAtMs ? sandbox : null;
  };
  const authorised = (sandbox: SandboxHandle): FakeSandbox | null => {
    const s = live(sandbox.sandboxRef);
    return s && sandbox.accessToken === s.token ? s : null;
  };
  const make = (request: SandboxCreateRequest): FakeSandbox => {
    sequence++;
    const ref = "fake" + String(sequence).padStart(6, "0");
    const sandbox: FakeSandbox = {
      ref,
      operationId: request.operationId,
      token: "fake-envd-token-" + String(sequence).padStart(6, "0"),
      expiresAtMs: options.now() + request.timeoutSeconds * 1000,
      files: new Map(),
      killed: false,
    };
    sandboxes.set(ref, sandbox);
    return sandbox;
  };
  const fake: FakeRuntime = {
    provider: "fake",
    guest: guest as FakeGuestView,
    calls,
    fault(fault: FakeFault) {
      faults.push(fault);
    },
    alive() {
      return [...sandboxes.values()]
        .filter((s) => live(s.ref) !== null)
        .map((s) => Object.freeze({ ref: s.ref, operationId: s.operationId }));
    },
    created() {
      return sandboxes.size;
    },
    async create(request, credential): Promise<RuntimeCreateResult> {
      calls.push({ op: "create", key: request.operationId });
      if (
        !request ||
        !uuid.test(request.operationId) ||
        request.internet !== false ||
        Object.keys(request.metadata).join() !== "operation" ||
        request.metadata.operation !== request.operationId ||
        !Number.isSafeInteger(request.timeoutSeconds) ||
        request.timeoutSeconds < 1 ||
        request.timeoutSeconds > 900
      )
        return { outcome: "not_sent" };
      guest.creates.push({
        template: request.template,
        timeoutSeconds: request.timeoutSeconds,
        internet: request.internet,
        metadata: { ...request.metadata },
      });
      const fault = take("create");
      if (fault && fault.op === "create") {
        if (fault.created) make(request);
        return { outcome: fault.outcome };
      }
      // A wrong key or an unknown template is answered after the send: conservatively unknown.
      if (credential !== options.credential || !templates.has(request.template))
        return { outcome: "unknown_effect" };
      const sandbox = make(request);
      return { outcome: "created", sandboxRef: sandbox.ref, accessToken: sandbox.token };
    },
    async status(operationId, sandboxRef, credential): Promise<RuntimeStatusResult> {
      calls.push({ op: "status", key: operationId });
      const fault = take("status");
      if (credential !== options.credential) return { outcome: "unknown" };
      const found = [...sandboxes.values()].find(
        (s) =>
          s.operationId === operationId &&
          (sandboxRef === null || s.ref === sandboxRef) &&
          live(s.ref),
      );
      if (fault && fault.op === "status") {
        if (fault.outcome === "paused" && found)
          return { outcome: "paused", sandboxRef: found.ref };
        if (fault.outcome === "unknown") return { outcome: "unknown" };
      }
      return found ? { outcome: "running", sandboxRef: found.ref } : { outcome: "not_found" };
    },
    async writeFile(sandbox, path, bytes): Promise<RuntimeWriteResult> {
      calls.push({ op: "write", key: sandbox.sandboxRef });
      if (take("write")) return { outcome: "unknown" };
      const s = authorised(sandbox);
      if (!s || !pathPattern.test(path) || !(bytes instanceof Uint8Array))
        return { outcome: "unknown" };
      const copy = new Uint8Array(bytes);
      s.files.set(path, copy);
      guest.files.push({ sandboxRef: s.ref, path, bytes: copy });
      return { outcome: "written" };
    },
    async exec(sandbox, command: SandboxCommand): Promise<RuntimeExecResult> {
      calls.push({ op: "exec", key: sandbox.sandboxRef });
      if (take("exec")) return { outcome: "unknown" };
      const s = authorised(sandbox);
      if (!s) return { outcome: "unknown" };
      guest.commands.push({
        sandboxRef: s.ref,
        argv: [...command.argv],
        cwd: command.cwd,
        user: command.user,
        environment: {},
      });
      const script = s.files.get(command.argv[command.argv.length - 1] ?? "");
      if (!script) return { outcome: "exited", exitCode: 2, stdout: "", stderr: "no script\n" };
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      for (const line of new TextDecoder().decode(script).split("\n")) {
        const directive = /^#!fake (write|stdout|stderr|exit|hang)(?: (.*))?$/.exec(line);
        if (!directive) continue;
        const [, verb, rest = ""] = directive;
        if (verb === "hang") return { outcome: "timed_out" };
        if (verb === "exit") exitCode = Number(rest);
        if (verb === "stdout") stdout += rest + "\n";
        if (verb === "stderr") stderr += rest + "\n";
        if (verb === "write") {
          const [target = "", data = ""] = rest.split(" ");
          if (!pathPattern.test(target)) continue;
          const binary = atob(data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          s.files.set(target, bytes);
        }
      }
      return {
        outcome: "exited",
        exitCode: Number.isSafeInteger(exitCode) ? exitCode : 1,
        stdout: stdout.slice(0, 4096),
        stderr: stderr.slice(0, 4096),
      };
    },
    async readFile(sandbox, path, maxBytes): Promise<RuntimeReadResult> {
      calls.push({ op: "read", key: sandbox.sandboxRef });
      if (take("read")) return { outcome: "unknown" };
      const s = authorised(sandbox);
      if (!s || !pathPattern.test(path)) return { outcome: "unknown" };
      const bytes = s.files.get(path);
      if (!bytes) return { outcome: "missing" };
      if (bytes.length > maxBytes) return { outcome: "too_large" };
      return { outcome: "read", bytes: new Uint8Array(bytes) };
    },
    async kill(sandboxRef, credential): Promise<RuntimeKillResult> {
      calls.push({ op: "kill", key: sandboxRef });
      const fault = take("kill");
      const s = live(sandboxRef);
      if (fault && fault.op === "kill") {
        if (fault.killed && s) s.killed = true;
        return { outcome: "unknown" };
      }
      if (credential !== options.credential) return { outcome: "unknown" };
      if (!s) return { outcome: "not_found" };
      s.killed = true;
      return { outcome: "killed" };
    },
  };
  return Object.freeze(fake);
}
