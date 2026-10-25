// Laboratory-only connector for scripts/staging-runner.mjs: one persistent psql process
// (docker exec into the isolated, network-none PostgreSQL 17 lab container) per
// connection, speaking the runner's connection interface
//   query(text, params) -> rows   exec(text)   close()
// Statements are framed with unique end markers; SELECT/WITH results come back as JSON;
// parameters are bound with PREPARE/EXECUTE and quoted literals, never interpolated into
// the statement. psql stops at the first error (ON_ERROR_STOP), which ends the session
// and aborts any open transaction, exactly like a dropped driver connection.
//
// Fault hooks (P04.T01i AC06) act on the session from outside the code under test:
//   before(text, session)  may call session.kill() before the statement is sent
//                          (a crash before COMMIT: nothing reaches the server)
//   after(text, session)   may call session.loseReply() after the statement completed
//                          (a lost acknowledgement: the server has committed)
// Every statement sent is recorded in `statements` for the lab's secret-marker checks.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const literal = (value) => {
  const text = String(value);
  if (text.includes("\0")) throw Error("LAB_LITERAL_NUL");
  return "'" + text.replaceAll("'", "''") + "'";
};

export function psqlConnector(
  containerId,
  { user = "postgres", database = "morrow", hooks = {} } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw Error("LAB_CONTAINER_INVALID");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user) || !/^[a-z_][a-z0-9_]{0,62}$/.test(database))
    throw Error("LAB_IDENTITY_INVALID");
  const statements = [];
  const sessions = new Set();
  async function connect() {
    const applicationName = "morrow-staging-runner";
    const child = spawn(
      "docker",
      [
        "exec",
        "--env",
        "PGAPPNAME=" + applicationName,
        "--interactive",
        containerId,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-U",
        user,
        "-d",
        database,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "",
      stderr = "",
      pending = null,
      ended = false;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const failure = () => {
      const match = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(stderr);
      const error = Error("LAB_SQL_FAILED");
      error.sqlstate = match?.[1] ?? null;
      error.server = match?.[2]?.trim() ?? null;
      return error;
    };
    child.once("close", () => {
      ended = true;
      if (pending) {
        const p = pending;
        pending = null;
        p.reject(failure());
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!pending) continue;
        if (line === pending.marker) {
          const p = pending;
          pending = null;
          p.resolve(p.lines);
        } else pending.lines.push(line);
      }
    });
    const session = {
      applicationName,
      killed: false,
      kill() {
        session.killed = true;
        child.kill("SIGKILL");
      },
      loseReply() {
        session.lost = true;
        child.kill("SIGKILL");
      },
    };
    const send = (text) =>
      new Promise((resolve, reject) => {
        if (ended || pending) return reject(failure());
        const marker = "STAGING_LAB_END_" + randomUUID();
        pending = { marker, lines: [], resolve, reject };
        child.stdin.write(text + "\n\\echo " + marker + "\n");
      });
    const run = async (text) => {
      statements.push(text);
      if (hooks.before) await hooks.before(text, session);
      if (session.killed) {
        await closed;
        throw failure();
      }
      const lines = await send(text);
      if (hooks.after) await hooks.after(text, session);
      if (session.lost) {
        await closed;
        throw Error("LAB_REPLY_LOST");
      }
      return lines;
    };
    sessions.add(child);
    child.once("close", () => sessions.delete(child));
    return Object.freeze({
      async query(text, params = []) {
        if (typeof text !== "string" || !Array.isArray(params)) throw Error("LAB_QUERY");
        const select = /^\s*(SELECT|WITH)\b/i.test(text);
        const body = select
          ? "SELECT COALESCE(json_agg(row_to_json(staging_lab_row)),'[]'::json)::text FROM (" +
            text +
            ") staging_lab_row"
          : text;
        const statement = params.length
          ? `PREPARE staging_lab_q AS ${body};\nEXECUTE staging_lab_q(${params.map(literal).join(",")});\nDEALLOCATE staging_lab_q;`
          : body + ";";
        const lines = await run(statement);
        if (!select) return [];
        const json = lines.filter((line) => line.startsWith("[")).at(-1);
        return json ? JSON.parse(json) : [];
      },
      async exec(text) {
        const trimmed = text.trimEnd();
        await run(trimmed.endsWith(";") ? trimmed : trimmed + ";");
      },
      async close() {
        try {
          child.stdin.end();
        } catch {
          // Already closed.
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await closed;
        clearTimeout(timer);
      },
    });
  }
  return Object.freeze({
    connect,
    statements,
    async closeAll() {
      for (const child of sessions) child.kill("SIGKILL");
    },
  });
}
