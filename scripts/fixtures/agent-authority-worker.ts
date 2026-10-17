// Local workerd fixture only. Never deployed or imported by an application.
import {
  createAgentAuthorityService,
  canonicalPayloadDigest,
} from "../../packages/policy/src/agent-authority";

interface Case {
  name: string;
  mode: "delegation" | "automation";
  input: unknown;
  facts: unknown;
  allowed: boolean;
}
export default {
  async fetch(request: Request) {
    const data = (await request.json()) as {
      cases: Case[];
      clock: string;
      digestPayload: unknown;
      expectedDigest: string;
    };
    const checks: { name: string; passed: boolean }[] = [];
    const record = (name: string, passed: boolean) => checks.push({ name, passed });
    for (const c of data.cases) {
      try {
        let reads = 0;
        const read = async () => {
          reads++;
          return JSON.stringify(c.facts);
        };
        const service = createAgentAuthorityService(
          { readDelegationCurrent: read, readAutomationCurrent: read },
          () => new Date(data.clock),
        );
        const result = await (c.mode === "delegation"
          ? service.decideDelegation(JSON.stringify(c.input))
          : service.decideAutomation(JSON.stringify(c.input)));
        record(
          c.name,
          result.decision.allowed === c.allowed &&
            reads === 1 &&
            (c.allowed
              ? result.lineage !== null && result.obligations.includes("qualified_dispatch")
              : result.lineage === null && result.obligations.length === 0),
        );
      } catch {
        record(c.name, false);
      }
    }
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps++;
          throw Error("FIXTURE_TRAP");
        },
        ownKeys() {
          traps++;
          throw Error("FIXTURE_TRAP");
        },
        // Native Promise resolution probes `then` before an awaited value reaches
        // the kernel. The kernel must reject the object without inspecting it.
        get(_target, key) {
          if (key === "then") return undefined;
          traps++;
          throw Error("FIXTURE_TRAP");
        },
      },
    );
    let getters = 0;
    const accessor = {
      get envelopeId() {
        getters++;
        throw Error("FIXTURE_GETTER");
      },
    };
    const normal = data.cases[0]!;
    const reader = async () => JSON.stringify(normal.facts);
    const service = createAgentAuthorityService(
      { readDelegationCurrent: reader, readAutomationCurrent: reader },
      () => new Date(data.clock),
    );
    for (const [name, input] of [
      ["proxy_input_rejected_without_traps", hostile],
      ["accessor_input_rejected_without_getters", accessor],
      ["malformed_json_rejected", "{broken"],
    ] as const) {
      let denied = false;
      try {
        await service.decideDelegation(input);
      } catch (error) {
        denied = (error as { code: string }).code === "AGENT_POLICY_INPUT_INVALID";
      }
      record(name, denied && traps === 0 && getters === 0);
    }
    const hostileReader = async () => hostile as unknown as string;
    const hostileService = createAgentAuthorityService(
      { readDelegationCurrent: hostileReader, readAutomationCurrent: hostileReader },
      () => new Date(data.clock),
    );
    let rejectedReader = false;
    try {
      await hostileService.decideDelegation(JSON.stringify(normal.input));
    } catch (error) {
      rejectedReader = (error as { code: string }).code === "AGENT_POLICY_AUTHORITY_UNAVAILABLE";
    }
    record("proxy_reader_rejected_without_reflection", rejectedReader && traps === 0);
    try {
      record(
        "canonical_digest_matches_independent_node_oracle",
        canonicalPayloadDigest(JSON.stringify(data.digestPayload)) === data.expectedDigest,
      );
    } catch {
      record("canonical_digest_matches_independent_node_oracle", false);
    }
    let dynamicDenied = false;
    try {
      new Function("return 1")();
    } catch {
      dynamicDenied = true;
    }
    record("dynamic_code_generation_denied", dynamicDenied);
    return Response.json({ checks });
  },
};
