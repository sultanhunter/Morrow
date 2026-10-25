// v1 PR 4: the screens that load as their own chunk after the workspace entry, which stays
// within its gzip budget (`entryGzipLimit`, scripts/workspace-web-checks.mjs, which also
// fails if one of these modules is bundled into an entry): Review and the task's "Changes
// applied" history (screens/review.tsx), Ask with its product picker (screens/ask.tsx,
// screens/product-picker.tsx), and v1 PR 15's exception screen (screens/exception.tsx),
// which shows one operation with Review's own OperationList and so loads with it. Nothing
// else may import those modules statically.
// While a chunk loads, its place shows the loading state. A chunk that cannot load shows
// "This couldn't load" with Retry, which reloads the page: after a deploy the open tab's
// chunks are gone, so only the new entry can load the screen again (the leave guard still
// asks first when something is unsaved). A screen's own errors are not caught here.
import { Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { StateView } from "../components/feedback";

type Frame = (state: ReactNode) => ReactNode;
const pageFrame: Frame = (state) => <div className="page">{state}</div>;
const bareFrame: Frame = (state) => <>{state}</>;

export function lazyScreen<P extends object>(
  load: () => Promise<ComponentType<P>>,
  frame: Frame,
  reload: () => void = () => window.location.reload(),
): ComponentType<P> {
  const Failed = () => <>{frame(<StateView kind="unavailable" onRetry={reload} />)}</>;
  // React types a lazy component's props through a conditional type that stays unresolved
  // for a generic P; the component itself takes exactly P.
  const Chunk = lazy<ComponentType<P>>(() =>
    load().then(
      (Screen) => ({ default: Screen }),
      () => ({ default: Failed }),
    ),
  ) as unknown as ComponentType<P>;
  return function LazyScreen(props: P) {
    return (
      <Suspense fallback={frame(<StateView kind="loading" />)}>
        <Chunk {...props} />
      </Suspense>
    );
  };
}

export const ReviewScreen = lazyScreen(
  () => import("./review").then((m) => m.ReviewScreen),
  pageFrame,
);
export const AppliedPanel = lazyScreen(
  () => import("./review").then((m) => m.AppliedPanel),
  bareFrame,
);
export const AskScreen = lazyScreen(() => import("./ask").then((m) => m.AskScreen), pageFrame);
export const ExceptionScreen = lazyScreen(
  () => import("./exception").then((m) => m.ExceptionScreen),
  pageFrame,
);
