// Shared fakes for the workspace-web unit tests (P14.T01a §7): a recording fetch
// transport, an in-memory Storage and a History-API window.
export function recordingTransport(responder) {
  const calls = [];
  const transport = async (path, init) => {
    calls.push({ path, init });
    return responder({ path, init, index: calls.length - 1 });
  };
  return { calls, transport };
}
export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export class MemoryStorage {
  #items = new Map();
  get length() {
    return this.#items.size;
  }
  key(index) {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }
  setItem(key, value) {
    this.#items.set(key, String(value));
  }
  removeItem(key) {
    this.#items.delete(key);
  }
  dump() {
    return Object.fromEntries(this.#items);
  }
}
export class ThrowingStorage {
  get length() {
    throw Error("blocked");
  }
  key() {
    throw Error("blocked");
  }
  getItem() {
    throw Error("blocked");
  }
  setItem() {
    throw Error("blocked");
  }
  removeItem() {
    throw Error("blocked");
  }
}
export function fakeWindow(start = "/") {
  const url = new URL(start, "https://w.test");
  const listeners = new Map();
  const entries = [url.pathname + url.search + url.hash];
  let index = 0;
  const location = {
    get pathname() {
      return new URL(entries[index], "https://w.test").pathname;
    },
    get search() {
      return new URL(entries[index], "https://w.test").search;
    },
    get hash() {
      return new URL(entries[index], "https://w.test").hash;
    },
  };
  return {
    location,
    entries,
    history: {
      pushState(_data, _unused, next) {
        entries.splice(index + 1);
        entries.push(next);
        index++;
      },
      replaceState(_data, _unused, next) {
        entries[index] = next;
      },
    },
    back() {
      index--;
      for (const listener of listeners.get("popstate") ?? []) listener();
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
}
