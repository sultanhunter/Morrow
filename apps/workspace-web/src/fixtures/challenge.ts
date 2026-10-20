// The fixture build's bot challenge (P05.T01ab). Scripted, like the adapter: the signup
// challenge scenarios get a host whose widget issues fixture tokens or none at all, and
// every other scenario asks for no challenge (a null token, as `{"provider":"none"}`). A
// widget gives one token per reset, as a single-use Turnstile token is: a form that sent
// without resetting gets "failed" next time.
import type { ChallengeHost } from "@morrow/workspace-ui";
import type { ScenarioName } from "./scenarios";

/** The scenarios whose build asks for a challenge, and what their widgets yield. */
export const challengedIn: Readonly<Partial<Record<ScenarioName, "issues" | "fails">>> = {
  account_challenge_failed: "issues",
  account_guard_rate_limited: "issues",
  account_challenge_unavailable: "fails",
};

export function fixtureChallengeFor(scenario: ScenarioName): ChallengeHost {
  const mode = challengedIn[scenario];
  let issued = 0;
  return () => {
    let armed = true;
    return {
      token() {
        if (mode === undefined) return Promise.resolve(null);
        if (mode === "fails" || !armed) return Promise.resolve("failed" as const);
        armed = false;
        issued += 1;
        return Promise.resolve(`fixture-challenge.${issued}`);
      },
      reset() {
        armed = true;
      },
      remove() {
        armed = false;
      },
    };
  };
}
