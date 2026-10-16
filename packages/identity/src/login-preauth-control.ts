import { createAuthenticationExchangeAdmission } from "./authentication-exchange-admission.js";
import type { IdentitySqlPool } from "./index.js";
import type { LoginAttempt, LoginControl } from "./standalone-login-protocol.js";
export interface LoginControlledSqlClient {
  query(
    text: string,
    values: readonly string[],
    control: Readonly<LoginControl>,
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(discard: boolean): Promise<void>;
}
export interface LoginControlledSqlPool {
  connect(control: Readonly<LoginControl>): Promise<LoginControlledSqlClient>;
}
// The unchanged69 transaction awaits release despite its legacy void type.
// This facade closes BEFORE an uncertain query propagates into its catch.
export async function runControlledPreauth<T>(
  pool: LoginControlledSqlPool,
  bindingJson: string,
  attempt: LoginAttempt,
  action: (service: ReturnType<typeof createAuthenticationExchangeAdmission>) => Promise<T>,
): Promise<T> {
  let client: LoginControlledSqlClient | undefined,
    closed = false,
    releasing: Promise<void> | undefined;
  const fail = () => Error("STANDALONE_LOGIN_PREAUTH_HELD");
  const dispose = () => {
    closed = true;
    if (client && !releasing) {
      const owned = client;
      releasing = Promise.resolve().then(() => owned.release(true));
      void releasing.catch(() => {});
    }
    return releasing;
  };
  const onAbort = () => {
    dispose();
  };
  const control = attempt.control();
  control.signal.addEventListener("abort", onAbort, { once: true });
  const legacy: IdentitySqlPool = {
    async connect() {
      attempt.check();
      if (closed || client) throw fail();
      const pending = Promise.resolve()
        .then(() => {
          attempt.check();
          if (closed) throw fail();
          return pool.connect(control);
        })
        .then((owned) => {
          client = owned;
          if (closed || control.signal.aborted) {
            dispose();
            throw fail();
          }
          return owned;
        });
      void pending.catch(() => {});
      try {
        await attempt.wait(pending);
      } catch {
        dispose();
        throw fail();
      }
      return {
        async query(text, values = []) {
          attempt.check();
          if (closed || !client) throw fail();
          try {
            const result = await attempt.wait(
              Promise.resolve().then(() => {
                attempt.check();
                if (closed) throw fail();
                return client!.query(text, Object.freeze([...values]), control);
              }),
            );
            return { rows: result.rows };
          } catch {
            dispose();
            throw fail();
          }
        },
        // Runtime promise deliberately retained for legacy69's await.
        release() {
          return dispose() as unknown as void;
        },
      };
    },
  };
  try {
    const value = await attempt.wait(
      action(createAuthenticationExchangeAdmission(legacy, bindingJson)),
    );
    const release = dispose();
    if (!release) throw fail();
    await attempt.wait(release);
    attempt.check();
    return value;
  } catch {
    const release = dispose();
    if (release)
      try {
        await attempt.wait(release);
      } catch {
        /* Closure uncertainty withholds all fresh material. */
      }
    throw fail();
  } finally {
    control.signal.removeEventListener("abort", onAbort);
  }
}
