import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
// Local-only test adapter. No cloud, host ports/mounts, merchant records or
// credential arguments. All command failures expose fixed codes only.
const commandKinds = new Set(["exec", "run", "inspect", "rm", "image"]);
const processErrors = new Set([
  "ETIMEDOUT",
  "ENOBUFS",
  "EAGAIN",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOMEM",
  "EMFILE",
  "ENFILE",
]);
const processSignals = new Set([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGABRT",
  "SIGSEGV",
  "SIGHUP",
  "SIGPIPE",
  "SIGQUIT",
]);
const expiryCases = new Set([
  "handoff_expiry_after_wait",
  "review_expiry_after_wait",
  "proof_expiry_after_wait",
  "session_expiry_after_wait",
  "grant_expiry_after_wait",
]);
// Only primitive, closed projections cross the diagnostic boundary. In
// particular, never stringify an Error, command arguments, SQL or process I/O.
export function localPostgresFailureDiagnostic(command, processError, exitCode, signal) {
  return Object.freeze({
    commandKind: typeof command === "string" && commandKinds.has(command) ? command : "other",
    processError:
      processError === null || processError === undefined
        ? null
        : typeof processError === "string" && processErrors.has(processError)
          ? processError
          : "other",
    exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
    signal:
      signal === null || signal === undefined
        ? null
        : typeof signal === "string" && processSignals.has(signal)
          ? signal
          : "other",
  });
}
export function localPostgresWaitingCaseDiagnostic(value) {
  return typeof value === "string" && expiryCases.has(value) ? value : "other_case";
}
export function containerCommand(args, input, allowFailure = false) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    try {
      console.error(
        "LOCAL_LAB_DIAGNOSTIC " +
          JSON.stringify(
            localPostgresFailureDiagnostic(
              args[0],
              result.error ? result.error.code : null,
              result.status,
              result.signal,
            ),
          ),
      );
    } catch {
      // Diagnostics must not replace the original failure or prevent cleanup.
    }
    throw Error("LOCAL_LAB_COMMAND_FAILED:" + args[0]);
  }
  return result;
}
export async function localPostgresLab(packet, use) {
  const config = JSON.parse(readFileSync("infra/local-engine.json", "utf8"));
  if (
    !/^postgres@sha256:[a-f0-9]{64}$/.test(config.image) ||
    config.major !== 17 ||
    config.user !== "999:999"
  )
    throw Error("UNREVIEWED_ENGINE_PROFILE");
  // Pull before creating a container, so a slow registry cannot leave an
  // unknown running container ID after the short execution timeout.
  if (containerCommand(["image", "inspect", config.image], undefined, true).status !== 0) {
    const pulled = spawnSync("docker", ["pull", config.image], {
      encoding: "utf8",
      timeout: 60000,
    });
    if (pulled.error || pulled.status !== 0) throw Error("LOCAL_ENGINE_IMAGE_UNAVAILABLE");
  }
  let id;
  try {
    id = containerCommand([
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
      "morrow.packet=" + packet,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=256m",
      "--tmpfs",
      "/var/run/postgresql:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=8m",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=32m",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_DB=morrow_lab",
      config.image,
      "postgres",
      "-c",
      "listen_addresses=",
      "-c",
      "password_encryption=scram-sha-256",
      "-c",
      "log_statement=none",
      "-c",
      "log_min_error_statement=panic",
      "-c",
      "log_error_verbosity=terse",
    ]).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("INVALID_OWNED_CONTAINER");
    const sql = (text, database = "morrow_lab") =>
      containerCommand(
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
          "postgres",
          "-d",
          database,
        ],
        text,
      ).stdout.trim();
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const process = containerCommand(["exec", id, "cat", "/proc/1/comm"], undefined, true);
      const result = containerCommand(
        ["exec", id, "psql", "-X", "-qAt", "-U", "postgres", "-d", "morrow_lab", "-c", "SELECT 1"],
        undefined,
        true,
      );
      if (
        process.stdout?.trim() === "postgres" &&
        result.status === 0 &&
        result.stdout?.trim() === "1"
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw Error("LOCAL_ENGINE_STARTUP_FAILED");
    const [actual] = JSON.parse(containerCommand(["inspect", id]).stdout);
    if (
      actual.HostConfig.NetworkMode !== "none" ||
      !actual.HostConfig.ReadonlyRootfs ||
      actual.Config.User !== "999:999" ||
      actual.Mounts.length
    )
      throw Error("LOCAL_ENGINE_ISOLATION_FAILED");
    const version = sql("SELECT current_setting('server_version');");
    if (!version.startsWith("17.11 ")) throw Error("UNREVIEWED_ENGINE_VERSION");
    return await use({ id, sql, image: config.image, version });
  } finally {
    if (id && /^[a-f0-9]{64}$/.test(id)) containerCommand(["rm", "--force", id]);
  }
}
