// Reads the Sunrise shell and its pages share (ADR-0032): what waits for you in the Inbox,
// the store connection, and the default-off Home samples. The shell owns a refresh: a
// mark made of the page on screen, the count of command changes (`useServicesVersion`)
// and the count of Retries, plus `bump`, the Retry that starts a new mark. The sidebar and
// top bar read again under each new mark: when the person moves to another page, a
// command (an answer, a store link) starts or settles, or a Retry is pressed. Home reads
// under the same mark, so the page and the shell settle on one reply and one request,
// and a Retry on Home reads the shell's copy again too. Under a mark, a re-read that gets
// no answer (unavailable, offline, rate limited) keeps the last ok reply on screen
// (`nextReadSlot`). Pages that hold a command read "mount" instead: once per mount and on
// their own Retry, so no background re-read can take a command's in-flight or
// unknown-outcome state (and its Check again) off the screen. Nothing here decides
// anything: the server answers every read and checks every action.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { InboxSamplesView, InboxView } from "./inbox-model";
import type { ConnectionsView, HomeSamplesView, Id } from "./model";
import type { Outcome } from "./port";
import { useRead, useServices, useServicesVersion, type ReadState } from "./services";

/** The shell's refresh: its current mark, and `bump`, a Retry that starts a new one. */
export interface ShellRefresh {
  readonly mark: string;
  readonly bump: () => void;
}
const ShellRefreshContext = createContext<ShellRefresh | null>(null);
/** Set by the shell around the page, so the page's shared reads follow the shell's. */
export const ShellRefreshProvider = ShellRefreshContext.Provider;
/** The shell's refresh for `page` (the route and its parameters). */
export function useShellRefresh(page: string): ShellRefresh {
  const version = useServicesVersion();
  const [retries, setRetries] = useState(0);
  const bump = useCallback(() => setRetries((n) => n + 1), []);
  const mark = `${page}|${version}|${retries}`;
  return useMemo(() => ({ mark, bump }), [mark, bump]);
}

/**
 * When a shared read is read again: "shell" (the default) under the shell's refresh when
 * the page is inside the shell, else once per mount; "mount" once per mount and on the
 * page's own Retry (pages that hold a command); or the given refresh (the shell itself,
 * which sits outside its own provider).
 */
export type Follow = "shell" | "mount" | ShellRefresh;

function useSharedRead<T>(
  key: string,
  load: () => Promise<Outcome<T>>,
  follow: Follow,
): readonly [ReadState<T>, () => void] {
  const inherited = useContext(ShellRefreshContext);
  const shell = follow === "mount" ? null : follow === "shell" ? inherited : follow;
  const [state, reload] = useRead(key, load, shell?.mark ?? "");
  // Under the shell, Retry is the shell's: the page and the sidebar read again together.
  return [state, shell?.bump ?? reload] as const;
}

/**
 * v1 PR 15: what waits for this person (GET /work/inbox), the one read the Inbox, Home's
 * header and Needs you, and the sidebar and top bar's count share, under the shell's
 * refresh: one request per page, command change or Retry.
 */
export function useInbox(
  ws: Id,
  follow: Follow = "shell",
): readonly [ReadState<InboxView>, () => void] {
  const services = useServices();
  return useSharedRead(`${ws}|inbox`, () => services.port.inbox.read(ws), follow);
}
/**
 * The Inbox preview's sample items (default off). While `samples.inbox` is uncomposed
 * (always, over HTTP) nothing is read and nothing is shown.
 */
export function useInboxSamples(ws: Id): InboxSamplesView | null {
  const services = useServices();
  const on = services.composed["samples.inbox"];
  const [samples] = useRead(on ? `${ws}|samples.inbox` : null, () =>
    services.port.samples.inbox(ws),
  );
  return on && samples.kind === "ok" ? samples.value : null;
}

export function useConnections(
  ws: Id,
  follow: Follow = "shell",
): readonly [ReadState<ConnectionsView>, () => void] {
  const services = useServices();
  return useSharedRead(`${ws}|connections`, () => services.port.connections.list(ws), follow);
}

/**
 * The Home preview's sample sections. While `samples.home` is uncomposed (always, over
 * HTTP) nothing is read and nothing is shown.
 */
export function useHomeSamples(ws: Id): HomeSamplesView | null {
  const services = useServices();
  const on = services.composed["samples.home"];
  const [samples] = useRead(on ? `${ws}|samples.home` : null, () => services.port.samples.home(ws));
  return on && samples.kind === "ok" ? samples.value : null;
}

/** The store a workspace shows: its first installation, or null when it has none. */
export function primaryStore(view: ConnectionsView) {
  return view.installations[0] ?? null;
}
