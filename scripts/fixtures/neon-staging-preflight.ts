// Operator-only local fixture. Never deploy or import into an application.
import { Client } from "@neondatabase/serverless";

interface Input {
  hostname: string;
  database: string;
  ownerUser: string;
  ownerPassword: string;
}
export default {
  async fetch(request: Request, env: { QUALIFICATION: string }) {
    if (new URL(request.url).pathname !== "/preflight" || request.method !== "POST")
      return new Response(null, { status: 404 });
    const input = JSON.parse(env.QUALIFICATION) as Input;
    const client = () => {
      const c = new Client({
        host: input.hostname,
        port: 5432,
        database: input.database,
        user: input.ownerUser,
        password: input.ownerPassword,
        ssl: false,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
        application_name: "morrow-staging-qualification",
      });
      c.neonConfig.useSecureWebSocket = true;
      c.neonConfig.forceDisablePgSSL = true;
      c.neonConfig.wsProxy = `${input.hostname}/v2`;
      c.neonConfig.pipelineConnect = false;
      c.neonConfig.webSocketConstructor = WebSocket;
      c.on("error", () => {});
      return c;
    };
    const check = (ok: boolean) => {
      if (!ok) throw Error("PREFLIGHT_FAILED");
    };
    const begin = "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY";
    const bind = "SELECT set_config('morrow.qualification_run', $1, true)";
    const context = "SELECT current_setting('morrow.qualification_run', true) AS value";
    const close = async (c: Client) => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          c.end(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error("PREFLIGHT_CLOSE_FAILED")), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    };
    const concurrent = async () => {
      const c = client(),
        token = crypto.randomUUID();
      try {
        await c.connect();
        await c.query(begin);
        await c.query(bind, [token]);
        check((await c.query(context)).rows[0].value === token);
        await c.query("COMMIT");
        check(!(await c.query(context)).rows[0].value);
        return true;
      } finally {
        await close(c);
      }
    };
    const c = client();
    let report: Record<string, unknown> | null = null;
    try {
      await c.connect();
      const row = (
        await c.query(
          "SELECT current_database() AS database, current_user AS role, current_setting('server_version') AS version, current_setting('server_version_num') AS version_num",
        )
      ).rows[0];
      check(row.database === input.database && row.role === input.ownerUser);
      check(Number(row.version_num) >= 170000 && Number(row.version_num) < 180000);
      await c.query(begin);
      const isolation = (await c.query("SHOW transaction_isolation")).rows[0].transaction_isolation;
      const readOnly = (await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
      check(isolation === "read committed" && readOnly === "on");
      const token = crypto.randomUUID();
      await c.query(bind, [token]);
      check((await c.query(context)).rows[0].value === token);
      await c.query("COMMIT");
      check(!(await c.query(context)).rows[0].value);
      await c.query(begin);
      await c.query(bind, [crypto.randomUUID()]);
      await c.query("ROLLBACK");
      check(!(await c.query(context)).rows[0].value);
      await Promise.all([concurrent(), concurrent()]);
      report = {
        passed: true,
        version: row.version,
        checks: [
          "database_and_login_binding",
          "postgresql17",
          "read_committed",
          "read_only",
          "transaction_local_context",
          "commit_context_cleanup",
          "rollback_context_cleanup",
          "concurrent_separate_client_contexts",
        ],
        qualification: "operator_transport_and_transaction_preflight_only",
      };
    } catch {
      report = null;
    } finally {
      try {
        await close(c);
      } catch {
        report = null;
      }
    }
    return report
      ? Response.json(report)
      : Response.json({ passed: false, code: "NEON_PREFLIGHT_FAILED" }, { status: 503 });
  },
};
