// Destinations without a backend in this build (P14.A04 slice): a truthful
// dependency state, with no fabricated item, count or badge.
import { copy } from "../copy";
import { StateView } from "../components/feedback";

export function UnavailableDestination({ title }: { readonly title: string }) {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
      </header>
      <StateView kind="not_in_build" message={copy.unavailableDestination(title)} />
    </div>
  );
}
