import { Client } from "@neondatabase/serverless";
import {
  createWorkersControlledNeonLoginPools,
  snapshotControlledNeonLoginPoolMetrics,
} from "../../packages/identity/src/controlled-neon-login-pool.js";
import {
  controlledNeonLoginProfiles,
  controlledNeonMetadataSql,
  controlledNeonTuple,
} from "../../packages/identity/src/controlled-neon-login-profiles.js";
import { createWorkersFixedWorkosLoginPort } from "../../packages/identity/src/fixed-workos-login-port.js";
import { createWorkosBrowserSessionAdmission } from "../../packages/identity/src/workos-browser-session-admission.js";
import { createLoginFlowCustody } from "../../packages/identity/src/login-flow-custody.js";
import { createStandaloneLoginBridge } from "../../packages/identity/src/standalone-login.js";

type Setup = {
  bindingJson: string;
  expectedHostSource: string;
  passwordByRole: Record<string, string>;
  cases: { configurationJson: string; workspaceId: string }[];
};
type Control = { deadlineMs: number; signal: AbortSignal };
type PoolName = keyof typeof controlledNeonLoginProfiles;
let current: Awaited<ReturnType<typeof initialized>> | undefined;
const held = () => Error("CONTROLLED_NEON_REAL_PG_WORKER_HELD");
function expect(value: unknown) {
  if (!value) throw held();
}
async function initialized(
  setup: Setup,
  index: number,
  wrongPassword = false,
  rejectSessionRelease = false,
) {
  const binding = JSON.parse(setup.bindingJson),
    configuration = setup.cases[index];
  expect(configuration);
  const leases = { borrows: 0, releaseAttempts: 0, releaseCompletions: 0, activeLeases: 0 };
  const pools = await createWorkersControlledNeonLoginPools({
    bindingJson: setup.bindingJson,
    now: Date.now,
    credentialBroker: {
      async borrow(namespaceJson: string, control: Readonly<Control>) {
        const n = JSON.parse(namespaceJson);
        expect(Object.values(controlledNeonLoginProfiles).some((p) => p.role === n.role));
        expect(
          namespaceJson ===
            JSON.stringify({
              schemaVersion: 1,
              providerId: "neon",
              environment: binding.environment,
              projectId: binding.projectId,
              branchId: binding.branchId,
              hostname: binding.hostname,
              database: binding.database,
              role: n.role,
              purpose: "primary_and_one_same_role_observer",
            }),
        );
        expect(
          control.signal instanceof AbortSignal &&
            !control.signal.aborted &&
            Date.now() < control.deadlineMs,
        );
        const revocation = new AbortController();
        let released = false;
        leases.borrows++;
        leases.activeLeases++;
        return {
          namespaceJson,
          password: wrongPassword ? "not_the_fixture_password" : setup.passwordByRole[n.role],
          expiresAtMs: Date.now() + 60000,
          revocationSignal: revocation.signal,
          async release(c: Readonly<Control>) {
            leases.releaseAttempts++;
            if (rejectSessionRelease && n.role === "morrow_identity_sessions") throw held();
            expect(!released && !c.signal.aborted && Date.now() < c.deadlineMs);
            released = true;
            leases.releaseCompletions++;
            leases.activeLeases--;
          },
        };
      },
    },
  });
  const wc = JSON.parse(configuration.configurationJson),
    profile = JSON.parse(wc.verificationProfileJson);
  const workos = { borrows: 0, releaseAttempts: 0, releaseCompletions: 0, activeLeases: 0 };
  const workosNamespace = JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    purpose: "list_active_sessions",
  });
  const providerPort = await createWorkersFixedWorkosLoginPort({
    configurationJson: configuration.configurationJson,
    now: Date.now,
    sessionCredentialBroker: {
      async borrow(selector: string, control: Readonly<Control>) {
        expect(
          selector === workosNamespace &&
            !control.signal.aborted &&
            Date.now() < control.deadlineMs,
        );
        workos.borrows++;
        workos.activeLeases++;
        const r = new AbortController();
        let released = false;
        return {
          namespaceJson: selector,
          credential: "platform_management_marker_87_only",
          expiresAtMs: Date.now() + 60000,
          revocationSignal: r.signal,
          async release(c: Readonly<Control>) {
            workos.releaseAttempts++;
            expect(!released && !c.signal.aborted && Date.now() < c.deadlineMs);
            released = true;
            workos.releaseCompletions++;
            workos.activeLeases--;
          },
        };
      },
    },
  });
  const auth = await createStandaloneLoginBridge({
    configurationJson: configuration.configurationJson,
    ...pools,
    providerPort,
    now: Date.now,
  });
  return {
    setup,
    index,
    pools,
    auth,
    leases,
    workos,
    metrics: () => snapshotControlledNeonLoginPoolMetrics(pools),
  };
}
function rawClient(setup: Setup, name: PoolName, applicationName: string) {
  const binding = JSON.parse(setup.bindingJson),
    profile = controlledNeonLoginProfiles[name];
  const client = new Client({
    host: binding.hostname,
    port: 5432,
    database: binding.database,
    user: profile.role,
    password: setup.passwordByRole[profile.role],
    ssl: false,
    application_name: applicationName,
    connectionTimeoutMillis: 1000,
    query_timeout: 1000,
    statement_timeout: profile.statementTimeout,
    idle_in_transaction_session_timeout: profile.idleTimeout,
  });
  client.on("error", () => {});
  client.neonConfig.useSecureWebSocket = true;
  client.neonConfig.forceDisablePgSSL = true;
  client.neonConfig.pipelineConnect = false;
  client.neonConfig.coalesceWrites = false;
  client.neonConfig.wsProxy = binding.hostname + "/v2";
  client.neonConfig.webSocketConstructor = WebSocket;
  return client;
}
export default {
  async fetch(request: Request, env: { SETUP_JSON: string }): Promise<Response> {
    try {
      const url = new URL(request.url),
        setup = JSON.parse(env.SETUP_JSON) as Setup;
      if (url.pathname === "/__fixture/initialize" && request.method === "POST") {
        const input = (await request.json()) as { index: number; mode?: string };
        expect(
          Number.isInteger(input.index) &&
            input.index >= 0 &&
            input.index < setup.cases.length &&
            [undefined, "normal", "session_release_reject"].includes(input.mode),
        );
        current = await initialized(
          setup,
          input.index,
          false,
          input.mode === "session_release_reject",
        );
        return Response.json({ initialized: true });
      }
      if (url.pathname.startsWith("/__fixture/source-address/")) {
        const name = url.pathname.slice("/__fixture/source-address/".length) as PoolName;
        expect(Object.hasOwn(controlledNeonLoginProfiles, name));
        const client = rawClient(
          setup,
          name,
          "morrow_t88_" + crypto.randomUUID().replaceAll("-", "") + "_p",
        );
        let serverSourceMatchedGateway = false;
        try {
          await client.connect();
          const result = await client.query(
            "SELECT pg_catalog.host(pg_catalog.inet_client_addr()) AS client_address, current_user::text AS role, session_user::text AS login",
          );
          expect(result.rows.length === 1);
          const row = result.rows[0];
          serverSourceMatchedGateway =
            typeof setup.expectedHostSource === "string" &&
            row.client_address === setup.expectedHostSource;
          expect(
            serverSourceMatchedGateway &&
              row.role === controlledNeonLoginProfiles[name].role &&
              row.login === controlledNeonLoginProfiles[name].role,
          );
        } finally {
          await client.end();
        }
        return Response.json({
          serverSourceMatchedGateway,
          role: controlledNeonLoginProfiles[name].role,
          clientEndAcknowledged: true,
        });
      }
      if (url.pathname === "/__fixture/metrics") {
        expect(current);
        return Response.json({
          pool: current!.metrics(),
          leases: current!.leases,
          workos: current!.workos,
        });
      }
      if (url.pathname.startsWith("/__fixture/probe/")) {
        const name = url.pathname.slice("/__fixture/probe/".length) as PoolName;
        expect(Object.hasOwn(controlledNeonLoginProfiles, name));
        const state = await initialized(setup, 0),
          control = { deadlineMs: Date.now() + 5000, signal: new AbortController().signal };
        const client = await state.pools[name].connect(control);
        const row = await client.query(
          controlledNeonLoginProfiles[name].statements.role.text,
          [],
          control,
        );
        expect(
          row.rows.length === 1 &&
            row.rows[0]!.role === controlledNeonLoginProfiles[name].role &&
            row.rows[0]!.login === controlledNeonLoginProfiles[name].role,
        );
        await client.release(true);
        expect(
          state.leases.activeLeases === 0 &&
            state.leases.borrows === state.leases.releaseCompletions,
        );
        return Response.json({
          role: controlledNeonLoginProfiles[name].role,
          normalRelease: true,
          leases: state.leases,
          pool: state.metrics(),
        });
      }
      if (url.pathname === "/__fixture/wrong-password") {
        const state = await initialized(setup, 0, true);
        let denied = false;
        try {
          await state.pools.loginPool.connect({
            deadlineMs: Date.now() + 3000,
            signal: new AbortController().signal,
          });
        } catch {
          denied = true;
        }
        expect(denied);
        return Response.json({ denied, leases: state.leases, pool: state.metrics() });
      }
      if (url.pathname === "/__fixture/reconcile" && request.method === "POST") {
        expect(current);
        const state = await initialized(setup, current!.index),
          input = (await request.json()) as { commandId: string; requestDigest: string };
        const service = createWorkosBrowserSessionAdmission({
          pool: state.pools.sessionPool,
          now: Date.now,
          readEvidence: () => {
            throw held();
          },
        });
        const result = await service.reconcile(
          JSON.stringify({
            schemaVersion: 1,
            commandId: input.commandId,
            requestDigest: input.requestDigest,
          }),
        );
        return Response.json({
          outcome: result.outcome,
          attributed: result.attribution !== null,
          secretReturned: Object.hasOwn(result.attribution ?? {}, "secret"),
          leases: state.leases,
          pool: state.metrics(),
        });
      }
      if (url.pathname === "/__fixture/flow-reconcile" && request.method === "POST") {
        expect(current);
        const state = await initialized(setup, current!.index),
          input = (await request.json()) as Record<string, unknown>;
        const result = await createLoginFlowCustody({
          pool: state.pools.loginPool,
          now: Date.now,
        }).reconcile(JSON.stringify(input), {
          deadlineMs: Date.now() + 5000,
          signal: new AbortController().signal,
        });
        return Response.json({
          outcome: result.outcome,
          phase: result.phase,
          issuerOutcome: result.issuer_outcome,
          hasFamily: result.family_id !== null,
          leases: state.leases,
          pool: state.metrics(),
        });
      }
      if (url.pathname.startsWith("/__fixture/authority/")) {
        const name = url.pathname.slice("/__fixture/authority/".length) as PoolName;
        expect(Object.hasOwn(controlledNeonLoginProfiles, name));
        const client = rawClient(
          setup,
          name,
          "morrow_t88_" + crypto.randomUUID().replaceAll("-", "") + "_p",
        );
        const denied = { table: false, maintenance: false, ownerRole: false };
        try {
          await client.connect();
          for (const [key, text] of Object.entries({
            table: "SELECT count(*) FROM morrow_identity.login_flows",
            maintenance: "SELECT * FROM morrow_identity.maintain_login_flows(NULL::text)",
            ownerRole: "SET ROLE morrow_identity_owner",
          })) {
            try {
              await client.query(text);
            } catch (error) {
              denied[key as keyof typeof denied] = (error as { code?: string }).code === "42501";
            }
          }
          expect(Object.values(denied).every(Boolean));
        } finally {
          await client.end();
        }
        return Response.json({
          role: controlledNeonLoginProfiles[name].role,
          denied,
          scope: "fixture_only_actual_PostgreSQL_privilege_denials",
        });
      }
      if (url.pathname.startsWith("/__fixture/visibility/")) {
        const name = url.pathname.slice("/__fixture/visibility/".length) as PoolName;
        expect(Object.hasOwn(controlledNeonLoginProfiles, name));
        const binding = JSON.parse(setup.bindingJson),
          role = controlledNeonLoginProfiles[name].role;
        const prefix = "morrow_t88_" + crypto.randomUUID().replaceAll("-", "");
        const primaryName = prefix + "_p",
          observerName = prefix + "_o";
        const primary = rawClient(setup, name, primaryName),
          observer = rawClient(setup, name, observerName);
        let livePrimaryVisible = false,
          selfRowValid = false,
          truncatedRejected = false;
        try {
          await primary.connect();
          const first = await primary.query(controlledNeonMetadataSql.primary);
          const tuple = controlledNeonTuple(first.rows, {
            role,
            database: binding.database,
            applicationName: primaryName,
          });
          await observer.connect();
          const read = await observer.query(controlledNeonMetadataSql.observer, [
            tuple.pid,
            tuple.start,
            tuple.database,
            tuple.role,
            tuple.applicationName,
          ]);
          expect(read.rows.length === 1);
          const { primary_present, ...self } = read.rows[0]!;
          controlledNeonTuple([self], {
            role,
            database: binding.database,
            applicationName: observerName,
          });
          selfRowValid = true;
          livePrimaryVisible = primary_present === true;
          const changed = { ...first.rows[0], backend_start: tuple.start.slice(0, 23) + "Z" };
          try {
            controlledNeonTuple([changed], {
              role,
              database: binding.database,
              applicationName: primaryName,
            });
          } catch {
            truncatedRejected = true;
          }
          expect(livePrimaryVisible && selfRowValid && truncatedRejected);
        } finally {
          await Promise.all([primary.end(), observer.end()]);
        }
        return Response.json({
          role,
          livePrimaryVisible,
          selfRowValid,
          truncatedRejected,
          scope: "fixture_only_actual_SDK_and_same_role_visibility_control",
        });
      }
      expect(current);
      return current!.auth.fetch(request);
    } catch {
      return new Response("held", { status: 503 });
    }
  },
};
