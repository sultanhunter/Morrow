// What screens may ask of the app (P14.T01a §4.2): the port, navigation through the
// leave guard, shared reads, single-flight commands and the text-free re-entry markers.
// The app (apps/workspace-web) provides it; screens never touch storage or a transport.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Id } from "./model";
import type { Command, Composed, Outcome, WorkspacePort } from "./port";

export type MarkerKind =
  | "goal"
  | "task"
  | "ready"
  | "assignment"
  | "question"
  | "answer"
  | "cancel";
export interface Marker {
  readonly workspaceId: Id;
  readonly kind: MarkerKind;
  readonly at: number;
}
export interface UiServices {
  readonly port: WorkspacePort;
  readonly composed: Composed;
  readonly loginBodyVersion: 1 | 2;
  readonly fixture: boolean;
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  /** Opens `/`: in the app while the session view is active, otherwise by a full load. */
  openAccount(): void;
  setDirty(token: object, dirty: boolean): void;
  read<T>(key: string, load: () => Promise<Outcome<T>>): Promise<Outcome<T>>;
  newCommand<B>(body: B): Command<B>;
  runCommand<T>(
    command: Command<unknown>,
    marker: { readonly workspaceId: Id; readonly kind: MarkerKind } | null,
    send: () => Promise<Outcome<T>>,
  ): Promise<Outcome<T>>;
  releaseCommand(key: string): void;
  reentryMarkers(workspaceId: Id): readonly Marker[];
  dismissMarker(marker: Marker): void;
  subscribe(listener: () => void): () => void;
  version(): number;
  startSignIn(workspaceId: Id | null): Promise<"started" | "failed">;
  signOut(): void;
}

const ServicesContext = createContext<UiServices | null>(null);
export const ServicesProvider = ServicesContext.Provider;
export function useServices(): UiServices {
  const services = useContext(ServicesContext);
  if (!services) throw Error("UI_SERVICES_MISSING");
  return services;
}

/** Registers unsent input with the leave guard while `dirty` holds. */
export function useDirty(dirty: boolean) {
  const services = useServices();
  const token = useRef({});
  useEffect(() => {
    services.setDirty(token.current, dirty);
    return () => services.setDirty(token.current, false);
  }, [services, dirty]);
}

/** Re-renders on pending-command and marker changes. */
export function useServicesVersion(): number {
  const services = useServices();
  return useSyncExternalStore(services.subscribe, services.version, services.version);
}

export type ReadState<T> = { readonly kind: "loading" } | Outcome<T>;
/** One shared read per key: a StrictMode double effect sends one request. */
export function useRead<T>(
  key: string | null,
  load: () => Promise<Outcome<T>>,
): readonly [ReadState<T>, () => void] {
  const services = useServices();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    base: string | null;
    value: ReadState<T>;
  }>({ key: null, base: null, value: { kind: "loading" } });
  const loader = useRef(load);
  loader.current = load;
  const scoped = key === null ? null : `${key}#${nonce}`;
  useEffect(() => {
    if (scoped === null) return;
    let live = true;
    services
      .read(scoped, () => loader.current())
      .then((value) => {
        if (live) setState({ key: scoped, base: key, value });
      });
    return () => {
      live = false;
    };
  }, [services, scoped, key]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  // A reload of the same key keeps showing the last reply until the new one arrives.
  const current = state.key === scoped || (state.base === key && key !== null);
  return [current ? state.value : { kind: "loading" }, reload] as const;
}

export type CommandPhase<T> =
  | { readonly phase: "idle" }
  | { readonly phase: "sending" }
  | { readonly phase: "uncertain"; readonly checking: boolean }
  | { readonly phase: "settled"; readonly outcome: Outcome<T> };

/**
 * One form's command (§4.7–§4.9). The key is minted on the first submit and reused
 * verbatim by Try again and Check again; a new key exists only after a terminal reply
 * (or, before anything was ever uncertain, after the person changes the body).
 */
export function useCommand<B, T>(options: {
  readonly marker: { readonly workspaceId: Id; readonly kind: MarkerKind } | null;
  readonly send: (command: Command<B>) => Promise<Outcome<T>>;
  /**
   * `sent.body` is the body the reply answers. `sent.current` is false when the form was
   * reset (a dialog closed, or reopened) while the reply was outstanding: the form no
   * longer shows that draft, so it must not be cleared or closed, but the outcome (a
   * confirmed record) is still reported. A stale reply leaves the form's phase alone.
   */
  readonly onOutcome?: (
    outcome: Outcome<T>,
    sent: { readonly body: B; readonly current: boolean },
  ) => void;
}) {
  const services = useServices();
  const command = useRef<Command<B> | null>(null);
  const live = useRef(true);
  const [phase, setPhase] = useState<CommandPhase<T>>({ phase: "idle" });
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (command.current) services.releaseCommand(command.current.key);
    };
  }, [services]);
  const dispatch = useCallback(
    async (sent: Command<B>, checking: boolean) => {
      setPhase(checking ? { phase: "uncertain", checking: true } : { phase: "sending" });
      const outcome = await services.runCommand(sent, latest.current.marker, () =>
        latest.current.send(sent),
      );
      if (!live.current) return;
      const current = command.current === sent;
      if (outcome.kind === "uncertain") {
        if (current) setPhase({ phase: "uncertain", checking: false });
        return;
      }
      if (outcome.kind === "unauthenticated") return; // the app ends the session view
      if (
        ["ok", "invalid", "denied", "not_found", "conflict", "not_in_build"].includes(outcome.kind)
      ) {
        services.releaseCommand(sent.key);
        if (current) command.current = null;
      }
      if (current) setPhase({ phase: "settled", outcome });
      latest.current.onOutcome?.(outcome, { body: sent.body, current });
    },
    [services],
  );
  const submit = useCallback(
    (body: B) => {
      const same =
        command.current !== null && JSON.stringify(command.current.body) === JSON.stringify(body);
      if (!same) {
        if (command.current) services.releaseCommand(command.current.key);
        command.current = services.newCommand(body);
      }
      return dispatch(command.current!, false);
    },
    [services, dispatch],
  );
  const retry = useCallback(() => {
    if (command.current) return dispatch(command.current, false);
    return Promise.resolve();
  }, [dispatch]);
  const checkAgain = useCallback(() => {
    if (command.current) return dispatch(command.current, true);
    return Promise.resolve();
  }, [dispatch]);
  const reset = useCallback(() => {
    if (command.current) services.releaseCommand(command.current.key);
    command.current = null;
    setPhase({ phase: "idle" });
  }, [services]);
  const busy = phase.phase === "sending" || phase.phase === "uncertain";
  return { phase, submit, retry, checkAgain, reset, busy } as const;
}
