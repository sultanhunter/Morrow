// Reads the Sunrise shell and Home share (ADR-0032): what waits for you in the Inbox, the
// store connection, and the default-off Home samples. One key per read, so the sidebar
// and Home settle on the same reply when they mount together. Nothing here decides
// anything: the server answers every read and checks every action.
import type { ConnectionsView, HomeSamplesView, Id, Page, QuestionView } from "./model";
import { useRead, useServices, type ReadState } from "./services";

/** Open questions for this person: the Inbox items that exist today. */
export function useOpenQuestions(
  ws: Id,
): readonly [ReadState<Page<QuestionView>>, () => void] {
  const services = useServices();
  return useRead(`${ws}|questions.mine|first`, () =>
    services.port.work.listMyOpenQuestions(ws, null),
  );
}
/** The count a person sees: the first page's size, or "50+" when more pages follow. */
export function waitingCount(page: Page<unknown>): string {
  return page.next !== null ? "50+" : String(page.items.length);
}

export function useConnections(ws: Id): readonly [ReadState<ConnectionsView>, () => void] {
  const services = useServices();
  return useRead(`${ws}|connections`, () => services.port.connections.list(ws));
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
