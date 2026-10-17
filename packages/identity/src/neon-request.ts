import { IdentityAccessError, withIdentityRead } from "./index";
import type { IdentityReadScope, IdentitySqlPool } from "./index";

// Internal lifecycle seam for the pinned SDK and controlled fixture tests.
// Not exported as an application package entrypoint. Never log provider errors.
export interface RequestDriverClient {
  connect(): Promise<void>;
  query(text: string, values: string[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error", listener: () => void): unknown;
}

export async function withDriverIdentityRead<T>(
  factory: () => RequestDriverClient,
  serverSessionDigest: string,
  requestedWorkspace: string,
  read: (scope: IdentityReadScope) => Promise<T>,
): Promise<T> {
  let driver: RequestDriverClient | undefined;
  let leased = false;
  let released = false;
  let failed = false;
  const unavailable = () => new IdentityAccessError("IDENTITY_UNAVAILABLE");
  const pool: IdentitySqlPool = {
    async connect() {
      if (leased) throw unavailable();
      leased = true;
      driver = factory();
      const client = driver;
      client.on("error", () => {
        failed = true;
      });
      await client.connect();
      if (failed) throw unavailable();
      return {
        async query(text, values = []) {
          if (released || failed) throw unavailable();
          const result = await client.query(text, [...values]);
          if (released || failed) throw unavailable();
          return result;
        },
        release(discard) {
          if (released) throw unavailable();
          released = true;
          failed ||= discard;
          // Always end this request's connection, including a clean commit.
          // Awaiting end happens in finally; no background reuse is possible.
        },
      };
    },
  };
  try {
    const result = await withIdentityRead(pool, serverSessionDigest, requestedWorkspace, read);
    if (failed) throw unavailable();
    return result;
  } finally {
    released = true;
    if (driver) {
      try {
        await driver.end();
      } catch {
        throw unavailable();
      }
      if (failed) throw unavailable();
    }
  }
}
