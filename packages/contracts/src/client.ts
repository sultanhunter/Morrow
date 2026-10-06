import type { CapabilityId, CapabilityInput, CapabilityOutput } from "./generated/domain";
import { validateCapabilityInput, validateCapabilityOutput } from "./validation";
/** Inject authenticated transport; schemas do not grant authority or implement endpoints. */
export type CapabilityTransport = (id: CapabilityId, input: unknown) => Promise<unknown>;
export function createCapabilityClient(transport: CapabilityTransport) {
  return {
    async invoke<K extends CapabilityId>(
      id: K,
      input: CapabilityInput<K>,
    ): Promise<CapabilityOutput<K>> {
      if (!validateCapabilityInput(id, input)) throw new Error("Invalid capability input");
      const output = await transport(id, input);
      if (!validateCapabilityOutput(id, output)) throw new Error("Invalid capability output");
      return output;
    },
  };
}
