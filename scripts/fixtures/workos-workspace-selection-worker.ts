// Synthetic workerd composition only. These SQL clients are test doubles, not
// production adapters; the separate PostgreSQL lab qualifies database policy.
import { createWorkosAuthenticationEvidence } from "../../packages/identity/src/workos-authentication-evidence";
import {
  createWorkosWorkspaceSelection,
  workspaceSelectionSql,
  type WorkspaceSelectionControl,
  type WorkspaceSelectionSqlClient,
} from "../../packages/identity/src/workos-workspace-selection";

type Row = Record<string, unknown>;
type Case = {
  name: string;
  profileJson: string;
  snapshotJson: string;
  token: string;
  page: string;
  now: number;
  evidenceExpiresAtMs: number;
  profileDigest: string;
  keySetDigest: string;
  observationDigest: string;
  args: string[];
  selector: unknown;
  rows: Row[][];
  roleRows: Row[];
  expected: "selected" | "held";
  expectedSelection: Row | null;
  expectedConnects: number;
  expectedLookups: number;
  expectedReleases: number;
  expectedRollbacks: number;
  expectedQueryPrefix: string[];
  rowMode?: "accessor" | "array_accessor" | "symbol" | "sparse" | "outer_accessor";
  handleMode?: "forged" | "foreign" | "serialized" | "proxy";
  selectorMode?: "proxy";
  fault?: { stage: string; kind: string };
  extraFault?: { stage: string; kind: string };
  shortLease?: boolean;
  advanceAfter?: boolean;
};
const sequence = ["begin", "role", "timeout", "idleTimeout", "resolve", "resolve", "commit"];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const names = (value: object) => Object.keys(value).sort().join(",");

export default {
  async fetch(request: Request) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/synthetic-workspace-selection"
    )
      return new Response(null, { status: 404 });
    const input = (await request.json()) as { cases: Case[]; isolation: Case[] };
    const checks: { name: string; passed: boolean }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    for (const c of input.cases) {
      try {
        let now = c.now,
          currentProfile = c.profileJson,
          pageReads = 0,
          connects = 0,
          lookups = 0,
          releases = 0,
          releaseCompletions = 0,
          sqlGetters = 0,
          hostileTraps = 0,
          faults = 0,
          pendingQueries = 0,
          cancelledQueries = 0,
          lateConnections = 0,
          disposed = false,
          parametersValid = true,
          controlsValid = true,
          noQueryAfterDisposal = true,
          discardedOnly = true;
        const queried: string[] = [];
        const cancel = new AbortController();
        const evidence = createWorkosAuthenticationEvidence(c.profileJson, c.snapshotJson, {
          now: () => now,
          currentProfile: () => currentProfile,
          readPage: async (selector, control) => {
            pageReads++;
            const value = JSON.parse(selector);
            check(
              c.name + "_page_selector",
              names(value) === "after,limit,order,schemaVersion,subjectId" &&
                value.schemaVersion === 1 &&
                value.subjectId === c.args[7] &&
                value.after === null &&
                value.limit === 100 &&
                value.order === "asc" &&
                Object.isFrozen(control) &&
                control.signal instanceof AbortSignal,
            );
            return c.page;
          },
        });
        const verified = await evidence.verify(c.token);
        if (verified.outcome !== "verified_active_evidence") throw Error("FIXTURE_EVIDENCE_FAILED");
        const owned = evidence.readEvidence(verified.handle);
        check(c.name + "_owned_evidence", owned !== null && pageReads === 1);
        check(
          c.name + "_independent_provenance",
          owned !== null &&
            owned.tokenProvenance === "signature_verified" &&
            owned.sessionClientBinding === "expected_only" &&
            owned.sessionLiveness === "not_guaranteed" &&
            owned.tokenProfileDigest === c.profileDigest &&
            owned.keySetDigest === c.keySetDigest &&
            owned.observationProfileDigest === c.observationDigest &&
            owned.expiresAtMs === c.evidenceExpiresAtMs,
        );
        const controlValid = (control: Readonly<WorkspaceSelectionControl>) => {
          controlsValid &&=
            Object.isFrozen(control) &&
            names(control) === "deadlineMs,signal" &&
            control.signal instanceof AbortSignal &&
            control.deadlineMs === Math.min(c.now + 5000, c.evidenceExpiresAtMs);
        };
        const fault = async (stage: string, control?: Readonly<WorkspaceSelectionControl>) => {
          await Promise.resolve(); // Exercise the continuation after each trusted await.
          for (const f of [c.fault, c.extraFault]) {
            if (!f || f.stage !== stage) continue;
            faults++;
            if (f.kind === "expiry") now = c.evidenceExpiresAtMs;
            else if (f.kind === "profile") currentProfile = "{}";
            else if (f.kind === "backward") now = c.now - 1;
            else if (f.kind === "cancel") cancel.abort();
            else if (f.kind === "throw") throw Error("SYNTHETIC_PRIVATE_SQL_DETAIL");
            else if (f.kind === "late") {
              await sleep(100);
              lateConnections++;
            } else if (f.kind === "delay") {
              await sleep(100);
            } else if (f.kind === "stall") {
              pendingQueries++;
              await new Promise<void>((_, reject) => {
                const abort = () => {
                  pendingQueries--;
                  cancelledQueries++;
                  reject(Error("SYNTHETIC_PRIVATE_CANCEL"));
                };
                if (control!.signal.aborted) abort();
                else control!.signal.addEventListener("abort", abort, { once: true });
              });
            } else throw Error("FIXTURE_FAULT_UNKNOWN");
          }
        };
        const client: WorkspaceSelectionSqlClient = {
          async query(sql, values, control) {
            noQueryAfterDisposal &&= !disposed;
            controlValid(control);
            const key = Object.entries(workspaceSelectionSql).find(([, text]) => sql === text)?.[0];
            if (!key) throw Error("FIXTURE_QUERY_UNKNOWN");
            queried.push(key);
            parametersValid &&= same(values, key === "resolve" ? c.args : []);
            const stage = key === "resolve" ? "resolve" + ++lookups : key;
            await fault(stage, control);
            if (key === "role") return { rows: c.roleRows };
            if (key === "resolve") {
              const rows = c.rows[lookups - 1] ?? [];
              const invalidGetter = () => {
                sqlGetters++;
                throw Error("PRIVATE_ROW_ACCESSOR");
              };
              if (c.rowMode === "accessor")
                Object.defineProperty(rows[0], "principal_id", {
                  enumerable: true,
                  get: invalidGetter,
                });
              if (c.rowMode === "array_accessor")
                Object.defineProperty(rows, "0", { enumerable: true, get: invalidGetter });
              if (c.rowMode === "symbol")
                Object.defineProperty(rows[0], Symbol("private"), { value: true });
              if (c.rowMode === "sparse") delete rows[0];
              if (c.rowMode === "outer_accessor")
                return Object.defineProperty({}, "rows", {
                  enumerable: true,
                  get: invalidGetter,
                }) as { rows: Row[] };
              return { rows };
            }
            return { rows: [] };
          },
          async release(discard) {
            releases++;
            discardedOnly &&= discard === true;
            disposed = true;
            await fault("release");
            releaseCompletions++;
          },
        };
        const service = createWorkosWorkspaceSelection({
          readEvidence: evidence.readEvidence,
          now: () => now,
          signal: cancel.signal,
          pool: {
            async connect(control) {
              connects++;
              controlValid(control);
              await fault("connect", control);
              return client;
            },
          },
        });
        let handle: unknown = verified.handle;
        let selector = c.selector;
        const hostile = new Proxy(
          {},
          {
            get() {
              hostileTraps++;
              throw Error("PRIVATE_GET");
            },
            getPrototypeOf() {
              hostileTraps++;
              throw Error("PRIVATE_PROTO");
            },
            ownKeys() {
              hostileTraps++;
              throw Error("PRIVATE_KEYS");
            },
            getOwnPropertyDescriptor() {
              hostileTraps++;
              throw Error("PRIVATE_DESCRIPTOR");
            },
          },
        );
        if (c.handleMode === "forged") handle = { verified: true };
        if (c.handleMode === "serialized") handle = JSON.stringify(verified.handle);
        if (c.handleMode === "proxy") handle = hostile;
        if (c.handleMode === "foreign") {
          const other = createWorkosAuthenticationEvidence(c.profileJson, c.snapshotJson, {
            now: () => now,
            currentProfile: () => currentProfile,
            readPage: async () => c.page,
          });
          const result = await other.verify(c.token);
          if (result.outcome !== "verified_active_evidence") throw Error("FIXTURE_FOREIGN_FAILED");
          handle = result.handle;
        }
        if (c.selectorMode === "proxy") selector = hostile;
        await fault("before");
        const result = await service.resolve(handle, selector);
        const completedBeforeResult = releaseCompletions;
        const retained = JSON.stringify(result);
        if (c.shortLease) await sleep(150); // Late acquisition must be destroyed, never used.
        check(c.name + "_outcome", result.outcome === c.expected);
        check(
          c.name + "_closed_result",
          Object.isFrozen(result) && names(result) === "outcome,selection",
        );
        check(
          c.name + "_exact_selection",
          result.outcome === "selected"
            ? c.expectedSelection !== null &&
                Object.isFrozen(result.selection) &&
                names(result.selection) === Object.keys(c.expectedSelection).sort().join(",") &&
                Object.entries(c.expectedSelection).every(
                  ([key, value]) => (result.selection as unknown as Row)[key] === value,
                )
            : result.selection === null && c.expectedSelection === null,
        );
        check(
          c.name + "_connection_budget",
          connects === c.expectedConnects && lookups === c.expectedLookups && pageReads === 1,
        );
        const normal = queried.filter((key) => key !== "rollback");
        check(
          c.name + "_fixed_query_order",
          same(normal, c.expectedQueryPrefix) &&
            same(normal, sequence.slice(0, normal.length)) &&
            queried.filter((key) => key === "rollback").length === c.expectedRollbacks &&
            (c.expectedRollbacks === 0 || queried.at(-1) === "rollback"),
        );
        check(c.name + "_exact_parameters", parametersValid);
        check(c.name + "_bounded_controls", controlsValid);
        check(
          c.name + "_discarded_cleanup",
          releases === c.expectedReleases &&
            discardedOnly &&
            pendingQueries === 0 &&
            noQueryAfterDisposal &&
            (result.outcome !== "selected" || completedBeforeResult === 1) &&
            (c.expectedReleases === 0 || disposed),
        );
        check(
          c.name + "_fault_exercised",
          faults === Number(Boolean(c.fault)) + Number(Boolean(c.extraFault)),
        );
        check(c.name + "_hostile_objects_unobserved", hostileTraps === 0 && sqlGetters === 0);
        check(
          c.name + "_late_results_closed",
          JSON.stringify(result) === retained &&
            (c.fault?.kind !== "late" ||
              (lateConnections === 1 && releases === 1 && queried.length === 0)) &&
            (c.fault?.kind !== "stall" || cancelledQueries === 1),
        );
        if (c.advanceAfter) {
          now = c.evidenceExpiresAtMs;
          check(
            c.name + "_snapshot_is_historical",
            JSON.stringify(result) === retained && evidence.readEvidence(verified.handle) === null,
          );
        }
      } catch {
        // No expected-denial catch: every normal negative must return held and
        // execute all mandatory assertions. Unexpected exceptions always fail.
        check(c.name + "_unexpected_exception", false);
      }
    }

    // One owning handle, one service, simultaneous selections. No shared mutable
    // active-organization field may redirect either result or SQL parameter.
    try {
      const [a, b] = input.isolation;
      let pages = 0,
        connections = 0,
        releases = 0;
      let params = true;
      const owner = createWorkosAuthenticationEvidence(a.profileJson, a.snapshotJson, {
        now: () => a.now,
        currentProfile: () => a.profileJson,
        readPage: async () => {
          pages++;
          return a.page;
        },
      });
      const verified = await owner.verify(a.token);
      if (verified.outcome !== "verified_active_evidence")
        throw Error("FIXTURE_ISOLATION_EVIDENCE");
      const service = createWorkosWorkspaceSelection({
        readEvidence: owner.readEvidence,
        now: () => a.now,
        pool: {
          async connect() {
            connections++;
            return {
              async query(sql, values) {
                await Promise.resolve();
                if (sql === workspaceSelectionSql.role) return { rows: a.roleRows };
                if (sql === workspaceSelectionSql.resolve) {
                  const c = values[8] === a.args[8] ? a : values[8] === b.args[8] ? b : null;
                  params &&= c !== null && same(values, c.args);
                  return { rows: c?.rows[0] ?? [] };
                }
                return { rows: [] };
              },
              async release(discard) {
                params &&= discard === true;
                releases++;
              },
            };
          },
        },
      });
      const results = await Promise.all([
        service.resolve(verified.handle, a.selector),
        service.resolve(verified.handle, b.selector),
      ]);
      check(
        "two_organizations_same_owned_evidence",
        pages === 1 && connections === 2 && releases === 2 && params,
      );
      check(
        "two_organizations_exact_independent_results",
        results.every(
          (r, i) =>
            r.outcome === "selected" &&
            Object.entries(input.isolation[i].expectedSelection!).every(
              ([key, value]) => (r.selection as unknown as Row)[key] === value,
            ),
        ) && results[0].selection?.organizationId !== results[1].selection?.organizationId,
      );
    } catch {
      check("two_organizations_unexpected_exception", false);
    }
    return Response.json({ checks });
  },
};
