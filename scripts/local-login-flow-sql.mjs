import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Isolated test adapter, never a production driver. Every client is a dedicated
// disposable psql process with no host network, mounted credential or SQL argv.
export function localLoginFlowSqlPool(container, role, statements, options = {}) {
  if (
    ![
      "morrow_identity_login",
      "morrow_identity_login_maintenance",
      "morrow_identity_preauth",
      "morrow_identity_resolution",
      "morrow_identity_sessions",
    ].includes(role) ||
    !Array.isArray(statements) ||
    !statements.length ||
    statements.length > 64 ||
    !statements.every((x) => typeof x === "string")
  )
    throw Error("LOCAL_LOGIN_FLOW_PROFILE_INVALID");
  const allowedStatements = new Set(statements);
  if (!/^[a-f0-9]{64}$/.test(container)) throw Error("LOCAL_LOGIN_FLOW_CONTAINER_INVALID");
  const clients = [];
  const observed = [];
  const metrics = {
    connections: 0,
    released: 0,
    closed: 0,
    discarded: 0,
    cancelled: 0,
    backendCleanupVerified: 0,
    unverifiedHostClosures: 0,
  };
  const failure = () => Error("LOCAL_LOGIN_FLOW_SQL_UNAVAILABLE");
  const validControl = (control) =>
    control &&
    control.signal instanceof AbortSignal &&
    Number.isSafeInteger(control.deadlineMs) &&
    !control.signal.aborted &&
    Date.now() < control.deadlineMs;
  return {
    observed,
    metrics,
    async connect(control) {
      if (!validControl(control)) throw failure();
      metrics.connections++;
      const applicationName = "morrow_login_flow_" + randomUUID().replaceAll("-", "");
      const child = spawn(
        "docker",
        [
          "exec",
          "--env",
          "PGAPPNAME=" + applicationName,
          "--interactive",
          container,
          "psql",
          "-X",
          "-qAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          role,
          "-d",
          "morrow",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let pending = null,
        buffer = "",
        ended = false,
        released = false,
        resolveClosed,
        cleanupPromise,
        hostCloseSignal = null;
      const output = { stdout: "", stderr: "" };
      observed.push(output);
      const finished = new Promise((resolve) => {
        resolveClosed = resolve;
      });
      const settleClosed = () => {
        if (!ended) {
          ended = true;
          metrics.closed++;
        }
        if (pending) {
          const p = pending;
          pending = null;
          p.cleanup();
          p.reject(failure());
        }
        resolveClosed();
      };
      const destroy = () => {
        try {
          child.stdin.end();
        } catch {
          /* Fixed errors only. */
        }
      };
      child.on("close", (_code, signal) => {
        hostCloseSignal = signal;
        settleClosed();
      });
      child.on("error", () => {
        /* close follows even when spawn fails. */
      });
      child.stdin?.on("error", () => {});
      child.stderr?.on("data", (chunk) => {
        output.stderr += chunk;
        if (output.stderr.length > 1048576) destroy();
      });
      child.stdout?.on("data", (chunk) => {
        output.stdout += chunk;
        buffer += chunk;
        if (output.stdout.length > 8388608) {
          destroy();
          return;
        }
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"),
            line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!pending) continue;
          if (line === pending.marker) {
            const p = pending;
            pending = null;
            p.cleanup();
            if (!validControl(p.control)) {
              destroy();
              p.reject(failure());
              continue;
            }
            try {
              const rows = p.lines.length ? JSON.parse(p.lines.join("\n")) : [];
              if (!Array.isArray(rows)) throw failure();
              p.resolve({ rows });
            } catch {
              destroy();
              p.reject(failure());
            }
          } else if (line) pending.lines.push(line);
        }
      });
      const run = (text, queryControl) => {
        if (released || ended || pending || !validControl(queryControl)) {
          destroy();
          return Promise.reject(failure());
        }
        const marker = "LOCAL_LOGIN_FLOW_END_" + randomUUID();
        return new Promise((resolve, reject) => {
          const cancel = () => {
            metrics.cancelled++;
            if (pending?.marker === marker) {
              const p = pending;
              pending = null;
              p.cleanup();
              p.reject(failure());
            }
            destroy();
          };
          const timer = setTimeout(
            cancel,
            Math.max(1, Math.min(queryControl.deadlineMs - Date.now(), 5000)),
          );
          const cleanup = () => {
            clearTimeout(timer);
            queryControl.signal.removeEventListener("abort", cancel);
          };
          pending = { marker, lines: [], resolve, reject, cleanup, control: queryControl };
          queryControl.signal.addEventListener("abort", cancel, { once: true });
          if (!validControl(queryControl)) {
            cancel();
            return;
          }
          try {
            child.stdin.write(text + "\n\\echo " + marker + "\n");
          } catch {
            cancel();
          }
        });
      };
      let committedAdmission = false;
      const client = {
        async query(text, values, queryControl) {
          if (
            !allowedStatements.has(text) ||
            !Array.isArray(values) ||
            !values.every((v) => typeof v === "string" && !v.includes("\0"))
          )
            throw failure();
          const indexes = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
          if ((indexes.length ? Math.max(...indexes) : 0) !== values.length) throw failure();
          let sql;
          if (/^(SELECT|WITH)\b/.test(text)) {
            const wrapped = `SELECT COALESCE(json_agg(row_to_json(result)), '[]'::json)::text FROM (${text}) AS result`;
            const literal = (v) => "'" + v.replaceAll("'", "''") + "'";
            sql = values.length
              ? `PREPARE local_browser_session_query(${values.map(() => "text").join(",")}) AS ${wrapped};\nEXECUTE local_browser_session_query(${values.map(literal).join(",")});\nDEALLOCATE local_browser_session_query;`
              : wrapped + ";";
          } else sql = text + ";";
          if (options.beforeQuery) await options.beforeQuery(text, values);
          const result = await run(
            (options.stallQueryText === text ? "SELECT pg_sleep(2);\n" : "") + sql,
            queryControl,
          );

          if (text === "COMMIT") committedAdmission = true;
          if (options.afterQuery) await options.afterQuery(text, values, result);
          if (options.commitAckLoss === true && committedAdmission && text === "COMMIT")
            throw failure();
          if (!validControl(queryControl)) {
            destroy();
            throw failure();
          }
          return result;
        },
        async release(discard) {
          if (!released) {
            released = true;
            metrics.released++;
            if (discard || pending) {
              metrics.discarded++;
              destroy();
            } else child.stdin.end();
            // Host docker-exec closure alone cannot prove its guest backend is
            // gone. Terminate only this source-generated application name, wait
            // for PG termination, and independently observe no matching row.
            cleanupPromise = (async () => {
              const where =
                "datname='morrow' AND usename='" +
                role +
                "' AND application_name='" +
                applicationName +
                "'";
              const checkBackend = async (terminate) => {
                const cleaner = spawn(
                  "docker",
                  [
                    "exec",
                    "--interactive",
                    container,
                    "psql",
                    "-X",
                    "-qAt",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "postgres",
                    "-d",
                    "morrow",
                  ],
                  { stdio: ["pipe", "pipe", "pipe"] },
                );
                let out = "",
                  failed = false;
                const cleaned = new Promise((resolve) => {
                  const timer = setTimeout(() => {
                    failed = true;
                    cleaner.kill("SIGKILL");
                  }, 3000);
                  cleaner.stdout.on("data", (chunk) => {
                    out += chunk;
                    if (out.length > 4096) {
                      failed = true;
                      cleaner.kill("SIGKILL");
                    }
                  });
                  cleaner.stderr.on("data", () => {
                    /* Never reflect PostgreSQL error text. */
                  });
                  cleaner.stdin.on("error", () => {});
                  cleaner.once("error", () => {
                    failed = true;
                  });
                  cleaner.once("close", (code) => {
                    clearTimeout(timer);
                    resolve(!failed && code === 0);
                  });
                });

                cleaner.stdin.end(
                  "SET statement_timeout='1500ms';\n" +
                    (terminate
                      ? "SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE " +
                        where +
                        ";\n"
                      : "") +
                    "SELECT count(*) FROM pg_stat_activity WHERE " +
                    where +
                    ";\n",
                );
                const ok = await cleaned;
                if (!ok) throw failure();
                return out.trim().split("\n").at(-1) === "0";
              };
              await checkBackend(true);
              destroy();
              let closeTimer;
              const guestFinished = await Promise.race([
                finished.then(() => true),
                new Promise((resolve) => {
                  closeTimer = setTimeout(() => resolve(false), 3000);
                }),
              ]);
              clearTimeout(closeTimer);
              if (!guestFinished) {
                child.kill("SIGKILL");
                await finished;
                throw failure();
              }
              if (!(await checkBackend(false))) throw failure();
              if (hostCloseSignal !== null) {
                metrics.unverifiedHostClosures++;
                throw failure();
              }
              metrics.backendCleanupVerified++;
            })();
          }
          await cleanupPromise;
          if (options.releaseAckLoss === true && committedAdmission) throw failure();
        },
      };
      clients.push(client);
      try {
        if (options.beforeStartup) options.beforeStartup();
        await run(
          "SET standard_conforming_strings=on;" +
            (options.stallStartup === true ? " SELECT pg_sleep(2);" : ""),
          control,
        );
        if (options.killHostAfterStartup === true) {
          // Deliberate local-lab fault: host closure is not guest completion.
          child.kill("SIGKILL");
          await finished;
          throw failure();
        }
        if (!validControl(control)) throw failure();
        return client;
      } catch {
        await client.release(true);
        throw failure();
      }
    },
    async close() {
      const settled = await Promise.allSettled(clients.map((client) => client.release(true)));
      if (settled.some((value) => value.status === "rejected")) throw failure();
    },
  };
}
