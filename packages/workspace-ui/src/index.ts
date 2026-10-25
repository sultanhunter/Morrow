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
export { ExceptionScreen } from "./screens/exception";
export { describeActivity, type ActivityLine } from "./screens/activity";
export { UnavailableDestination } from "./screens/unavailable";
export { ListingsAgentCard } from "./screens/agents";
export { ModelDefaultScreen } from "./screens/settings-models";
export { AskScreen, parseProducts } from "./screens/ask";
export { RunsPanel } from "./screens/runs";
export { AppliedPanel, OperationList, ReviewScreen, operationNote } from "./screens/review";
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
export { FilesScreen, ShopKnowledgeScreen } from "./screens/library";
export { NotificationsScreen } from "./screens/notifications";
export { ActivityScreen } from "./screens/activity";
export { StopAllCard } from "./screens/stop-all";
export { sunriseCopy } from "./sunrise/copy";
