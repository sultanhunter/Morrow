import {
  brokerLimits,
  brokerUtf8Bytes,
  challengeLimits,
  challengeTokenValid,
  decodeNeonLeaseGrant,
  type ApiBrokerRpc,
  type ChallengeVerdict,
} from "../../../packages/identity/src/broker-protocol.js";
import type { LoginControl } from "../../../packages/identity/src/standalone-login-protocol.js";
import type { WorkosSessionPageReader } from "../../../packages/identity/src/workos-session-status.js";

// api-side adapters over the ApiBroker service binding (P04.T02a D3, D6). They
// are structural (no `cloudflare:` import): no AbortSignal or absolute time
// crosses RPC, each call makes at most one RPC raced against the caller's own
// signal and timer, a late result is discarded, and nothing is retried.

const held = () => Error("API_BROKER_HELD");
const time = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8640000000000000;

// The control's own data only: exactly deadlineMs and signal.
export function brokerControl(value: unknown): Readonly<LoginControl> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw held();
  const keys = Reflect.ownKeys(value);
  const deadline = Object.getOwnPropertyDescriptor(value, "deadlineMs");
  const signal = Object.getOwnPropertyDescriptor(value, "signal");
  if (
    keys.length !== 2 ||
    !deadline ||
    !signal ||
    !("value" in deadline) ||
    !("value" in signal) ||
    !time(deadline.value) ||
    !(signal.value instanceof AbortSignal)
  )
    throw held();
  return Object.freeze({ deadlineMs: deadline.value, signal: signal.value });
}
function clock(now: () => number): number {
  const at: unknown = now();
  if (!time(at)) throw held();
  return at;
}

// Races one started operation against `signal` and a timer of `ms`. The loser is
// left to settle unobserved; its value is never used.
export async function raceBrokerCall<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T> {
  if (signal.aborted || !(ms > 0)) throw held();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(held());
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, ms);
  });
  void stopped.catch(() => {});
  try {
    const pending = start();
    void Promise.resolve(pending).catch(() => {});
    return await Promise.race([pending, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (stop) signal.removeEventListener("abort", stop);
  }
}

export function createBrokerNeonCredentialBroker(
  broker: ApiBrokerRpc,
  now: () => number,
): Readonly<{ borrow(namespaceJson: string, control: Readonly<LoginControl>): Promise<unknown> }> {
  return Object.freeze({
    async borrow(namespaceJson: string, supplied: Readonly<LoginControl>): Promise<unknown> {
      const control = brokerControl(supplied);
      if (
        typeof namespaceJson !== "string" ||
        brokerUtf8Bytes(namespaceJson) > brokerLimits.namespaceMaxBytes ||
        control.signal.aborted
      )
        throw held();
      const remaining = control.deadlineMs - clock(now);
      if (remaining <= 0) throw held();
      const grant = await raceBrokerCall(
        () => broker.neonLease(namespaceJson),
        control.signal,
        remaining,
      );
      const password = decodeNeonLeaseGrant(grant);
      // expiresAtMs adds nothing beyond the pool's own deadline D; the password is
      // static. release resolves locally and never aborts the signal, which the
      // pool's normal release path listens on.
      const release = async (releaseControl: Readonly<LoginControl>): Promise<void> => {
        brokerControl(releaseControl);
      };
      return Object.freeze({
        namespaceJson,
        password,
        expiresAtMs: control.deadlineMs,
        revocationSignal: new AbortController().signal,
        release,
      });
    },
  });
}

export function createBrokerSessionPageReader(
  broker: ApiBrokerRpc,
  workosNamespaceJson: string,
  now: () => number,
): WorkosSessionPageReader {
  return async (selectorJson: string, supplied) => {
    const control = brokerControl(supplied);
    if (typeof selectorJson !== "string" || control.signal.aborted) throw held();
    const budgetMs = Math.min(brokerLimits.sessionPageMaxMs, control.deadlineMs - clock(now));
    if (budgetMs <= 0) throw held();
    const page = await raceBrokerCall(
      () => broker.workosSessionPage(workosNamespaceJson, selectorJson, budgetMs),
      control.signal,
      budgetMs,
    );
    if (typeof page !== "string" || brokerUtf8Bytes(page) > brokerLimits.sessionPageMaxBytes)
      throw held();
    return page;
  };
}

// One health() RPC at a time, at most once per 30 s per isolate, each bounded by
// 1000 ms; a public /healthz therefore cannot amplify broker calls.
export function createBrokerHealth(
  broker: ApiBrokerRpc,
  now: () => number,
): () => Promise<boolean> {
  let cached: Readonly<{ at: number; value: boolean }> | undefined;
  let pending: Promise<boolean> | undefined;
  return () => {
    let at: number;
    try {
      at = clock(now);
    } catch {
      return Promise.resolve(false);
    }
    if (cached && at >= cached.at && at - cached.at < brokerLimits.healthCacheMs)
      return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = (async () => {
      let value = false;
      try {
        // A fresh signal per call: Workers bind I/O objects to the request that
        // created them, and this instance outlives the request that composed it.
        const unaborted = new AbortController().signal;
        value =
          (await raceBrokerCall(() => broker.health(), unaborted, brokerLimits.healthMaxMs)) ===
          true;
      } catch {
        value = false;
      }
      cached = Object.freeze({ at, value });
      pending = undefined;
      return value;
    })();
    return pending;
  };
}

// P05.T01ab: exactly one challengeVerify RPC, raced against the request's signal and
// the budget plus a small RPC allowance; never retried. Only "passed" or "failed"
// are verdicts; anything else, a late reply or a throw is API_BROKER_HELD.
export function createBrokerChallengeVerifier(
  broker: ApiBrokerRpc,
): (
  action: string,
  token: string,
  budgetMs: number,
  signal: AbortSignal,
) => Promise<ChallengeVerdict> {
  return async (action, token, budgetMs, signal) => {
    if (
      typeof action !== "string" ||
      !challengeTokenValid(token) ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > challengeLimits.budgetMaxMs ||
      !(signal instanceof AbortSignal)
    )
      throw held();
    const verdict: unknown = await raceBrokerCall(
      () => broker.challengeVerify(action, token, budgetMs),
      signal,
      budgetMs + 250,
    );
    if (verdict !== "passed" && verdict !== "failed") throw held();
    return verdict;
  };
}
