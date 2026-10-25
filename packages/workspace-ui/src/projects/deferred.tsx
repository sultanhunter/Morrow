// The project screens as the app routes them: each loads `./screens` on first use (one
// chunk for all three) and then renders the screen itself with the same props. Under the
// HTTP build their methods are uncomposed, so the app never renders them and the chunk is
// never requested.
import type { ComponentProps } from "react";
import { createDeferred } from "../components/deferred";
import type * as Screens from "./screens";

export const projectScreens = createDeferred<typeof Screens>(() => import("./screens"));

export function ProjectsScreen(props: ComponentProps<typeof Screens.ProjectsScreen>) {
  return <projectScreens.View>{(m) => <m.ProjectsScreen {...props} />}</projectScreens.View>;
}

export function ProjectScreen(props: ComponentProps<typeof Screens.ProjectScreen>) {
  return <projectScreens.View>{(m) => <m.ProjectScreen {...props} />}</projectScreens.View>;
}

export function AskConversationScreen(props: ComponentProps<typeof Screens.AskConversationScreen>) {
  return <projectScreens.View>{(m) => <m.AskConversationScreen {...props} />}</projectScreens.View>;
}
