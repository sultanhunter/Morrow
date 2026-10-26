// @morrow/workspace-ui: the Sunrise design system (ADR-0032) and the provisional screens
// (P14.T01a). It imports only react and @morrow/contracts/routes. Stylesheets are
// imported once by each app entry as `@morrow/workspace-ui/styles.css`.
export * from "./port";
export * from "./model";
export * from "./team-model";
export * from "./inbox-model";
export { copy, statusLabel } from "./copy";
export { breakpoints, referenceWidths, motionDurationMs, targetPx } from "./tokens";
export * from "./services";
export * from "./components/controls";
export * from "./components/display";
export * from "./components/feedback";
export * from "./components/shell";
export * from "./components/avatars";
export * from "./components/settings-frame";
export {
  primaryStore,
  useConnections,
  useHomeSamples,
  useInbox,
  useInboxSamples,
} from "./workspace-data";
export {
  AccountScreen,
  NotFoundScreen,
  SignedOutScreen,
  SignInButton,
  SignInScreen,
} from "./screens/entry";
export {
  SignOutUnconfirmedScreen,
  WorkspaceLoadFailedScreen,
  WorkspaceUnavailableScreen,
} from "./screens/entry";
export { normalizeName, CommandFeedback } from "./screens/entry";
export { HomeScreen, byRecent, homeDate, homeHeader } from "./screens/home";
export { WorkScreen } from "./screens/work";
export { TaskScreen } from "./screens/task";
export { InboxScreen, QuestionScreen } from "./screens/inbox";
export { describeActivity, type ActivityLine } from "./screens/activity";
export { UnavailableDestination } from "./screens/unavailable";
export { ListingsAgentCard } from "./screens/agents";
export { ModelDefaultScreen } from "./screens/settings-models";
export { RunsPanel } from "./screens/runs";
// v1 PR 4: Review, the task's history and Ask (with its product picker) load as their own
// chunks (screens/lazy.tsx), as does v1 PR 15's exception screen, which uses Review's
// OperationList. Nothing here re-exports screens/review, screens/ask, screens/product-picker
// or screens/exception, which would bundle them into the entry.
export { AppliedPanel, AskScreen, ExceptionScreen, ReviewScreen } from "./screens/lazy";
export { ConnectionScreen, ConnectionsScreen } from "./screens/connections";
// T7 PR 19 (ADR-0033, ADR-0034): the project screens, behind the default-off `projects.*`
// and `plans.*` port methods.
export * from "./projects/model";
export { projectsCopy } from "./projects/copy";
export {
  byEndDate,
  bucketRows,
  formatDay,
  healthStyle,
  parseDay,
  statusStyle,
} from "./projects/format";
export { documentBinds } from "./projects/plan-start";
export { planEdits } from "./projects/plan-card";
export { taskHomes } from "./projects/new-task";
export { localToday, validAsk, validEnd, validGoal, validTitle } from "./projects/new-project";
// The three screens load on first use, in their own chunk (`projects/deferred`).
export { AskConversationScreen, ProjectScreen, ProjectsScreen } from "./projects/deferred";
// T7 PR 16: Team, agent pages, Add agents, Settings, Shop knowledge and Files (Sunrise).
export { TeamScreen } from "./screens/team";
export { AgentScreen } from "./screens/agent-page";
export { AddAgentsScreen } from "./screens/add-agents";
export {
  EmailAddressesScreen,
  PeopleRolesScreen,
  PlanCreditsScreen,
  SettingsHomeScreen,
} from "./screens/settings-pages";
// PR 20: Shop knowledge (with Files, the same module) loads as its own chunk
// (screens/lazy.tsx); nothing here re-exports screens/library.
export { FilesScreen, ShopKnowledgeScreen } from "./screens/lazy";
export { NotificationsScreen } from "./screens/notifications";
export { ActivityScreen } from "./screens/activity";
export { StopAllCard } from "./screens/stop-all";
export { sunriseCopy } from "./sunrise/copy";
