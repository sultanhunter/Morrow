import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { encryptedLabFixtures } from "./encrypted-lab-fixtures.mjs";
import { encodeOperationalEvent } from "../packages/infrastructure/src/operations.ts";
import { inspectProvisioningReadiness } from "../packages/infrastructure/src/readiness.ts";
const start = performance.now();
const correlationId = randomUUID();
const events = [];
const emit = (code) =>
  events.push(
    JSON.parse(
      encodeOperationalEvent({
        schemaVersion: 1,
        environment: "development",
        service: "workers",
        code,
        correlationId,
        at: new Date().toISOString(),
      }),
    ),
  );
const vault = encryptedLabFixtures();
let report;
try {
  report = await localPostgresLab("P04.T03", async ({ id, sql, image, version }) => {
    const oldPassword = randomBytes(32).toString("hex");
    const newPassword = randomBytes(32).toString("hex");
    vault.put("credential-v1", Buffer.from(oldPassword));
    vault.put("credential-v2", Buffer.from(newPassword));
    sql(`CREATE ROLE morrow_worker LOGIN PASSWORD '${oldPassword}';
      CREATE TABLE worker_fixture(id integer PRIMARY KEY);
      GRANT SELECT,INSERT ON worker_fixture TO morrow_worker;`);
    containerCommand(
      ["exec", "--interactive", id, "sh", "-c", "cat > /var/lib/postgresql/data/pg_hba.conf"],
      "local all postgres trust\nlocal all all scram-sha-256\n",
    );
    if (sql("SELECT pg_reload_conf();") !== "t") throw Error("LOCAL_HBA_RELOAD_FAILED");
    const passfile = (revision) => {
      const password = vault.get(revision).toString();
      containerCommand(
        ["exec", "--interactive", id, "sh", "-c", `umask 077; cat > /tmp/${revision}`],
        `*:5432:morrow_lab:morrow_worker:${password}\n`,
      );
    };
    passfile("credential-v1");
    const login = (revision) =>
      containerCommand(
        [
          "exec",
          "--env",
          "PGPASSFILE=/tmp/" + revision,
          id,
          "psql",
          "-X",
          "-qAt",
          "-w",
          "-h",
          "/var/run/postgresql",
          "-U",
          "morrow_worker",
          "-d",
          "morrow_lab",
          "-c",
          "SELECT 1",
        ],
        undefined,
        true,
      );
    if (login("credential-v1").stdout?.trim() !== "1") throw Error("INITIAL_SCRAM_LOGIN_FAILED");
    passfile("credential-v2");
    const unverified = login("credential-v2");
    if (unverified.status === 0 || !unverified.stderr?.includes("password authentication failed"))
      throw Error("UNVERIFIED_CREDENTIAL_NOT_REJECTED");
    emit("CREDENTIAL_ROTATION_FAILED");
    // The actual client commits one row then holds another uncommitted.
    const worker = spawn(
      "docker",
      [
        "exec",
        "--interactive",
        "--env",
        "PGPASSFILE=/tmp/credential-v1",
        id,
        "sh",
        "-c",
        "echo $$ > /tmp/morrow-worker.pid; exec psql -X -qAt -w -v ON_ERROR_STOP=1 -h /var/run/postgresql -U morrow_worker -d morrow_lab",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let workerOutput = "";
    let workerError = "";
    worker.stdout.on("data", (chunk) => {
      workerOutput += chunk;
    });
    worker.stderr.on("data", (chunk) => {
      workerError += chunk;
    });
    const ended = new Promise((resolve, reject) => {
      worker.once("error", () => reject(Error("LOCAL_WORKER_START_FAILED")));
      worker.once("close", (code) => resolve(code));
    });
    worker.stdin.end(
      "SET application_name='morrow_local_worker'; INSERT INTO worker_fixture VALUES(1); BEGIN; INSERT INTO worker_fixture VALUES(2); SELECT pg_sleep(30); COMMIT;\n",
    );
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (
        sql(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='morrow_local_worker' AND state='active' AND query LIKE '%pg_sleep%';",
        ) === "1"
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw Error("LOCAL_WORKER_DID_NOT_HOLD_TRANSACTION");
    emit("CREDENTIAL_ROTATION_STARTED");
    sql(`ALTER ROLE morrow_worker PASSWORD '${newPassword}';`);
    const obsolete = login("credential-v1");
    if (obsolete.status === 0 || !obsolete.stderr?.includes("password authentication failed"))
      throw Error("OLD_CREDENTIAL_STILL_ACCEPTED");
    passfile("credential-v2");
    if (login("credential-v2").stdout?.trim() !== "1")
      throw Error("ROTATED_CREDENTIAL_LOGIN_FAILED");
    emit("CREDENTIAL_ROTATION_VERIFIED");
    // No promotion until a real authenticated new connection succeeds.
    const currentCredentialRevision = "credential-v2";
    emit("CREDENTIAL_ROTATION_PROMOTED");
    const beforeDeath = sql("SELECT count(*) FROM worker_fixture;");
    containerCommand(["exec", id, "sh", "-c", "kill -KILL $(cat /tmp/morrow-worker.pid)"]);
    const exit = await Promise.race([
      ended,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("LOCAL_WORKER_STOP_TIMEOUT")), 5000),
      ),
    ]);
    if (exit === 0) throw Error("LOCAL_WORKER_NOT_ABRUPTLY_KILLED");
    emit("WORKER_CONNECTION_LOST");
    // Terminate only the owned lab backend if its sleeping query outlives client
    // disconnection. This is not a production retry/replay mechanism.
    sql(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='morrow_local_worker';",
    );
    const durableRows = sql("SELECT string_agg(id::text, ',' ORDER BY id) FROM worker_fixture;");
    if (beforeDeath !== "1" || durableRows !== "1" || login(currentCredentialRevision).status !== 0)
      throw Error("ROTATION_WORKER_DURABILITY_FAILED");
    emit("WORKER_CONNECTION_RECOVERED");
    const pending = inspectProvisioningReadiness(
      {
        environment: "development",
        region: "us-east-1",
        accountId: null,
        sourceCommit: null,
        templateDigest: null,
        engineVersion: null,
        maximumAcu: null,
        ingressCertificateArn: null,
        s3RegionalPrefixListId: null,
        deploymentIssuerRolePath: null,
        recoveryIssuerRolePath: null,
        cloudflarePrivateProcessing: false,
        checks: {},
        quote: null,
        ownerAuthorization: null,
      },
      {
        environment: "development",
        sourceCommit: "a".repeat(40),
        templateDigest: "b".repeat(64),
        now: new Date().toISOString(),
      },
    );
    if (!pending.includes("BOUND_OWNER_COST_AUTHORIZATION_REQUIRED"))
      throw Error("INVALID_ACTIVATION_NOT_HELD");
    emit("ACTIVATION_HELD");
    const serverLogs = containerCommand(["logs", id]);
    const logs =
      serverLogs.stdout +
      serverLogs.stderr +
      unverified.stderr +
      obsolete.stderr +
      workerOutput +
      workerError +
      JSON.stringify(events);
    if ([oldPassword, newPassword].some((password) => logs.includes(password)))
      throw Error("LOCAL_CREDENTIAL_LOG_DISCLOSURE");
    return {
      scope:
        "Actual isolated local SCRAM rotation and abrupt client-worker death; not AWS rotation/ECS deployment/Temporal durability/TLS/IAM qualification",
      synthetic_only: true,
      image,
      server_version: version,
      network: "none",
      host_mounts: 0,
      credentials:
        "random process-memory AES-GCM fixture; stdin/tmpfs only, not AWS secret storage",
      authentication: "actual local Unix socket SCRAM-SHA-256",
      unverified_credential_promoted: false,
      old_new_connection: "denied after rotation",
      new_connection: "succeeded before promotion",
      worker_exit: exit,
      committed_rows: 1,
      uncommitted_rows: 0,
      activation: "held by diagnostic; no deployment attempted",
      dispatch_enabled: false,
      credentials_in_observed_output: false,
      events,
    };
  });
} finally {
  vault.close();
}
report.elapsed_ms = Math.round(performance.now() - start);
report.cleanup = "owned ephemeral container removed";
mkdirSync("docs/evidence/P04.T03", { recursive: true });
writeFileSync("docs/evidence/P04.T03/operations-lab.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  "PASS: actual local SCRAM rotation, abrupt client death, durable committed rows and redacted signals; cloud qualification pending.",
);
