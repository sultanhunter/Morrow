import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import core from "../../../docs/contracts/schemas/v1/core.schema.json";
import capabilities from "../../../docs/contracts/schemas/v1/capabilities.schema.json";
import billing from "../../../docs/contracts/schemas/v1/billing.schema.json";
import type { CapabilityId, CapabilityInput, CapabilityOutput } from "./generated/domain";
const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  validateFormats: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
addFormats(ajv);
for (const schema of [core, capabilities, billing]) ajv.addSchema(schema);
const cache = new Map<string, ReturnType<typeof ajv.compile>>();
function valid(ref: string, value: unknown): boolean {
  let validator = cache.get(ref);
  if (!validator) {
    validator = ajv.compile({ $ref: ref });
    cache.set(ref, validator);
  }
  return validator(value) === true;
}
export function validateCapabilityInput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityInput<K> {
  return valid(`${capabilities.$id}#/$defs/${id}.input`, value);
}
export function validateCapabilityOutput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityOutput<K> {
  return valid(`${capabilities.$id}#/$defs/${id}.output`, value);
}
export function validateDefinition(
  schema: "core" | "billing",
  name: string,
  value: unknown,
): boolean {
  const source = schema === "core" ? core : billing;
  if (!(name in source.$defs)) return false;
  return valid(`${source.$id}#/$defs/${name}`, value);
}
