import {
  loginHash,
  loginId,
  loginJson,
  loginRevision,
  parseLoginConfigurationWithAttempt,
  type LoginAttempt,
  type LoginConfiguration,
} from "./standalone-login-protocol.js";
import {
  parseStandaloneLogoutConfigurationWithAttempt,
  type StandaloneLogoutConfiguration,
} from "./standalone-logout.js";

// Private captured source configuration. No request, context, credential,
// pending initialization or keyring material belongs in this binding.
export interface CapturedManagedWorkspaceBinding {
  readonly loginConfigurationJson: string;
  readonly workspaceConfigurationJson: string;
  readonly logoutConfigurationJson: string;
  readonly bindingJson: string;
  readonly origin: string;
}
export interface ManagedWorkspaceNeonBinding {
  readonly schemaVersion: 1;
  readonly environment: "development" | "staging";
  readonly projectId: string;
  readonly branchId: string;
  readonly hostname: string;
  readonly database: string;
}
export interface ResolvedManagedWorkspaceBinding extends CapturedManagedWorkspaceBinding {
  readonly configurationDigest: string;
  readonly login: Readonly<LoginConfiguration>;
  readonly logout: Readonly<StandaloneLogoutConfiguration>;
  readonly neon: Readonly<ManagedWorkspaceNeonBinding>;
}
const invalid = () => Error("MANAGED_WORKSPACE_BINDING_INVALID");
const keys = [
  "loginConfigurationJson",
  "workspaceConfigurationJson",
  "logoutConfigurationJson",
  "bindingJson",
] as const;
function data(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== [...names].sort().join(",") ||
    names.some((key) => !Object.hasOwn(descriptors[key]!, "value"))
  )
    throw invalid();
  return Object.fromEntries(names.map((key) => [key, descriptors[key]!.value]));
}
function exact(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function origin(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 512) throw invalid();
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "https:" || url.username || url.password)
    throw invalid();
  return value;
}
function neonConfiguration(value: unknown): Readonly<ManagedWorkspaceNeonBinding> {
  const n = loginJson(value, 4096, [
    "schemaVersion",
    "environment",
    "projectId",
    "branchId",
    "hostname",
    "database",
  ]);
  if (
    n.schemaVersion !== 1 ||
    (n.environment !== "development" && n.environment !== "staging") ||
    !exact(/^[a-z0-9][a-z0-9-]{0,79}$/, n.projectId) ||
    !exact(/^br-[a-z0-9-]{1,77}$/, n.branchId) ||
    !exact(/^ep-[a-z0-9-]+\.(?:c-[0-9]+\.)?[a-z0-9-]+\.(aws|azure)\.neon\.tech$/, n.hostname) ||
    n.hostname.length > 253 ||
    n.hostname.split(".")[0]!.includes("-pooler") ||
    !exact(/^[a-z][a-z0-9_]{0,62}$/, n.database)
  )
    throw invalid();
  return n as unknown as Readonly<ManagedWorkspaceNeonBinding>;
}

// This synchronous selector cross-match performs no crypto, lease or I/O.
// Full existing login/logout validation and hashes remain request-budgeted.
export function captureManagedWorkspaceBinding(
  value: unknown,
): Readonly<CapturedManagedWorkspaceBinding> {
  try {
    const captured = data(value, keys);
    const login = loginJson(captured.loginConfigurationJson, 32768, [
      "schemaVersion",
      "controllerProtocol",
      "origin",
      "retentionTier",
      "authenticationBindingJson",
      "verificationProfileJson",
      "profileId",
      "profileRecordRevision",
    ]);
    const sharedOrigin = origin(login.origin);
    if (
      login.schemaVersion !== 1 ||
      login.controllerProtocol !== "morrow-login-v1" ||
      !["development", "staging", "production"].includes(login.retentionTier as string) ||
      !loginId(login.profileId) ||
      !loginRevision(login.profileRecordRevision)
    )
      throw invalid();
    const authentication = loginJson(login.authenticationBindingJson, 8192, [
      "bindingId",
      "bindingRevision",
      "environmentId",
      "applicationId",
      "clientId",
      "redirectUri",
      "returnPath",
    ]);
    const profile = loginJson(login.verificationProfileJson, 8192, [
      "schemaVersion",
      "providerId",
      "environmentId",
      "applicationId",
      "clientId",
      "issuer",
      "revision",
      "audiencePolicy",
    ]);
    if (
      !loginId(authentication.bindingId) ||
      !loginRevision(authentication.bindingRevision) ||
      !exact(/^environment_[A-Z0-9]{26}$/, authentication.environmentId) ||
      !exact(/^app_[A-Z0-9]{26}$/, authentication.applicationId) ||
      !exact(/^client_[A-Z0-9]{26}$/, authentication.clientId) ||
      authentication.redirectUri !== sharedOrigin + "/auth/workos/callback" ||
      authentication.returnPath !== "/" ||
      profile.schemaVersion !== 1 ||
      profile.providerId !== "workos" ||
      profile.audiencePolicy !== "absent" ||
      profile.environmentId !== authentication.environmentId ||
      profile.applicationId !== authentication.applicationId ||
      profile.clientId !== authentication.clientId ||
      profile.issuer !== `https://api.workos.com/user_management/${authentication.clientId}` ||
      !loginRevision(profile.revision)
    )
      throw invalid();
    const workspace = loginJson(captured.workspaceConfigurationJson, 2048, [
      "schemaVersion",
      "mode",
      "origin",
    ]);
    const logout = loginJson(captured.logoutConfigurationJson, 8192, [
      "schemaVersion",
      "protocol",
      "origin",
      "providerId",
      "environmentId",
      "applicationId",
      "clientId",
      "profileId",
    ]);
    if (
      workspace.schemaVersion !== 1 ||
      workspace.mode !== "https" ||
      workspace.origin !== sharedOrigin ||
      logout.schemaVersion !== 1 ||
      logout.protocol !== "morrow-self-logout-v1" ||
      logout.origin !== sharedOrigin ||
      logout.providerId !== "workos" ||
      logout.environmentId !== authentication.environmentId ||
      logout.applicationId !== authentication.applicationId ||
      logout.clientId !== authentication.clientId ||
      logout.profileId !== login.profileId
    )
      throw invalid();
    neonConfiguration(captured.bindingJson);
    return Object.freeze({
      loginConfigurationJson: captured.loginConfigurationJson as string,
      workspaceConfigurationJson: captured.workspaceConfigurationJson as string,
      logoutConfigurationJson: captured.logoutConfigurationJson as string,
      bindingJson: captured.bindingJson as string,
      origin: sharedOrigin,
    });
  } catch {
    throw invalid();
  }
}

export async function resolveManagedWorkspaceBinding(
  captured: Readonly<CapturedManagedWorkspaceBinding>,
  originalAttempt: LoginAttempt,
): Promise<Readonly<ResolvedManagedWorkspaceBinding>> {
  originalAttempt.check();
  const row = data(captured, [...keys, "origin"]);
  const fixed = captureManagedWorkspaceBinding(
    Object.fromEntries(keys.map((key) => [key, row[key]])),
  );
  if (row.origin !== fixed.origin) throw invalid();
  originalAttempt.check();
  const login = await parseLoginConfigurationWithAttempt(
    fixed.loginConfigurationJson,
    originalAttempt,
  );
  originalAttempt.check();
  const logout = await parseStandaloneLogoutConfigurationWithAttempt(
    fixed.logoutConfigurationJson,
    originalAttempt,
  );
  originalAttempt.check();
  const neon = neonConfiguration(fixed.bindingJson);
  originalAttempt.check();
  const pending = loginHash(
    JSON.stringify([
      "morrow.workspace.api.configuration",
      "1",
      login.configurationDigest,
      logout.configurationDigest,
      "https",
      fixed.origin,
      neon.environment,
      neon.projectId,
      neon.branchId,
      neon.hostname,
      neon.database,
    ]),
  );
  void pending.catch(() => {});
  const configurationDigest = await originalAttempt.wait(pending);
  originalAttempt.check();
  return Object.freeze({ ...fixed, configurationDigest, login, logout, neon });
}
