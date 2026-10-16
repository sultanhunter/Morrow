import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

const roles = Object.freeze([
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_resolution",
  "morrow_identity_sessions",
]);
const held = () => Error("CONTROLLED_NEON_POSTGRESQL_HELD");
const require = (value) => {
  if (!value) throw held();
};
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
function command(args, input, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 2097152) {
        failed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 65536) {
        failed = true;
        child.kill("SIGKILL");
      }
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = { code, stdout, stderr, failed };
      if (failed || (code !== 0 && !allowFailure)) reject(held());
      else resolve(result);
    });
    child.stdin.end(input);
  });
}
async function absent(kind, id) {
  const result = await command(
    kind === "network" ? ["network", "inspect", id] : ["inspect", id],
    undefined,
    true,
  );
  require(
    result.code !== 0 &&
      (/No such (object|container|network)/i.test(result.stderr) ||
        (kind === "network" && result.stderr.includes("network " + id + " not found"))),
  );
}
async function authenticationProbe(endpoint, user) {
  const fields = Buffer.from(
    "user\0" + user + "\0database\0morrow\0application_name\0morrow_t88_authprobe\0\0",
  );
  const startup = Buffer.alloc(fields.length + 8);
  startup.writeInt32BE(startup.length);
  startup.writeInt32BE(196608, 4);
  fields.copy(startup, 8);
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = Buffer.alloc(0),
      result,
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      socket.destroy();
    }, 1000);
    socket.once("connect", () => socket.write(startup));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) {
        failed = true;
        socket.destroy();
        return;
      }
      if (buffer.length < 5) return;
      const size = buffer.readInt32BE(1);
      if (size < 4 || size > 4096) {
        failed = true;
        socket.destroy();
        return;
      }
      if (buffer.length < size + 1) return;
      if (
        buffer[0] === 82 &&
        size >= 8 &&
        buffer.readInt32BE(5) === 10 &&
        buffer
          .subarray(9, size + 1)
          .toString("utf8")
          .split("\0")
          .includes("SCRAM-SHA-256")
      )
        result = "scram";
      else if (buffer[0] === 69) {
        const parts = buffer
          .subarray(5, size + 1)
          .toString("utf8")
          .split("\0");
        result = parts.includes("C28000") ? "rejected" : "other_error";
      } else result = "other";
      socket.destroy();
    });
    socket.once("error", () => {
      failed = true;
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (failed || !result) reject(held());
      else resolve(result);
    });
  });
}
export async function controlledNeonPostgresqlLab(use) {
  // Importing this fixture never starts Docker. Integration is isolated Linux CI only.
  require(
    process.platform === "linux" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.version === "v24.13.0",
  );
  const config = JSON.parse(readFileSync("infra/local-engine.json", "utf8"));
  require(
    /^postgres@sha256:[a-f0-9]{64}$/.test(config.image) &&
      config.major === 17 &&
      config.user === "999:999",
  );
  await command(["image", "inspect", config.image]); // CI must obtain the exact image before allocation.
  const suffix = randomUUID().replaceAll("-", "");
  const networkName = "morrow-t88-net-" + suffix;
  const containerName = "morrow-t88-pg-" + suffix;
  const passwordByRole = Object.fromEntries(
    roles.map((role) => [role, randomBytes(32).toString("hex")]),
  );
  const cleanup = {
    container: "not_created",
    network: "not_created",
    finalNamespace: "not_observed",
    forcedFinalCleanup: false,
  };
  let networkId,
    containerId,
    phase = "setup",
    finalObservation,
    outcome,
    primaryFailure = false,
    networkAttempted = false,
    containerAttempted = false;
  const cleanupFailures = [];
  let setupStage = "network_absence";
  const setupObservation = {
    networkProfile: null,
    gatewayMatched: null,
    readiness: null,
    serverVersionMatched: null,
    containerProfile: null,
    attachedNetworkOnlyOwned: null,
    kernelRoutes: null,
    loopbackReachable: null,
  };
  const setupPhase = (value) => {
    setupStage = value;
    console.error("CONTROLLED_PG_SETUP_PHASE:" + value);
  };
  try {
    setupPhase("network_absence");
    await absent("network", networkName);
    networkAttempted = true;
    cleanup.network = "attempted_unknown";
    setupPhase("network_create");
    networkId = (
      await command([
        "network",
        "create",
        "--internal",
        "--driver",
        "bridge",
        "--label",
        "morrow.packet=P05.T01t",
        "--label",
        "morrow.fixture=" + suffix,
        networkName,
      ])
    ).stdout.trim();
    require(/^[a-f0-9]{64}$/.test(networkId));
    cleanup.network = "owned";
    setupPhase("network_inspection");
    const [network] = JSON.parse((await command(["network", "inspect", networkId])).stdout);
    setupObservation.networkProfile = Object.freeze({
      idMatched: network.Id === networkId,
      nameMatched: network.Name === networkName,
      internal: network.Internal === true,
      bridge: network.Driver === "bridge",
      packetLabelMatched: network.Labels?.["morrow.packet"] === "P05.T01t",
      nonceLabelMatched: network.Labels?.["morrow.fixture"] === suffix,
      ipv6Disabled: network.EnableIPv6 === false,
      empty: Object.keys(network.Containers ?? {}).length === 0,
    });
    require(
      network.Id === networkId &&
        network.Name === networkName &&
        network.Internal === true &&
        network.Driver === "bridge" &&
        network.Labels?.["morrow.packet"] === "P05.T01t" &&
        network.Labels?.["morrow.fixture"] === suffix &&
        network.EnableIPv6 === false &&
        Object.keys(network.Containers ?? {}).length === 0,
    );
    setupPhase("network_gateway");
    const gateway = network.IPAM?.Config?.[0]?.Gateway;
    setupObservation.gatewayMatched =
      typeof gateway === "string" && /^172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/.test(gateway);
    require(
      typeof gateway === "string" && /^172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/.test(gateway),
    );
    setupPhase("container_absence");
    await absent("container", containerName);
    containerAttempted = true;
    cleanup.container = "attempted_unknown";
    setupPhase("container_create");
    containerId = (
      await command([
        "run",
        "--detach",
        "--rm",
        "--name",
        containerName,
        "--network",
        networkId,
        "--publish",
        "127.0.0.1::5432",
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
        "morrow.packet=P05.T01t",
        "--label",
        "morrow.fixture=" + suffix,
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
        // Public bootstrap marker, unusable over rejected TCP. Actual role secrets use SQL stdin only.
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
      ])
    ).stdout.trim();
    require(/^[a-f0-9]{64}$/.test(containerId));
    cleanup.container = "owned";
    const sql = async (text, database = "morrow_lab") => {
      require(phase === "setup" || phase === "final");
      require(["morrow_lab", "morrow"].includes(database));
      return (
        await command(
          [
            "exec",
            "--interactive",
            containerId,
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
        )
      ).stdout.trim();
    };
    // Existing seed helpers are synchronous. This separate adapter is setup-only,
    // so it cannot carry administrator capability into the Worker/request path.
    const { spawnSync } = await import("node:child_process");
    const setupSql = (text, database = "morrow_lab") => {
      require(phase === "setup" && ["morrow_lab", "morrow"].includes(database));
      const result = spawnSync(
        "docker",
        [
          "exec",
          "--interactive",
          containerId,
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
        { input: text, encoding: "utf8", timeout: 10000, maxBuffer: 2097152 },
      );
      require(!result.error && result.status === 0);
      return result.stdout.trim();
    };
    setupPhase("container_readiness");
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const value = await command(
        [
          "exec",
          containerId,
          "pg_isready",
          "-h",
          "/var/run/postgresql",
          "-U",
          "postgres",
          "-d",
          "morrow_lab",
        ],
        undefined,
        true,
      );
      const main = await command(["exec", containerId, "cat", "/proc/1/comm"], undefined, true);
      setupObservation.readiness = Object.freeze({
        attempts: i + 1,
        pgReadyExitCode: value.code,
        pidReadExitCode: main.code,
        pidMatched: main.stdout.trim() === "postgres",
      });
      if (value.code === 0 && main.code === 0 && main.stdout.trim() === "postgres") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    require(ready);
    setupPhase("server_version");
    const version = await sql("SELECT current_setting('server_version');");
    setupObservation.serverVersionMatched = version.startsWith("17.11 ");
    require(version.startsWith("17.11 "));
    setupPhase("container_inspection");
    const [container] = JSON.parse((await command(["inspect", containerId])).stdout);
    const published = container.NetworkSettings?.Ports?.["5432/tcp"];
    setupObservation.containerProfile = Object.freeze({
      nameMatched: container.Name === "/" + containerName,
      imageMatched: container.Config.Image === config.image,
      userMatched: container.Config.User === "999:999",
      packetLabelMatched: container.Config.Labels?.["morrow.packet"] === "P05.T01t",
      nonceLabelMatched: container.Config.Labels?.["morrow.fixture"] === suffix,
      readOnlyRootfs: container.HostConfig.ReadonlyRootfs === true,
      networkModeMatched: container.HostConfig.NetworkMode === networkId,
      noHostMounts: container.Mounts.length === 0,
      publicationArray: Array.isArray(published),
      singlePublication: Array.isArray(published) && published.length === 1,
      loopbackPublication:
        Array.isArray(published) && published.length === 1 && published[0].HostIp === "127.0.0.1",
      validPortSpelling:
        Array.isArray(published) &&
        published.length === 1 &&
        /^\d{1,5}$/.test(published[0].HostPort),
      singleNetwork: Object.keys(container.NetworkSettings.Networks).length === 1,
    });
    require(
      container.Name === "/" + containerName &&
        container.Config.Image === config.image &&
        container.Config.User === "999:999" &&
        container.Config.Labels?.["morrow.packet"] === "P05.T01t" &&
        container.Config.Labels?.["morrow.fixture"] === suffix &&
        container.HostConfig.ReadonlyRootfs &&
        container.HostConfig.NetworkMode === networkId &&
        container.Mounts.length === 0 &&
        Array.isArray(published) &&
        published.length === 1 &&
        published[0].HostIp === "127.0.0.1" &&
        /^\d{1,5}$/.test(published[0].HostPort) &&
        Object.keys(container.NetworkSettings.Networks).length === 1,
    );
    setupPhase("attached_network");
    const [attachedNetwork] = JSON.parse((await command(["network", "inspect", networkId])).stdout);
    setupObservation.attachedNetworkOnlyOwned =
      Object.keys(attachedNetwork.Containers ?? {}).join(",") === containerId;
    require(Object.keys(attachedNetwork.Containers ?? {}).join(",") === containerId);
    setupPhase("kernel_routes");
    const routeText = (await command(["exec", containerId, "cat", "/proc/net/route"])).stdout;
    const routeRows = routeText
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/));
    setupObservation.kernelRoutes = Object.freeze({
      rowCount: routeRows.length,
      nonEmpty: routeRows.length > 0,
      rowsParsed: routeRows.every((row) => row.length >= 8 && /^[A-Fa-f0-9]{8}$/.test(row[1])),
      defaultRouteAbsent: routeRows.every((row) => row[1] !== "00000000"),
    });
    require(
      routeRows.length > 0 &&
        routeRows.every(
          (row) => row.length >= 8 && /^[A-Fa-f0-9]{8}$/.test(row[1]) && row[1] !== "00000000",
        ),
    );
    const port = Number(published[0].HostPort);
    require(port > 0 && port <= 65535);
    setupPhase("loopback_reachability");
    const reachability = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let connected = false;
      socket.once("connect", () => {
        connected = true;
        socket.end();
      });
      socket.once("error", () => socket.destroy());
      socket.setTimeout(1000, () => socket.destroy());
      socket.once("close", () => resolve(connected));
    });
    setupObservation.loopbackReachable = reachability;
    require(reachability);
    const endpoint = Object.freeze({ host: "127.0.0.1", port });
    const api = Object.freeze({
      id: containerId,
      image: config.image,
      version,
      sql: setupSql,
      endpoint,
      passwordByRole,
      topology: Object.freeze({
        internalNetwork: true,
        loopbackOnlyPublication: true,
        ephemeralPort: true,
        reachable: true,
        hostMounts: 0,
        tcpAdministratorAllowed: false,
        ipv4NoDefaultRouteMeasured: true,
        networkIpv6Disabled: true,
        singleOwnedNetworkEndpoint: true,
      }),
      async sealSetup() {
        setupPhase("role_scram_configuration");
        require(phase === "setup");
        for (const role of roles)
          await sql(
            "ALTER ROLE " + role + " LOGIN PASSWORD " + literal(passwordByRole[role]) + ";",
            "morrow",
          );
        const hba =
          "local all all trust\nhost morrow " +
          roles.join(",") +
          " " +
          gateway +
          "/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n";
        await command(
          [
            "exec",
            "--interactive",
            containerId,
            "sh",
            "-c",
            "umask 077; cat > /var/lib/postgresql/data/pg_hba.conf",
          ],
          hba,
        );
        setupPhase("hba_reload");
        const loadedBefore = await sql("SELECT pg_conf_load_time()::text;");
        require((await sql("SELECT pg_reload_conf();")) === "t");
        let loaded = false;
        for (let i = 0; i < 20; i++) {
          if ((await sql("SELECT pg_conf_load_time()::text;")) !== loadedBefore) {
            loaded = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        require(loaded);
        setupPhase("role_authentication");
        for (const role of roles) require((await authenticationProbe(endpoint, role)) === "scram");
        require((await authenticationProbe(endpoint, "postgres")) === "rejected");
        require((await authenticationProbe(endpoint, "morrow_identity_owner")) === "rejected");
        phase = "requests";
        setupPhase("requests_callback");
        return Object.freeze({
          scramOfferedRoles: 4,
          tcpAdministratorRejected: true,
          tcpOwnerRejected: true,
          probeConnectionsClosed: 6,
        });
      },
      async observeFinalNamespace() {
        setupPhase("final_namespace");
        require(phase === "requests");
        phase = "final";
        const where =
          "datname='morrow' AND usename IN (" +
          roles.map(literal).join(",") +
          ") AND left(application_name,11)='morrow_t88_'";
        const before = Number(
          await sql("SELECT count(*) FROM pg_stat_activity WHERE " + where + ";", "morrow"),
        );
        require(Number.isSafeInteger(before) && before >= 0);
        if (before) {
          cleanup.forcedFinalCleanup = true;
          await sql(
            "SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE " + where + ";",
            "morrow",
          );
        }
        const after = Number(
          await sql("SELECT count(*) FROM pg_stat_activity WHERE " + where + ";", "morrow"),
        );
        require(after === 0);
        cleanup.finalNamespace = "absent";
        finalObservation = Object.freeze({
          presentBeforeFinalCleanup: before,
          absentAfterFinalCleanup: true,
          forcedFinalCleanup: cleanup.forcedFinalCleanup,
        });
        return finalObservation;
      },
    });
    setupPhase("setup_callback");
    const result = await use(api);
    require(finalObservation !== undefined);
    outcome = { result, cleanup, image: config.image, version };
    setupPhase("completed");
  } catch {
    primaryFailure = true;
  } finally {
    // A CLI timeout may follow a real allocation. Reconcile only this prelatched
    // unique attempt name and exact nonce/packet labels; never allocate again.
    if (containerAttempted) {
      try {
        const found = await command(["inspect", containerName], undefined, true);
        if (found.code === 0) {
          const rows = JSON.parse(found.stdout);
          require(rows.length === 1);
          const owned = rows[0];
          require(
            owned.Name === "/" + containerName &&
              owned.Config.Labels?.["morrow.packet"] === "P05.T01t" &&
              owned.Config.Labels?.["morrow.fixture"] === suffix &&
              /^[a-f0-9]{64}$/.test(owned.Id) &&
              (!containerId || containerId === owned.Id),
          );
          containerId = owned.Id;
          await command(["rm", "--force", containerId]);
          await absent("container", containerId);
        } else require(/No such (object|container)/i.test(found.stderr));
        cleanup.container = "absent";
      } catch {
        cleanup.container = "unverified";
        cleanupFailures.push("container_cleanup_held");
      }
    }
    if (networkAttempted) {
      try {
        const found = await command(["network", "inspect", networkName], undefined, true);
        if (found.code === 0) {
          const rows = JSON.parse(found.stdout);
          require(rows.length === 1);
          const owned = rows[0];
          require(
            owned.Name === networkName &&
              owned.Labels?.["morrow.packet"] === "P05.T01t" &&
              owned.Labels?.["morrow.fixture"] === suffix &&
              /^[a-f0-9]{64}$/.test(owned.Id) &&
              (!networkId || networkId === owned.Id) &&
              Object.keys(owned.Containers ?? {}).length === 0,
          );
          networkId = owned.Id;
          await command(["network", "rm", networkId]);
          await absent("network", networkId);
        } else
          require(
            /No such network/i.test(found.stderr) ||
              found.stderr.includes("network " + networkName + " not found"),
          );
        cleanup.network = "absent";
      } catch {
        cleanup.network = "unverified";
        cleanupFailures.push("network_cleanup_held");
      }
    }
    for (const role of roles) passwordByRole[role] = "";
  }
  if (primaryFailure || cleanupFailures.length) {
    const error = held();
    error.observation = Object.freeze({
      primaryExecutionHeld: primaryFailure,
      setupPhase: setupStage,
      setupObservation: Object.freeze({ ...setupObservation }),
      cleanup: Object.freeze({ ...cleanup }),
      cleanupFailures: Object.freeze(cleanupFailures),
    });
    throw error;
  }
  return outcome;
}
