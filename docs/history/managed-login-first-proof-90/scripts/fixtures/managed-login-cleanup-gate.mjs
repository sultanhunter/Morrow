// Independent, bounded raw-Node observer. This callback never returns a lifetime Promise.
const host = "morrow-cleanup-gate.test";
const body = { gate: "u01-opened-gate", accepted: "u01-admitted", complete: "u01-marker-ack" };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
export function createManagedLoginCleanupGate({ nonce, now = () => performance.now() }) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw Error("U01_GATE_NONCE_INVALID");
  const canceled = deferred(),
    marker = deferred();
  const handles = [],
    events = [];
  const counts = { gate: 0, accepted: 0, complete: 0, unexpected: 0 };
  let gateHandle,
    admissionHandle,
    forced = false,
    opened = false,
    ownerComplete = false;
  let naturalPrematureClose = false,
    markerRead = false,
    ambiguousErrors = 0;
  let ignoredIncomingCloses = 0,
    listeners = 0,
    interceptedRequests = 0,
    overflowResponses = 0;
  const event = (name) => {
    if (events.length < 64) events.push({ sequence: events.length + 1, name, at: now() });
  };
  function own(req, res, route) {
    const closed = deferred();
    const entry = {
      req,
      res,
      route,
      closed,
      closeObserved: false,
      finishObserved: false,
      removes: [],
    };
    handles.push(entry);
    const on = (target, name, fn) => {
      target.on(name, fn);
      listeners++;
      entry.removes.push(() => {
        target.removeListener(name, fn);
        listeners--;
      });
    };
    on(req, "close", () => {
      ignoredIncomingCloses++;
      event(route + ":incoming_close_ignored");
    });
    on(req, "error", () => {
      ambiguousErrors++;
      event(route + ":incoming_error_ambiguous");
    });
    on(res, "finish", () => {
      entry.finishObserved = true;
      event(route + ":response_finish");
    });
    on(res, "error", () => {
      ambiguousErrors++;
      event(route + ":response_error_ambiguous");
    });
    on(res, "close", () => {
      if (entry.closeObserved) return;
      entry.closeObserved = true;
      event(route + ":response_close");
      if (route === "gate" && !opened && !forced && !res.writableFinished) {
        naturalPrematureClose = true;
        event("gate:natural_premature_unfinished_close");
        canceled.resolve();
      }
      closed.resolve();
    });
    entry.on = on;
    return entry;
  }
  function send(entry, status, text) {
    if (entry.closeObserved || entry.res.destroyed) return;
    entry.res.writeHead(status, {
      "content-type": "text/plain",
      "content-length": Buffer.byteLength(text),
    });
    entry.res.end(text);
  }
  function admit() {
    if (gateHandle && admissionHandle) {
      event("accepted:acknowledgement_sent");
      send(admissionHandle, 200, body.accepted);
    }
  }
  function node(req, res) {
    interceptedRequests++;
    let route;
    for (const name of ["gate", "accepted", "complete"])
      if (req.url === `/${nonce}/${name}` && req.headers.host === host) route = name;
    if (
      forced ||
      !route ||
      counts[route] !== 0 ||
      req.method !== (route === "complete" ? "POST" : "GET") ||
      handles.length >= 6
    ) {
      counts.unexpected++;
      event("unexpected_request_denied");
      if (handles.length < 6) send(own(req, res, "unexpected"), 403, "refused");
      else {
        overflowResponses++;
        res.writeHead(403);
        res.end("refused");
      }
      return;
    }
    counts[route]++;
    const entry = own(req, res, route);
    event(route + ":admitted");
    if (route === "gate") {
      gateHandle = entry;
      admit();
    } else if (route === "accepted") {
      admissionHandle = entry;
      admit();
    } else {
      let bytes = 0,
        text = "",
        invalid = false;
      entry.on(req, "data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 32) invalid = true;
        else text += Buffer.from(chunk).toString("utf8");
      });
      entry.on(req, "end", () => {
        if (invalid || text !== "u01-gate-read" || !opened || !ownerComplete) {
          counts.unexpected++;
          send(entry, 403, "refused");
          return;
        }
        markerRead = true;
        event("complete:gate_read_marker_validated");
        send(entry, 200, body.complete);
        marker.resolve();
      });
    }
    // Explicitly return undefined, never an admission/gate/marker Promise.
  }
  return Object.freeze({
    node,
    cancellation: canceled.promise,
    completionMarker: marker.promise,
    ownerBodyCompleted() {
      ownerComplete = true;
      event("owner:finite_body_completed");
    },
    open() {
      if (!ownerComplete || !gateHandle || opened || forced || gateHandle.closeObserved)
        throw Error("U01_GATE_OPEN_REFUSED");
      opened = true;
      event("gate:host_opened_after_owner_body");
      send(gateHandle, 200, body.gate);
    },
    beginForcedCleanup() {
      forced = true;
      event("fixture:forced_cleanup_started");
    },
    destroyOpenResponses() {
      if (!forced) throw Error("U01_CLEANUP_PHASE_REQUIRED");
      for (const h of handles) if (!h.closeObserved) h.res.destroy();
    },
    responsesClosed() {
      return Promise.all(handles.map((h) => h.closed.promise));
    },
    detachListeners() {
      if (!forced) throw Error("U01_CLEANUP_PHASE_REQUIRED");
      for (const h of handles) for (const remove of h.removes.splice(0)) remove();
    },
    snapshot() {
      return {
        requests: { ...counts },
        interceptedRequests,
        unobservedOverflowResponseClosures: overflowResponses,
        gateOpened: opened,
        ownerBodyComplete: ownerComplete,
        naturalPrematureUnfinishedResponseClose: naturalPrematureClose,
        gateReadMarker: markerRead,
        ambiguousErrors,
        ignoredIncomingCloses,
        forcedCleanupStarted: forced,
        activeResponses: handles.filter((h) => !h.closeObserved).length,
        responseHandles: handles.length,
        responseCloseAcknowledgements: handles.filter((h) => h.closeObserved).length,
        responseFinishAcknowledgements: handles.filter((h) => h.finishObserved).length,
        closedByRoute: Object.fromEntries(
          ["gate", "accepted", "complete"].map((route) => [
            route,
            handles.filter((h) => h.route === route && h.closeObserved).length,
          ]),
        ),
        finishedByRoute: Object.fromEntries(
          ["gate", "accepted", "complete"].map((route) => [
            route,
            handles.filter((h) => h.route === route && h.finishObserved).length,
          ]),
        ),
        activeListeners: listeners,
        events: events.map((e) => ({ ...e })),
      };
    },
  });
}
