import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

// Issued only after this module has inspected the actual owned Docker endpoint.
// Importing or resolving never starts Docker; no synthetic capability issuer exists.
const ownedEndpoints = new WeakMap();
export function resolveControlledNeonPostgresqlEndpoint(capability) {
  return ownedEndpoints.get(capability) ?? null;
}
function ipv4(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value))
    return null;
  const octets = value.split(".").map(Number);
  if (octets.some((part) => part > 255) || octets.join(".") !== value) return null;
  return octets.reduce((result, part) => result * 256 + part, 0);
}
// A pure arithmetic guard, never an ownership or capability issuer.
export function controlledNeonFixtureIpv4Matches({
  address,
  gateway,
  subnet,
  memberAddress,
  prefixLength,
}) {
  if (typeof subnet !== "string" || typeof memberAddress !== "string") return false;
  const network = subnet.split("/"),
    member = memberAddress.split("/");
  if (network.length !== 2 || member.length !== 2 || !/^(?:[1-9]|[12]\d|30)$/.test(network[1]))
    return false;
  if (network[1] !== String(Number(network[1]))) return false;
  const prefix = Number(network[1]),
    host = ipv4(address),
    gw = ipv4(gateway),
    base = ipv4(network[0]);
  if (
    host === null ||
    gw === null ||
    base === null ||
    prefixLength !== prefix ||
    member[0] !== address ||
    member[1] !== network[1]
  )
    return false;
  const size = 2 ** (32 - prefix);
  if (
    base % size !== 0 ||
    host <= base ||
    host >= base + size - 1 ||
    gw <= base ||
    gw >= base + size - 1 ||
    host === gw
  )
    return false;
  // Preserve the prior fixture's bounded Docker IPv4 gateway range.
  const privateStart = 172 * 2 ** 24 + 16 * 2 ** 16;
  if (base < privateStart || base + size > privateStart + 16 * 2 ** 16) return false;
  return host >= base && host < base + size && gw >= base && gw < base + size;
}
const roles = Object.freeze([
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_resolution",
  "morrow_identity_sessions",
]);
const loginProfile = Object.freeze({ roles });
const workspaceProfile = Object.freeze({
  roles: Object.freeze([
    ...roles,
    "morrow_api",
    "morrow_identity_linking",
    "morrow_identity_logout",
  ]),
});
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
async function authenticationProbe(target, user) {
  const fields = Buffer.from(
    "user\0" + user + "\0database\0morrow\0application_name\0morrow_id_authprobe\0\0",
  );
  const startup = Buffer.alloc(fields.length + 8);
  startup.writeInt32BE(startup.length);
  startup.writeInt32BE(196608, 4);
  fields.copy(startup, 8);
  return new Promise((resolve, reject) => {
    const socket = createConnection(target);
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
  return ownedPostgresqlLab(use, loginProfile);
}
export async function managedWorkspacePostgresqlLab(use) {
  return ownedPostgresqlLab(use, workspaceProfile);
}
async function ownedPostgresqlLab(use, profile) {
  require(profile === loginProfile || profile === workspaceProfile);
  const roles = profile.roles;
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
  const suffix = randomUUID().replaceAll("-", "");
  const networkName = "morrow-loopback-net-" + suffix;
  const containerName = "morrow-loopback-pg-" + suffix;
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
    containerAttempted = false,
    issuedEndpoint;
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
    sameHostConnection: null,
    endpointAttestation: null,
    localDockerProfile: null,
  };
  const setupPhase = (value) => {
    setupStage = value;
    console.error("CONTROLLED_PG_SETUP_PHASE:" + value);
  };
  try {
    setupPhase("local_docker_profile");
    const dockerHost = process.env.DOCKER_HOST;
    require(dockerHost === undefined || dockerHost === "unix:///var/run/docker.sock");
    const contextHost = (
      await command(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
    ).stdout.trim();
    const daemonType = (await command(["info", "--format", "{{.OSType}}"])).stdout.trim();
    const security = JSON.parse(
      (await command(["info", "--format", "{{json .SecurityOptions}}"])).stdout,
    );
    setupObservation.localDockerProfile = Object.freeze({
      localUnixContext: contextHost === "unix:///var/run/docker.sock",
      linuxDaemon: daemonType === "linux",
      rootless:
        Array.isArray(security) &&
        security.some((value) => typeof value === "string" && value.includes("rootless")),
    });
    require(
      setupObservation.localDockerProfile.localUnixContext &&
        setupObservation.localDockerProfile.linuxDaemon &&
        Array.isArray(security) &&
        !setupObservation.localDockerProfile.rootless,
    );
    setupPhase("pinned_image");
    await command(["image", "inspect", config.image]);
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
    const noPublishedPorts =
      Object.keys(container.HostConfig.PortBindings ?? {}).length === 0 &&
      container.HostConfig.PublishAllPorts === false &&
      container.NetworkSettings.Ports !== null &&
      typeof container.NetworkSettings.Ports === "object" &&
      Object.values(container.NetworkSettings.Ports).every(
        (value) => value === null || (Array.isArray(value) && value.length === 0),
      );
    setupObservation.containerProfile = Object.freeze({
      nameMatched: container.Name === "/" + containerName,
      imageMatched: container.Config.Image === config.image,
      userMatched: container.Config.User === "999:999",
      packetLabelMatched: container.Config.Labels?.["morrow.packet"] === "P05.T01t",
      nonceLabelMatched: container.Config.Labels?.["morrow.fixture"] === suffix,
      readOnlyRootfs: container.HostConfig.ReadonlyRootfs === true,
      networkModeMatched: container.HostConfig.NetworkMode === networkId,
      noHostMounts: container.Mounts.length === 0,
      noPublishedPorts,
      singleNetwork: Object.keys(container.NetworkSettings.Networks).length === 1,
    });
    require(Object.values(setupObservation.containerProfile).every((value) => value === true));
    setupPhase("attached_network");
    const [attachedNetwork] = JSON.parse((await command(["network", "inspect", networkId])).stdout);
    setupObservation.attachedNetworkOnlyOwned =
      Object.keys(attachedNetwork.Containers ?? {}).join(",") === containerId;
    require(Object.keys(attachedNetwork.Containers ?? {}).join(",") === containerId);
    const networkEntries = Object.entries(container.NetworkSettings.Networks);
    const [attachedName, attached] = networkEntries[0];
    const member = attachedNetwork.Containers[containerId];
    const subnet = network.IPAM?.Config?.[0]?.Subnet;
    const endpointId = attached.EndpointID;
    const containerAddress = attached.IPAddress;
    setupObservation.endpointAttestation = Object.freeze({
      networkIdentityMatched:
        attachedNetwork.Id === networkId &&
        attachedNetwork.Name === networkName &&
        attachedNetwork.Internal === true &&
        attachedNetwork.EnableIPv6 === false &&
        attachedNetwork.Labels?.["morrow.packet"] === "P05.T01t" &&
        attachedNetwork.Labels?.["morrow.fixture"] === suffix,
      singleSubnet:
        network.IPAM?.Config?.length === 1 &&
        attachedNetwork.IPAM?.Config?.length === 1 &&
        attachedNetwork.IPAM.Config[0].Subnet === subnet &&
        attachedNetwork.IPAM.Config[0].Gateway === gateway,
      networkNameMatched: attachedName === networkName && attached.NetworkID === networkId,
      endpointIdMatched:
        typeof endpointId === "string" &&
        /^[a-f0-9]{64}$/.test(endpointId) &&
        member.EndpointID === endpointId,
      memberNameMatched: member.Name === containerName,
      ipv4Matched: controlledNeonFixtureIpv4Matches({
        address: containerAddress,
        gateway,
        subnet,
        memberAddress: member.IPv4Address,
        prefixLength: attached.IPPrefixLen,
      }),
      noIpv6Endpoint: !attached.GlobalIPv6Address && !member.IPv6Address,
    });
    require(Object.values(setupObservation.endpointAttestation).every((value) => value === true));
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
    const target = Object.freeze({ host: containerAddress, port: 5432 });
    setupPhase("same_host_reachability");
    const sameHostConnection = await new Promise((resolve) => {
      const socket = createConnection(target);
      let connected = false,
        sourceMatchedGateway = false,
        destinationMatched = false;
      socket.once("connect", () => {
        connected = true;
        sourceMatchedGateway = socket.localAddress === gateway;
        destinationMatched = socket.remoteAddress === containerAddress;
        socket.end();
      });
      socket.once("error", () => socket.destroy());
      socket.setTimeout(1000, () => socket.destroy());
      socket.once("close", () =>
        resolve(Object.freeze({ connected, sourceMatchedGateway, destinationMatched })),
      );
    });
    setupObservation.sameHostConnection = sameHostConnection;
    require(Object.values(sameHostConnection).every((value) => value === true));
    const endpoint = Object.freeze({});
    ownedEndpoints.set(endpoint, target);
    issuedEndpoint = endpoint;
    const api = Object.freeze({
      id: containerId,
      image: config.image,
      version,
      sql: setupSql,
      endpoint,
      passwordByRole,
      expectedHostSource: gateway,
      revokeEndpoint() {
        ownedEndpoints.delete(endpoint);
      },
      topology: Object.freeze({
        internalNetwork: true,
        noPublishedPorts: true,
        ownedContainerEndpointAttested: true,
        sameHostReachability: true,
        sourceMatchedGateway: true,
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
        let scramOfferedRoles = 0,
          probeConnectionsClosed = 0;
        for (const role of roles) {
          require((await authenticationProbe(target, role)) === "scram");
          scramOfferedRoles++;
          probeConnectionsClosed++;
        }
        require((await authenticationProbe(target, "postgres")) === "rejected");
        probeConnectionsClosed++;
        require((await authenticationProbe(target, "morrow_identity_owner")) === "rejected");
        probeConnectionsClosed++;
        phase = "requests";
        setupPhase("requests_callback");
        return Object.freeze({
          scramOfferedRoles,
          tcpAdministratorRejected: true,
          tcpOwnerRejected: true,
          probeConnectionsClosed,
        });
      },
      async observeFinalNamespace() {
        setupPhase("final_namespace");
        require(phase === "requests" && resolveControlledNeonPostgresqlEndpoint(endpoint) === null);
        phase = "final";
        const where =
          "datname='morrow' AND usename IN (" +
          roles.map(literal).join(",") +
          ") AND left(application_name,10)='morrow_id_'";
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
    if (issuedEndpoint) ownedEndpoints.delete(issuedEndpoint);
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
