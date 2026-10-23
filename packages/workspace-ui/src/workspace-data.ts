// Reads the Sunrise shell and its pages share (ADR-0032): what waits for you in the Inbox,
// the store connection, and the default-off Home samples. The shell owns a refresh mark:
// the page on screen and the count of command changes (`useServicesVersion`). The sidebar
// and top bar read again under a new mark, when the person moves to another page or a
// command (an answer, a store link) starts or settles; the page they show reads under the
// same mark, so both settle on one reply and one request. Nothing here decides anything:
// the server answers every read and checks every action.
import { createContext, useContext } from "react";
import type { ConnectionsView, HomeSamplesView, Id, Page, QuestionView } from "./model";
import { useRead, useServices, useServicesVersion, type ReadState } from "./services";

const ShellRefresh = createContext("");
/** Set by the shell around the page, so the page's shared reads use the shell's mark. */
export const ShellRefreshProvider = ShellRefresh.Provider;
/** The shell's mark for `page` (the route and its parameters). */
export function useShellRefreshMark(page: string): string {
  return `${page}|${useServicesVersion()}`;
}

/** Open questions for this person: the Inbox items that exist today. */
export function useOpenQuestions(
  ws: Id,
  mark?: string,
): readonly [ReadState<Page<QuestionView>>, () => void] {
  const services = useServices();
  const inherited = useContext(ShellRefresh);
  return useRead(
    `${ws}|questions.mine|first`,
    () => services.port.work.listMyOpenQuestions(ws, null),
    mark ?? inherited,
  );
}
/** The count a person sees: the first page's size, or "50+" when more pages follow. */
export function waitingCount(page: Page<unknown>): string {
  return page.next !== null ? "50+" : String(page.items.length);
}

export function useConnections(
  ws: Id,
  mark?: string,
): readonly [ReadState<ConnectionsView>, () => void] {
  const services = useServices();
  const inherited = useContext(ShellRefresh);
  return useRead(`${ws}|connections`, () => services.port.connections.list(ws), mark ?? inherited);
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
