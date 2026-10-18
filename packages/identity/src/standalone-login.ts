import {
  assertManagedLoginSealEligibility,
  importManagedLoginKeyring,
  parseManagedLoginKeyring,
  selectManagedLoginOpenKey,
  selectManagedLoginSealKey,
  type ResolvedManagedLoginKeyring,
} from "./managed-login-capsule.js";
import {
  bindManagedLoginRequestNamespace,
  snapshotManagedLoginRequestMetrics,
  type ManagedLoginRequestScope,
  type ManagedLoginRequestOwnerToken,
} from "./managed-login-request-scope.js";
import {
  createWorkersRequestBoundNeonLoginPools,
  snapshotControlledNeonLoginPoolMetrics,
  type ControlledNeonLoginPools,
} from "./controlled-neon-login-pool.js";
import { ownRecord, wellFormed } from "./controlled-neon-login-profiles.js";
import { createLoginFlowCustody } from "./login-flow-custody.js";
import { createWorkosAuthenticationEvidence } from "./workos-authentication-evidence.js";
import { createWorkosAccountAdmission } from "./workos-browser-session-admission.js";
import type { WorkosSessionPageReader } from "./workos-session-status.js";
import { runControlledPreauth, type LoginControlledSqlPool } from "./login-preauth-control.js";
import {
  createLoginAttempt,
  LoginInputError,
  loginBase64,
  loginBytes,
  loginCallbackInput,
  loginFailure,
  loginHash,
  loginJson,
  loginRequestEnvelope,
  loginSecret,
  loginStartInput,
  loginTime,
  loginUuid,
  parseLoginConfiguration,
  parseLoginConfigurationWithAttempt,
  type LoginAttempt,
  type LoginControl,
} from "./standalone-login-protocol.js";

export interface AuthDeliveryPlan {
  readonly status: 200 | 303 | 400 | 403 | 404 | 405 | 503;
  readonly headers: readonly (readonly [string, string])[];
  readonly cookies: readonly string[];
  readonly bodyText: string;
}
export type AuthDeliverySink = (plan: Readonly<AuthDeliveryPlan>) => void;
export interface FixedWorkosLoginPort {
  exchange(inputJson: string, control: Readonly<LoginControl>): Promise<string>;
  readPublicKeyset(control: Readonly<LoginControl>): Promise<string>;
  readonly readSessionPage: WorkosSessionPageReader;
}
export interface StandaloneLoginDependencies {
  readonly configurationJson: string;
  readonly loginPool: LoginControlledSqlPool;
  readonly preauthPool: LoginControlledSqlPool;
  readonly sessionPool: LoginControlledSqlPool;
  readonly providerPort: Readonly<FixedWorkosLoginPort>;
  readonly now: () => number;
}
const encoder = new TextEncoder();
function plan(
  status: AuthDeliveryPlan["status"],
  bodyText = "",
  extra: readonly (readonly [string, string])[] = [],
  cookies: readonly string[] = [],
): Readonly<AuthDeliveryPlan> {
  const headers: readonly (readonly [string, string])[] = Object.freeze([
    Object.freeze(["cache-control", "no-store"] as const),
    Object.freeze(["x-content-type-options", "nosniff"] as const),
    Object.freeze(["referrer-policy", "no-referrer"] as const),
    ...extra.map((pair) => Object.freeze([...pair] as [string, string])),
  ]);
  return Object.freeze({ status, headers, cookies: Object.freeze([...cookies]), bodyText });
}
const unavailable = (status: AuthDeliveryPlan["status"] = 503) =>
  plan(status, JSON.stringify({ schemaVersion: 1, outcome: "login_unavailable" }), [
    ["content-type", "application/json; charset=utf-8"],
  ]);
const failedCallback = () => plan(303, "", [["location", "/auth/result"]]);
const resultPage = () =>
  plan(
    200,
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in unavailable</title><p>Sign-in could not be completed. Please start again.</p><a href="/">Return to Morrow</a></html>',
    [
      ["content-type", "text/html; charset=utf-8"],
      ["content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"],
    ],
  );
const cookie = (name: string, secret: string, age: number) =>
  `${name}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const decimal = (value: unknown): number => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,15})$/.test(value) ||
    !loginTime(Number(value))
  )
    throw loginFailure();
  return Number(value);
};
// Trusted source composition. No native provider adapter or normal application
// entrypoint is enabled by constructing this factory.

type Configuration = Awaited<ReturnType<typeof parseLoginConfiguration>>;
type Capsule =
  | Readonly<{ kind: "ephemeral"; key: CryptoKey; keyId: string }>
  | Readonly<{ kind: "managed"; keyring: ResolvedManagedLoginKeyring }>;
type CoreContext = Readonly<
  Omit<StandaloneLoginDependencies, "configurationJson"> & {
    config: Configuration;
    capsule: Capsule;
  }
>;
type LoginCore = ReturnType<typeof createLoginCore>;
declare const constructionBrand: unique symbol;
declare const setupBrand: unique symbol;
export type ManagedLoginConstruction = Readonly<{ [constructionBrand]: true }>;
export type StandaloneLoginSetup = Readonly<{ [setupBrand]: true }>;
export interface ManagedLoginDependencies {
  readonly configurationJson: string;
  readonly capsuleKeyringJson: string;
  readonly bindingJson: string;
  readonly credentialBroker: unknown;
  readonly providerPort: Readonly<FixedWorkosLoginPort>;
  readonly now: () => number;
}
type Construction = {
  configurationJson: string;
  capsuleKeyringJson: string;
  bindingJson: string;
  credentialBroker: unknown;
  provider: Readonly<FixedWorkosLoginPort>;
  now: () => number;
  cache?: Readonly<{ config: Configuration; keyring: ResolvedManagedLoginKeyring }>;
};
type Setup = {
  kind: "ephemeral" | "managed";
  enteredAt: number;
  entryError?: unknown;
  core?: LoginCore;
  config?: Configuration;
  construction?: Construction;
  scope?: ManagedLoginRequestScope | undefined;
  ownerToken?: ManagedLoginRequestOwnerToken | undefined;
  pools?: ControlledNeonLoginPools;
  cacheHit?: boolean;
};
const constructions = new WeakMap<object, Construction>();
const setups = new WeakMap<object, Setup>();
function issueSetup(value: Setup): StandaloneLoginSetup {
  const handle = Object.freeze(Object.create(null)) as StandaloneLoginSetup;
  setups.set(handle, value);
  return handle;
}
// A constructor owns a complete captured definition and only resolved cache
// entries. No request context/control/scope/client or pending IO is cached here.
export function captureManagedLoginConstruction(
  dependencies: ManagedLoginDependencies,
): Readonly<{ construction: ManagedLoginConstruction; now: () => number }> {
  try {
    const d = ownRecord(dependencies, [
      "configurationJson",
      "capsuleKeyringJson",
      "bindingJson",
      "credentialBroker",
      "providerPort",
      "now",
    ]);
    for (const [name, limit] of [
      ["configurationJson", 32768],
      ["capsuleKeyringJson", 4096],
      ["bindingJson", 8192],
    ] as const) {
      const text = d[name];
      if (typeof text !== "string" || !wellFormed(text) || encoder.encode(text).length > limit)
        throw loginFailure();
    }
    const broker = ownRecord(d.credentialBroker, ["borrow"]);
    const port = ownRecord(d.providerPort, ["exchange", "readPublicKeyset", "readSessionPage"]);
    if (
      typeof d.now !== "function" ||
      typeof broker.borrow !== "function" ||
      Object.values(port).some((method) => typeof method !== "function")
    )
      throw loginFailure();
    const trustedNow = d.now as () => number;
    let last = -1,
      bad = false;
    const now = () => {
      try {
        const at = trustedNow();
        if (bad || !loginTime(at) || at < last) throw loginFailure();
        last = at;
        return at;
      } catch {
        bad = true;
        throw loginFailure();
      }
    };
    const provider = Object.freeze({
      exchange: (port.exchange as FixedWorkosLoginPort["exchange"]).bind(d.providerPort),
      readPublicKeyset: (port.readPublicKeyset as FixedWorkosLoginPort["readPublicKeyset"]).bind(
        d.providerPort,
      ),
      readSessionPage: (port.readSessionPage as FixedWorkosLoginPort["readSessionPage"]).bind(
        d.providerPort,
      ),
    }) as Readonly<FixedWorkosLoginPort>;
    const record: Construction = {
      configurationJson: d.configurationJson as string,
      capsuleKeyringJson: d.capsuleKeyringJson as string,
      bindingJson: d.bindingJson as string,
      credentialBroker: Object.freeze({ borrow: broker.borrow.bind(d.credentialBroker) }),
      provider,
      now,
    };
    const construction = Object.freeze(Object.create(null)) as ManagedLoginConstruction;
    constructions.set(construction, record);
    return Object.freeze({ construction, now });
  } catch {
    throw Error("STANDALONE_LOGIN_CONFIGURATION_INVALID");
  }
}
export function createManagedStandaloneLoginSetup(
  construction: ManagedLoginConstruction,
  enteredAt: number,
  scope?: ManagedLoginRequestScope,
  ownerToken?: ManagedLoginRequestOwnerToken,
  entryError?: unknown,
): StandaloneLoginSetup {
  const record = constructions.get(construction);
  if (!record) throw loginFailure();
  return issueSetup({
    kind: "managed",
    construction: record,
    enteredAt,
    scope,
    ownerToken,
    entryError,
  });
}
async function managedCore(setup: Setup, attempt: LoginAttempt, seal: boolean): Promise<LoginCore> {
  const d = setup.construction;
  if (!d || !setup.scope || !setup.ownerToken) throw loginFailure();
  attempt.check();
  let resolved = d.cache;
  setup.cacheHit = resolved !== undefined;
  if (!resolved) {
    const config = await parseLoginConfigurationWithAttempt(d.configurationJson, attempt);
    attempt.check();
    const definition = parseManagedLoginKeyring(d.capsuleKeyringJson, config.configurationDigest);
    if (seal) assertManagedLoginSealEligibility(definition, attempt);
    attempt.check();
    const pending = importManagedLoginKeyring(definition, attempt);
    void pending.catch(() => {});
    const keyring = await attempt.wait(pending);
    if (seal) assertManagedLoginSealEligibility(keyring, attempt);
    attempt.check();
    resolved = Object.freeze({ config, keyring });
  } else if (seal) assertManagedLoginSealEligibility(resolved.keyring, attempt);
  attempt.check();
  bindManagedLoginRequestNamespace(
    setup.scope,
    setup.ownerToken,
    resolved.config.configurationDigest,
  );
  attempt.check();
  const pendingPools = createWorkersRequestBoundNeonLoginPools(
    {
      bindingJson: d.bindingJson,
      credentialBroker: d.credentialBroker,
      now: d.now,
    },
    setup.scope,
    setup.ownerToken,
    resolved.config.configurationDigest,
  );
  void pendingPools.catch(() => {});
  const pools = await attempt.wait(pendingPools);
  attempt.check();
  if (seal) assertManagedLoginSealEligibility(resolved.keyring, attempt);
  // All cached values are resolved and immutable, tied to this entire captured
  // construction. A different handler/ring has a different private cache.
  d.cache = resolved;
  setup.pools = pools;
  setup.config = resolved.config;
  return createLoginCore({
    ...pools,
    providerPort: d.provider,
    now: d.now,
    config: resolved.config,
    capsule: Object.freeze({ kind: "managed", keyring: resolved.keyring }),
  });
}
export function snapshotManagedStandaloneLoginSetup(handle: StandaloneLoginSetup) {
  const s = setups.get(handle);
  if (!s || s.kind !== "managed") throw loginFailure();
  return Object.freeze({
    cacheHit: s.cacheHit === true,
    cacheResolved: s.construction?.cache !== undefined,
    scope:
      s.scope && s.ownerToken ? snapshotManagedLoginRequestMetrics(s.scope, s.ownerToken) : null,
    pools: s.pools ? snapshotControlledNeonLoginPoolMetrics(s.pools) : null,
  });
}
export function standaloneLoginResponseFromPlan(output: Readonly<AuthDeliveryPlan>): Response {
  const headers = new Headers(
    output.headers.map(([name, value]) => [name, value] as [string, string]),
  );
  for (const value of output.cookies) headers.append("Set-Cookie", value);
  return new Response(output.bodyText, { status: output.status, headers });
}
export async function createStandaloneLoginBridge(dependencies: StandaloneLoginDependencies) {
  let config: Awaited<ReturnType<typeof parseLoginConfiguration>>;
  let loginPool: LoginControlledSqlPool,
    preauthPool: LoginControlledSqlPool,
    sessionPool: LoginControlledSqlPool;
  let provider: Readonly<FixedWorkosLoginPort>, now: () => number;
  try {
    config = await parseLoginConfiguration(dependencies.configurationJson);
    ({ loginPool, preauthPool, sessionPool, now } = dependencies);
    provider = dependencies.providerPort;
    if (
      [loginPool, preauthPool, sessionPool].some(
        (pool) => !pool || typeof pool.connect !== "function",
      ) ||
      typeof now !== "function" ||
      !provider ||
      typeof provider.exchange !== "function" ||
      typeof provider.readPublicKeyset !== "function" ||
      typeof provider.readSessionPage !== "function" ||
      new Set([loginPool, preauthPool, sessionPool]).size !== 3
    )
      throw loginFailure();
  } catch {
    throw Error("STANDALONE_LOGIN_CONFIGURATION_INVALID");
  }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const keyId = crypto.randomUUID();
  const core = createLoginCore({
    config,
    loginPool,
    preauthPool,
    sessionPool,
    providerPort: provider,
    now,
    capsule: Object.freeze({ kind: "ephemeral", key, keyId }),
  });
  const dispatch = async (request: Request, sink: AuthDeliverySink): Promise<void> => {
    let attempt: LoginAttempt | undefined, entryError: unknown;
    try {
      if (typeof sink === "function" && request instanceof Request)
        attempt = createLoginAttempt(now, request.signal, 25000);
    } catch (error) {
      entryError = error;
    }
    const setup = issueSetup({
      kind: "ephemeral",
      core,
      config,
      enteredAt: attempt ? attempt.control().deadlineMs - 25000 : 0,
      entryError,
    });
    try {
      await dispatchStandaloneLoginWithAttempt(request, sink, attempt, setup);
    } finally {
      attempt?.end();
    }
  };
  const fetch = async (request: Request): Promise<Response> => {
    let response: Response | undefined;
    await dispatch(request, (output) => {
      response = standaloneLoginResponseFromPlan(output);
    });
    if (!response) throw loginFailure();
    return response;
  };
  return Object.freeze({ fetch, dispatch });
}
function createLoginCore(context: CoreContext) {
  const {
    config,
    loginPool,
    preauthPool,
    sessionPool,
    now,
    providerPort: provider,
    capsule,
  } = context;
  const managed = capsule.kind === "managed";
  const hashFor = (text: string, attempt: LoginAttempt) => {
    if (managed) attempt.check();
    const pending = loginHash(text);
    if (managed) void pending.catch(() => {});
    return pending;
  };
  const retainLateBufferSink = (pending: Promise<ArrayBuffer>, attempt: LoginAttempt) => {
    if (managed)
      void pending.then(
        (buffer) => {
          try {
            attempt.check();
          } catch {
            new Uint8Array(buffer).fill(0);
          }
        },
        () => {},
      );
  };
  const custody = createLoginFlowCustody({ pool: loginPool, now });
  // An account flow has no workspace: its AAD element is JSON null, exactly as the
  // 0010 bind check's array_to_json renders a NULL workspace_id (0013).
  const aad = (fields: readonly (string | null)[]) =>
    encoder.encode(
      JSON.stringify(["morrow.login.capsule", "1", config.configurationDigest, ...fields]),
    );
  type Finalize = () => Readonly<AuthDeliveryPlan>;
  const start = async (request: Request, attempt: LoginAttempt): Promise<Finalize> => {
    if (capsule.kind === "managed") assertManagedLoginSealEligibility(capsule.keyring, attempt);
    await loginStartInput(request, attempt);
    const freshId = () => {
      if (managed) attempt.check();
      const id = crypto.randomUUID();
      if (managed) attempt.check();
      return id;
    };
    const ids = [freshId(), freshId(), freshId(), freshId()];
    if (new Set(ids).size !== 4) throw loginFailure();
    const [flowId, beginCommandId, admissionCommandId, issuerCommandId] = ids as [
      string,
      string,
      string,
      string,
    ];
    if (capsule.kind === "managed") assertManagedLoginSealEligibility(capsule.keyring, attempt);
    const intent = await attempt.wait(
      custody.createAccountIntent(
        JSON.stringify({
          schemaVersion: 1,
          configurationDigest: config.configurationDigest,
          flowId,
          beginCommandId,
          admissionCommandId,
          issuerCommandId,
        }),
        attempt.control(),
      ),
    );
    if (
      intent.outcome !== "newly_created" ||
      intent.flow_id !== flowId ||
      !intent.flow_revision ||
      !intent.expires_at_ms
    )
      throw loginFailure();
    const expiresAt = decimal(intent.expires_at_ms);
    attempt.cap(expiresAt);
    const selectedKey =
      capsule.kind === "managed"
        ? selectManagedLoginSealKey(capsule.keyring, attempt, expiresAt)
        : capsule;
    const { key, keyId } = selectedKey;
    const checkSeal = () => {
      if (capsule.kind === "managed") {
        const current = selectManagedLoginSealKey(capsule.keyring, attempt, expiresAt);
        if (current.keyId !== keyId || current.key !== key) throw loginFailure();
      }
    };
    const material = await runControlledPreauth(
      preauthPool,
      config.authenticationBindingJson,
      attempt,
      (service) => service.begin(JSON.stringify({ commandId: beginCommandId })),
    );
    if (
      !material ||
      !loginUuid(material.challengeId) ||
      ![material.state, material.browserProof, material.verifier, material.codeChallenge].every(
        loginSecret,
      ) ||
      material.codeChallengeMethod !== "S256"
    )
      throw loginFailure();
    if (managed) attempt.check();
    const opaqueBytes = crypto.getRandomValues(new Uint8Array(32));
    let opaque: string;
    try {
      if (managed) attempt.check();
      opaque = loginBase64(opaqueBytes);
    } finally {
      opaqueBytes.fill(0);
    }
    const [stateDigest, cookieDigest, browserProofDigest, verifierDigest] = await attempt.wait(
      Promise.all([
        hashFor(material.state, attempt),
        hashFor(opaque, attempt),
        hashFor(material.browserProof, attempt),
        hashFor(material.verifier, attempt),
      ]),
    );
    const aadBytes = aad([
      flowId,
      material.challengeId,
      beginCommandId,
      admissionCommandId,
      issuerCommandId,
      null,
      intent.expires_at_ms,
      stateDigest,
      cookieDigest,
      browserProofDigest,
      verifierDigest,
      keyId,
    ]);
    const aadDigest = await attempt.wait(hashFor(new TextDecoder().decode(aadBytes), attempt));
    if (managed) attempt.check();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    let ciphertext: string;
    let sealed = false;
    try {
      if (managed) attempt.check();
      plaintext = encoder.encode(
        JSON.stringify({
          schemaVersion: 1,
          browserProof: material.browserProof,
          verifier: material.verifier,
        }),
      );
      checkSeal();
      if (managed) attempt.check();
      const pending = crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aadBytes, tagLength: 128 },
        key,
        plaintext,
      );
      retainLateBufferSink(pending, attempt);
      let result: ArrayBuffer;
      try {
        result = await attempt.wait(pending);
      } catch (error) {
        if (managed)
          void pending.then(
            (buffer) => new Uint8Array(buffer).fill(0),
            () => {},
          );
        throw error;
      }
      const encrypted = new Uint8Array(result);
      try {
        checkSeal();
        ciphertext = loginBase64(encrypted);
        sealed = true;
      } finally {
        if (managed) encrypted.fill(0);
      }
    } finally {
      plaintext?.fill(0);
      if (!sealed) nonce.fill(0);
    }
    let ready: Awaited<ReturnType<typeof custody.bindBegin>>;
    try {
      checkSeal();
      ready = await attempt.wait(
        custody.bindBegin(
          JSON.stringify({
            schemaVersion: 1,
            configurationDigest: config.configurationDigest,
            flowId,
            expectedRevision: intent.flow_revision,
            challengeId: material.challengeId,
            stateDigest,
            cookieDigest,
            browserProofDigest,
            verifierDigest,
            ciphertext,
            encryptionNonce: loginBase64(nonce),
            keyId,
            aadDigest,
          }),
          attempt.control(),
        ),
      );
    } finally {
      nonce.fill(0);
    }
    checkSeal();
    if (
      ready.outcome !== "newly_ready" ||
      ready.flow_id !== flowId ||
      ready.expires_at_ms !== intent.expires_at_ms
    )
      throw loginFailure();
    const authorization = new URL("https://api.workos.com/user_management/authorize");
    for (const [name, value] of Object.entries({
      client_id: config.binding.clientId,
      redirect_uri: config.binding.redirectUri,
      response_type: "code",
      provider: "authkit",
      state: material.state,
      code_challenge: material.codeChallenge,
      code_challenge_method: "S256",
    }))
      authorization.searchParams.set(name, value);
    const body = JSON.stringify({ schemaVersion: 1, authorizationUrl: authorization.href });
    return () => {
      checkSeal();
      const at = attempt.check(),
        age = Math.min(300, Math.floor((expiresAt - at) / 1000));
      if (age <= 0) throw loginFailure();
      return plan(
        200,
        body,
        [["content-type", "application/json; charset=utf-8"]],
        [cookie("__Host-morrow_login", opaque, age)],
      );
    };
  };
  const callback = async (request: Request, url: URL, attempt: LoginAttempt): Promise<Finalize> => {
    const input = loginCallbackInput(request, url);
    const [cookieDigest, stateDigest, codeDigest] = await attempt.wait(
      Promise.all([
        hashFor(input.cookie, attempt),
        hashFor(input.state, attempt),
        hashFor(input.code, attempt),
      ]),
    );
    const claimed = await attempt.wait(
      custody.claimCallback(
        JSON.stringify({
          schemaVersion: 1,
          configurationDigest: config.configurationDigest,
          cookieDigest,
          stateDigest,
          codeDigest,
        }),
        attempt.control(),
      ),
    );
    if (
      claimed.outcome !== "newly_claimed" ||
      !claimed.flow_id ||
      !claimed.expires_at_ms ||
      !claimed.challenge_id ||
      !claimed.begin_command_id ||
      !claimed.admission_command_id ||
      !claimed.issuer_command_id ||
      claimed.workspace_id !== null ||
      !claimed.ciphertext ||
      !claimed.encryption_nonce ||
      !claimed.aad_digest ||
      !claimed.browser_proof_digest ||
      !claimed.verifier_digest ||
      (capsule.kind === "ephemeral"
        ? claimed.key_id !== capsule.keyId
        : !loginUuid(claimed.key_id)) ||
      claimed.cookie_digest !== cookieDigest ||
      claimed.state_digest !== stateDigest ||
      claimed.code_digest !== codeDigest
    )
      throw loginFailure();
    const expiresAt = decimal(claimed.expires_at_ms);
    attempt.cap(expiresAt);
    const selectedKey =
      capsule.kind === "managed"
        ? selectManagedLoginOpenKey(capsule.keyring, claimed.key_id!, attempt, expiresAt)
        : capsule;
    const { key, keyId } = selectedKey;
    const checkOpen = () => {
      if (capsule.kind === "managed") {
        const current = selectManagedLoginOpenKey(
          capsule.keyring,
          claimed.key_id!,
          attempt,
          expiresAt,
        );
        if (current.keyId !== keyId || current.key !== key) throw loginFailure();
      }
    };
    const aadBytes = aad([
      claimed.flow_id,
      claimed.challenge_id,
      claimed.begin_command_id,
      claimed.admission_command_id,
      claimed.issuer_command_id,
      null,
      claimed.expires_at_ms,
      stateDigest,
      cookieDigest,
      claimed.browser_proof_digest,
      claimed.verifier_digest,
      keyId,
    ]);
    if (
      (await attempt.wait(hashFor(new TextDecoder().decode(aadBytes), attempt))) !==
      claimed.aad_digest
    )
      throw loginFailure();
    const nonce = loginBytes(claimed.encryption_nonce, 12),
      ciphertext = loginBytes(claimed.ciphertext, 512);
    if (nonce.length !== 12 || ciphertext.length < 16) throw loginFailure();
    let plaintext: Uint8Array | undefined;
    let proof: Readonly<Record<string, unknown>>;
    try {
      checkOpen();
      if (managed) attempt.check();
      const pending = crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aadBytes, tagLength: 128 },
        key,
        ciphertext,
      );
      retainLateBufferSink(pending, attempt);
      try {
        plaintext = new Uint8Array(await attempt.wait(pending));
      } catch (error) {
        if (managed)
          void pending.then(
            (buffer) => new Uint8Array(buffer).fill(0),
            () => {},
          );
        throw error;
      }
      checkOpen();
      proof = loginJson(new TextDecoder("utf-8", { fatal: true }).decode(plaintext), 512, [
        "schemaVersion",
        "browserProof",
        "verifier",
      ]);
    } finally {
      plaintext?.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
    }
    if (
      proof.schemaVersion !== 1 ||
      !loginSecret(proof.browserProof) ||
      !loginSecret(proof.verifier) ||
      (await attempt.wait(hashFor(proof.browserProof, attempt))) !== claimed.browser_proof_digest ||
      (await attempt.wait(hashFor(proof.verifier, attempt))) !== claimed.verifier_digest
    )
      throw loginFailure();
    const reserved = await runControlledPreauth(
      preauthPool,
      config.authenticationBindingJson,
      attempt,
      (service) =>
        service.admit(
          JSON.stringify({
            commandId: claimed.admission_command_id,
            challengeId: claimed.challenge_id,
            state: input.state,
            browserProof: proof.browserProof,
            verifier: proof.verifier,
            code: input.code,
          }),
        ),
    );
    if (
      reserved.outcome !== "newly_reserved" ||
      reserved.commandId !== claimed.admission_command_id ||
      !loginUuid(reserved.admissionId)
    )
      throw loginFailure();
    // These latches are lexical to this original claim. Historical status is not
    // read here, and can never rebuild a reservation or enter this port gate.
    let exchangeEntered = false,
      issuerEntered = false;
    const eligible = async (childControl?: Readonly<LoginControl>) => {
      attempt.check();
      const observed = await attempt.wait(
        custody.observeEligibility(
          JSON.stringify({
            schemaVersion: 1,
            flowId: claimed.flow_id,
            configurationDigest: config.configurationDigest,
          }),
          childControl
            ? Object.freeze({
                deadlineMs: Math.min(childControl.deadlineMs, attempt.control().deadlineMs),
                signal: childControl.signal,
              })
            : attempt.control(),
        ),
      );
      if (
        observed.matches !== true ||
        decimal(observed.database_now_ms) >= decimal(claimed.expires_at_ms)
      )
        throw loginFailure();
      attempt.check();
    };
    await eligible();
    if (exchangeEntered) throw loginFailure();
    exchangeEntered = true;
    const exchangeDeadline = Math.min(attempt.check() + 10000, attempt.control().deadlineMs);
    const exchangeAbort = new AbortController(),
      parentSignal = attempt.control().signal;
    const stopExchange = () => exchangeAbort.abort();
    parentSignal.addEventListener("abort", stopExchange, { once: true });
    const exchangeControl = Object.freeze({
      deadlineMs: exchangeDeadline,
      signal: exchangeAbort.signal,
    });
    let exchangeTimer: ReturnType<typeof setTimeout> | undefined;
    let exchangeText: string;
    const stopped = new Promise<never>((_, reject) =>
      exchangeAbort.signal.addEventListener("abort", () => reject(loginFailure()), { once: true }),
    );
    if (managed) void stopped.catch(() => {});
    try {
      attempt.check();
      if (parentSignal.aborted) throw loginFailure();
      exchangeTimer = setTimeout(stopExchange, Math.max(0, exchangeDeadline - attempt.check()));
      exchangeText = await attempt.wait(
        Promise.race([
          provider.exchange(
            JSON.stringify({
              schemaVersion: 1,
              admissionId: reserved.admissionId,
              code: input.code,
              verifier: proof.verifier,
              clientId: config.binding.clientId,
              redirectUri: config.binding.redirectUri,
            }),
            exchangeControl,
          ),
          stopped,
        ]),
      );
    } finally {
      if (exchangeTimer !== undefined) clearTimeout(exchangeTimer);
      parentSignal.removeEventListener("abort", stopExchange);
      exchangeAbort.abort();
    }
    const exchanged = loginJson(exchangeText, 32768, ["schemaVersion", "accessToken"]);
    if (
      attempt.check() >= exchangeDeadline ||
      exchanged.schemaVersion !== 1 ||
      typeof exchanged.accessToken !== "string" ||
      encoder.encode(exchanged.accessToken).length > 16384
    )
      throw loginFailure();
    await eligible();
    attempt.check();
    const publicKeyset = await attempt.wait(provider.readPublicKeyset(attempt.control()));
    if (typeof publicKeyset !== "string" || encoder.encode(publicKeyset).length > 65536)
      throw loginFailure();
    const compositionDeadline = Math.min(attempt.check() + 10000, attempt.control().deadlineMs);
    let compositionPending = true;
    const owner = createWorkosAuthenticationEvidence(config.verificationProfileJson, publicKeyset, {
      now: () => {
        const at = attempt.check();
        if (compositionPending && at >= compositionDeadline) throw loginFailure();
        return at;
      },
      currentProfile: () => {
        attempt.check();
        return config.verificationProfileJson;
      },
      signal: attempt.control().signal,
      readPage: async (selectorJson, control) => {
        await eligible(control);
        const bounded = Object.freeze({
          deadlineMs: Math.min(
            control.deadlineMs,
            compositionDeadline,
            attempt.control().deadlineMs,
          ),
          signal: control.signal,
        });
        attempt.check();
        if (bounded.signal.aborted) throw loginFailure();
        const result = await attempt.wait(provider.readSessionPage(selectorJson, bounded));
        attempt.check();
        if (bounded.signal.aborted) throw loginFailure();
        return result;
      },
    });
    const verified = await attempt.wait(owner.verify(exchanged.accessToken));
    if (verified.outcome !== "verified_active_evidence") throw loginFailure();
    // The completed composition window does not shorten76's separate fresh
    // observation lease. Its owner still checks that lease at every read.
    compositionPending = false;
    const readEvidence = (handle: unknown) => {
      attempt.check();
      return owner.readEvidence(handle);
    };
    if (!readEvidence(verified.handle)) throw loginFailure();
    // Account admission (ADR-0009): no workspace is selected at sign-in. The configured
    // profile is the only selector; an unmapped verified subject may enroll in the same
    // definer transaction, which grants no tenant authority.
    const admission = createWorkosAccountAdmission({
      pool: sessionPool,
      now: attempt.check,
      readEvidence,
      signal: attempt.control().signal,
    });
    if (issuerEntered) throw loginFailure();
    issuerEntered = true;
    const admitted = await attempt.wait(
      admission.admit(
        verified.handle,
        JSON.stringify({
          schemaVersion: 1,
          commandId: claimed.issuer_command_id,
          profileId: config.profileId,
          profileRecordRevision: config.profileRecordRevision,
        }),
      ),
    );
    if (
      admitted.outcome !== "newly_admitted" ||
      admitted.correlation?.commandId !== claimed.issuer_command_id ||
      !admitted.credential ||
      !loginSecret(admitted.credential.secret) ||
      !readEvidence(verified.handle)
    )
      throw loginFailure();
    const credential = admitted.credential;
    return () => {
      checkOpen();
      if (!readEvidence(verified.handle)) throw loginFailure();
      const at = attempt.check(),
        age = Math.min(900, Math.floor((credential.expiresAtMs - at) / 1000));
      if (age <= 0) throw loginFailure();
      return plan(
        303,
        "",
        [["location", "/"]],
        [cookie("__Host-morrow_session", credential.secret, age)],
      );
    };
  };
  return Object.freeze({ start, callback });
}
export async function dispatchStandaloneLoginWithAttempt(
  request: Request,
  sink: AuthDeliverySink,
  attempt: LoginAttempt | undefined,
  closedSetup: StandaloneLoginSetup,
): Promise<void> {
  let delivered = false,
    isCallback = false,
    externalSignal: AbortSignal | undefined;
  const deliver = (output: Readonly<AuthDeliveryPlan>) => {
    if (delivered || externalSignal?.aborted) throw loginFailure();
    delivered = true;
    const result: unknown = sink(output);
    if (result !== undefined) {
      // Do not await an unsupported async sink or invoke it again. Suppress
      // rejection only for a genuine native Promise without inspecting an
      // arbitrary thenable's getters or granting it any protocol authority.
      if (result instanceof Promise)
        void Promise.prototype.then.call(
          result,
          () => undefined,
          () => undefined,
        );
      throw Error("STANDALONE_LOGIN_TRANSPORT_UNKNOWN");
    }
  };
  try {
    if (typeof sink !== "function" || !(request instanceof Request)) throw loginFailure();
    externalSignal = request.signal;
    const setup = setups.get(closedSetup);
    if (!setup) throw loginFailure();
    if (!attempt || setup.entryError !== undefined) throw setup.entryError ?? loginFailure();
    // The wrapper supplied the one entry-owned attempt. Classification and
    // managed initialization share this original ceiling and delivery frame.
    const pathname = new URL(request.url).pathname;
    isCallback = pathname === "/auth/workos/callback";
    if (!isCallback) attempt.cap(setup.enteredAt + 5000);
    const core =
      setup.kind === "managed"
        ? await managedCore(setup, attempt, pathname === "/auth/login" && request.method === "POST")
        : setup.core;
    const config = setup.config;
    if (!core || !config) throw loginFailure();
    const { start, callback } = core;
    const url = loginRequestEnvelope(request, config.origin);
    if (url.pathname === "/auth/result" && !url.search && request.method === "GET") {
      deliver(resultPage());
      return;
    }
    if (url.pathname !== "/auth/login" && !isCallback) {
      deliver(unavailable(404));
      return;
    }
    if ((isCallback && request.method !== "GET") || (!isCallback && request.method !== "POST")) {
      deliver(unavailable(405));
      return;
    }
    if (!isCallback && url.search) {
      deliver(unavailable(400));
      return;
    }
    if (
      !isCallback &&
      (request.headers.get("origin") !== config.origin ||
        request.headers.get("content-type") !== "application/json" ||
        request.headers.get("x-morrow-request") !== "1")
    ) {
      deliver(unavailable(403));
      return;
    }
    const finalize = await (isCallback ? callback(request, url, attempt) : start(request, attempt));
    // Freshness and cookie construction remain in this same stack as sink.
    const output = finalize();
    deliver(output);
  } catch (error) {
    if (delivered) throw Error("STANDALONE_LOGIN_TRANSPORT_UNKNOWN");
    if (!externalSignal?.aborted)
      deliver(
        isCallback
          ? failedCallback()
          : unavailable(error instanceof LoginInputError ? error.status : 503),
      );
  }
}
