// Local workerd composition fixture only. No public identity route or real key.
import { createWorkosAuthenticationEvidence } from "../../packages/identity/src/workos-authentication-evidence";

type Case = {
  name: string;
  profileJson: unknown;
  snapshotJson: unknown;
  token: unknown;
  pages: unknown[];
  now: number;
  expected: string;
  expectedReads: number;
  expectedSubjectId: string;
  expectedSessionId: string;
  expectedTokenProfileDigest: string;
  expectedKeySetDigest: string;
  expectedObservationProfileDigest: string;
  expectedIssuedAtMs: number;
  expectedObservedAtMs: number;
  expectedExpiresAtMs: number;
  readAt?: number;
  expectedConfigDenial?: boolean;
  mode?: string;
  advanceTo?: number;
  later?: number;
};
const evidenceFields = [
  "providerId",
  "environmentId",
  "applicationId",
  "clientId",
  "issuer",
  "subjectId",
  "providerSessionId",
  "tokenProvenance",
  "sessionClientBinding",
  "sessionLiveness",
  "issuedAtMs",
  "observedAtMs",
  "expiresAtMs",
  "tokenProfileRevision",
  "tokenProfileDigest",
  "keySetDigest",
  "observationProfileDigest",
]
  .sort()
  .join(",");

export default {
  async fetch(request: Request) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/synthetic-authentication-evidence"
    )
      return new Response(null, { status: 404 });
    const input = (await request.json()) as {
      cases: Case[];
      concurrency: {
        profileJson: string;
        snapshotJson: string;
        now: number;
        firstToken: string;
        secondToken: string;
        firstSubject: string;
        secondSubject: string;
        firstPage: string;
        secondPage: string;
      };
    };
    const checks: { name: string; passed: boolean }[] = [];
    for (const c of input.cases) {
      let now = c.now;
      let currentProfile = c.profileJson;
      let reads = 0;
      let advanceOnProfileRead = false;
      const cancel = new AbortController();
      let factory: ReturnType<typeof createWorkosAuthenticationEvidence>;
      try {
        factory = createWorkosAuthenticationEvidence(c.profileJson, c.snapshotJson, {
          now: () => now,
          currentProfile: () => {
            if (advanceOnProfileRead) {
              now = c.advanceTo!;
              advanceOnProfileRead = false;
            }
            return currentProfile;
          },
          signal: cancel.signal,
          readPage: async (selectorJson, control) => {
            const selector = JSON.parse(selectorJson);
            checks.push({
              name: c.name + "_fixed_page_request_" + reads,
              passed:
                Object.keys(selector).sort().join(",") ===
                  "after,limit,order,schemaVersion,subjectId" &&
                selector.schemaVersion === 1 &&
                selector.limit === 100 &&
                selector.order === "asc" &&
                selector.after ===
                  (reads === 0
                    ? null
                    : JSON.parse(c.pages[reads - 1] as string).list_metadata.after) &&
                selector.subjectId === c.expectedSubjectId &&
                control.deadlineMs <= c.now + 10000 &&
                control.signal instanceof AbortSignal &&
                Object.isFrozen(control),
            });
            const page = c.pages[reads++];
            if (c.mode === "profile_drift") currentProfile = "{}";
            if (c.mode === "clock_backward") now--;
            if (c.mode === "advance_page") now = c.advanceTo!;
            if (c.mode === "cancel_page") cancel.abort();
            if (c.mode === "stall_abort") {
              queueMicrotask(() => cancel.abort());
              return new Promise(() => {});
            }
            if (c.mode === "throw_page") throw Error("SYNTHETIC_PRIVATE_ERROR");
            return page;
          },
        });
      } catch {
        checks.push({
          name: c.name,
          passed: c.expectedConfigDenial === true && c.expected === "held",
        });
        checks.push({ name: c.name + "_read_budget", passed: reads === c.expectedReads });
        continue;
      }
      if (c.expectedConfigDenial) {
        checks.push({ name: c.name, passed: false });
        checks.push({ name: c.name + "_read_budget", passed: reads === c.expectedReads });
        continue;
      }
      try {
        const pending = factory.verify(c.token);
        if (c.mode === "advance_crypto")
          queueMicrotask(() => {
            now = c.advanceTo!;
          });
        if (c.mode === "profile_drift_crypto")
          queueMicrotask(() => {
            currentProfile = "{}";
          });
        if (c.mode === "cancel_crypto") queueMicrotask(() => cancel.abort());
        const result = await pending;
        checks.push({ name: c.name, passed: result.outcome === c.expected });
        checks.push({ name: c.name + "_read_budget", passed: reads === c.expectedReads });
        checks.push({
          name: c.name + "_closed_result",
          passed:
            Object.isFrozen(result) && Object.keys(result).sort().join(",") === "handle,outcome",
        });
        if (result.outcome === "held")
          checks.push({ name: c.name + "_no_handle", passed: result.handle === null });
        else {
          const value = factory.readEvidence(result.handle);
          const profile = JSON.parse(c.profileJson as string);
          checks.push({
            name: c.name + "_private_frozen_evidence",
            passed: value !== null && Object.isFrozen(value),
          });
          checks.push({
            name: c.name + "_minimal_evidence_shape",
            passed: value !== null && Object.keys(value).sort().join(",") === evidenceFields,
          });
          checks.push({
            name: c.name + "_provenance_stays_separate",
            passed:
              value !== null &&
              value.tokenProvenance === "signature_verified" &&
              value.sessionClientBinding === "expected_only" &&
              value.sessionLiveness === "not_guaranteed" &&
              value.environmentId === profile.environmentId &&
              value.applicationId === profile.applicationId &&
              value.clientId === profile.clientId &&
              value.issuer === profile.issuer &&
              value.tokenProfileDigest !== value.observationProfileDigest,
          });
          checks.push({
            name: c.name + "_exact_signed_identity",
            passed:
              value?.subjectId === c.expectedSubjectId &&
              value.providerSessionId === c.expectedSessionId,
          });
          checks.push({
            name: c.name + "_independent_digest_oracles",
            passed:
              value?.tokenProfileDigest === c.expectedTokenProfileDigest &&
              value.keySetDigest === c.expectedKeySetDigest &&
              value.observationProfileDigest === c.expectedObservationProfileDigest,
          });
          checks.push({
            name: c.name + "_exact_time_metadata",
            passed:
              value?.issuedAtMs === c.expectedIssuedAtMs &&
              value.observedAtMs === c.expectedObservedAtMs &&
              value.expiresAtMs === c.expectedExpiresAtMs &&
              value.tokenProfileRevision === profile.revision,
          });
          checks.push({
            name: c.name + "_successful_handle_survives_cleanup",
            passed: factory.readEvidence(result.handle) !== null,
          });
          checks.push({
            name: c.name + "_opaque_handle",
            passed:
              Object.isFrozen(result.handle) &&
              Object.getPrototypeOf(result.handle) === null &&
              Object.keys(result.handle).length === 0,
          });
          checks.push({
            name: c.name + "_serialized_handle",
            passed: factory.readEvidence(JSON.parse(JSON.stringify(result.handle))) === null,
          });
          const other = createWorkosAuthenticationEvidence(c.profileJson, c.snapshotJson, {
            now: () => now,
            currentProfile: () => c.profileJson,
            readPage: async () => c.pages[0],
          });
          checks.push({
            name: c.name + "_foreign_handle",
            passed: other.readEvidence(result.handle) === null,
          });
          if (c.readAt !== undefined) {
            now = c.readAt;
            checks.push({
              name: c.name + "_completed_operation_deadline_is_not_evidence_expiry",
              passed: factory.readEvidence(result.handle) !== null,
            });
          }
          if (c.later !== undefined) {
            now = c.later;
            checks.push({
              name: c.name + "_evidence_expiry",
              passed: factory.readEvidence(result.handle) === null,
            });
          }
          if (c.mode === "profile_drift_on_read") {
            currentProfile = "{}";
            checks.push({
              name: c.name + "_drift_denial",
              passed: factory.readEvidence(result.handle) === null,
            });
            currentProfile = c.profileJson;
            checks.push({
              name: c.name + "_no_profile_revival",
              passed: factory.readEvidence(result.handle) === null,
            });
          }
          if (c.mode === "clock_backward_on_read") {
            now--;
            checks.push({
              name: c.name + "_clock_denial",
              passed: factory.readEvidence(result.handle) === null,
            });
            now = c.now;
            checks.push({
              name: c.name + "_no_clock_revival",
              passed: factory.readEvidence(result.handle) === null,
            });
          }
          if (c.mode === "cancel_on_read") {
            cancel.abort();
            checks.push({
              name: c.name + "_cancel_denial",
              passed: factory.readEvidence(result.handle) === null,
            });
          }
          if (c.mode === "expiry_during_profile_read") {
            advanceOnProfileRead = true;
            checks.push({
              name: c.name + "_post_profile_time_recheck",
              passed: factory.readEvidence(result.handle) === null,
            });
          }
        }
      } catch {
        checks.push({ name: c.name + "_unexpected_exception", passed: false });
      }
    }
    // A timed-out first attempt cannot cancel or substitute a later valid one.
    const concurrent = input.concurrency;
    let now = concurrent.now;
    let releaseFirst!: (value: string) => void;
    let notifyFirst!: () => void;
    const firstPage = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      notifyFirst = resolve;
    });
    let calls = 0;
    const factory = createWorkosAuthenticationEvidence(
      concurrent.profileJson,
      concurrent.snapshotJson,
      {
        now: () => now,
        currentProfile: () => concurrent.profileJson,
        readPage: async (selectorJson) => {
          calls++;
          const selector = JSON.parse(selectorJson);
          if (selector.subjectId === concurrent.firstSubject) {
            notifyFirst();
            return firstPage;
          }
          if (selector.subjectId === concurrent.secondSubject) return concurrent.secondPage;
          throw Error("WRONG_DERIVED_SUBJECT");
        },
      },
    );
    const first = factory.verify(concurrent.firstToken);
    const reachedPage = await Promise.race([requested.then(() => true), first.then(() => false)]);
    checks.push({ name: "concurrency_first_reaches_owned_page", passed: reachedPage });
    now += 10000;
    const second = await factory.verify(concurrent.secondToken);
    checks.push({
      name: "concurrency_second_token_verified",
      passed: second.outcome === "verified_active_evidence",
    });
    releaseFirst(concurrent.firstPage);
    const timedOut = await first;
    checks.push({
      name: "concurrency_first_attempt_deadline_held",
      passed: timedOut.outcome === "held",
    });
    const secondEvidence = second.outcome === "held" ? null : factory.readEvidence(second.handle);
    checks.push({
      name: "concurrency_timeout_does_not_poison_second",
      passed: secondEvidence?.subjectId === concurrent.secondSubject,
    });
    checks.push({ name: "concurrency_exact_two_derived_subject_reads", passed: calls === 2 });

    // Non-string data and foreign handles must not execute caller traps.
    const c = input.cases[0]!;
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw Error("PRIVATE");
        },
        getPrototypeOf() {
          traps++;
          throw Error("PRIVATE");
        },
        ownKeys() {
          traps++;
          throw Error("PRIVATE");
        },
      },
    );
    let pageReads = 0;
    const closed = createWorkosAuthenticationEvidence(c.profileJson, c.snapshotJson, {
      now: () => c.now,
      currentProfile: () => c.profileJson,
      readPage: async () => {
        pageReads++;
        return c.pages[0];
      },
    });
    checks.push({
      name: "hostile_token_held_without_page",
      passed: (await closed.verify(hostile)).outcome === "held" && pageReads === 0,
    });
    checks.push({
      name: "hostile_handle_no_reflection",
      passed: closed.readEvidence(hostile) === null,
    });
    for (const field of ["profile", "snapshot"]) {
      let denied = false;
      try {
        createWorkosAuthenticationEvidence(
          field === "profile" ? hostile : c.profileJson,
          field === "snapshot" ? hostile : c.snapshotJson,
          {
            now: () => c.now,
            currentProfile: () => c.profileJson,
            readPage: async () => c.pages[0],
          },
        );
      } catch {
        denied = true;
      }
      checks.push({ name: "hostile_" + field + "_denied", passed: denied });
    }
    checks.push({ name: "zero_hostile_object_traps", passed: traps === 0 });
    return Response.json({ checks });
  },
};
