import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { workspaceStoreLinkingSql } from "../packages/identity/src/workspace-store-linking.ts";
// Scripts-only local test adapter. Executes the real application query strings
// on one persistent unprivileged psql connection; never a production driver.
// No host network/mount, proof arguments/env or raw error output.
export function localStoreLinkingPool(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("LOCAL_STORE_LINKING_CONTAINER_INVALID");
  const clients = [];
  const observed = [];
  return {
    observed,
    async connect() {
      const child = spawn(
        "docker",
        [
          "exec",
          "--interactive",
          id,
          "psql",
          "-X",
          "-qAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "morrow_identity_linking",
          "-d",
          "morrow",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let buffer = "",
        pending = null,
        closed = false;
      const output = { stdout: "", stderr: "" };
      observed.push(output);
      const finished = new Promise((resolve) =>
        child.on("close", () => {
          closed = true;
          if (pending) {
            clearTimeout(pending.timer);
            pending.reject(Error("LOCAL_STORE_LINKING_SQL_FAILED"));
            pending = null;
          }
          resolve();
        }),
      );
      child.on("error", () => {
        closed = true;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(Error("LOCAL_STORE_LINKING_SQL_FAILED"));
          pending = null;
        }
      });
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk) => {
        output.stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output.stdout += chunk;
        buffer += chunk;
        if (output.stdout.length > 8 * 1024 * 1024 || output.stderr.length > 1024 * 1024) {
          child.kill("SIGKILL");
          return;
        }
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!pending) continue;
          if (line === pending.marker) {
            const current = pending;
            pending = null;
            clearTimeout(current.timer);
            try {
              const rows = current.lines.length ? JSON.parse(current.lines.join("\n")) : [];
              if (!Array.isArray(rows)) throw Error();
              current.resolve({ rows });
            } catch {
              current.reject(Error("LOCAL_STORE_LINKING_SQL_PROTOCOL"));
            }
          } else if (line) pending.lines.push(line);
        }
      });
      child.stdin.write("SET standard_conforming_strings=on;\n");
      const client = {
        async query(text, values = []) {
          if (
            closed ||
            pending ||
            !Object.values(workspaceStoreLinkingSql).includes(text) ||
            !values.every((v) => typeof v === "string")
          )
            throw Error("LOCAL_STORE_LINKING_QUERY_UNSUPPORTED");
          const indexes = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
          if ((indexes.length ? Math.max(...indexes) : 0) !== values.length)
            throw Error("LOCAL_STORE_LINKING_PARAMETERS_INVALID");
          let sql;
          if (/^(SELECT|WITH)\b/.test(text)) {
            const wrapped = `SELECT COALESCE(json_agg(row_to_json(result)), '[]'::json)::text FROM (${text}) AS result`;
            if (values.length) {
              const literal = (v) => "'" + v.replaceAll("'", "''") + "'";
              sql = `PREPARE local_store_linking_query(${values.map(() => "text").join(",")}) AS ${wrapped};\nEXECUTE local_store_linking_query(${values.map(literal).join(",")});\nDEALLOCATE local_store_linking_query;`;
            } else sql = wrapped + ";";
          } else sql = text + ";";
          const marker = "LOCAL_STORE_LINKING_END_" + randomUUID();
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(Error("LOCAL_STORE_LINKING_SQL_TIMEOUT"));
            }, 8000);
            pending = { resolve, reject, timer, marker, lines: [] };
            child.stdin.write(sql + "\n\\echo " + marker + "\n");
          });
        },
        release(discard) {
          if (pending) throw Error("LOCAL_STORE_LINKING_QUERY_UNFINISHED");
          if (discard) child.kill("SIGKILL");
          else child.stdin.end();
        },
      };
      clients.push({ child, finished });
      return client;
    },
    async close() {
      for (const { child } of clients) {
        child.stdin.end();
        if (child.exitCode === null) child.kill("SIGTERM");
      }
      await Promise.all(clients.map((c) => c.finished));
    },
  };
}
