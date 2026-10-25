// Screens that load on first use, in their own chunk, so the entry script stays inside
// its size budget (P14.T01a §4.11, AC19: 150 KB gzip). `createDeferred` takes a literal
// `import()` of a module that only it imports: the bundler then splits that module and
// everything only it reaches out of the entry (`verify:workspace-web` checks the split).
// Until the chunk arrives the screen shows the loading state; a failed load (offline, or a
// deploy that replaced the chunk) shows "This couldn't load. Nothing was changed." with
// Retry, which asks for the chunk again. Nothing here reads or sends workspace data: the
// loaded screen does, as it always did.
import { useEffect, useState, type ReactNode } from "react";
import { StateView } from "./feedback";

/** Before the module arrives, after a failed load, or the module (wrapped, never called). */
export type DeferredState<T> = "loading" | "failed" | { readonly module: T };

export interface Deferred<T> {
  /** Loads the module once; a failed load is forgotten, so the next call asks again. */
  readonly load: () => Promise<T>;
  /** The loaded module, or null before the first load succeeds. */
  readonly loaded: () => T | null;
  /** Renders `children(module)` once loaded; the loading and unavailable states before. */
  readonly View: (props: { readonly children: (module: T) => ReactNode }) => ReactNode;
}

/** What a deferred screen shows in each state. */
export function deferredView<T>(
  state: DeferredState<T>,
  children: (module: T) => ReactNode,
  onRetry: () => void,
): ReactNode {
  if (state === "loading") return <StateView kind="loading" />;
  if (state === "failed") return <StateView kind="unavailable" onRetry={onRetry} />;
  return children(state.module);
}

export function createDeferred<T>(importModule: () => Promise<T>): Deferred<T> {
  let module: T | null = null;
  let pending: Promise<T> | null = null;
  const load = () => {
    pending ??= importModule().then(
      (value) => {
        module = value;
        return value;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  function View({ children }: { readonly children: (module: T) => ReactNode }) {
    const [state, setState] = useState<DeferredState<T>>(() =>
      module === null ? "loading" : { module },
    );
    useEffect(() => {
      if (state !== "loading") return;
      let live = true;
      load().then(
        (value) => {
          if (live) setState({ module: value });
        },
        () => {
          if (live) setState("failed");
        },
      );
      return () => {
        live = false;
      };
    }, [state]);
    return <>{deferredView(state, children, () => setState("loading"))}</>;
  }
  return { load, loaded: () => module, View };
}
