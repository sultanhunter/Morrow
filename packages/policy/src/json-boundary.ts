// Internal JSON boundary helpers shared by the policy evaluators. Not a package export.
// JSON-only bounded values: reject getters/toJSON/prototype tricks before schema
// validators or cloning can read fields. These are not user-supplied adapters.
export function plainJson(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 0 },
): boolean {
  if (++budget.nodes > 200000 || depth > 16) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  if (
    Array.isArray(value) &&
    (Object.getPrototypeOf(value) !== Array.prototype ||
      Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, i) => key !== String(i)))
  )
    return false;
  seen.add(value);
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (
      !desc.enumerable ||
      !("value" in desc) ||
      !plainJson(desc.value as unknown, depth + 1, seen, budget)
    )
      return false;
  }
  seen.delete(value);
  return true;
}
export function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
export function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}
