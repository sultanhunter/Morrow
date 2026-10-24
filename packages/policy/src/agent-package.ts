// The checks of an agent release's package (PR 10; AgentPackage@1 and SkillManifest@1). Pure:
// no I/O, clock or randomness. CI runs them on every first-party package and install runs them
// again (ADR-0023 decisions 6 and 11d, ADR-0025 items 6 and 8, ADR-0027 items 3 and 12,
// ADR-0030 item 3); they decide nothing about a run, whose authority the loop re-checks at
// every tool call.
//
// - Every declared tool is in the catalogue and offered to the package's kind; the
//   Coordinator's tools are exactly its fixed set.
// - A tool's capability and verb are among those the package asks for (the install screen
//   shows them); an agent never asks for a human_only capability except to propose it.
// - Only Support (morrow.support) asks for support.* or Level 2; Level 1 and orders.read need
//   the read_orders scope; no package declares both customer reads and the computer.
// - Each pinned skill's skill.json is present with its digest, and declares only tools the
//   package declares: a skill never adds a tool.
// - The offered model entries exist in the catalogue version and include the kind's default.
import type { Current_AgentPackage, Current_SkillManifest } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import catalogue from "../../../docs/contracts/capabilities.json";
import { defaultLoopProfile, loopEntry } from "./loop-catalogue";
import { canonicalDigest } from "./review";
import { toolEntry, toolsForContext } from "./tool-catalogue";

export type AgentPackageCode =
  | "PACKAGE_INVALID"
  | "PACKAGE_ID_KIND_MISMATCH"
  | "TOOL_NOT_FOR_KIND"
  | "COORDINATOR_TOOLS_NOT_FIXED"
  | "TOOL_CAPABILITY_NOT_REQUESTED"
  | "CAPABILITY_UNKNOWN"
  | "CAPABILITY_REPEATED"
  | "HUMAN_ONLY_REQUESTED"
  | "SUPPORT_OUTSIDE_SUPPORT"
  | "LEVEL2_OUTSIDE_SUPPORT"
  | "ORDERS_WITHOUT_SCOPE"
  | "CUSTOMER_READS_WITH_COMPUTER"
  | "SKILL_MANIFEST_MISSING"
  | "SKILL_DIGEST_MISMATCH"
  | "SKILL_ADDS_TOOL"
  | "PROFILE_NOT_IN_CATALOGUE"
  | "PROFILE_DEFAULT_NOT_OFFERED"
  | "KIND_DEFAULT_NOT_OFFERED";

const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
/** The digest a package pins for one skill: SHA-256 of its skill.json's RFC 8785 text. */
export const skillDigest = (manifest: Current_SkillManifest): string => canonicalDigest(manifest);

/** Every problem with a package and its skills, in a fixed order; empty passes. */
export function inspectAgentPackage(
  value: unknown,
  skills: readonly unknown[],
  catalogueVersion: number,
): readonly AgentPackageCode[] {
  if (!validateCurrentDefinition("AgentPackage", value)) return ["PACKAGE_INVALID"];
  if (!Array.isArray(skills) || !skills.every((s) => validateCurrentDefinition("SkillManifest", s)))
    return ["PACKAGE_INVALID"];
  const pkg = value as Current_AgentPackage;
  const manifests = skills as readonly Current_SkillManifest[];
  const codes = new Set<AgentPackageCode>();
  const builtIn = { coordinator: "morrow.coordinator", specialist: "morrow.specialist" } as const;
  if (
    (pkg.kind === "installed" && Object.values(builtIn).includes(pkg.id as never)) ||
    (pkg.kind !== "installed" && pkg.id !== builtIn[pkg.kind])
  )
    codes.add("PACKAGE_ID_KIND_MISMATCH");
  // Tools by kind.
  const allowed =
    pkg.kind === "coordinator"
      ? toolsForContext("coordinator")
      : pkg.kind === "specialist"
        ? toolsForContext("specialist")
        : [...new Set([...toolsForContext("routed"), ...toolsForContext("mandate")])];
  if (pkg.tools.some((name) => !allowed.includes(name))) codes.add("TOOL_NOT_FOR_KIND");
  if (
    pkg.kind === "coordinator" &&
    [...pkg.tools].sort().join() !== [...toolsForContext("coordinator")].sort().join()
  )
    codes.add("COORDINATOR_TOOLS_NOT_FIXED");
  // Capabilities asked for.
  const asked = new Map<string, readonly string[]>();
  for (const row of pkg.capabilities) {
    if (asked.has(row.capabilityId)) codes.add("CAPABILITY_REPEATED");
    asked.set(row.capabilityId, row.verbs);
    const capability = capabilities.get(row.capabilityId);
    if (!capability) {
      codes.add("CAPABILITY_UNKNOWN");
      continue;
    }
    if (capability.executor === "human_only" && row.verbs.some((verb) => verb !== "propose"))
      codes.add("HUMAN_ONLY_REQUESTED");
  }
  for (const name of pkg.tools) {
    const tool = toolEntry(name);
    if (!tool || !(asked.get(tool.capabilityId) ?? []).includes(tool.verb))
      codes.add("TOOL_CAPABILITY_NOT_REQUESTED");
  }
  // Customer data, orders and the computer.
  const isSupport = pkg.id === "morrow.support";
  if (!isSupport && [...asked.keys()].some((id) => id.startsWith("support.")))
    codes.add("SUPPORT_OUTSIDE_SUPPORT");
  if (!isSupport && pkg.customerData === "level2") codes.add("LEVEL2_OUTSIDE_SUPPORT");
  if (
    (asked.has("orders.read") || pkg.customerData !== "none") &&
    !pkg.optionalScopes.includes("read_orders")
  )
    codes.add("ORDERS_WITHOUT_SCOPE");
  if (pkg.computer && (pkg.customerData === "level2" || asked.has("support.case.read")))
    codes.add("CUSTOMER_READS_WITH_COMPUTER");
  // Pinned skills.
  for (const pinned of pkg.skills) {
    const manifest = manifests.find((m) => m.id === pinned.id);
    if (!manifest) {
      codes.add("SKILL_MANIFEST_MISSING");
      continue;
    }
    if (skillDigest(manifest) !== pinned.digest) codes.add("SKILL_DIGEST_MISMATCH");
    if (manifest.tools.some((name) => !pkg.tools.includes(name))) codes.add("SKILL_ADDS_TOOL");
  }
  // Model entries (ADR-0027 item 12): each offered entry exists, the default is offered, and
  // so is the kind's default.
  const key = (s: { model: string; effort: string }) => s.model + "/" + s.effort;
  const offered = pkg.offeredProfiles.map(key);
  if (pkg.offeredProfiles.some((s) => !loopEntry(catalogueVersion, s.model, s.effort)))
    codes.add("PROFILE_NOT_IN_CATALOGUE");
  if (!offered.includes(key(pkg.defaultProfile))) codes.add("PROFILE_DEFAULT_NOT_OFFERED");
  try {
    const kindDefault = defaultLoopProfile(
      catalogueVersion,
      pkg.kind === "installed" ? "installed" : pkg.kind,
    );
    if (!offered.includes(key(kindDefault))) codes.add("KIND_DEFAULT_NOT_OFFERED");
  } catch {
    codes.add("PROFILE_NOT_IN_CATALOGUE");
  }
  const order: readonly AgentPackageCode[] = [
    "PACKAGE_ID_KIND_MISMATCH",
    "TOOL_NOT_FOR_KIND",
    "COORDINATOR_TOOLS_NOT_FIXED",
    "TOOL_CAPABILITY_NOT_REQUESTED",
    "CAPABILITY_UNKNOWN",
    "CAPABILITY_REPEATED",
    "HUMAN_ONLY_REQUESTED",
    "SUPPORT_OUTSIDE_SUPPORT",
    "LEVEL2_OUTSIDE_SUPPORT",
    "ORDERS_WITHOUT_SCOPE",
    "CUSTOMER_READS_WITH_COMPUTER",
    "SKILL_MANIFEST_MISSING",
    "SKILL_DIGEST_MISMATCH",
    "SKILL_ADDS_TOOL",
    "PROFILE_NOT_IN_CATALOGUE",
    "PROFILE_DEFAULT_NOT_OFFERED",
    "KIND_DEFAULT_NOT_OFFERED",
  ];
  return Object.freeze(order.filter((code) => codes.has(code)));
}
