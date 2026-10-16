import { createLoginFlowCustody } from "./login-flow-custody.js";
import { createWorkosAuthenticationEvidence } from "./workos-authentication-evidence.js";
import { createWorkosWorkspaceSelection } from "./workos-workspace-selection.js";
import { createWorkosBrowserSessionAdmission } from "./workos-browser-session-admission.js";
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
  readonly selectionPool: LoginControlledSqlPool;
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
export async function createStandaloneLoginBridge(dependencies: StandaloneLoginDependencies) {
  let config: Awaited<ReturnType<typeof parseLoginConfiguration>>;
  let loginPool: LoginControlledSqlPool,
    preauthPool: LoginControlledSqlPool,
    selectionPool: LoginControlledSqlPool,
    sessionPool: LoginControlledSqlPool;
  let provider: Readonly<FixedWorkosLoginPort>, now: () => number;
  try {
    config = await parseLoginConfiguration(dependencies.configurationJson);
    ({ loginPool, preauthPool, selectionPool, sessionPool, now } = dependencies);
    provider = dependencies.providerPort;
    if (
      [loginPool, preauthPool, selectionPool, sessionPool].some(
        (pool) => !pool || typeof pool.connect !== "function",
      ) ||
      typeof now !== "function" ||
      !provider ||
      typeof provider.exchange !== "function" ||
      typeof provider.readPublicKeyset !== "function" ||
      typeof provider.readSessionPage !== "function" ||
      new Set([loginPool, preauthPool, selectionPool, sessionPool]).size !== 4
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
  const custody = createLoginFlowCustody({ pool: loginPool, now });
  const aad = (fields: readonly string[]) =>
    encoder.encode(
      JSON.stringify(["morrow.login.capsule", "1", config.configurationDigest, ...fields]),
    );
  type Finalize = () => Readonly<AuthDeliveryPlan>;
  const start = async (request: Request, attempt: LoginAttempt): Promise<Finalize> => {
    const workspaceId = await loginStartInput(request, attempt);
    const ids = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    if (new Set(ids).size !== 4) throw loginFailure();
    const [flowId, beginCommandId, admissionCommandId, issuerCommandId] = ids as [
      string,
      string,
      string,
      string,
    ];
    const intent = await attempt.wait(
      custody.createIntent(
        JSON.stringify({
          schemaVersion: 1,
          configurationDigest: config.configurationDigest,
          flowId,
          beginCommandId,
          admissionCommandId,
          issuerCommandId,
          workspaceId,
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
    const opaqueBytes = crypto.getRandomValues(new Uint8Array(32));
    const opaque = loginBase64(opaqueBytes);
    opaqueBytes.fill(0);
    const [stateDigest, cookieDigest, browserProofDigest, verifierDigest] = await attempt.wait(
      Promise.all([
        loginHash(material.state),
        loginHash(opaque),
        loginHash(material.browserProof),
        loginHash(material.verifier),
      ]),
    );
    const aadBytes = aad([
      flowId,
      material.challengeId,
      beginCommandId,
      admissionCommandId,
      issuerCommandId,
      workspaceId,
      intent.expires_at_ms,
      stateDigest,
      cookieDigest,
      browserProofDigest,
      verifierDigest,
      keyId,
    ]);
    const aadDigest = await attempt.wait(loginHash(new TextDecoder().decode(aadBytes)));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(
      JSON.stringify({
        schemaVersion: 1,
        browserProof: material.browserProof,
        verifier: material.verifier,
      }),
    );
    let ciphertext: string;
    try {
      ciphertext = loginBase64(
        new Uint8Array(
          await attempt.wait(
            crypto.subtle.encrypt(
              { name: "AES-GCM", iv: nonce, additionalData: aadBytes, tagLength: 128 },
              key,
              plaintext,
            ),
          ),
        ),
      );
    } finally {
      plaintext.fill(0);
    }
    const ready = await attempt.wait(
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
    nonce.fill(0);
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
      Promise.all([loginHash(input.cookie), loginHash(input.state), loginHash(input.code)]),
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
      !claimed.workspace_id ||
      !claimed.ciphertext ||
      !claimed.encryption_nonce ||
      !claimed.aad_digest ||
      !claimed.browser_proof_digest ||
      !claimed.verifier_digest ||
      claimed.key_id !== keyId ||
      claimed.cookie_digest !== cookieDigest ||
      claimed.state_digest !== stateDigest ||
      claimed.code_digest !== codeDigest
    )
      throw loginFailure();
    attempt.cap(decimal(claimed.expires_at_ms));
    const aadBytes = aad([
      claimed.flow_id,
      claimed.challenge_id,
      claimed.begin_command_id,
      claimed.admission_command_id,
      claimed.issuer_command_id,
      claimed.workspace_id,
      claimed.expires_at_ms,
      stateDigest,
      cookieDigest,
      claimed.browser_proof_digest,
      claimed.verifier_digest,
      keyId,
    ]);
    if ((await attempt.wait(loginHash(new TextDecoder().decode(aadBytes)))) !== claimed.aad_digest)
      throw loginFailure();
    const nonce = loginBytes(claimed.encryption_nonce, 12),
      ciphertext = loginBytes(claimed.ciphertext, 512);
    if (nonce.length !== 12 || ciphertext.length < 16) throw loginFailure();
    const plaintext = new Uint8Array(
      await attempt.wait(
        crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aadBytes, tagLength: 128 },
          key,
          ciphertext,
        ),
      ),
    );
    let proof: Readonly<Record<string, unknown>>;
    try {
      proof = loginJson(new TextDecoder("utf-8", { fatal: true }).decode(plaintext), 512, [
        "schemaVersion",
        "browserProof",
        "verifier",
      ]);
    } finally {
      plaintext.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
    }
    if (
      proof.schemaVersion !== 1 ||
      !loginSecret(proof.browserProof) ||
      !loginSecret(proof.verifier) ||
      (await attempt.wait(loginHash(proof.browserProof))) !== claimed.browser_proof_digest ||
      (await attempt.wait(loginHash(proof.verifier))) !== claimed.verifier_digest
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
    const selectionService = createWorkosWorkspaceSelection({
      pool: selectionPool,
      now: attempt.check,
      readEvidence,
      signal: attempt.control().signal,
    });
    const selected = await attempt.wait(
      selectionService.resolve(
        verified.handle,
        JSON.stringify({ schemaVersion: 1, workspaceId: claimed.workspace_id }),
      ),
    );
    if (
      selected.outcome !== "selected" ||
      selected.selection.profileId !== config.profileId ||
      selected.selection.profileRecordRevision !== config.profileRecordRevision ||
      selected.selection.workspaceId !== claimed.workspace_id
    )
      throw loginFailure();
    const s = selected.selection;
    const admission = createWorkosBrowserSessionAdmission({
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
          workspaceId: s.workspaceId,
          profileId: s.profileId,
          profileRecordRevision: s.profileRecordRevision,
          mappingId: s.mappingId,
          mappingRevision: s.mappingRevision,
          bindingRevision: s.bindingRevision,
          membershipId: s.membershipId,
          policyRevision: s.policyRevision,
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
  const dispatch = async (request: Request, sink: AuthDeliverySink): Promise<void> => {
    let attempt: LoginAttempt | undefined,
      delivered = false,
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
      // Start the ceiling before even classifying/parsing the callback URL.
      attempt = createLoginAttempt(now, externalSignal, 25000);
      const enteredAt = attempt.control().deadlineMs - 25000;
      isCallback = new URL(request.url).pathname === "/auth/workos/callback";
      if (!isCallback) attempt.cap(enteredAt + 5000);
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
      const finalize = await (isCallback
        ? callback(request, url, attempt)
        : start(request, attempt));
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
    } finally {
      attempt?.end();
    }
  };
  const fetch = async (request: Request): Promise<Response> => {
    let response: Response | undefined;
    await dispatch(request, (output) => {
      const headers = new Headers(
        output.headers.map(([name, value]) => [name, value] as [string, string]),
      );
      for (const value of output.cookies) headers.append("Set-Cookie", value);
      response = new Response(output.bodyText, { status: output.status, headers });
    });
    if (!response) throw loginFailure();
    return response;
  };
  return Object.freeze({ fetch, dispatch });
}
