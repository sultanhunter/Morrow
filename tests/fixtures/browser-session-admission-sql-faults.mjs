import { localBrowserSessionPool } from "../../scripts/local-browser-session-sql.mjs";
import { createWorkosBrowserSessionAdmission } from "../../packages/identity/src/workos-browser-session-admission.ts";

const failed = () => Error("BROWSER_SESSION_SQL_FAULT_QUALIFICATION_FAILED");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failed()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}
const backendWhere =
  "datname='morrow' AND usename='morrow_identity_sessions' AND application_name LIKE 'morrow_browser_session_%'";
const held = (result) => result.outcome === "held" && result.credential === null;
const ordinaryCleanup = (m) =>
  m.connections === 1 &&
  m.released === 1 &&
  m.closed === 1 &&
  m.discarded === 1 &&
  m.backendCleanupVerified === 1 &&
  m.unverifiedHostClosures === 0;

// These are actual isolated-PostgreSQL adapter faults. All evidence still comes
// from the independent RSA fixture and its owning, unchanged76 composition.
// Intentionally unverified host loss is kept outside normal cleanup metrics.
export async function exerciseBrowserSessionSqlFaults(ctx) {
  const { id, fixture, evidenceFor, check, count } = ctx;
  const faultMetrics = [];
  const observer = ctx.sqlConnection();
  const backendAbsent = async () =>
    (await observer.query("SELECT count(*) FROM pg_stat_activity WHERE " + backendWhere + ";")) ===
    "0";
  try {
    await observer.query("SELECT 1;");

    // An actual connected client is withheld until the original attempt has
    // expired. Only the application's late disposer may start its release.
    {
      const f = fixture();
      const pool = localBrowserSessionPool(id);
      let deliver,
        announce,
        queries = 0,
        pending;
      const delivery = new Promise((resolve) => {
        deliver = resolve;
      });
      const connected = new Promise((resolve) => {
        announce = resolve;
      });
      try {
        const e = await evidenceFor(f);
        const delayed = {
          async connect(control) {
            const client = await pool.connect(control);
            announce();
            await delivery;
            return {
              query(...args) {
                queries++;
                return client.query(...args);
              },
              release(discard) {
                return client.release(discard);
              },
            };
          },
        };
        const service = createWorkosBrowserSessionAdmission({
          pool: delayed,
          readEvidence: e.owner.readEvidence,
          now: Date.now,
        });
        pending = service.admit(e.handle, JSON.stringify(f.selector));
        await bounded(
          Promise.race([
            connected,
            pending.then(() => {
              throw failed();
            }),
          ]),
          4500,
        );
        check(
          "late_connection_actual_client_held_before_delivery",
          pool.metrics.connections === 1 && pool.metrics.released === 0 && queries === 0,
        );
        const result = await bounded(pending, 6000);
        check(
          "late_connection_deadline_returns_no_credential_or_sql",
          held(result) &&
            queries === 0 &&
            count("browser_session_commands", `command_id='${f.selector.commandId}'`) === 0,
        );
        deliver();
        check(
          "late_connection_application_disposer_starts_once",
          await until(() => pool.metrics.released === 1, 2000),
        );
        await bounded(pool.close());
        check("late_connection_physical_cleanup_verified", ordinaryCleanup(pool.metrics));
        check("late_connection_fresh_backend_absence", await backendAbsent());
        faultMetrics.push({
          case: "late_connection",
          metrics: { ...pool.metrics },
          applicationQueries: queries,
          backendAbsenceObserved: true,
          adapterCleanupVerified: true,
          requiresContainerFence: false,
        });
      } finally {
        deliver();
        if (pending) await bounded(pending).catch(() => {});
        await bounded(pool.close()).catch(() => {});
      }
    }

    // Warm the observer before creating the short-lived owning evidence. Abort
    // only after PostgreSQL proves the one newly attributable startup is asleep.
    {
      const f = fixture();
      const baseline = new Set(
        (await observer.query("SELECT pid FROM pg_stat_activity WHERE " + backendWhere + ";"))
          .split("\n")
          .filter(Boolean),
      );
      const cancellation = new AbortController();
      const pool = localBrowserSessionPool(id, { stallStartup: true });
      let pending;
      try {
        const e = await evidenceFor(f);
        const service = createWorkosBrowserSessionAdmission({
          pool,
          readEvidence: e.owner.readEvidence,
          now: Date.now,
          signal: cancellation.signal,
        });
        pending = service.admit(e.handle, JSON.stringify(f.selector));
        let exactPid = null;
        const witnessed = await until(async () => {
          const rows = (
            await observer.query(
              "SELECT pid FROM pg_stat_activity WHERE " +
                backendWhere +
                " AND state='active' AND wait_event='PgSleep';",
            )
          )
            .split("\n")
            .filter((pid) => pid && !baseline.has(pid));
          if (rows.length !== 1 || !/^[1-9][0-9]*$/.test(rows[0])) return false;
          exactPid = rows[0];
          return true;
        }, 1500);
        check("stalled_startup_actual_owned_sleep_observed", witnessed && exactPid !== null);
        cancellation.abort();
        const result = await bounded(pending);
        check(
          "stalled_startup_actual_abort_no_admission",
          held(result) &&
            pool.metrics.cancelled >= 1 &&
            count("browser_session_commands", `command_id='${f.selector.commandId}'`) === 0,
        );
        await bounded(pool.close());
        check("stalled_startup_physical_cleanup_verified", ordinaryCleanup(pool.metrics));
        check("stalled_startup_fresh_backend_absence", await backendAbsent());
        faultMetrics.push({
          case: "cancelled_stalled_startup",
          metrics: { ...pool.metrics },
          backendAbsenceObserved: true,
          adapterCleanupVerified: true,
          requiresContainerFence: false,
        });
      } finally {
        cancellation.abort();
        if (pending) await bounded(pending).catch(() => {});
        await bounded(pool.close()).catch(() => {});
      }
    }

    // An actual SIGKILL of the attributable host exec must never be promoted to
    // verified guest cleanup, even when a separate database read finds absence.
    {
      const f = fixture();
      const pool = localBrowserSessionPool(id, { killHostAfterStartup: true });
      try {
        const e = await evidenceFor(f);
        const service = createWorkosBrowserSessionAdmission({
          pool,
          readEvidence: e.owner.readEvidence,
          now: Date.now,
        });
        const result = await bounded(service.admit(e.handle, JSON.stringify(f.selector)));
        let closeRejected = false;
        try {
          await bounded(pool.close());
        } catch {
          closeRejected = true;
        }
        const m = pool.metrics;
        check(
          "host_signal_actual_fault_held_no_admission",
          held(result) &&
            count("browser_session_commands", `command_id='${f.selector.commandId}'`) === 0,
        );
        check(
          "host_signal_cleanup_remains_explicitly_unverified",
          closeRejected &&
            m.connections === 1 &&
            m.closed === 1 &&
            m.released === 1 &&
            m.backendCleanupVerified === 0 &&
            m.unverifiedHostClosures === 1,
        );
        check("host_signal_separate_fresh_backend_absence", await backendAbsent());
        faultMetrics.push({
          case: "host_signal",
          metrics: { ...m },
          backendAbsenceObserved: true,
          adapterCleanupVerified: false,
          requiresContainerFence: true,
        });
      } finally {
        await bounded(pool.close()).catch(() => {});
      }
    }
    return { faultMetrics };
  } finally {
    await observer.close();
  }
}
