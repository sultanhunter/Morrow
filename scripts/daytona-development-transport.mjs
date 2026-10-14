// Operator-only synthetic laboratory. Importing this file does not import or
// construct the SDK, read credentials, connect to a provider, or allocate work.
const organizationId = "8862ff17-6109-4eb1-ac70-2f7bafba64ae";
const apiUrl = "https://app.daytona.io/api";
const currentKeyUrl = `${apiUrl}/api-keys/current`;
const toolboxUrl = "https://proxy.app.daytona.io/toolbox";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const namePrefix = "morrow-dev-lab-";
const labelNames = ["morrowDeadline", "morrowLab", "morrowOperation", "morrowProfile"];
const states = new Set([
  "creating",
  "restoring",
  "destroyed",
  "destroying",
  "started",
  "stopped",
  "starting",
  "stopping",
  "error",
  "build_failed",
  "pending_build",
  "building_snapshot",
  "unknown",
  "pulling_snapshot",
  "archived",
  "archiving",
  "resizing",
  "snapshotting",
  "forking",
  "pausing",
  "paused",
  "resuming",
]);
const deny = () => Error("DEVELOPMENT_LAB_TRANSPORT_DENIED");
const providerFailure = () => Error("DEVELOPMENT_LAB_PROVIDER_FAILED");
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) =>
  plain(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const sameLabels = (left, right) => labelNames.every((key) => left[key] === right[key]);
const ownValue = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

function checkedOfficialOptions(input) {
  try {
    const names = ["apiKey", "organizationId", "region", "mode"];
    if (!exactKeys(input, names)) throw deny();
    const options = Object.fromEntries(names.map((name) => [name, ownValue(input, name)]));
    if (
      typeof options.apiKey !== "string" ||
      options.apiKey.length < 32 ||
      options.apiKey.length > 2048 ||
      /[\x00-\x20\x7f]/.test(options.apiKey) ||
      options.organizationId !== organizationId ||
      options.region !== "us" ||
      !["allocate", "cleanup"].includes(options.mode)
    )
      throw deny();
    return Object.freeze(options);
  } catch {
    throw deny();
  }
}

/**
 * Read-only principal binding BEFORE any SDK client or resource creation.
 * The API-key auth path ignores the SDK's organization selector, so returned
 * key details must independently prove the credential's organization/scopes.
 * The masked value, key name, user and other response fields are never returned.
 */
export async function verifyDaytonaDevelopmentKey(options, injected = {}) {
  options = checkedOfficialOptions(options);
  if (
    !plain(injected) ||
    Object.keys(injected).some((key) => !["fetch", "now"].includes(key)) ||
    (injected.fetch !== undefined && typeof injected.fetch !== "function") ||
    (injected.now !== undefined && typeof injected.now !== "function")
  )
    throw deny();
  const fetchKey = injected.fetch ?? globalThis.fetch;
  const now = injected.now ?? Date.now;
  const expiryWindowMs = options.mode === "cleanup" ? 240_000 : 900_000;
  const controller = new AbortController();
  const failure = () => Error("DEVELOPMENT_LAB_KEY_UNQUALIFIED");
  let timer;
  let reader;
  const work = async () => {
    const response = await fetchKey(currentKeyUrl, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (
      controller.signal.aborted ||
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== currentKeyUrl) ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      !response.body
    )
      throw failure();
    const maximumBytes = 32_768;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximumBytes))
      throw failure();
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (controller.signal.aborted) throw failure();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw failure();
      chunks.push(Buffer.from(chunk.value));
    }
    const value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    const current = now();
    if (
      controller.signal.aborted ||
      !Number.isSafeInteger(current) ||
      current < 0 ||
      !plain(value) ||
      value.organizationId !== organizationId ||
      !Array.isArray(value.permissions) ||
      value.permissions.length !== 2 ||
      value.permissions.some((permission) => typeof permission !== "string") ||
      [...value.permissions].sort().join(",") !== "delete:sandboxes,write:sandboxes" ||
      !Object.hasOwn(value, "expiresAt") ||
      (value.expiresAt !== null &&
        (typeof value.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(value.expiresAt)) ||
          Date.parse(value.expiresAt) < current + expiryWindowMs))
    )
      throw failure();
    return Object.freeze({
      organizationId,
      permissions: Object.freeze(["delete:sandboxes", "write:sandboxes"]),
      mode: options.mode,
      expiresAfterRequiredWindow: true,
    });
  };
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(failure());
        }, 15_000);
      }),
    ]);
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

function operationFromName(name) {
  if (typeof name !== "string" || !name.startsWith(namePrefix)) throw deny();
  const operation = name.slice(namePrefix.length);
  if (!uuid.test(operation)) throw deny();
  return operation;
}

function checkedLabels(name, labels, provider = false) {
  const operation = operationFromName(name);
  const keys = provider ? [...labelNames, "code-toolbox-language"] : labelNames;
  if (
    !exactKeys(labels, keys) ||
    labels.morrowLab !== "P04.T01f" ||
    labels.morrowOperation !== operation ||
    !/^[0-9a-f]{64}$/.test(labels.morrowProfile) ||
    !/^[1-9][0-9]*$/.test(labels.morrowDeadline) ||
    !Number.isSafeInteger(Number(labels.morrowDeadline)) ||
    (provider && labels["code-toolbox-language"] !== "typescript")
  )
    throw deny();
  return Object.fromEntries(labelNames.map((key) => [key, labels[key]]));
}

function checkedCreate(spec) {
  if (
    !exactKeys(spec, [
      "name",
      "labels",
      "organizationId",
      "region",
      "sandboxClass",
      "snapshot",
      "cpu",
      "memoryGiB",
      "diskGiB",
      "autoStopMinutes",
      "autoDeleteMinutes",
      "networkBlockAll",
      "publicPreview",
    ]) ||
    spec.organizationId !== organizationId ||
    spec.region !== "us" ||
    spec.sandboxClass !== "container" ||
    spec.snapshot !== "daytona-small" ||
    spec.cpu !== 1 ||
    spec.memoryGiB !== 1 ||
    spec.diskGiB !== 3 ||
    spec.autoStopMinutes !== 5 ||
    spec.autoDeleteMinutes !== 1 ||
    spec.networkBlockAll !== true ||
    spec.publicPreview !== false
  )
    throw deny();
  return checkedLabels(spec.name, spec.labels);
}

function checkedObservation(sandbox) {
  if (
    !sandbox ||
    typeof sandbox !== "object" ||
    !uuid.test(sandbox.id) ||
    sandbox.organizationId !== organizationId ||
    sandbox.target !== "us" ||
    !["container", "linux-vm", "windows"].includes(sandbox.sandboxClass) ||
    typeof sandbox.snapshot !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(sandbox.snapshot) ||
    ![sandbox.cpu, sandbox.memory, sandbox.disk].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !states.has(sandbox.state)
  )
    throw deny();
  return {
    id: sandbox.id,
    name: sandbox.name,
    labels: checkedLabels(sandbox.name, sandbox.labels, true),
    sandboxClass: sandbox.sandboxClass,
    snapshot: sandbox.snapshot,
    cpu: sandbox.cpu,
    memoryGiB: sandbox.memory,
    diskGiB: sandbox.disk,
    state: sandbox.state,
  };
}

// Ownership and caps are distinct. Return wrong-size owned observations to the
// harness so it can deny execution and still clean up that exact resource.
function checkedExecution(sandbox) {
  const created = Date.parse(sandbox.createdAt);
  const expires = Date.parse(sandbox.autoDestroyAt);
  if (
    sandbox.sandboxClass !== "container" ||
    sandbox.snapshot !== "daytona-small" ||
    sandbox.cpu !== 1 ||
    sandbox.memory !== 1 ||
    sandbox.disk !== 3 ||
    sandbox.public !== false ||
    sandbox.autoStopInterval !== 5 ||
    sandbox.autoPauseInterval !== 0 ||
    sandbox.autoDeleteInterval !== 1 ||
    sandbox.networkBlockAll !== true ||
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    expires <= created ||
    expires - created > 600_000 ||
    !plain(sandbox.env) ||
    Object.keys(sandbox.env).length !== 0 ||
    (sandbox.volumes !== undefined &&
      (!Array.isArray(sandbox.volumes) || sandbox.volumes.length !== 0)) ||
    (sandbox.linkedSandboxId !== undefined && sandbox.linkedSandboxId !== null) ||
    (sandbox.kvm !== undefined && sandbox.kvm !== false) ||
    (sandbox.gpu !== undefined && sandbox.gpu !== 0) ||
    (sandbox.domainAllowList !== undefined && sandbox.domainAllowList !== "") ||
    (sandbox.networkAllowList !== undefined && sandbox.networkAllowList !== "") ||
    (sandbox.outboundProxyUrl !== undefined && sandbox.outboundProxyUrl !== "")
  )
    throw deny();
  if (
    typeof sandbox.toolboxProxyUrl !== "string" ||
    ![toolboxUrl, `${toolboxUrl}/`].includes(sandbox.toolboxProxyUrl)
  )
    throw deny();
}

/**
 * @param {{client: object, NotFoundError: Function, now?: () => number, mode?: 'allocate'|'cleanup'}} options
 * @returns {import('../packages/infrastructure/src/daytona-development-lab.ts').DevelopmentLabPort & {dispose(): Promise<void>}}
 */
export function createDaytonaDevelopmentTransport(options) {
  if (
    !plain(options) ||
    Object.keys(options).some((key) => !["client", "NotFoundError", "now", "mode"].includes(key)) ||
    !options.client ||
    typeof options.client.create !== "function" ||
    typeof options.client.get !== "function" ||
    typeof options.NotFoundError !== "function" ||
    (options.now !== undefined && typeof options.now !== "function") ||
    (options.mode !== undefined && !["allocate", "cleanup"].includes(options.mode))
  )
    throw deny();
  const { client, NotFoundError } = options;
  const mode = options.mode ?? "allocate";
  const now = options.now ?? Date.now;
  const bindings = new Map();
  let disposed = false;

  const remaining = (context) => {
    if (
      disposed ||
      !exactKeys(context, ["deadlineMs", "signal"]) ||
      !Number.isSafeInteger(context.deadlineMs) ||
      !(context.signal instanceof AbortSignal)
    )
      throw deny();
    if (context.signal.aborted) throw Error("DEVELOPMENT_LAB_CANCELLED");
    const time = now();
    if (!Number.isSafeInteger(time) || context.deadlineMs <= time)
      throw Error("DEVELOPMENT_LAB_DEADLINE");
    return Math.min(60_000, context.deadlineMs - time);
  };
  const bounded = async (context, effect) => {
    const milliseconds = remaining(context);
    let timer;
    let listener;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          remaining(context);
          return effect();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("DEVELOPMENT_LAB_DEADLINE")), milliseconds);
          listener = () => reject(Error("DEVELOPMENT_LAB_CANCELLED"));
          context.signal.addEventListener("abort", listener, { once: true });
          if (context.signal.aborted) listener();
        }),
      ]);
    } catch (error) {
      const code = ownValue(error, "message");
      if (
        typeof code === "string" &&
        [
          "DEVELOPMENT_LAB_CANCELLED",
          "DEVELOPMENT_LAB_DEADLINE",
          "DEVELOPMENT_LAB_TRANSPORT_DENIED",
        ].includes(code)
      )
        throw Error(code);
      // The wrapper deliberately drops the SDK message, headers, Axios config,
      // request, response and cause. None belongs in a persisted failure report.
      throw providerFailure();
    } finally {
      clearTimeout(timer);
      if (listener) context.signal.removeEventListener("abort", listener);
    }
  };
  const seconds = (context) => Math.max(0.001, remaining(context) / 1000);
  const notFound = (error) => {
    try {
      return (
        error instanceof NotFoundError &&
        ownValue(error, "statusCode") === 404 &&
        ownValue(error, "source") === "DAYTONA_API"
      );
    } catch {
      return false;
    }
  };
  const bind = (sandbox, expectedId, expectedName) => {
    const observed = checkedObservation(sandbox);
    if (
      (expectedId && observed.id !== expectedId) ||
      (expectedName && observed.name !== expectedName)
    )
      throw deny();
    const old = bindings.get(observed.id);
    if (old && (old.name !== observed.name || !sameLabels(old.labels, observed.labels)))
      throw deny();
    bindings.set(observed.id, {
      name: observed.name,
      labels: Object.freeze({ ...observed.labels }),
    });
    return observed;
  };
  const lookup = async (key, context, id = false) => {
    if (id ? !uuid.test(key) : !operationFromName(key)) throw deny();
    return bounded(context, async () => {
      let sandbox;
      try {
        sandbox = await client.get(key);
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
      bind(sandbox, id ? key : undefined, id ? undefined : key);
      return sandbox;
    });
  };
  const ownedForEffect = async (id, context, execution = false) => {
    if (!bindings.has(id)) throw deny();
    const sandbox = await lookup(id, context, true);
    if (!sandbox) throw deny();
    if (execution) checkedExecution(sandbox);
    return sandbox;
  };
  const marker = (id, path, value) => {
    const binding = bindings.get(id);
    if (!binding) throw deny();
    const operation = operationFromName(binding.name);
    const expectedPath = `/tmp/morrow-dev-lab-${operation}.txt`;
    const expectedValue = `MORROW_SYNTHETIC_PERSISTENCE_V1:${operation}\n`;
    if (path !== expectedPath || (value !== undefined && value !== expectedValue)) throw deny();
    return expectedValue;
  };
  const allocationOrProbe = () => {
    if (mode !== "allocate") throw deny();
  };
  return Object.freeze({
    async create(spec, context) {
      allocationOrProbe();
      const labels = checkedCreate(spec);
      const sandbox = await bounded(context, () =>
        client.create(
          {
            name: spec.name,
            labels: { ...labels },
            snapshot: "daytona-small",
            language: "typescript",
            target: "us",
            public: false,
            envVars: {},
            autoStopInterval: 5,
            autoPauseInterval: 0,
            autoArchiveInterval: 60,
            autoDeleteInterval: 1,
            ttlMinutes: 10,
            queueTimeout: 1,
            // Tier1 retains essential-service exceptions; this is not strict egress.
            networkBlockAll: true,
          },
          { timeout: seconds(context) },
        ),
      );
      return bind(sandbox, undefined, spec.name);
    },
    async getByName(name, context) {
      const sandbox = await lookup(name, context);
      return sandbox ? checkedObservation(sandbox) : null;
    },
    async inspect(id, context) {
      const sandbox = await lookup(id, context, true);
      return sandbox ? checkedObservation(sandbox) : null;
    },
    async writeMarker(id, path, value, context) {
      allocationOrProbe();
      marker(id, path, value);
      const sandbox = await ownedForEffect(id, context, true);
      await bounded(context, () =>
        sandbox.fs.uploadFile(Buffer.from(value, "utf8"), path, seconds(context)),
      );
    },
    async readMarker(id, path, context) {
      allocationOrProbe();
      const expected = marker(id, path);
      const sandbox = await ownedForEffect(id, context, true);
      const result = await bounded(context, () => sandbox.fs.downloadFile(path, seconds(context)));
      if (!Buffer.isBuffer(result) || !result.equals(Buffer.from(expected, "utf8"))) throw deny();
      return expected;
    },
    async stop(id, context) {
      allocationOrProbe();
      const sandbox = await ownedForEffect(id, context, true);
      await bounded(context, () => sandbox.stop(seconds(context)));
      // SDK stop may resolve on DESTROYED. The harness separately inspects and
      // requires STOPPED before it can claim persistence and restart.
    },
    async start(id, context) {
      allocationOrProbe();
      const sandbox = await ownedForEffect(id, context, true);
      if (sandbox.state !== "stopped") throw deny();
      await bounded(context, () => sandbox.start(seconds(context)));
    },
    async delete(id, context) {
      const sandbox = await ownedForEffect(id, context);
      await bounded(context, () => sandbox.delete(seconds(context), true));
      // Verify the immutable ID, never a name that may have been reused.
      const terminal = await lookup(id, context, true);
      if (terminal && terminal.state !== "destroyed") throw providerFailure();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      bindings.clear();
      try {
        await client[Symbol.asyncDispose]?.();
      } catch {
        throw providerFailure();
      }
    },
  });
}

// Only the opted-in CLI calls this after account, free-credit, journal, source
// and private-access gates. Full destination/key config avoids implicit SDK
// credential/default selection. The caller denies DAYTONA_* and .env inputs.
export async function createOfficialDaytonaDevelopmentTransport(options) {
  options = checkedOfficialOptions(options);
  await verifyDaytonaDevelopmentKey(options);
  try {
    const sdk = await import("@daytona/sdk");
    const client = new sdk.Daytona({
      apiKey: options.apiKey,
      apiUrl,
      organizationId,
      target: "us",
      requestTimeoutMs: 15_000,
      otelEnabled: false,
      useDeprecatedPolling: true,
    });
    return createDaytonaDevelopmentTransport({
      client,
      NotFoundError: sdk.DaytonaNotFoundError,
      mode: options.mode,
    });
  } catch {
    throw providerFailure();
  }
}
