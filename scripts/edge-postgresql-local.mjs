// Local-only runner for the P04.T02a PostgreSQL journeys (`npm run
// lab:edge-postgresql-local`). It runs the same `edgePostgresqlJourneys` as
// lab:edge-postgresql, on a developer machine with Docker Desktop, so the journeys
// can be exercised before the Linux `pgwire` job. It is supporting evidence only:
// the hosted `pgwire` job (managed engine on an internal Docker network, measured
// gateway source, no published port) stays the authority, and this runner refuses
// to run in GitHub Actions.
//
// Differences from the managed engine, all on the fixture side: the pinned image
// must already be present (no pull); port 5432 is published on 127.0.0.1 only, on
// an ephemeral host port; Docker Desktop NATs host connections, so the HBA admits
// the seven runtime roles from any source address inside the container's network
// namespace, and the loopback-only publication is the boundary. Administrator and
// owner logins are still rejected over TCP, and setup SQL goes over the local
// Unix socket before the seal only.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeArtifact } from "./artifacts.mjs";
import { edgeRefusals } from "./edge.mjs";
import { edgePostgresqlJourneys, edgePostgresqlRoles } from "./edge-postgresql-lab.mjs";
import { authenticationProbe } from "./fixtures/controlled-neon-postgresql.mjs";
import { createSyntheticLoopbackControlledNeonTcpService } from "./fixtures/controlled-neon-tcp-bridge.mjs";

const held = (code) => Error("EDGE_POSTGRESQL_LOCAL_" + code);
const require = (condition, code) => {
  if (!condition) throw held(code);
};
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
// Docker Desktop on a busy Mac can take tens of seconds per call, so the local
// timeouts are longer than the managed lab's.
function docker(args, { input, allowFailure = false, timeout = 60000 } = {}) {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 << 20,
  });
  if (!allowFailure)
    require(!result.error && result.status === 0, "DOCKER_" + args[0].toUpperCase());
  return { code: result.status, stdout: (result.stdout ?? "").trim() };
}

export async function localEngine(use) {
  const config = JSON.parse(readFileSync("infra/local-engine.json", "utf8"));
  require(/^postgres@sha256:[a-f0-9]{64}$/.test(config.image) && config.major === 17, "IMAGE_PIN");
  require(docker(["image", "inspect", config.image], { allowFailure: true }).code ===
    0, "IMAGE_MISSING");
  // An earlier run's container (for example one a timed-out `docker run` created
  // late) is an unknown outcome: refuse until the owner removes it with
  // `docker rm --force $(docker ps -aq --filter label=morrow.packet=P04.T02a)`.
  require(docker(["ps", "--all", "--quiet", "--filter", "label=morrow.packet=P04.T02a"]).stdout ===
    "", "LEFTOVER_CONTAINER");
  const nonce = randomUUID().replaceAll("-", "");
  const name = "morrow-edge-local-pg-" + nonce;
  const roles = edgePostgresqlRoles;
  const passwordByRole = Object.fromEntries(
    roles.map((role) => [role, randomBytes(32).toString("hex")]),
  );
  let id = null;
  try {
    id = docker(
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
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
        "morrow.packet=P04.T02a",
        "--label",
        "morrow.fixture=" + nonce,
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql/data:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=256m",
        "--tmpfs",
        "/var/run/postgresql:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=8m",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,uid=999,gid=999,mode=0700,size=32m",
        "--env",
        "POSTGRES_DB=morrow_lab",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=reject",
        "--env",
        "POSTGRES_PASSWORD=morrow_fixture_bootstrap_tcp_rejected",
        "--env",
        "POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=reject",
        config.image,
        "postgres",
        "-c",
        "listen_addresses=*",
        "-c",
        "password_encryption=scram-sha-256",
        "-c",
        "log_statement=none",
        "-c",
        "log_min_error_statement=panic",
        "-c",
        "log_error_verbosity=terse",
      ],
      { timeout: 120000 },
    ).stdout;
    require(/^[a-f0-9]{64}$/.test(id), "CONTAINER_ID");
    let sealed = false;
    const sql = (text, database = "morrow_lab") => {
      require(["morrow_lab", "morrow"].includes(database), "DATABASE");
      return docker(
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
        { input: text, timeout: 60000 },
      ).stdout;
    };
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      ready =
        docker(
          [
            "exec",
            id,
            "pg_isready",
            "-h",
            "/var/run/postgresql",
            "-U",
            "postgres",
            "-d",
            "morrow_lab",
          ],
          { allowFailure: true },
        ).code === 0 &&
        docker(["exec", id, "cat", "/proc/1/comm"], { allowFailure: true }).stdout === "postgres";
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    require(ready, "NOT_READY");
    const version = sql("SELECT current_setting('server_version');");
    require(version.startsWith(config.observed_version + " "), "SERVER_VERSION");
    const published = docker(["port", id, "5432/tcp"]).stdout.split("\n");
    const match = /^127\.0\.0\.1:(\d+)$/.exec(published[0] ?? "");
    require(published.length === 1 && match, "PUBLISHED_PORT");
    const target = Object.freeze({ host: "127.0.0.1", port: Number(match[1]) });
    const engine = Object.freeze({
      id,
      sql(text, database) {
        require(!sealed, "SEALED");
        return sql(text, database);
      },
      endpoint: target,
      passwordByRole,
      async sealSetup() {
        require(!sealed, "SEALED");
        for (const role of roles)
          sql(
            "ALTER ROLE " + role + " LOGIN PASSWORD " + literal(passwordByRole[role]) + ";",
            "morrow",
          );
        const hba =
          "local all all trust\nhost morrow " +
          roles.join(",") +
          " 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n";
        docker(
          [
            "exec",
            "--interactive",
            id,
            "sh",
            "-c",
            "umask 077; cat > /var/lib/postgresql/data/pg_hba.conf",
          ],
          { input: hba },
        );
        const before = sql("SELECT pg_conf_load_time()::text;");
        require(sql("SELECT pg_reload_conf();") === "t", "HBA_RELOAD");
        let loaded = false;
        for (let i = 0; i < 40 && !loaded; i++) {
          loaded = sql("SELECT pg_conf_load_time()::text;") !== before;
          if (!loaded) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        require(loaded, "HBA_RELOAD");
        let scramOfferedRoles = 0;
        for (const role of roles)
          if ((await authenticationProbe(target, role)) === "scram") scramOfferedRoles++;
        require((await authenticationProbe(target, "postgres")) === "rejected", "TCP_ADMIN");
        require((await authenticationProbe(target, "morrow_identity_owner")) ===
          "rejected", "TCP_OWNER");
        sealed = true;
        return Object.freeze({ scramOfferedRoles, tcpAdministratorRejected: true });
      },
      revokeEndpoint() {},
      async observeFinalNamespace() {
        const where = "datname='morrow' AND usename IN (" + roles.map(literal).join(",") + ")";
        const count = () =>
          Number(sql("SELECT count(*) FROM pg_stat_activity WHERE " + where + ";", "morrow"));
        const present = count();
        if (present)
          sql(
            "SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE " + where + ";",
            "morrow",
          );
        require(count() === 0, "FINAL_NAMESPACE");
        return Object.freeze({ presentBeforeFinalCleanup: present, absentAfterFinalCleanup: true });
      },
    });
    return { result: await use(engine), image: config.image, version };
  } finally {
    for (const role of roles) passwordByRole[role] = "";
    // A `docker run` that timed out may still create the container afterwards, so
    // removal goes by the unique name and absence is checked three times.
    let absent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      docker(["rm", "--force", name], { allowFailure: true, timeout: 60000 });
      absent = docker(["inspect", name], { allowFailure: true }).code !== 0;
    }
    require(absent, "CONTAINER_CLEANUP");
  }
}

async function main() {
  require(process.version === "v24.13.0", "PINNED_NODE");
  require(process.env.GITHUB_ACTIONS !== "true", "CI_USES_LAB_EDGE_POSTGRESQL");
  require(edgeRefusals().length === 0, "REFUSED");
  const started = Date.now();
  let measured = null;
  let failure = null;
  try {
    measured = await localEngine((engine) =>
      edgePostgresqlJourneys(engine, createSyntheticLoopbackControlledNeonTcpService),
    );
  } catch (error) {
    failure = String(error?.message ?? "EDGE_POSTGRESQL_LOCAL_HELD").slice(0, 120);
  }
  const result = measured?.result ?? null;
  const passed =
    !failure &&
    result &&
    result.checks.every((row) => row.passed) &&
    result.cases.every((row) => row.passed);
  const report = {
    generated_at: new Date().toISOString(),
    packet: "P04.T02a",
    status: passed ? "passed" : "held",
    scope:
      "Local-only supporting run of the lab:edge-postgresql journeys (real wrangler dry-run api and broker bundles in local workerd, WSS->TCP bridge, PostgreSQL 17 in Docker on a loopback-published port, synthetic WorkOS). Not CI evidence: the hosted `pgwire` job is the authority.",
    platform: process.platform,
    durationMs: Date.now() - started,
    image: measured?.image ?? null,
    serverVersion: measured?.version ?? null,
    appliedMigrations: result?.appliedMigrations ?? null,
    cases: result?.cases ?? [],
    checks: result?.checks ?? [],
    wrongSecretMatrix: result?.wrongSecretMatrix ?? null,
    responsesScanned: result?.responsesScanned ?? null,
    outbound: result?.outbound ?? null,
    finalNamespace: result?.final ?? null,
    failure,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  const markers = result?.privateMarkers ?? [];
  require(markers.every((marker) => !marker || !text.includes(marker)), "MARKER_IN_REPORT");
  const path = writeArtifact("labs/edge-postgresql-local.json", text);
  process.stdout.write(
    JSON.stringify({
      report: path,
      status: report.status,
      cases: report.cases.length,
      checks: report.checks.length,
      durationMs: report.durationMs,
    }) + "\n",
  );
  if (!passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
