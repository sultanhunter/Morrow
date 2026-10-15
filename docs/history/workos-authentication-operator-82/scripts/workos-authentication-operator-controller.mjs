import { createHash, timingSafeEqual } from "node:crypto";
import { adoptWorkosAuthenticationOperatorRun } from "./workos-authentication-operator-input.mjs";
import {
  authenticationOperatorClosed as parse,
  authenticationOperatorHeld as heldError,
  authenticationOperatorId as uuid,
  authenticationOperatorCategories as categories,
} from "./workos-authentication-operator-journal.mjs";
const proof = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(v) &&
  Buffer.from(v, "base64url").toString("base64url") === v;
function record(value, keys) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw heldError();
    const names = Reflect.ownKeys(value);
    if (
      names.some((k) => typeof k !== "string") ||
      names.sort().join(",") !== [...keys].sort().join(",")
    )
      throw heldError();
    const out = {};
    for (const name of keys) {
      const d = Object.getOwnPropertyDescriptor(value, name);
      if (!d || !("value" in d)) throw heldError();
      Object.defineProperty(out, name, { value: d.value, enumerable: true });
    }
    return Object.freeze(out);
  } catch {
    throw heldError();
  }
}
const resultKeys = [
  "outcome",
  "category",
  "statusClass",
  "jwksGetCount",
  "codePostCount",
  "sessionGetCount",
  "tokenProvenance",
  "sessionClientBinding",
  "sessionLiveness",
  "providerSessionCleanup",
];
function resultOf(value, journal) {
  const v = record(value, resultKeys),
    n = journal.counts(),
    positive = v.outcome === "verified_active_evidence";
  if (
    !["verified_active_evidence", "held"].includes(v.outcome) ||
    !categories.includes(v.category) ||
    (v.statusClass !== null && !/^[2-5]xx$/.test(v.statusClass)) ||
    ![0, 1].includes(v.jwksGetCount) ||
    ![0, 1].includes(v.codePostCount) ||
    !Number.isInteger(v.sessionGetCount) ||
    v.sessionGetCount < 0 ||
    v.sessionGetCount > 4 ||
    v.jwksGetCount > n.jwks ||
    v.codePostCount > n.posts ||
    v.sessionGetCount > n.pages ||
    v.providerSessionCleanup !== "unknown" ||
    (positive
      ? v.category !== "evidence_observed" ||
        v.jwksGetCount !== 1 ||
        v.codePostCount !== 1 ||
        v.sessionGetCount < 1 ||
        v.sessionGetCount !== n.pages ||
        n.observation !== "evidence_observed" ||
        v.statusClass !== "2xx" ||
        v.tokenProvenance !== "signature_verified" ||
        v.sessionClientBinding !== "expected_only" ||
        v.sessionLiveness !== "not_guaranteed"
      : v.tokenProvenance !== null || v.sessionClientBinding !== null || v.sessionLiveness !== null)
  )
    throw heldError();
  return v;
}
export function createWorkosAuthenticationOperatorController({
  ownedRun,
  admission,
  transportFactory,
}) {
  const adopted = adoptWorkosAuthenticationOperatorRun(ownedRun),
    { context, activation, journal, clock } = adopted;
  let transport,
    transportClosed = false,
    state = "ready",
    flow = null,
    latched = false,
    closed = false,
    observation = null,
    lastTime = clock();
  const cancellation = new AbortController(),
    openedAt = lastTime,
    flowDeadline = Math.min(context.expiresAtMs, openedAt + context.profile.flowMs);
  const alive = () => {
    const at = clock();
    if (
      !Number.isSafeInteger(at) ||
      at < lastTime ||
      at >= flowDeadline ||
      closed ||
      cancellation.signal.aborted
    )
      return false;
    lastTime = at;
    return true;
  };
  const current = () => {
    if (!alive() || context.current() !== true || !alive()) throw heldError();
    return true;
  };
  const closeTransport = () => {
    if (transportClosed) return;
    transportClosed = true;
    try {
      transport?.close();
    } catch {}
  };
  const status = () => {
    if (
      !["held", "closed", "verified_active_evidence", "authorization_not_completed"].includes(
        state,
      ) &&
      !alive()
    ) {
      state = "held";
      cancellation.abort();
      flow = null;
      closeTransport();
    }
    return Object.freeze({
      state,
      providerSessionCleanup: "unknown",
      ...(observation ? { observation } : {}),
    });
  };
  const hold = () => {
    state = "held";
    flow = null;
    cancellation.abort();
    closeTransport();
    return status();
  };
  try {
    current();
    if (
      !admission ||
      ![admission.begin, admission.admit, admission.reconcile, transportFactory].every(
        (v) => typeof v === "function",
      )
    )
      throw heldError();
    transport = transportFactory(adopted.nativeSubpermit);
    if (
      !transport ||
      transport.mode !== context.mode ||
      typeof transport.completeOnce !== "function" ||
      typeof transport.close !== "function"
    )
      throw heldError();
    current();
  } catch {
    hold();
    throw heldError();
  }
  function callback(text, errorOnly) {
    const value = parse(
      text,
      errorOnly ? ["state", "browserProof"] : ["state", "browserProof", "code"],
      32768,
    );
    if (
      state !== "awaiting_callback" ||
      latched ||
      !flow ||
      !alive() ||
      !proof(value.state) ||
      !proof(value.browserProof) ||
      !timingSafeEqual(Buffer.from(value.state), Buffer.from(flow.state)) ||
      !timingSafeEqual(Buffer.from(value.browserProof), Buffer.from(flow.browserProof)) ||
      (!errorOnly &&
        (typeof value.code !== "string" ||
          !value.code.isWellFormed() ||
          value.code.length < 1 ||
          value.code.length > context.profile.maxCodeUnits))
    )
      throw heldError();
    current();
    latched = true;
    state = "processing";
    return value;
  }
  return Object.freeze({
    status,
    close() {
      if (closed) return status();
      closed = true;
      cancellation.abort();
      flow = null;
      closeTransport();
      if (!["verified_active_evidence", "authorization_not_completed", "held"].includes(state))
        state = "closed";
      return status();
    },
    async start() {
      if (state !== "ready") throw heldError();
      state = "starting";
      try {
        current();
        const material = record(
          await admission.begin(JSON.stringify({ commandId: activation.beginCommandId })),
          [
            "challengeId",
            "state",
            "browserProof",
            "verifier",
            "codeChallenge",
            "codeChallengeMethod",
          ],
        );
        if (
          !uuid(material.challengeId) ||
          ![material.state, material.browserProof, material.verifier, material.codeChallenge].every(
            proof,
          ) ||
          material.codeChallengeMethod !== "S256" ||
          material.codeChallenge !==
            createHash("sha256").update(material.verifier, "ascii").digest("base64url")
        )
          throw heldError();
        current();
        journal.initiation(
          JSON.stringify({
            beginCommandId: activation.beginCommandId,
            challengeId: material.challengeId,
          }),
        );
        current();
        flow = Object.freeze({ ...material, deadlineMs: flowDeadline });
        const url = new URL(context.profile.authorizePath, context.profile.apiOrigin);
        for (const [k, v] of Object.entries({
          client_id: context.binding.clientId,
          redirect_uri: context.profile.loopbackOrigin + context.profile.callbackPath,
          response_type: "code",
          provider: "authkit",
          state: material.state,
          code_challenge: material.codeChallenge,
          code_challenge_method: "S256",
        }))
          url.searchParams.set(k, v);
        state = "awaiting_callback";
        return Object.freeze({
          state: material.state,
          browserProof: material.browserProof,
          authorizationUrl: url.href,
          expiresAt: new Date(flowDeadline).toISOString(),
        });
      } catch {
        hold();
        throw heldError();
      }
    },
    complete(text) {
      const input = callback(text, false),
        material = flow;
      const callbackJson = JSON.stringify({
        commandId: activation.callbackCommandId,
        challengeId: material.challengeId,
        state: input.state,
        browserProof: input.browserProof,
        verifier: material.verifier,
        code: input.code,
      });
      return (async () => {
        try {
          current();
          const reserved = record(await admission.admit(callbackJson), [
            "outcome",
            "commandId",
            "admissionId",
          ]);
          if (
            reserved.outcome !== "newly_reserved" ||
            reserved.commandId !== activation.callbackCommandId ||
            !uuid(reserved.admissionId)
          )
            throw heldError();
          current();
          const recheck = async () => {
            current();
            const r = record(await admission.reconcile(callbackJson), [
              "outcome",
              "commandId",
              "admissionId",
            ]);
            if (
              r.outcome !== "held" ||
              r.admissionId !== reserved.admissionId ||
              r.commandId !== activation.callbackCommandId
            )
              throw heldError();
            current();
            return true;
          };
          const intent = JSON.stringify({
            commandId: activation.callbackCommandId,
            admissionId: reserved.admissionId,
          });
          const used = new Set();
          let page = 0;
          const once = (name) => {
            if (used.has(name)) throw heldError();
            used.add(name);
          };
          const nativeDeadline = Math.min(
            material.deadlineMs,
            context.expiresAtMs,
            clock() + context.profile.nativeMs,
          );
          const output = await transport.completeOnce(
            JSON.stringify({ code: input.code, verifier: material.verifier }),
            {
              signal: cancellation.signal,
              deadlineMs: nativeDeadline,
              beforeJwks: async () => {
                once("jwks");
                await recheck();
                journal.jwks(intent);
                current();
                return true;
              },
              beforePost: async () => {
                once("post");
                await recheck();
                journal.exchange(intent);
                current();
                return true;
              },
              onVerifiedTarget: async (targetJson) => {
                once("target");
                await recheck();
                journal.target(targetJson);
                current();
                return true;
              },
              beforePage: async (selectorJson, control) => {
                if (
                  !control ||
                  !(control.signal instanceof AbortSignal) ||
                  control.signal.aborted ||
                  !Number.isSafeInteger(control.deadlineMs) ||
                  control.deadlineMs > nativeDeadline ||
                  clock() >= control.deadlineMs ||
                  control.pageNumber !== page + 1 ||
                  control.pageNumber > 4
                )
                  throw heldError();
                await recheck();
                if (control.signal.aborted || clock() >= control.deadlineMs) throw heldError();
                journal.page(selectorJson, control.pageNumber);
                page++;
                current();
                return true;
              },
              onEvidenceObservation: async (value) => {
                once("observation");
                current();
                journal.observation(value);
                current();
                return true;
              },
            },
          );
          current();
          observation = resultOf(output, journal);
          flow = null;
          state =
            observation.outcome === "verified_active_evidence"
              ? "verified_active_evidence"
              : "held";
          return status();
        } catch {
          return hold();
        }
      })();
    },
    authorizationNotCompleted(text) {
      callback(text, true);
      flow = null;
      state = "authorization_not_completed";
      return Promise.resolve(status());
    },
  });
}
