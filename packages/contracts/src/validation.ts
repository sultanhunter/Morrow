import { validators } from "./generated/runtime-validators.mjs";
import type { CapabilityId, CapabilityInput, CapabilityOutput } from "./generated/domain";
function valid(selector: string, value: unknown): boolean {
  if (!Object.hasOwn(validators, selector)) return false;
  return validators[selector]!(value) === true;
}
export function validateCapabilityInput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityInput<K> {
  return valid(`capabilities:${id}.input`, value);
}
export function validateCapabilityOutput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityOutput<K> {
  return valid(`capabilities:${id}.output`, value);
}
export function validateDefinition(
  schema: "core" | "billing",
  name: string,
  value: unknown,
): boolean {
  return valid(`${schema}:${name}`, value);
}
