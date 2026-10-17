// Synthetic local workerd fixture only. No deployed route or real provider token.
import { createWorkosSessionTokenVerifier } from "../../packages/identity/src/workos-session-token";

type Case = {
  name: string;
  profileJson: string;
  snapshotJson: string;
  token: unknown;
  now: number;
  expected: boolean;
  later?: number;
  clockSequence?: number[];
  advanceDuringCrypto?: number;
};

export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/synthetic-token-verifier")
      return new Response(null, { status: 404 });
    const input = (await request.json()) as { cases: Case[] };
    const checks: { name: string; passed: boolean }[] = [];
    for (const c of input.cases) {
      let now = c.now,
        reads = 0;
      try {
        const verifier = createWorkosSessionTokenVerifier(c.profileJson, c.snapshotJson, () =>
          c.clockSequence ? c.clockSequence[Math.min(reads++, c.clockSequence.length - 1)]! : now,
        );
        const pending = verifier.verify(c.token);
        if (c.advanceDuringCrypto !== undefined)
          queueMicrotask(() => {
            now = c.advanceDuringCrypto!;
          });
        const result = await pending;
        const verified = result.outcome === "verified";
        checks.push({ name: c.name, passed: verified === c.expected });
        if (verified) {
          const candidate = verifier.readCandidate(result.handle);
          checks.push({ name: c.name + "_candidate", passed: candidate !== null });
          if (candidate) {
            checks.push({
              name: c.name + "_no_local_authority",
              passed: ![
                "actor",
                "actorRef",
                "organizationId",
                "workspaceId",
                "roles",
                "permissions",
                "email",
                "accessToken",
                "token",
              ].some((key) => key in candidate),
            });
          }
          const other = createWorkosSessionTokenVerifier(c.profileJson, c.snapshotJson, () => now);
          checks.push({
            name: c.name + "_foreign_handle",
            passed: other.readCandidate(result.handle) === null,
          });
          checks.push({
            name: c.name + "_serialized_handle",
            passed: verifier.readCandidate(JSON.parse(JSON.stringify(result.handle))) === null,
          });
          if (c.later !== undefined) {
            now = c.later;
            checks.push({
              name: c.name + "_inspection_expiry",
              passed: verifier.readCandidate(result.handle) === null,
            });
          }
        }
      } catch {
        checks.push({ name: c.name + "_config_denial", passed: !c.expected });
      }
    }
    const first = input.cases[0]!;
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw Error("SYNTHETIC_ACCESSOR");
        },
        getPrototypeOf() {
          traps++;
          throw Error("SYNTHETIC_PROTOTYPE");
        },
        ownKeys() {
          traps++;
          throw Error("SYNTHETIC_KEYS");
        },
      },
    );
    const isolated = createWorkosSessionTokenVerifier(
      first.profileJson,
      first.snapshotJson,
      () => first.now,
    );
    checks.push({
      name: "hostile_token_without_reflection",
      passed: (await isolated.verify(hostile)).outcome === "denied",
    });
    checks.push({
      name: "hostile_handle_without_reflection",
      passed: isolated.readCandidate(hostile) === null,
    });
    for (const field of ["profile", "snapshot"]) {
      let denied = false;
      try {
        createWorkosSessionTokenVerifier(
          field === "profile" ? hostile : first.profileJson,
          field === "snapshot" ? hostile : first.snapshotJson,
          () => first.now,
        );
      } catch {
        denied = true;
      }
      checks.push({ name: "hostile_" + field + "_without_reflection", passed: denied });
    }
    checks.push({ name: "zero_hostile_object_traps", passed: traps === 0 });
    return Response.json({ checks });
  },
};
