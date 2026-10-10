import { Client } from "@neondatabase/serverless";
import type { IdentityReadScope } from "./index";
import { IdentityAccessError } from "./index";
import { withDriverIdentityRead } from "./neon-request";

// Server-owned selectors only. This validates configuration, not account
// ownership, hosted qualification, authentication or deployment permission.
export interface NeonIdentityBinding {
  readonly environment: "development" | "staging";
  readonly projectId: string;
  readonly branchId: string;
  readonly hostname: string;
  readonly database: string;
}

export function createNeonIdentityClient(binding: NeonIdentityBinding, secret: string): Client {
  try {
    if (
      !binding ||
      Object.keys(binding).sort().join(",") !==
        "branchId,database,environment,hostname,projectId" ||
      !["development", "staging"].includes(binding.environment) ||
      typeof binding.projectId !== "string" ||
      typeof binding.branchId !== "string" ||
      typeof binding.hostname !== "string" ||
      typeof binding.database !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(binding.projectId) ||
      !/^br-[a-z0-9-]{1,77}$/.test(binding.branchId) ||
      !/^ep-[a-z0-9-]+\.[a-z0-9-]+\.(aws|azure)\.neon\.tech$/.test(binding.hostname) ||
      binding.hostname.length > 253 ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(binding.database) ||
      typeof secret !== "string" ||
      secret.length < 16 ||
      secret.length > 1024 ||
      /[\x00-\x20\x7f]/.test(secret)
    )
      throw Error();
    // Explicit parameters avoid URL query overrides, environment-derived pg
    // defaults and custom proxy hosts. A new Client is allocated per read.
    const client = new Client({
      host: binding.hostname,
      port: 5432,
      database: binding.database,
      user: "morrow_api",
      password: secret,
      ssl: false,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      application_name: `morrow-${binding.environment}-identity`,
    });
    client.neonConfig.useSecureWebSocket = true;
    // WSS provides TLS to the configured Neon host. The driver disables the
    // inner pg TLS protocol; experimental pure-JS pg TLS is not used.
    client.neonConfig.forceDisablePgSSL = true;
    client.neonConfig.wsProxy = `${binding.hostname}/v2`;
    client.neonConfig.pipelineConnect = false;
    client.neonConfig.webSocketConstructor = WebSocket;
    return client;
  } catch {
    throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
  }
}

// No module-global connection, pool or credentials. Call only inside a trusted
// request after the provider/session boundary supplies the server proof.
// This remains disconnected from public routes until hosted qualification.
export async function withNeonIdentityRead<T>(
  binding: NeonIdentityBinding,
  secret: string,
  serverSessionDigest: string,
  requestedWorkspace: string,
  read: (scope: IdentityReadScope) => Promise<T>,
): Promise<T> {
  return withDriverIdentityRead(
    () => createNeonIdentityClient(binding, secret),
    serverSessionDigest,
    requestedWorkspace,
    read,
  );
}
