import { createHash, randomUUID } from "node:crypto";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { encryptedLabFixtures } from "./encrypted-lab-fixtures.mjs";
import { encodeOperationalEvent } from "../packages/infrastructure/src/operations.ts";
import { writeArtifact } from "./artifacts.mjs";
const archive = encryptedLabFixtures();
const restoredObjects = encryptedLabFixtures();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const objects = [
  ["artifact-a", "org-a", "version-a1", Buffer.from("synthetic original product revision")],
  ["artifact-b", "org-a", "version-b1", Buffer.from("synthetic later deleted revision")],
  ["artifact-c", "org-b", "version-c1", Buffer.from("synthetic later erased organization")],
];
const started = performance.now();
const events = [];
const correlationId = randomUUID();
const emit = (code) =>
  events.push(
    JSON.parse(
      encodeOperationalEvent({
        schemaVersion: 1,
        environment: "development",
        service: "recovery",
        code,
        correlationId,
        at: new Date().toISOString(),
      }),
    ),
  );
const verifyObjects = (rows, store) => {
  const findings = [];
  for (const row of rows) {
    try {
      if (digest(store.get(row.version)) !== row.sha256) findings.push("VERSION_CHECKSUM_MISMATCH");
    } catch {
      findings.push("EXACT_VERSION_MISSING");
    }
  }
  return findings;
};
let report;
try {
  for (const [, , version, bytes] of objects) archive.put(version, bytes);
  // A newer version deliberately differs. Recovery must not silently use latest.
  archive.put("version-a2", Buffer.from("synthetic post-backup revision"));
  report = await localPostgresLab("P04.T04", async ({ id, sql, image, version }) => {
    sql(`CREATE SCHEMA restore_fixture;
      CREATE TABLE restore_fixture.organizations(id text PRIMARY KEY);
      CREATE TABLE restore_fixture.artifacts(id text PRIMARY KEY,org_id text NOT NULL REFERENCES restore_fixture.organizations(id) ON DELETE CASCADE,version text NOT NULL,sha256 text NOT NULL);
      CREATE TABLE restore_fixture.connections(id text PRIMARY KEY,org_id text NOT NULL REFERENCES restore_fixture.organizations(id) ON DELETE CASCADE,status text NOT NULL CHECK(status IN ('active','revoked')));
      CREATE TABLE restore_fixture.tasks(id text PRIMARY KEY,connection_id text NOT NULL REFERENCES restore_fixture.connections(id) ON DELETE CASCADE,lease_generation integer NOT NULL,status text NOT NULL CHECK(status IN ('pending','held')));
      CREATE TABLE restore_fixture.recovery_control(singleton boolean PRIMARY KEY CHECK(singleton),dispatch_enabled boolean NOT NULL DEFAULT false CHECK(NOT dispatch_enabled),integrity_checked boolean NOT NULL DEFAULT false);
      INSERT INTO restore_fixture.recovery_control(singleton) VALUES(true);
      INSERT INTO restore_fixture.organizations VALUES('org-a'),('org-b');
      INSERT INTO restore_fixture.artifacts VALUES ${objects.map(([artifact, org, rev, bytes]) => `('${artifact}','${org}','${rev}','${digest(bytes)}')`).join(",")};
      INSERT INTO restore_fixture.connections VALUES('connection-a','org-a','active'),('connection-b','org-b','active');
      INSERT INTO restore_fixture.tasks VALUES('task-a','connection-a',7,'pending'),('task-b','connection-b',9,'pending');`);
    containerCommand([
      "exec",
      id,
      "pg_dump",
      "-U",
      "postgres",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--schema=restore_fixture",
      "--file=/tmp/restore-fixture.dump",
      "morrow_lab",
    ]);
    const backupSha256 = containerCommand(["exec", id, "sha256sum", "/tmp/restore-fixture.dump"])
      .stdout.trim()
      .split(" ")[0];
    if (!/^[a-f0-9]{64}$/.test(backupSha256)) throw Error("LOCAL_BACKUP_DIGEST_FAILED");
    // Later authoritative marker source is outside the backed-up schema.
    sql(`CREATE SCHEMA current_journal;
      CREATE TABLE current_journal.markers(sequence integer PRIMARY KEY,kind text NOT NULL,target text NOT NULL);
      INSERT INTO current_journal.markers VALUES(11,'artifact-delete','artifact-b'),(12,'connection-revoke','connection-a'),(13,'organization-erase','org-b');
      DELETE FROM restore_fixture.artifacts WHERE id='artifact-b';
      UPDATE restore_fixture.connections SET status='revoked' WHERE id='connection-a';
      DELETE FROM restore_fixture.organizations WHERE id='org-b';`);
    const restoreStart = performance.now();
    containerCommand([
      "exec",
      id,
      "createdb",
      "-U",
      "postgres",
      "--template=template0",
      "morrow_restored",
    ]);
    containerCommand([
      "exec",
      id,
      "pg_restore",
      "-U",
      "postgres",
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "--dbname=morrow_restored",
      "/tmp/restore-fixture.dump",
    ]);
    const targetSql = (text) => sql(text, "morrow_restored");
    if (targetSql("SELECT dispatch_enabled FROM restore_fixture.recovery_control;") !== "f")
      throw Error("RESTORE_NOT_QUARANTINED");
    emit("RESTORE_QUARANTINED");
    const unauthorizedEnable = containerCommand(
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
        "morrow_restored",
      ],
      "UPDATE restore_fixture.recovery_control SET dispatch_enabled=true;",
      true,
    );
    if (unauthorizedEnable.status === 0 || !unauthorizedEnable.stderr?.includes("check constraint"))
      throw Error("LOCAL_QUARANTINE_BYPASSED");
    const rows = JSON.parse(
      targetSql("SELECT json_agg(a ORDER BY id)::text FROM restore_fixture.artifacts a;"),
    );
    if (rows.length !== 3) throw Error("BACKUP_ROWS_NOT_RESTORED");
    for (const row of rows) restoredObjects.put(row.version, archive.get(row.version));
    restoredObjects.remove("version-a1");
    const missing = verifyObjects(rows, restoredObjects);
    if (!missing.includes("EXACT_VERSION_MISSING")) throw Error("MISSING_VERSION_NOT_DETECTED");
    emit("RESTORE_INTEGRITY_FAILED");
    restoredObjects.put("version-a1", archive.get("version-a1"));
    const wrong = verifyObjects(rows, {
      get: (ref) => archive.get(ref === "version-a1" ? "version-a2" : ref),
    });
    if (!wrong.includes("VERSION_CHECKSUM_MISMATCH"))
      throw Error("LATEST_VERSION_SUBSTITUTION_NOT_DETECTED");
    if (verifyObjects(rows, restoredObjects).length) throw Error("EXACT_OBJECT_INTEGRITY_FAILED");
    const markers = JSON.parse(
      sql(
        "SELECT json_agg(m ORDER BY sequence)::text FROM current_journal.markers m WHERE sequence>10;",
      ),
    );
    if (markers.length !== 3 || markers.map((m) => m.sequence).join(",") !== "11,12,13")
      throw Error("MARKER_RANGE_INCOMPLETE");
    // Fixed synthetic fixture adapter only; actual erasure journal authority,
    // parameterized app queries and lease contracts arrive in later packages.
    const replay = [];
    const erasedVersions = [];
    for (const marker of markers) {
      if (!/^[a-z]+(?:-[a-z]+)*$/.test(marker.target)) throw Error("INVALID_SYNTHETIC_MARKER");
      if (marker.kind === "artifact-delete") {
        erasedVersions.push(
          ...rows.filter((row) => row.id === marker.target).map((row) => row.version),
        );
        replay.push(`DELETE FROM restore_fixture.artifacts WHERE id='${marker.target}';`);
      } else if (marker.kind === "organization-erase") {
        erasedVersions.push(
          ...rows.filter((row) => row.org_id === marker.target).map((row) => row.version),
        );
        replay.push(`DELETE FROM restore_fixture.organizations WHERE id='${marker.target}';`);
      } else if (marker.kind === "connection-revoke") {
        replay.push(
          `UPDATE restore_fixture.connections SET status='revoked' WHERE id='${marker.target}';`,
        );
      } else throw Error("UNSUPPORTED_SYNTHETIC_MARKER");
    }
    targetSql(
      "BEGIN; " +
        replay.join("\n") +
        "UPDATE restore_fixture.tasks SET lease_generation=lease_generation+1,status='held'; COMMIT;",
    );
    for (const rev of erasedVersions) restoredObjects.remove(rev);
    const remaining = JSON.parse(
      targetSql("SELECT json_agg(a ORDER BY id)::text FROM restore_fixture.artifacts a;"),
    );
    if (
      remaining.length !== 1 ||
      remaining[0].id !== "artifact-a" ||
      verifyObjects(remaining, restoredObjects).length
    )
      throw Error("ERASURE_REPLAY_INTEGRITY_FAILED");
    const task = targetSql(
      "SELECT t.lease_generation||':'||t.status||':'||c.status FROM restore_fixture.tasks t JOIN restore_fixture.connections c ON c.id=t.connection_id;",
    );
    if (task !== "8:held:revoked") throw Error("REVOCATION_OR_LEASE_REPLAY_FAILED");
    const brokenFk = containerCommand(
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
        "morrow_restored",
      ],
      "INSERT INTO restore_fixture.tasks VALUES('invalid-task','missing-connection',1,'pending');",
      true,
    );
    if (brokenFk.status === 0 || !brokenFk.stderr?.includes("foreign key constraint"))
      throw Error("RESTORED_FK_NOT_ENFORCED");
    targetSql("UPDATE restore_fixture.recovery_control SET integrity_checked=true;");
    if (
      targetSql(
        "SELECT integrity_checked||':'||dispatch_enabled FROM restore_fixture.recovery_control;",
      ) !== "true:false"
    )
      throw Error("RECOVERY_DISPATCH_ENABLED");
    emit("RESTORE_INTEGRITY_VERIFIED");
    return {
      scope:
        "Actual local PostgreSQL17 pg_dump/transactional pg_restore plus synthetic encrypted versioned objects and marker replay; not Aurora PITR/S3/production RTO-RPO/authenticated reopening qualification",
      synthetic_only: true,
      image,
      server_version: version,
      network: "none",
      host_mounts: 0,
      backup_sha256: backupSha256,
      backup_marker_sequence: 10,
      replayed_marker_sequences: [11, 12, 13],
      database: "new template0 target; owner/ACL restore excluded; lab schema only",
      restored_artifacts_before_replay: 3,
      retained_artifacts_after_replay: 1,
      erased_restored_object_versions: 2,
      missing_version_detected: true,
      latest_version_substitution_rejected: true,
      foreign_key_violation_rejected: true,
      invalidated_fixture_leases: true,
      revoked_connection: "held",
      dispatch_enable_attempt: "denied by local DB constraint",
      unresolved_steps: [
        "current authenticated marker authority/watermark",
        "newer workflow/provider effects",
        "fresh runtime leases/authority",
        "real target/object/reopening qualification",
      ],
      dispatch_enabled: false,
      reopening: "denied; local integrity cannot authorize activation",
      restore_and_replay_ms: Math.round(performance.now() - restoreStart),
      events,
    };
  });
} finally {
  archive.close();
  restoredObjects.close();
}
report.elapsed_ms = Math.round(performance.now() - started);
report.cleanup = "owned ephemeral container and process-local encrypted fixtures removed";
writeArtifact("labs/restore.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  "PASS: actual local database restore, exact object integrity, later erasure/revocation replay and closed quarantine; real integration pending.",
);
