// The checks of an agent release's package (PR 10; AgentPackage@1 and SkillManifest@1,
// generalised for workspace-created agents by ADR-0037 PR 2). Pure: no I/O, clock or
// randomness. CI runs them on every first-party package, install runs them again, and the
// Add to team transaction runs them on a workspace package (ADR-0023 decisions 6 and 11d,
// ADR-0025 items 6 and 8, ADR-0027 items 3 and 12, ADR-0030 item 3, ADR-0037 items 2, 4 and
// 5); they decide nothing about a run, whose authority the loop re-checks at every tool call.
//
// - Every declared tool is in the catalogue and offered to the package's kind; the
//   Coordinator's tools are exactly its fixed set.
// - Depth 1 (ADR-0037 item 2): no package but the Coordinator's holds an agent.* tool,
//   workspace.task.delegate or an agents.* capability.
// - A workspace package (origin workspace, id workspace.*) holds nothing ADR-0037 item 5
//   excludes: no human_only capability with any verb, no support.*, no Level 2, no inbound
//   mail; its roleTextDigest is its instructions' digest. A first-party package never takes a
//   workspace id.
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
import { isAgentTool, toolEntry, toolsForContext } from "./tool-catalogue";

export type AgentPackageCode =
  | "PACKAGE_INVALID"
  | "PACKAGE_ID_KIND_MISMATCH"
  | "PACKAGE_ID_ORIGIN_MISMATCH"
  | "AGENT_AUTHORITY_OUTSIDE_COORDINATOR"
  | "WORKSPACE_EXCLUDED"
  | "ROLE_TEXT_DIGEST_MISMATCH"
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
  // morrow.specialist retired with the specialist kind (ADR-0037 item 7): no package takes it.
  const reserved = ["morrow.coordinator", "morrow.specialist"];
  if (
    (pkg.kind === "installed" && reserved.includes(pkg.id)) ||
    (pkg.kind === "coordinator" && pkg.id !== "morrow.coordinator")
  )
    codes.add("PACKAGE_ID_KIND_MISMATCH");
  if ((pkg.origin === "workspace") !== pkg.id.startsWith("workspace."))
    codes.add("PACKAGE_ID_ORIGIN_MISMATCH");
  // Tools by kind: an installed agent of either origin may be handed off to, run under a
  // mandate or called (ADR-0037 item 4: the same in every other way).
  const allowed =
    pkg.kind === "coordinator"
      ? toolsForContext("coordinator")
      : [
          ...new Set([
            ...toolsForContext("routed"),
            ...toolsForContext("mandate"),
            ...toolsForContext("call"),
          ]),
        ];
  if (pkg.tools.some((name) => !allowed.includes(name))) codes.add("TOOL_NOT_FOR_KIND");
  // Depth 1 (ADR-0037 item 2): only Morrow calls, routes to or creates an agent.
  if (
    pkg.kind !== "coordinator" &&
    (pkg.tools.some((name) => isAgentTool(name)) ||
      pkg.capabilities.some(
        (row) =>
          row.capabilityId === "workspace.task.delegate" || row.capabilityId.startsWith("agents."),
      ))
  )
    codes.add("AGENT_AUTHORITY_OUTSIDE_COORDINATOR");
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
  // ADR-0037 item 5: the fixed catalogue only, and never Level 2, support.* or customer mail.
  if (
    pkg.origin === "workspace" &&
    (pkg.capabilities.some(
      (row) =>
        capabilities.get(row.capabilityId)?.executor === "human_only" ||
        row.capabilityId.startsWith("support."),
    ) ||
      pkg.customerData === "level2" ||
      pkg.triggerKinds.includes("inbound_mail"))
  )
    codes.add("WORKSPACE_EXCLUDED");
  if (
    pkg.origin === "workspace" &&
    (pkg.instructions === null || canonicalDigest(pkg.instructions) !== pkg.roleTextDigest)
  )
    codes.add("ROLE_TEXT_DIGEST_MISMATCH");
  // Customer data, orders and the computer.
  const isSupport = pkg.id === "morrow.support" && pkg.origin === "first_party";
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
  // a first-party release offers its kind's default. A workspace package offers the entry its
  // card carried (the workspace's default for new teammates, ADR-0037 item 4).
  const key = (s: { model: string; effort: string }) => s.model + "/" + s.effort;
  const offered = pkg.offeredProfiles.map(key);
  if (pkg.offeredProfiles.some((s) => !loopEntry(catalogueVersion, s.model, s.effort)))
    codes.add("PROFILE_NOT_IN_CATALOGUE");
  if (!offered.includes(key(pkg.defaultProfile))) codes.add("PROFILE_DEFAULT_NOT_OFFERED");
  try {
    const kindDefault = defaultLoopProfile(catalogueVersion, pkg.kind);
    if (pkg.origin === "first_party" && !offered.includes(key(kindDefault)))
      codes.add("KIND_DEFAULT_NOT_OFFERED");
  } catch {
    codes.add("PROFILE_NOT_IN_CATALOGUE");
  }
  const order: readonly AgentPackageCode[] = [
    "PACKAGE_ID_KIND_MISMATCH",
    "PACKAGE_ID_ORIGIN_MISMATCH",
    "TOOL_NOT_FOR_KIND",
    "AGENT_AUTHORITY_OUTSIDE_COORDINATOR",
    "WORKSPACE_EXCLUDED",
    "ROLE_TEXT_DIGEST_MISMATCH",
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
