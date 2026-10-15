// Local workerd laboratory only. No public status route or provider credentials.
import { createWorkosSessionStatusReader } from "../../packages/identity/src/workos-session-status";

type Case = {
  name: string;
  profileJson: unknown;
  queryJson: unknown;
  pages: unknown[];
  now: number;
  expected: string;
  expectedReads: number;
  expectedConfigDenial?: boolean;
  mode?: string;
  later?: number;
};

export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/synthetic-session-status")
      return new Response(null, { status: 404 });
    const input = (await request.json()) as { cases: Case[] };
    const checks: { name: string; passed: boolean }[] = [];
    for (const c of input.cases) {
      let now = c.now;
      let profileJson = c.profileJson;
      let reads = 0;
      const external = new AbortController();
      let reader: ReturnType<typeof createWorkosSessionStatusReader>;
      try {
        reader = createWorkosSessionStatusReader(c.profileJson, {
          now: () => now,
          currentProfile: () => profileJson,
          signal: external.signal,
          readPage: async (selectorJson, control) => {
            const selector = JSON.parse(selectorJson);
            checks.push({
              name: c.name + "_fixed_page_request_" + reads,
              passed:
                Object.keys(selector).sort().join(",") ===
                  "after,limit,order,schemaVersion,subjectId" &&
                selector.after ===
                  (reads === 0
                    ? null
                    : JSON.parse(c.pages[reads - 1] as string).list_metadata.after) &&
                selector.schemaVersion === 1 &&
                selector.subjectId === JSON.parse(c.queryJson as string).subjectId &&
                selector.limit === 100 &&
                selector.order === "asc" &&
                control.deadlineMs === c.now + 10000 &&
                control.signal instanceof AbortSignal &&
                Object.isFrozen(control),
            });
            const page = c.pages[reads++];
            if (c.mode === "throw") throw Error("SYNTHETIC_PRIVATE_ERROR");
            if (c.mode === "profile_drift") profileJson = "{}";
            if (c.mode === "clock_backward") now--;
            if (c.mode === "deadline") now += 10000;
            if (c.mode === "lease_elapsed") now += 5000;
            if (c.mode === "cancel") external.abort();
            if (c.mode === "stall_abort") {
              queueMicrotask(() => external.abort());
              return new Promise(() => {});
            }
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
        const result = await reader.observe(c.queryJson);
        checks.push({ name: c.name, passed: result.outcome === c.expected });
        checks.push({ name: c.name + "_read_budget", passed: reads === c.expectedReads });
        checks.push({
          name: c.name + "_closed_result",
          passed:
            Object.isFrozen(result) && Object.keys(result).sort().join(",") === "handle,outcome",
        });
        if (result.outcome !== "held") {
          const value = reader.readObservation(result.handle);
          checks.push({
            name: c.name + "_private_observation",
            passed: value !== null && Object.isFrozen(value),
          });
          checks.push({
            name: c.name + "_expected_only_client_provenance",
            passed:
              value?.clientBinding === "expected_only" &&
              value.expectedApplicationId === JSON.parse(c.profileJson as string).applicationId &&
              value.expectedClientId === JSON.parse(c.profileJson as string).clientId &&
              !("applicationId" in value) &&
              !("clientId" in value),
          });
          checks.push({
            name: c.name + "_no_local_authority",
            passed:
              value !== null &&
              ![
                "actor",
                "actorRef",
                "workspaceId",
                "organizationId",
                "roles",
                "permissions",
                "email",
                "token",
                "accessToken",
                "session",
                "principal",
                "user_agent",
                "ip_address",
              ].some((key) => key in value),
          });
          checks.push({
            name: c.name + "_opaque_handle",
            passed:
              Object.isFrozen(result.handle) &&
              Object.keys(result.handle).length === 0 &&
              Object.getPrototypeOf(result.handle) === null,
          });
          const other = createWorkosSessionStatusReader(c.profileJson, {
            now: () => now,
            currentProfile: () => c.profileJson,
            readPage: async () => c.pages[0],
          });
          checks.push({
            name: c.name + "_foreign_handle",
            passed: other.readObservation(result.handle) === null,
          });
          checks.push({
            name: c.name + "_serialized_handle",
            passed: reader.readObservation(JSON.parse(JSON.stringify(result.handle))) === null,
          });
          if (c.later !== undefined) {
            now = c.later;
            checks.push({
              name: c.name + "_lease_expiry",
              passed: reader.readObservation(result.handle) === null,
            });
          }
        } else checks.push({ name: c.name + "_no_handle", passed: result.handle === null });
      } catch {
        checks.push({
          name: c.name + "_unexpected_exception",
          passed: false,
        });
      }
    }
    // Object boundaries must reject without invoking getters or Proxy traps.
    const c = input.cases[0]!;
    let traps = 0;
    // Async return performs Promise then-assimilation before the module receives it.
    const hostile = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") return undefined;
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
    const reader = createWorkosSessionStatusReader(c.profileJson, {
      now: () => c.now,
      currentProfile: () => c.profileJson,
      readPage: async () => hostile,
    });
    checks.push({
      name: "hostile_query_no_reflection",
      passed: (await reader.observe(hostile)).outcome === "held",
    });
    checks.push({
      name: "hostile_page_no_reflection",
      passed: (await reader.observe(c.queryJson)).outcome === "held",
    });
    checks.push({
      name: "hostile_handle_no_reflection",
      passed: reader.readObservation(hostile) === null,
    });
    let profileDenied = false;
    try {
      createWorkosSessionStatusReader(hostile, {
        now: () => c.now,
        currentProfile: () => c.profileJson,
        readPage: async () => c.pages[0],
      });
    } catch {
      profileDenied = true;
    }
    checks.push({ name: "hostile_profile_no_reflection", passed: profileDenied });
    checks.push({ name: "zero_hostile_object_traps", passed: traps === 0 });
    return Response.json({ checks });
  },
};
