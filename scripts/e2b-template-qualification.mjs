import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { e2bLabSourceBinding, loadE2BReadOnlyAccess } from "./e2b-development-input.mjs";
import { discoverE2BDevelopmentOwnedTemplates } from "../packages/runtime-adapters/src/e2b/development-transport.ts";

export async function mainE2BTemplateQualification(argv = process.argv.slice(2)) {
  if (argv.length && !(argv.length === 2 && argv[0] === "--run")) {
    console.log("E2B_READONLY_USAGE_DENIED");
    return 2;
  }
  const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
  const account = JSON.parse(readFileSync("infra/labs/e2b-development-account.json", "utf8"));
  const source = e2bLabSourceBinding(".");
  const destination = `docs/evidence/P04.T01h/${argv.length ? "template-qualification" : "template-preparation"}.json`;
  mkdirSync(resolve(destination, ".."), { recursive: true });
  const base = {
    task: "P04.T01h",
    plan_sequence: plan.sources.plan.sequence,
    source_sha256: source.sourceSha256,
    source_digests: source.digests,
    read_only: true,
    sandbox_allocated: false,
    production_qualified: false,
  };
  const report = (value) =>
    writeFileSync(destination, JSON.stringify({ ...base, ...value }, null, 2) + "\n");
  if (!argv.length) {
    report({ status: "prepared", provider_calls: false, private_input_read: false });
    console.log("E2B_READONLY_PREPARED");
    return 0;
  }
  if (
    plan.sources.plan.sequence !== 59 ||
    account.plan_sequence !== 59 ||
    account.project_id !== "22220c06-b76d-47b2-98d7-a1069d611e8f" ||
    account.operator_access_authorized !== true ||
    account.private_access_receipt !== "owner_explicit" ||
    account.allocation_authorized !== false ||
    existsSync(".env") ||
    existsSync(".env.local") ||
    Object.keys(process.env).some(
      (name) =>
        name.startsWith("E2B_") || /^(HTTPS?_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)$/i.test(name),
    )
  )
    throw Error("E2B_READONLY_PREREQUISITES_DENIED");
  const access = loadE2BReadOnlyAccess(argv[1], resolve("../../morrow-private-staging"), {
    projectId: account.project_id,
    consoleProjectId: account.console_project_id,
    workspaceId: account.workspace_id,
  });
  try {
    const result = await discoverE2BDevelopmentOwnedTemplates(access);
    report({
      status: "partial",
      provider_calls: true,
      private_input_read: true,
      project_binding_verified: true,
      owned_ready_builds: result.builds.length,
      template_resources_verified: result.builds.length > 0,
      runtime_profile_qualified: false,
      result,
    });
    console.log(
      result.builds.length
        ? "E2B_READONLY_PROJECT_AND_OWNED_TEMPLATE_VERIFIED"
        : "E2B_READONLY_PROJECT_VERIFIED_NO_READY_OWNED_BUILD",
    );
    return 0;
  } catch {
    report({
      status: "unqualified",
      provider_calls_attempted: true,
      private_input_read: true,
      code: "E2B_READONLY_PROVIDER_QUALIFICATION_FAILED",
    });
    console.log("E2B_READONLY_PROVIDER_QUALIFICATION_FAILED");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await mainE2BTemplateQualification();
  } catch {
    console.log("E2B_READONLY_CONTROLLER_DENIED");
    process.exitCode = 2;
  }
}
