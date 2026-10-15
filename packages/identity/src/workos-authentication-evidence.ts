import { createWorkosSessionTokenVerifier } from "./workos-session-token.js";
import {
  createWorkosSessionStatusReader,
  type WorkosSessionPageReader,
  type WorkosSessionObservation,
} from "./workos-session-status.js";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

export interface WorkosAuthenticationEvidenceDependencies {
  readonly readPage: WorkosSessionPageReader;
  readonly currentProfile: () => unknown;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}
export interface WorkosAuthenticationEvidence {
  readonly providerId: "workos";
  readonly environmentId: string;
  readonly applicationId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly subjectId: string;
  readonly providerSessionId: string;
  readonly tokenProvenance: "signature_verified";
  readonly sessionClientBinding: "expected_only";
  readonly sessionLiveness: "not_guaranteed";
  readonly issuedAtMs: number;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly tokenProfileRevision: number;
  readonly tokenProfileDigest: string;
  readonly keySetDigest: string;
  readonly observationProfileDigest: string;
}
export type WorkosAuthenticationEvidenceResult =
  | Readonly<{ outcome: "verified_active_evidence"; handle: object }>
  | Readonly<{ outcome: "held"; handle: null }>;

const held = Object.freeze({ outcome: "held" as const, handle: null });
const fail = () => Error("WORKOS_AUTHENTICATION_EVIDENCE_HELD");
const clockValue = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8640000000000000;

// Server-only evidence composition. Environment/application are trusted
// configuration; the signature binds issuer/client/user/session. The session
// catalogue keeps expected-only client provenance and issues no local authority.
export function createWorkosAuthenticationEvidence(
  profileJson: unknown,
  jwksSnapshotJson: unknown,
  dependencies: WorkosAuthenticationEvidenceDependencies,
) {
  let readPage: WorkosSessionPageReader;
  let currentProfile: () => unknown;
  let now: () => number;
  let externalSignal: AbortSignal | undefined;
  try {
    if (typeof profileJson !== "string" || typeof jwksSnapshotJson !== "string") throw fail();
    readPage = dependencies.readPage;
    currentProfile = dependencies.currentProfile;
    now = dependencies.now;
    externalSignal = dependencies.signal;
    if (
      typeof readPage !== "function" ||
      typeof currentProfile !== "function" ||
      typeof now !== "function" ||
      (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
    )
      throw fail();
  } catch {
    throw Error("WORKOS_AUTHENTICATION_EVIDENCE_CONFIG_INVALID");
  }
  const sourceProfile = profileJson;
  let previousTime = -1;
  let invalidated = false;
  const readClock = () => {
    try {
      if (invalidated) throw fail();
      const at: unknown = now();
      if (!clockValue(at) || at < previousTime) throw fail();
      previousTime = at;
      return at;
    } catch {
      invalidated = true;
      throw fail();
    }
  };
  const current = () => {
    try {
      readClock();
      const present: unknown = currentProfile();
      const at = readClock();
      if (externalSignal?.aborted || present !== sourceProfile) throw fail();
      return at;
    } catch {
      invalidated = true;
      throw fail();
    }
  };
  let verifier: ReturnType<typeof createWorkosSessionTokenVerifier>;
  let observationProfileJson: string;
  let leaseEnd: number;
  try {
    // The unchanged verifier owns the complete closed profile/keyset validation.
    verifier = createWorkosSessionTokenVerifier(profileJson, jwksSnapshotJson, current);
    const profile = parseWorkosSessionStatusJson(profileJson, 8192) as Record<string, unknown>;
    const snapshot = parseWorkosSessionStatusJson(jwksSnapshotJson, 65536) as Record<
      string,
      unknown
    >;
    observationProfileJson = JSON.stringify({
      schemaVersion: 1,
      providerId: "workos",
      environmentId: profile.environmentId,
      applicationId: profile.applicationId,
      clientId: profile.clientId,
      revision: profile.revision,
    });
    leaseEnd = snapshot.expiresAtMs as number;
  } catch {
    throw Error("WORKOS_AUTHENTICATION_EVIDENCE_CONFIG_INVALID");
  }

  type Attempt = {
    phase: "pending" | "succeeded" | "failed";
    abort: AbortController;
    deadline: number;
  };
  type Entry = {
    readonly attempt: Attempt;
    readonly tokenHandle: object;
    readonly reader: ReturnType<typeof createWorkosSessionStatusReader>;
    readonly observationHandle: object;
    readonly evidence: Readonly<WorkosAuthenticationEvidence>;
  };
  const handles = new WeakMap<object, Entry>();
  const attemptClock = (attempt: Attempt) => {
    const at = current();
    if (
      attempt.phase === "failed" ||
      attempt.abort.signal.aborted ||
      (attempt.phase === "pending" && at >= attempt.deadline)
    )
      throw fail();
    return at;
  };
  const ownedFacts = (entry: Omit<Entry, "evidence">) => {
    attemptClock(entry.attempt);
    const candidate = verifier.readCandidate(entry.tokenHandle);
    const observation = entry.reader.readObservation(entry.observationHandle);
    const at = attemptClock(entry.attempt);
    if (
      !candidate ||
      !observation ||
      observation.outcome !== "observed_active" ||
      observation.providerId !== candidate.providerId ||
      observation.environmentId !== candidate.environmentId ||
      observation.expectedApplicationId !== candidate.applicationId ||
      observation.expectedClientId !== candidate.clientId ||
      observation.subjectId !== candidate.subjectId ||
      observation.providerSessionId !== candidate.providerSessionId ||
      observation.clientBinding !== "expected_only" ||
      at >= candidate.expiresAt * 1000 ||
      at >= leaseEnd ||
      at >= observation.expiresAtMs
    )
      throw fail();
    return { candidate, observation };
  };
  const observationFields = (observation: Readonly<WorkosSessionObservation>) => ({
    observedAtMs: observation.observedAtMs,
    observationProfileDigest: observation.profileDigest,
  });
  return Object.freeze({
    async verify(token: unknown): Promise<WorkosAuthenticationEvidenceResult> {
      // No parsed claims, selectors, foreign handles or reflective caller objects.
      if (typeof token !== "string") return held;
      let attempt: Attempt | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      try {
        const startedAt = readClock();
        const deadline = startedAt + 10000;
        if (!clockValue(deadline)) throw fail();
        attempt = { phase: "pending", abort: new AbortController(), deadline };
        const ownAttempt = attempt;
        const checkedAt = attemptClock(ownAttempt);
        const interrupt = () => {
          if (ownAttempt.phase === "pending") {
            ownAttempt.phase = "failed";
            ownAttempt.abort.abort();
          }
        };
        stop = () => {
          invalidated = true;
          ownAttempt.phase = "failed";
          ownAttempt.abort.abort();
        };
        externalSignal?.addEventListener("abort", stop, { once: true });
        const interrupted = new Promise<WorkosAuthenticationEvidenceResult>((resolve) => {
          ownAttempt.abort.signal.addEventListener("abort", () => resolve(held), { once: true });
          timer = setTimeout(interrupt, deadline - checkedAt);
        });
        const operation = async (): Promise<WorkosAuthenticationEvidenceResult> => {
          attemptClock(ownAttempt);
          const verification = await verifier.verify(token);
          token = undefined;
          attemptClock(ownAttempt);
          if (verification.outcome !== "verified") return held;
          const candidate = verifier.readCandidate(verification.handle);
          attemptClock(ownAttempt);
          if (!candidate) return held;
          const queryJson = JSON.stringify({
            schemaVersion: 1,
            subjectId: candidate.subjectId,
            providerSessionId: candidate.providerSessionId,
          });
          const reader = createWorkosSessionStatusReader(observationProfileJson, {
            readPage: async (selectorJson, control) => {
              attemptClock(ownAttempt);
              try {
                return await readPage(
                  selectorJson,
                  Object.freeze({
                    deadlineMs: Math.min(control.deadlineMs, deadline),
                    signal: control.signal,
                  }),
                );
              } finally {
                attemptClock(ownAttempt);
              }
            },
            currentProfile: () => {
              attemptClock(ownAttempt);
              return observationProfileJson;
            },
            now: () => attemptClock(ownAttempt),
            signal: ownAttempt.abort.signal,
          });
          attemptClock(ownAttempt);
          const observed = await reader.observe(queryJson);
          attemptClock(ownAttempt);
          if (observed.outcome !== "observed_active") return held;
          const owned = {
            attempt: ownAttempt,
            tokenHandle: verification.handle,
            reader,
            observationHandle: observed.handle,
          };
          const { candidate: finalCandidate, observation } = ownedFacts(owned);
          const evidence: Readonly<WorkosAuthenticationEvidence> = Object.freeze({
            providerId: "workos",
            environmentId: finalCandidate.environmentId,
            applicationId: finalCandidate.applicationId,
            clientId: finalCandidate.clientId,
            issuer: finalCandidate.issuer,
            subjectId: finalCandidate.subjectId,
            providerSessionId: finalCandidate.providerSessionId,
            tokenProvenance: "signature_verified",
            sessionClientBinding: "expected_only",
            sessionLiveness: "not_guaranteed",
            issuedAtMs: finalCandidate.issuedAt * 1000,
            ...observationFields(observation),
            expiresAtMs: Math.min(
              finalCandidate.expiresAt * 1000,
              leaseEnd,
              observation.expiresAtMs,
            ),
            tokenProfileRevision: finalCandidate.profileRevision,
            tokenProfileDigest: finalCandidate.profileDigest,
            keySetDigest: finalCandidate.keySetDigest,
          });
          const handle = Object.freeze(Object.create(null)) as object;
          handles.set(handle, { ...owned, evidence });
          // Successful evidence retains its independent observation lease. An
          // operation deadline bounds work, not an already completed handle.
          ownAttempt.phase = "succeeded";
          if (timer !== undefined) clearTimeout(timer);
          return Object.freeze({ outcome: "verified_active_evidence", handle });
        };
        return await Promise.race([operation().catch(() => held), interrupted]);
      } catch {
        return held;
      } finally {
        token = undefined;
        if (timer !== undefined) clearTimeout(timer);
        if (stop) externalSignal?.removeEventListener("abort", stop);
        if (attempt && attempt.phase !== "succeeded") {
          attempt.phase = "failed";
          attempt.abort.abort();
        }
      }
    },
    readEvidence(handle: unknown): Readonly<WorkosAuthenticationEvidence> | null {
      if (!handle || typeof handle !== "object") return null;
      const entry = handles.get(handle);
      if (!entry) return null;
      try {
        ownedFacts(entry);
        if (current() >= entry.evidence.expiresAtMs) return null;
        return entry.evidence;
      } catch {
        return null;
      }
    },
  });
}
