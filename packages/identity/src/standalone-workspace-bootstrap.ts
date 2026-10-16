import { IdentityAccessError, withIdentityRead, type IdentitySqlClient } from "./index.js";
import {
  createStandaloneRequestGuard,
  standaloneJson,
  type GuardedStandaloneRequest,
  type StandaloneWorkspaceSqlControl,
} from "./standalone-request-guard.js";

export type { StandaloneWorkspaceSqlControl } from "./standalone-request-guard.js";
export interface StandaloneWorkspaceSqlClient {
  query(
    text: string,
    values: readonly string[],
    control: Readonly<StandaloneWorkspaceSqlControl>,
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(discard: boolean): Promise<void>;
}
export interface StandaloneWorkspaceSqlPool {
  connect(control: Readonly<StandaloneWorkspaceSqlControl>): Promise<StandaloneWorkspaceSqlClient>;
}
export interface StandaloneWorkspaceBootstrapDependencies {
  readonly configurationJson: string;
  readonly pool: StandaloneWorkspaceSqlPool;
  readonly now: () => number;
}

// A controlled owner around the unchanged synchronous legacy port. Every
// underlying client is disposable and its asynchronous close is awaited before
// success. An aborted/late acquisition is closed even after its caller returns.
async function readBootstrap(
  pool: StandaloneWorkspaceSqlPool,
  context: Readonly<GuardedStandaloneRequest>,
) {
  let owned: StandaloneWorkspaceSqlClient | undefined,
    disposal: Promise<void> | undefined,
    closed = false;
  const dispose = () => {
    closed = true;
    if (owned && !disposal) {
      disposal = Promise.resolve().then(() => owned!.release(true));
      void disposal.catch(() => {});
    }
    return disposal;
  };
  const onAbort = () => void dispose();
  context.control.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await withIdentityRead(
      {
        async connect() {
          context.check();
          const connecting = Promise.resolve(pool.connect(context.control)).then((client) => {
            owned = client;
            if (closed || context.control.signal.aborted) {
              dispose();
              throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
            }
            return client;
          });
          void connecting.catch(() => {});
          await context.wait(connecting);
          context.check();
          const client: IdentitySqlClient = {
            async query(text, values = []) {
              context.check();
              if (closed || !owned) throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
              try {
                const rows = await context.wait(
                  Promise.resolve(owned.query(text, Object.freeze([...values]), context.control)),
                );
                context.check();
                if (closed) throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
                return rows;
              } catch {
                // A lost query acknowledgement is not a completed transaction
                // boundary. Close before the legacy catch can attempt another
                // statement, including its otherwise legitimate rollback.
                dispose();
                throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
              }
            },
            release() {
              dispose();
            },
          };
          return client;
        },
      },
      context.sessionDigest,
      context.workspaceId,
      async (scope) => {
        const workspace = await scope.readWorkspace();
        context.check();
        const authority = await scope.readWorkspaceAuthority();
        context.check();
        if (
          authority.identity.actor.workspaceId !== workspace.id ||
          authority.identity.actor.organizationId !== workspace.organizationId ||
          authority.identity.actor.principalId !== scope.identity.actor.principalId ||
          authority.identity.actor.membershipId !== scope.identity.actor.membershipId
        )
          throw new IdentityAccessError("IDENTITY_DENIED");
        return Object.freeze({
          schemaVersion: 1 as const,
          workspace: Object.freeze({ id: workspace.id, displayName: workspace.displayName }),
          policyRevision: authority.identity.policyRevision,
        });
      },
    );
    const pending = dispose();
    if (!pending) throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
    await context.wait(pending);
    context.check();
    return result;
  } finally {
    context.control.signal.removeEventListener("abort", onAbort);
    const pending = dispose();
    if (pending && !context.control.signal.aborted) await context.wait(pending);
  }
}

// Private same-guard callback; the unchanged SQL owner and disposal path above
// are shared by legacy and managed request entries.
export async function executeStandaloneWorkspaceBootstrap(
  pool: StandaloneWorkspaceSqlPool,
  context: Readonly<GuardedStandaloneRequest>,
): Promise<Response> {
  try {
    return standaloneJson(200, await readBootstrap(pool, context));
  } catch (error) {
    if (error instanceof IdentityAccessError && error.code === "IDENTITY_DENIED")
      return standaloneJson(401, { code: "authentication_required" });
    return standaloneJson(503, { code: "unavailable" });
  }
}

export function createStandaloneWorkspaceBootstrap(
  dependencies: StandaloneWorkspaceBootstrapDependencies,
) {
  const { configurationJson, pool, now } = dependencies;
  if (typeof pool?.connect !== "function") throw Error("STANDALONE_REQUEST_CONFIG_INVALID");
  const guard = createStandaloneRequestGuard(configurationJson, now);
  return Object.freeze({
    fetch(request: Request): Promise<Response> {
      return guard.handle(request, "bootstrap", async (context) => {
        return executeStandaloneWorkspaceBootstrap(pool, context);
      });
    },
  });
}
