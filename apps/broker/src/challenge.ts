import {
  challengeLimits,
  challengeTokenValid,
  type ChallengeVerdict,
} from "../../../packages/identity/src/broker-protocol.js";
import { BrokerHold, brokerCapabilities, invokeBrokerMethod } from "./capabilities.js";

// P05.T01ab (ADR-0019 item 6): the fourth ApiBroker method, a pre-authentication
// call under the v0 trust model. Exactly one POST to the fixed siteverify URL with
// only `secret` and `response`, no redirect followed, a reply of at most 4096 bytes
// and the caller's budget. workerd refuses `redirect: "error"` ("use manual and check
// the status"), so a 3xx, like every other non-200 status, is held. `passed` needs success, the configured hostname, the expected
// action and a fresh challenge_ts; any other decoded reply is `failed`. Transport,
// status, size, timeout or decoding problems are BROKER_HELD. Nothing is retried.
export const siteverifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !(/^[0-9]{1,5}$/.test(declared) && Number(declared) <= 4096))
    throw Error("REPLY_TOO_LARGE");
  if (!response.body) throw Error("REPLY_MISSING");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw Error("REPLY_TIMEOUT");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > challengeLimits.replyMaxBytes) throw Error("REPLY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}

function fresh(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !timestampPattern.test(value)) return false;
  const at = Date.parse(value);
  return (
    Number.isFinite(at) &&
    at >= now - challengeLimits.freshnessMs - challengeLimits.skewMs &&
    at <= now + challengeLimits.skewMs
  );
}

export function challengePassed(
  reply: unknown,
  hostname: string,
  action: string,
  now: number,
): boolean {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) return false;
  const fields = reply as Record<string, unknown>;
  return (
    fields.success === true &&
    fields.hostname === hostname &&
    fields.action === action &&
    fresh(fields.challenge_ts, now)
  );
}

export function brokerChallengeVerify(
  env: unknown,
  action: unknown,
  token: unknown,
  budgetMs: unknown,
): Promise<ChallengeVerdict> {
  return invokeBrokerMethod("challengeVerify", async () => {
    if (typeof action !== "string" || !challengeTokenValid(token))
      throw new BrokerHold("INPUT_INVALID");
    if (
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > challengeLimits.budgetMaxMs
    )
      throw new BrokerHold("BUDGET_INVALID");
    const capabilities = await brokerCapabilities(env);
    const challenge = capabilities.challenge;
    if (!challenge) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    if (!challenge.actions.includes(action)) throw new BrokerHold("INPUT_INVALID");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), budgetMs);
    let reply: unknown;
    try {
      const response = await fetch(siteverifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: challenge.secret, response: token }).toString(),
        redirect: "manual",
        signal: abort.signal,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw Error("REPLY_STATUS");
      }
      reply = JSON.parse(await boundedText(response, abort.signal));
    } catch {
      throw new BrokerHold("PROVIDER_HELD");
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    if (challengePassed(reply, challenge.hostname, action, Date.now())) return "passed";
    console.log(JSON.stringify({ event: "morrow_challenge", code: "failed" }));
    return "failed";
  });
}
