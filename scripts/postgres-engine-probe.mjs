import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync("infra/local-engine.json", "utf8"));
if (
  !/^postgres@sha256:[a-f0-9]{64}$/.test(config.image) ||
  config.major !== 17 ||
  config.user !== "999:999"
)
  throw Error("UNREVIEWED_ENGINE_PROFILE");
function docker(args, input) {
  const result = spawnSync("docker", args, { encoding: "utf8", input, timeout: 10000 });
  if (result.error || result.status !== 0) throw Error("LOCAL_CONTAINER_COMMAND_FAILED:" + args[0]);
  return result.stdout.trim();
}
const started = performance.now();
let container;
let record;
try {
  container = docker([
    "run",
    "--detach",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "999:999",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--label",
    "morrow.packet=P04.T01",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=256m",
    "--tmpfs",
    "/var/run/postgresql:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=8m",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=32m",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    "POSTGRES_DB=morrow_engine_lab",
    config.image,
    "postgres",
    "-c",
    "listen_addresses=",
  ]);
  if (!/^[a-f0-9]{64}$/.test(container)) throw Error("INVALID_OWNED_CONTAINER_ID");
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    // pg_isready can accept connections during the image's temporary init server,
    // even before the requested database exists. Wait for PID1's final server.
    const main = spawnSync("docker", ["exec", container, "cat", "/proc/1/comm"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const result = spawnSync(
      "docker",
      [
        "exec",
        container,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "morrow_engine_lab",
        "-c",
        "SELECT 1",
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    if (
      main.stdout?.trim() === "postgres" &&
      result.status === 0 &&
      result.stdout?.trim() === "1"
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw Error("LOCAL_ENGINE_STARTUP_FAILED");
  const sql =
    "SELECT current_setting('server_version');\nCREATE TABLE engine_probe(id integer PRIMARY KEY);\nBEGIN; INSERT INTO engine_probe VALUES (1); ROLLBACK;\nSELECT count(*) FROM engine_probe;\nBEGIN; INSERT INTO engine_probe VALUES (2); COMMIT;\nSELECT id FROM engine_probe;\n";
  const output = docker(
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
      "morrow_engine_lab",
    ],
    sql,
  ).split("\n");
  if (!output[0]?.startsWith("17.11 ") || output[1] !== "0" || output[2] !== "2")
    throw Error("ENGINE_TRANSACTION_PROBE_FAILED");
  const [actual] = JSON.parse(docker(["inspect", container]));
  if (
    actual.HostConfig.NetworkMode !== "none" ||
    actual.HostConfig.ReadonlyRootfs !== true ||
    actual.Config.User !== "999:999" ||
    actual.Mounts.length !== 0
  )
    throw Error("ENGINE_ISOLATION_READBACK_FAILED");
  record = {
    scope:
      "Actual local PostgreSQL17 engine startup and commit/rollback; not Aurora, tenant RLS, worker durability, rotation or restore qualification",
    image: config.image,
    server_version: output[0],
    synthetic_only: true,
    network: "none",
    host_mounts: 0,
    unprivileged_user: "999:999",
    root_read_only: true,
    rolled_back_rows: Number(output[1]),
    committed_id: Number(output[2]),
    elapsed_ms: Math.round(performance.now() - started),
    cleanup: "pending",
  };
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) {
    // Only the newly created ID, no user containers, images, files or volumes.
    docker(["rm", "--force", container]);
    if (record) record.cleanup = "owned ephemeral container removed";
  }
}
writeFileSync("docs/evidence/P04.T01/postgres-engine.json", JSON.stringify(record, null, 2) + "\n");
console.log(
  "PASS: actual PostgreSQL17.11 startup, transaction commit/rollback and container isolation; ephemeral probe removed.",
);
