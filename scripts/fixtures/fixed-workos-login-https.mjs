import { createFixedWorkosProviderOracle } from "./fixed-workos-provider.mjs";

// This fixture remaps no network endpoint. The merchant-facing listener uses
// real loopback HTTPS; provider replies are independent in-process Fetch objects
// whose final URL is explicitly normalized by the independent oracle.
export function createFixedWorkosHttpsProvider({
  configurationJson,
  subjectId,
  providerSessionId,
  fault = "none",
}) {
  let advance = 0;
  const now = () => Date.now() + advance;
  const privateMarkers = [];
  let faultCount = 0;
  const oracle = createFixedWorkosProviderOracle({
    configurationJson,
    subjectId,
    providerSessionId,
    now,
    async responseFault({ kind, response, url }) {
      if (faultCount) return response;
      if (fault === "exchange_redirect" && kind === "exchange") {
        faultCount++;
        await response.body.cancel();
        return oracle.response(url, "", 302, {
          "Content-Type": "application/json",
          Location: "https://foreign.invalid/never-requested",
        });
      }
      if (fault === "signature" && kind === "exchange") {
        faultCount++;
        const body = JSON.parse(await response.text());
        const parts = body.access_token.split(".");
        parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
        const changed = parts.join(".");
        privateMarkers.push(changed);
        return oracle.response(url, JSON.stringify({ access_token: changed }));
      }
      if (fault === "late_keyset" && kind === "publicKeyset") {
        faultCount++;
        // Advance only the synthetic operation clock after a complete provider
        // reply. Existing callback/observation deadlines are never extended.
        advance = 30000;
      }
      return response;
    },
    async beforeBorrowReturn({ lease }) {
      if (fault === "wrong_namespace") {
        faultCount++;
        lease.namespaceJson = JSON.stringify({ schemaVersion: 1, purpose: "foreign" });
      }
    },
    async beforeRelease() {
      if (fault === "release_rejected") {
        faultCount++;
        throw Error("SYNTHETIC_FIXED_PROVIDER_RELEASE_HELD");
      }
    },
  });
  return Object.freeze({
    oracle,
    now,
    async fetch(input, init) {
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        if (typeof body.code_verifier === "string") privateMarkers.push(body.code_verifier);
      }
      return oracle.syntheticFetch(input, init);
    },
    sessionCredentialBroker: oracle.broker,
    metrics: oracle.metrics,
    calls: oracle.calls,
    privateMarkers,
    faultCount: () => faultCount,
    arm(authorizationUrl) {
      const result = oracle.arm(authorizationUrl);
      privateMarkers.push(result.code, result.token, authorizationUrl);
      return result;
    },
    cleanupObservation() {
      return Object.freeze({
        releaseAttempts: oracle.metrics.releaseAttempts,
        releaseCompletions: oracle.metrics.releaseCompletions,
        activeLeases: oracle.metrics.activeLeases,
        // A deliberately rejected release is a tested unknown outcome. It is
        // not relabeled disposed from loss of JS references or test teardown.
        credentialDisposal:
          oracle.metrics.activeLeases === 0 ? "acknowledged" : "intentionally_unverified",
      });
    },
  });
}
