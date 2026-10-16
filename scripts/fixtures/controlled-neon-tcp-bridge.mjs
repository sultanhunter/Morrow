import { createConnection } from "node:net";
import { Response, WebSocketPair } from "miniflare";
import { resolveControlledNeonPostgresqlEndpoint } from "./controlled-neon-postgresql.mjs";

const held = () => Error("CONTROLLED_NEON_TCP_BRIDGE_HELD");
const require = (value) => {
  if (!value) throw held();
};
function createTcpBridge({
  endpoint,
  socket,
  onClientBytes = () => {},
  onServerBytes = () => {},
  maximumBytes = 2097152,
  maximumQueuedBytes = 262144,
  lifetimeMs = 30000,
}) {
  require(
    socket &&
      ["addEventListener", "removeEventListener", "send", "close"].every(
        (name) => typeof socket[name] === "function",
      ) &&
      typeof onClientBytes === "function" &&
      typeof onServerBytes === "function",
  );
  require(
    Number.isInteger(maximumBytes) &&
      maximumBytes > 0 &&
      maximumBytes <= 2097152 &&
      Number.isInteger(maximumQueuedBytes) &&
      maximumQueuedBytes > 0 &&
      maximumQueuedBytes <= 262144 &&
      Number.isInteger(lifetimeMs) &&
      lifetimeMs > 0 &&
      lifetimeMs <= 30000,
  );
  const metrics = {
    tcpConnected: false,
    tcpClosed: false,
    webSocketClosed: false,
    fromWorkerBytes: 0,
    toWorkerBytes: 0,
    pendingBytes: 0,
    peakPendingBytes: 0,
    transportHeld: false,
    closeRequested: false,
    timerActive: true,
  };
  let ended = false,
    resolveClosed,
    tcp,
    timer;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const finish = () => {
    if (metrics.tcpClosed && metrics.webSocketClosed) {
      clearTimeout(timer);
      metrics.timerActive = false;
      resolveClosed();
    }
  };
  const close = (failed = false) => {
    metrics.transportHeld ||= failed;
    if (ended) return closed;
    ended = true;
    metrics.closeRequested = true;
    tcp?.destroy();
    try {
      socket.close(failed ? 1011 : 1000, failed ? "held" : "closed");
    } catch {
      metrics.transportHeld = true;
    }
    return closed;
  };
  const onMessage = (event) => {
    if (ended) return;
    let bytes;
    try {
      const value = event.data;
      if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (ArrayBuffer.isView(value))
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      else throw held();
      require(bytes.byteLength > 0 && bytes.byteLength <= 131072);
      metrics.fromWorkerBytes += bytes.byteLength;
      require(
        metrics.fromWorkerBytes <= maximumBytes &&
          metrics.pendingBytes + bytes.byteLength <= maximumQueuedBytes,
      );
      metrics.pendingBytes += bytes.byteLength;
      metrics.peakPendingBytes = Math.max(metrics.peakPendingBytes, metrics.pendingBytes);
      const copied = Uint8Array.from(bytes);
      onClientBytes(Uint8Array.from(copied));
      require(tcp !== undefined);
      tcp.write(copied, (error) => {
        metrics.pendingBytes -= copied.byteLength;
        if (error) close(true);
      });
    } catch {
      close(true);
    }
  };
  const onClose = () => {
    metrics.webSocketClosed = true;
    if (!ended) close();
    finish();
  };
  const onError = () => {
    close(true);
  };
  try {
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    require(!ended);
  } catch {
    for (const [kind, listener] of [
      ["message", onMessage],
      ["close", onClose],
      ["error", onError],
    ]) {
      try {
        socket.removeEventListener(kind, listener);
      } catch {
        /* No TCP exists at this stage. */
      }
    }
    throw held();
  }
  tcp = createConnection({ host: endpoint.host, port: endpoint.port });
  timer = setTimeout(() => {
    metrics.timerActive = false;
    close(true);
  }, lifetimeMs);
  tcp.once("connect", () => {
    metrics.tcpConnected = true;
    if (ended) tcp.destroy();
  });
  tcp.on("data", (chunk) => {
    if (ended) return;
    metrics.toWorkerBytes += chunk.byteLength;
    if (metrics.toWorkerBytes > maximumBytes) {
      close(true);
      return;
    }
    try {
      onServerBytes(Uint8Array.from(chunk));
      socket.send(Uint8Array.from(chunk));
    } catch {
      close(true);
    }
  });
  tcp.once("end", () => {
    close();
  });
  tcp.once("error", () => {
    close(true);
  });
  tcp.once("close", () => {
    metrics.tcpClosed = true;
    if (!ended) close();
    finish();
  });
  return Object.freeze({
    metrics,
    closed,
    close,
    detach() {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    },
  });
}
function syntheticLoopbackEndpoint(endpoint) {
  return endpoint?.host === "127.0.0.1" &&
    Number.isInteger(endpoint.port) &&
    endpoint.port > 0 &&
    endpoint.port <= 65535
    ? Object.freeze({ host: "127.0.0.1", port: endpoint.port })
    : null;
}
export function createControlledNeonTcpBridge(options) {
  const target = resolveControlledNeonPostgresqlEndpoint(options.endpoint);
  require(target !== null);
  return createTcpBridge({ ...options, endpoint: target });
}
// Explicit CPU fixture seam; it cannot issue an owned-container capability.
export function createSyntheticLoopbackControlledNeonTcpBridge(options) {
  const target = syntheticLoopbackEndpoint(options.endpoint);
  require(target !== null);
  return createTcpBridge({ ...options, endpoint: target });
}
export function createControlledNeonTcpService(options) {
  return createTcpService(options, resolveControlledNeonPostgresqlEndpoint);
}
export function createSyntheticLoopbackControlledNeonTcpService(options) {
  return createTcpService(options, syntheticLoopbackEndpoint);
}
function createTcpService({ endpoint, hostname, onClientBytes, onServerBytes }, resolveEndpoint) {
  require(/^ep-[a-z0-9-]+(?:\.c-[0-9]+)?\.[a-z0-9-]+\.aws\.neon\.tech$/.test(hostname));
  const bridges = [],
    observations = [];
  let interceptedRequests = 0,
    deniedRequests = 0,
    pairAllocations = 0;
  return Object.freeze({
    bridges,
    observations,
    counts: () =>
      Object.freeze({
        interceptedRequests,
        deniedRequests,
        pairAllocations,
        actualInternetRequests: 0,
        actualProviderRequests: 0,
      }),
    outbound(request) {
      const url = new URL(request.url);
      const allowed =
        url.protocol === "https:" &&
        url.hostname === hostname &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.pathname === "/v2" &&
        [...url.searchParams.keys()].join(",") === "address" &&
        url.searchParams.get("address") === hostname + ":5432" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        request.method === "GET";
      const target = resolveEndpoint(endpoint);
      if (!allowed || !target || bridges.length >= 256) {
        deniedRequests++;
        return new Response("held", { status: 403 });
      }
      interceptedRequests++;
      const index = bridges.length;
      const pair = new WebSocketPair();
      pairAllocations++;
      pair[1].accept();
      const observation = {
        index,
        startup: null,
        messages: [],
        authenticationSasl: false,
        parseFailure: false,
      };
      observations.push(observation);
      const bridge = createTcpBridge({
        endpoint: target,
        socket: pair[1],
        onClientBytes: (bytes) => onClientBytes?.(bytes, observation),
        onServerBytes: (bytes) => onServerBytes?.(bytes, observation),
      });
      bridges.push(bridge);
      return new Response(null, { status: 101, webSocket: pair[0] });
    },
    async close() {
      const pending = bridges.map((bridge) => bridge.close());
      let timer;
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(held()), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        for (const bridge of bridges) bridge.detach();
      }
      require(
        bridges.every(
          (bridge) =>
            bridge.metrics.tcpClosed &&
            bridge.metrics.webSocketClosed &&
            !bridge.metrics.timerActive,
        ),
      );
    },
  });
}
