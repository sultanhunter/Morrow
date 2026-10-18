import {
  validators,
  currentDefinitionSelectors,
  capabilityBodySelectors,
  currentBillingDefinitionSelectors,
} from "./generated/runtime-validators.mjs";
import type {
  CapabilityId,
  CapabilityInput,
  CapabilityOutput,
  CurrentBillingDefinitionName,
  CurrentDefinitionName,
} from "./generated/domain";
/** Exact schema layers. Product code uses the effective (current) selectors below. */
export type DefinitionSchema = "core" | "billing" | "core-v1.1" | "billing-v1.1";
const definitionSchemas: readonly string[] = ["core", "billing", "core-v1.1", "billing-v1.1"];
function valid(selector: string, value: unknown): boolean {
  if (!Object.hasOwn(validators, selector)) return false;
  return validators[selector]!(value) === true;
}
function selected(selectors: Readonly<Record<string, string>>, key: string, value: unknown) {
  return Object.hasOwn(selectors, key) && valid(selectors[key]!, value);
}
/** Validates the effective input body: the v1.1 override when one exists, else v1. */
export function validateCapabilityInput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityInput<K> {
  return selected(capabilityBodySelectors, `${id}.input`, value);
}
/** Validates the effective output body: the v1.1 override when one exists, else v1. */
export function validateCapabilityOutput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityOutput<K> {
  return selected(capabilityBodySelectors, `${id}.output`, value);
}
/** Exact selector, for the frozen baseline, history and tests. */
export function validateDefinition(
  schema: DefinitionSchema,
  name: string,
  value: unknown,
): boolean {
  return definitionSchemas.includes(schema) && valid(`${schema}:${name}`, value);
}
/** Effective definition: the newest core layer that defines the name. */
export function validateCurrentDefinition(name: CurrentDefinitionName, value: unknown): boolean {
  return selected(currentDefinitionSelectors, name, value);
}
/** Effective billing definition: the newest billing layer that defines the name (ADR-0015). */
export function validateCurrentBillingDefinition(
  name: CurrentBillingDefinitionName,
  value: unknown,
): boolean {
  return selected(currentBillingDefinitionSelectors, name, value);
}
