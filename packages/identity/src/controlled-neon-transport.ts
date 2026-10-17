import { controlledNeonHeld } from "./controlled-neon-login-profiles.js";

// Private implementation seam. Native factories capture the constructor; only
// direct source tests of this helper may supply a synthetic constructor.
export type NeonSocket = {
  binaryType: string;
  readonly readyState: number;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
};
export type NeonSocketConstructor = new (url: string) => NeonSocket;
export type NeonOwnedSocket = Readonly<{
  acquired(): boolean;
  isClosed(): boolean;
  closed: Promise<void>;
  close(): void;
}>;
export function createControlledNeonSocketClass(options: {
  native: NeonSocketConstructor;
  expectedUrl: string;
  targetUrl: string;
  live(): boolean;
  fault(): void;
  own(socket: NeonOwnedSocket): void;
  observe(
    kind: "attempt" | "acquired" | "closeAttempt" | "closeAck" | "sent" | "received" | "late",
  ): void;
}): NeonSocketConstructor {
  return class ControlledNeonSocket {
    private socket: NeonSocket | undefined;
    private stopped = false;
    private closing = false;
    private closedValue = false;
    private ready = 0;
    private type = "arraybuffer";
    private sent = 0;
    private received = 0;
    private listeners = new Map<string, ((event: any) => void)[]>();
    private nativeListeners: { type: string; listener: (event: any) => void }[] = [];
    private finish!: () => void;
    private readonly closedPromise = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    constructor(url: string) {
      options.observe("attempt");
      const handle = Object.freeze({
        acquired: () => this.socket !== undefined,
        isClosed: () => this.closedValue,
        closed: this.closedPromise,
        close: () => this.close(),
      });
      options.own(handle);
      try {
        if (url !== options.expectedUrl || !options.live()) throw controlledNeonHeld();
        this.socket = new options.native(options.targetUrl);
        options.observe("acquired");
        this.socket.binaryType = "arraybuffer";
        this.listen("error", () => this.fail());
        this.listen("close", () => {
          if (this.closedValue) return;
          this.closedValue = true;
          this.ready = 3;
          this.stopped = true;
          options.observe("closeAck");
          this.finish();
          this.dispatch("close", { type: "close" });
          this.detach();
        });
        this.listen("open", () => {
          if (this.stopped || !options.live()) {
            options.observe("late");
            this.fail();
            return;
          }
          this.ready = 1;
          this.dispatch("open", { type: "open" });
        });
        this.listen("message", (event) => {
          if (this.stopped || !options.live()) {
            options.observe("late");
            this.fail();
            return;
          }
          const data = event.data;
          const size =
            data instanceof ArrayBuffer
              ? data.byteLength
              : ArrayBuffer.isView(data)
                ? data.byteLength
                : -1;
          this.received += Math.max(0, size);
          if (size < 0 || size > 262144 || this.received > 1048576) {
            this.fail();
            return;
          }
          options.observe("received");
          this.dispatch("message", { type: "message", data });
        });
      } catch {
        this.fail();
      }
    }
    private listen(type: string, listener: (event: any) => void) {
      this.socket!.addEventListener(type, listener);
      this.nativeListeners.push({ type, listener });
    }
    private detach() {
      try {
        for (const item of this.nativeListeners)
          this.socket?.removeEventListener?.(item.type, item.listener);
      } catch {
        options.fault();
      }
      this.nativeListeners.length = 0;
      this.listeners.clear();
    }
    get binaryType() {
      return this.type;
    }
    set binaryType(value: string) {
      // Must never throw into SDK configureWebSocket's Fetch-fallback catch.
      try {
        if (value !== "arraybuffer") throw controlledNeonHeld();
        this.type = value;
        if (this.socket) this.socket.binaryType = value;
      } catch {
        this.fail();
      }
    }
    get readyState() {
      return this.ready;
    }
    addEventListener(type: string, listener: (event: any) => void) {
      try {
        if (!["open", "message", "error", "close"].includes(type) || typeof listener !== "function")
          throw controlledNeonHeld();
        const list = this.listeners.get(type) ?? [];
        if (list.length >= 8) throw controlledNeonHeld();
        list.push(listener);
        this.listeners.set(type, list);
      } catch {
        this.fail();
      }
    }
    private dispatch(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) ?? []) {
        try {
          listener.call(this, event);
        } catch {
          this.fail();
        }
      }
    }
    private fail() {
      if (this.stopped) return;
      this.stopped = true;
      // The SDK installs its listeners after construction. Defer the fixed
      // failure, but do not manufacture a transport-close acknowledgement.
      queueMicrotask(() => {
        options.fault();
        this.dispatch("error", controlledNeonHeld());
        if (!this.socket) {
          this.ready = 3;
          this.dispatch("close", { type: "close" });
        }
        this.close();
      });
    }
    send(data: unknown) {
      try {
        const size =
          data instanceof ArrayBuffer
            ? data.byteLength
            : ArrayBuffer.isView(data)
              ? data.byteLength
              : -1;
        this.sent += Math.max(0, size);
        if (
          this.stopped ||
          this.ready !== 1 ||
          !options.live() ||
          !this.socket ||
          size < 0 ||
          size > 262144 ||
          this.sent > 1048576
        )
          throw controlledNeonHeld();
        this.socket.send(data);
        options.observe("sent");
      } catch {
        this.fail();
      }
    }
    close() {
      if (this.closing || this.closedValue) return;
      this.closing = true;
      this.stopped = true;
      this.ready = 2;
      if (!this.socket) {
        this.ready = 3;
        return;
      }
      options.observe("closeAttempt");
      try {
        this.socket.close();
      } catch {
        options.fault();
      }
    }
  };
}
