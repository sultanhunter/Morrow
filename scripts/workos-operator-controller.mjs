import { createHash, timingSafeEqual } from "node:crypto";
import { createWorkosOperatorJournal } from "./workos-operator-journal.mjs";

export class WorkosOperatorError extends Error {
  constructor(code = "WORKOS_OPERATOR_HELD") {
    super(code);
    this.name = "WorkosOperatorError";
    this.code = code;
  }
}
const invalid = () => new WorkosOperatorError("WORKOS_OPERATOR_INPUT_INVALID");
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const id = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const proof = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(v) &&
  Buffer.from(v, "base64url").toString("base64url") === v;
const utf16 = (v) => typeof v === "string" && v.isWellFormed();
const iso = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function parse(value, keys, max = 16384) {
  if (typeof value !== "string" || value.length > max) throw invalid();
  let r;
  try {
    r = JSON.parse(value);
  } catch {
    throw invalid();
  }
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !== [...keys].sort().join(",")
  )
    throw invalid();
  for (const v of Object.values(r)) if (typeof v === "string" && !utf16(v)) throw invalid();
  return Object.freeze(r);
}
const scopeKeys = [
  "schemaVersion",
  "planSequence",
  "planDigest",
  "sourceDigest",
  "profileDigest",
  "bindingDigest",
  "profileJson",
  "bindingJson",
];
const activationKeys = [
  "schemaVersion",
  "mode",
  "operationId",
  "activationId",
  "beginCommandId",
  "callbackCommandId",
  "planSequence",
  "planDigest",
  "sourceDigest",
  "profileDigest",
  "bindingDigest",
  "environmentId",
  "applicationId",
  "clientId",
  "bindingId",
  "bindingRevision",
  "ownerUid",
  "rootDevice",
  "rootInode",
  "expiresAt",
  "tokenEndpoint",
  "maxInitiations",
  "maxPosts",
  "ownerApproved",
  "callbackRegistered",
  "cleanupBaseline",
];
const profileValues = Object.freeze({
  schema_version: 1,
  plan_sequence: 70,
  provider_id: "workos",
  environment_kind: "staging",
  environment_id: "environment_01M4HG7FV7X8EFXE1J9S6GG00R",
  application_id: "app_01M4HG7GEJJWTKG4W16RB98VZE",
  client_id: "client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  binding_id: "workos_operator_staging",
  binding_revision: 1,
  origin: "http://127.0.0.1:4110",
  start_path: "/operator/workos/start",
  callback_path: "/operator/workos/callback",
  result_path: "/operator/workos/result",
  return_path: "/operator/workos/result",
  authorize_endpoint: "https://api.workos.com/user_management/authorize",
  token_endpoint: "https://api.workos.com/user_management/authenticate",
  max_flow_seconds: 300,
  max_post_seconds: 15,
  max_response_bytes: 131072,
  max_code_units: 4096,
  max_invalid_requests: 20,
  max_body_bytes: 1024,
  max_uri_bytes: 65536,
  max_header_bytes: 98304,
  max_posts: 1,
  max_initiations: 1,
  keyless_only: true,
  merchant_routes_enabled: false,
  actual_provider_status: "awaiting_owner_activation",
});
function scopeOf(value) {
  const s = parse(value, scopeKeys);
  if (
    s.schemaVersion !== 1 ||
    s.planSequence !== 70 ||
    ![s.planDigest, s.sourceDigest, s.profileDigest, s.bindingDigest].every(sha)
  )
    throw invalid();
  const p = parse(s.profileJson, Object.keys(profileValues));
  if (
    Object.keys(profileValues).some((k) => p[k] !== profileValues[k]) ||
    digest(s.profileJson) !== s.profileDigest ||
    typeof s.bindingJson !== "string" ||
    digest(s.bindingJson) !== s.bindingDigest
  )
    throw invalid();
  const b = parse(s.bindingJson, [
    "bindingId",
    "bindingRevision",
    "environmentId",
    "applicationId",
    "clientId",
    "redirectUri",
    "returnPath",
  ]);
  const expected = {
    bindingId: p.binding_id,
    bindingRevision: p.binding_revision,
    environmentId: p.environment_id,
    applicationId: p.application_id,
    clientId: p.client_id,
    redirectUri: p.origin + p.callback_path,
    returnPath: p.return_path,
  };
  if (Object.keys(expected).some((k) => b[k] !== expected[k])) throw invalid();
  return { s, p, b };
}
export function validateWorkosOperatorActivation(scopeJson, activationJson) {
  const { s, p, b } = scopeOf(scopeJson);
  const a = parse(activationJson, activationKeys);
  if (
    a.schemaVersion !== 1 ||
    !["native", "synthetic"].includes(a.mode) ||
    ![a.operationId, a.activationId, a.beginCommandId, a.callbackCommandId].every(id) ||
    new Set([a.operationId, a.activationId, a.beginCommandId, a.callbackCommandId]).size !== 4 ||
    a.planSequence !== 70 ||
    ["planDigest", "sourceDigest", "profileDigest", "bindingDigest"].some((k) => a[k] !== s[k]) ||
    a.environmentId !== b.environmentId ||
    a.applicationId !== b.applicationId ||
    a.clientId !== b.clientId ||
    a.bindingId !== b.bindingId ||
    a.bindingRevision !== b.bindingRevision ||
    !Number.isSafeInteger(a.ownerUid) ||
    a.ownerUid < 0 ||
    ![a.rootDevice, a.rootInode].every((v) => typeof v === "string" && /^[0-9]{1,24}$/.test(v)) ||
    !iso(a.expiresAt) ||
    a.tokenEndpoint !== p.token_endpoint ||
    a.maxInitiations !== 1 ||
    a.maxPosts !== 1 ||
    [a.ownerApproved, a.callbackRegistered, a.cleanupBaseline].some((v) => typeof v !== "boolean")
  )
    throw invalid();
  return Object.freeze({
    scope: s,
    activation: a,
    profile: p,
    binding: b,
    qualified: a.ownerApproved && a.callbackRegistered && a.cleanupBaseline,
  });
}
const categories = new Set([
  "response_shape_received",
  "already_used",
  "input_denied",
  "configuration_denied",
  "cancelled",
  "timeout",
  "transport_failed",
  "http_rejected",
  "response_origin_denied",
  "content_denied",
  "body_denied",
  "shape_denied",
]);
function observationOf(value) {
  // This is a trusted adapter output, still copied to a closed coarse shape.
  const o = parse(JSON.stringify(value), [
    "outcome",
    "category",
    "statusClass",
    "providerSessionCleanup",
  ]);
  if (
    !["response_shape_received", "held"].includes(o.outcome) ||
    !categories.has(o.category) ||
    ![null, "2xx", "3xx", "4xx", "5xx"].includes(o.statusClass) ||
    o.providerSessionCleanup !== "unknown" ||
    (o.outcome === "response_shape_received" &&
      (o.category !== "response_shape_received" || o.statusClass !== "2xx"))
  )
    throw invalid();
  return o;
}
export async function createWorkosOperatorController({
  scopeJson,
  activationJson,
  journalRoot,
  admission,
  transport,
  currentScope,
  clock = Date.now,
  journalFault,
}) {
  const { scope, activation, profile, qualified } = validateWorkosOperatorActivation(
    scopeJson,
    activationJson,
  );
  let state = "held",
    journal = null,
    flow = null,
    latched = false,
    closed = false;
  const cancellation = new AbortController();
  const deadline = Date.parse(activation.expiresAt);
  const openedAt = clock();
  const flowDeadline = Math.min(deadline, openedAt + profile.max_flow_seconds * 1000);
  const status = () => Object.freeze({ state, providerSessionCleanup: "unknown" });
  const alive = () => {
    const now = clock();
    return !closed && Number.isFinite(now) && now >= openedAt && now < flowDeadline;
  };
  const current = async () => {
    if (!alive()) throw new WorkosOperatorError();
    const next = scopeOf(await currentScope()).s;
    if (scopeKeys.some((k) => next[k] !== scope[k]) || !alive()) throw new WorkosOperatorError();
  };
  const hold = async () => {
    state = "held";
    flow = null;
    if (journal) await journal.hold();
    return status();
  };
  if (
    qualified &&
    activation.ownerUid === process.getuid() &&
    transport?.mode === activation.mode &&
    alive() &&
    deadline - clock() <= 3600000 &&
    (!journalFault || activation.mode === "synthetic")
  ) {
    try {
      await current();
      journal = await createWorkosOperatorJournal(journalRoot, activationJson, {
        fault: journalFault,
      });
      await current();
      state = "ready";
    } catch {
      await hold();
    }
  }
  function validCallback(value, errorOnly = false) {
    const input = parse(
      value,
      errorOnly ? ["state", "browserProof"] : ["state", "browserProof", "code"],
      32768,
    );
    if (
      state !== "awaiting_callback" ||
      latched ||
      !flow ||
      !alive() ||
      clock() >= flow.deadline ||
      !proof(input.state) ||
      !proof(input.browserProof) ||
      !timingSafeEqual(Buffer.from(input.state), Buffer.from(flow.state)) ||
      !timingSafeEqual(Buffer.from(input.browserProof), Buffer.from(flow.browserProof)) ||
      (!errorOnly &&
        (!utf16(input.code) || input.code.length < 1 || input.code.length > profile.max_code_units))
    )
      throw invalid();
    latched = true;
    state = "processing";
    return input;
  }
  return Object.freeze({
    status,
    async close() {
      closed = true;
      cancellation.abort();
      return hold();
    },
    async start() {
      if (state !== "ready") throw new WorkosOperatorError();
      state = "starting";
      try {
        await current();
        const material = await admission.begin(
          JSON.stringify({ commandId: activation.beginCommandId }),
        );
        if (
          !material ||
          !uuid(material.challengeId) ||
          ![material.state, material.browserProof, material.verifier, material.codeChallenge].every(
            proof,
          ) ||
          material.codeChallengeMethod !== "S256" ||
          material.codeChallenge !==
            createHash("sha256").update(material.verifier, "ascii").digest("base64url")
        )
          throw new WorkosOperatorError();
        await current();
        const expiresAt = new Date(flowDeadline).toISOString();
        await journal.markInitiationStarted(
          JSON.stringify({
            beginCommandId: activation.beginCommandId,
            challengeId: material.challengeId,
            expiresAt,
          }),
        );
        await current();
        flow = Object.freeze({ ...material, deadline: Date.parse(expiresAt) });
        const url = new URL(profile.authorize_endpoint);
        for (const [k, v] of Object.entries({
          client_id: profile.client_id,
          redirect_uri: profile.origin + profile.callback_path,
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
          expiresAt,
        });
      } catch {
        await hold();
        throw new WorkosOperatorError();
      }
    },
    complete(value) {
      const input = validCallback(value);
      const material = flow;
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
          await current();
          const reserved = await admission.admit(callbackJson);
          if (
            reserved?.outcome !== "newly_reserved" ||
            reserved.commandId !== activation.callbackCommandId ||
            !uuid(reserved.admissionId)
          )
            throw new WorkosOperatorError();
          const recheck = async () => {
            await current();
            const checked = await admission.reconcile(callbackJson);
            if (
              checked?.outcome !== "held" ||
              checked.admissionId !== reserved.admissionId ||
              checked.commandId !== activation.callbackCommandId ||
              !alive() ||
              clock() >= material.deadline
            )
              throw new WorkosOperatorError();
          };
          await recheck();
          const handle = await journal.markSendRequested(
            JSON.stringify({
              callbackCommandId: activation.callbackCommandId,
              challengeId: material.challengeId,
              admissionId: reserved.admissionId,
              codeDigest: digest(input.code),
              requestDigest: digest(
                JSON.stringify({
                  clientId: profile.client_id,
                  grantType: "authorization_code",
                  codeDigest: digest(input.code),
                  verifierDigest: digest(material.verifier),
                  challengeId: material.challengeId,
                  admissionId: reserved.admissionId,
                  callbackCommandId: activation.callbackCommandId,
                  tokenEndpoint: profile.token_endpoint,
                }),
              ),
            }),
          );
          await recheck();
          await journal.consumeSend(handle);
          if (!alive() || clock() >= material.deadline) throw new WorkosOperatorError();
          const observation = observationOf(
            await transport.exchangeOnce(
              JSON.stringify({ code: input.code, verifier: material.verifier }),
              {
                signal: cancellation.signal,
                deadlineMs: Math.min(
                  deadline,
                  material.deadline,
                  clock() + profile.max_post_seconds * 1000,
                ),
              },
            ),
          );
          await journal.observe(JSON.stringify(observation));
          flow = null;
          state = observation.outcome;
          return status();
        } catch {
          return hold();
        }
      })();
    },
    authorizationNotCompleted(value) {
      validCallback(value, true);
      return (async () => {
        try {
          await journal.observe(
            JSON.stringify({
              outcome: "authorization_not_completed",
              providerSessionCleanup: "unknown",
            }),
          );
          flow = null;
          state = "authorization_not_completed";
          return status();
        } catch {
          return hold();
        }
      })();
    },
  });
}
