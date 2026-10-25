// In-memory commands, single flight and text-free re-entry markers (P14.T01a §4.7, §4.9).
// A command is keyed by its Idempotency-Key: a second caller gets the request already in
// flight. Once a command was uncertain it stays uncertain until a decoded terminal reply;
// a later 503 or 429 never turns it into "nothing was changed". Markers hold only
// {workspaceId, kind, at}: no key, body, record id or text ever reaches storage.
import {
  isTerminal,
  type Command,
  type Marker,
  type MarkerKind,
  type Outcome,
} from "@morrow/workspace-ui";
import { isId } from "./http/client";

export const markerStorageKey = "morrow.unconfirmed.v1";
export const maxMarkers = 20;
const markerKinds: readonly MarkerKind[] = [
  "goal",
  "task",
  "ready",
  "assignment",
  "question",
  "answer",
  "cancel",
  "agent",
  "model_default",
  "run",
  "project",
  "plan",
  "thinking",
  "add_agent",
  "disconnect",
  "knowledge",
];
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}
/** The tab's sessionStorage, or null where the browser blocks it. */
export function browserSessionStorage(): StorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
const validMarker = (value: unknown): value is Marker => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).sort().join() === "at,kind,workspaceId" &&
    isId(entry.workspaceId) &&
    markerKinds.includes(entry.kind as MarkerKind) &&
    typeof entry.at === "number" &&
    Number.isSafeInteger(entry.at) &&
    entry.at >= 0
  );
};
export function readMarkers(storage: StorageLike | null): readonly Marker[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(markerStorageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(validMarker).slice(-maxMarkers) : [];
  } catch {
    return [];
  }
}
function writeMarkers(storage: StorageLike | null, markers: readonly Marker[]) {
  if (!storage) return;
  try {
    if (markers.length === 0) storage.removeItem(markerStorageKey);
    else
      storage.setItem(
        markerStorageKey,
        JSON.stringify(
          markers
            .slice(-maxMarkers)
            .map(({ workspaceId, kind, at }) => ({ workspaceId, kind, at })),
        ),
      );
  } catch {}
}
const sameMarker = (a: Marker, b: Marker) =>
  a.workspaceId === b.workspaceId && a.kind === b.kind && a.at === b.at;

/** Clears every `morrow.*` sessionStorage key (sign-out, session ended). */
export function clearMorrowStorage(storage: StorageLike | null = browserSessionStorage()) {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith("morrow.")) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {}
}

export interface Pending {
  run<T>(
    command: Command<unknown>,
    marker: { readonly workspaceId: string; readonly kind: MarkerKind } | null,
    send: () => Promise<Outcome<T>>,
  ): Promise<Outcome<T>>;
  release(key: string): void;
  blocking(): boolean;
  markers(): readonly Marker[];
  liveMarkers(): readonly Marker[];
  addMarker(workspaceId: string, kind: MarkerKind): Marker;
  dismiss(marker: Marker): void;
  /** Sign-out: forget uncertain keys and every marker, and disown commands still in flight. */
  clear(): void;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export function createPending({
  storage = browserSessionStorage(),
  now = Date.now,
}: { readonly storage?: StorageLike | null; readonly now?: () => number } = {}): Pending {
  // Each flight remembers the generation it started in. `clear()` (sign-out) starts a new
  // one, so a flight still in the air then neither blocks leaving nor, when it settles,
  // writes a marker or an uncertain key back for the next person on this tab.
  let generation = 0;
  const inflight = new Map<
    string,
    { readonly generation: number; readonly flight: Promise<Outcome<unknown>> }
  >();
  const uncertain = new Map<string, Marker | null>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    for (const listener of [...listeners]) listener();
  };
  let lastAt = 0;
  const addMarker = (workspaceId: string, kind: MarkerKind): Marker => {
    const at = Math.max(now(), lastAt + 1);
    lastAt = at;
    const marker = { workspaceId, kind, at };
    writeMarkers(storage, [...readMarkers(storage), marker]);
    notify();
    return marker;
  };
  const removeMarker = (marker: Marker) =>
    writeMarkers(
      storage,
      readMarkers(storage).filter((m) => !sameMarker(m, marker)),
    );
  return {
    run<T>(
      command: Command<unknown>,
      marker: { readonly workspaceId: string; readonly kind: MarkerKind } | null,
      send: () => Promise<Outcome<T>>,
    ): Promise<Outcome<T>> {
      const existing = inflight.get(command.key);
      if (existing && existing.generation === generation)
        return existing.flight as Promise<Outcome<T>>;
      const started = generation;
      // A Check again starts while the key is uncertain. If its form is reset meanwhile
      // (a dialog closed: `release`), the reply still settles this command: a terminal
      // one removes the marker it started with, and another uncertain one doesn't
      // register the key again or add a second marker.
      const startedUncertain = uncertain.has(command.key);
      const startMarker = uncertain.get(command.key) ?? null;
      const flight: Promise<Outcome<T>> = (async (): Promise<Outcome<T>> => {
        let outcome: Outcome<T>;
        try {
          outcome = await send();
        } catch {
          outcome = { kind: "uncertain" };
        }
        if (started !== generation) return outcome; // it outlived a sign-out
        const held = uncertain.has(command.key);
        const wasUncertain = held || startedUncertain;
        if (wasUncertain && (outcome.kind === "unavailable" || outcome.kind === "rate_limited"))
          outcome = { kind: "uncertain" };
        if (outcome.kind === "uncertain") {
          if (!wasUncertain)
            uncertain.set(command.key, marker ? addMarker(marker.workspaceId, marker.kind) : null);
        } else if (isTerminal(outcome) || outcome.kind === "not_in_build") {
          const entry = held ? uncertain.get(command.key) : startMarker;
          if (entry) removeMarker(entry);
          uncertain.delete(command.key);
        }
        // `unauthenticated` keeps the marker: the change may still have been saved.
        return outcome;
      })().finally(() => {
        if (inflight.get(command.key)?.flight === flight) inflight.delete(command.key);
        notify();
      });
      inflight.set(command.key, { generation: started, flight });
      notify();
      return flight;
    },
    release(key) {
      if (uncertain.delete(key)) notify();
    },
    blocking: () =>
      uncertain.size > 0 || [...inflight.values()].some((f) => f.generation === generation),
    markers: () => readMarkers(storage),
    liveMarkers: () => [...uncertain.values()].filter((m): m is Marker => m !== null),
    addMarker,
    dismiss(marker) {
      removeMarker(marker);
      notify();
    },
    clear() {
      generation++;
      uncertain.clear();
      writeMarkers(storage, []);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}
