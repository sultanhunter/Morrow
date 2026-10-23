// The Sunrise shell (ADR-0032): skip link, the provisional label (every screen, every
// width), the store switcher, the Ask Morrow button on every page, the seven destinations
// of the route contract under their Sunrise labels (Home, Inbox, Projects, Team, Shop
// knowledge, Files, then Settings at the bottom), the store connection, and below 760 px
// a top bar with the labelled modal drawer (focus trapped, background `inert`, Escape
// restores focus). Route ids and paths are the contract's; only labels change.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { buildWorkspacePath, routeAncestry, workspaceRoutes } from "@morrow/contracts/routes";
import { copy } from "../copy";
import type { AgentKind, HomeSamplesView, Id, WorkspaceSummary, WorkspaceView } from "../model";
import { useServices } from "../services";
import { breakpoints } from "../tokens";
import {
  primaryStore,
  useConnections,
  useHomeSamples,
  useOpenQuestions,
  waitingCount,
} from "../workspace-data";
import { AgentAvatar, PersonAvatar, StoreTile, agentNames } from "./avatars";
import { Button, RouteLink, trapTab } from "./controls";
import { Icon, MorrowMark, type IconName } from "./display";

export function ProvisionalBar({ fixture }: { readonly fixture?: ReactNode }) {
  return (
    <div className="provisional-bar">
      <p role="note" className="provisional-note">
        {copy.provisional}
      </p>
      {fixture ?? null}
    </div>
  );
}

export function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById("main")?.focus();
      }}
    >
      {copy.skip}
    </a>
  );
}

/** Morrow's name with its character: the entry screens' top bar. */
function Brand() {
  return (
    <p className="brand">
      <AgentAvatar agent="morrow" size={32} />
      {copy.brand}
    </p>
  );
}

/** Screens outside a workspace: sign-in, signed out, not found, unavailable, account. */
export function EntryLayout({
  fixture,
  children,
}: {
  readonly fixture?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <SkipLink />
      <ProvisionalBar fixture={fixture} />
      <div className="entry">
        <div className="entry-top">
          <Brand />
        </div>
        <main id="main" tabIndex={-1} className="entry-main">
          {children}
        </main>
      </div>
    </>
  );
}

const labels = copy.destinations as Readonly<Record<string, string>>;
/** The order of the board's sidebar; Settings sits apart at the bottom. */
const destinations: readonly { readonly route: string; readonly icon: IconName }[] = [
  { route: "home", icon: "home" },
  { route: "inbox", icon: "inbox" },
  { route: "work", icon: "work" },
  { route: "agents", icon: "agents" },
  { route: "knowledge", icon: "knowledge" },
  { route: "assets", icon: "assets" },
];
const bottom: readonly { readonly route: string; readonly icon: IconName }[] = [
  { route: "settings", icon: "settings" },
];

function NavLink({
  workspaceId,
  route,
  icon,
  current,
  waiting,
  onNavigate,
}: {
  readonly workspaceId: Id;
  readonly route: string;
  readonly icon: IconName;
  readonly current: boolean;
  readonly waiting?: string | null;
  readonly onNavigate?: (() => void) | undefined;
}) {
  return (
    <RouteLink
      route={route}
      params={{ workspaceId }}
      current={current}
      className="nav-link"
      {...(onNavigate ? { onNavigate } : {})}
    >
      <Icon name={icon} />
      <span className="nav-label">{labels[route]}</span>
      {waiting ? (
        <>
          <span className="count-pill" aria-hidden="true">
            {waiting}
          </span>
          <span className="visually-hidden">{`, ${waiting} waiting`}</span>
        </>
      ) : null}
    </RouteLink>
  );
}

/** Pinned projects under Projects: only the Home preview's samples have any today. */
function PinnedProjects({
  workspaceId,
  samples,
  onNavigate,
}: {
  readonly workspaceId: Id;
  readonly samples: HomeSamplesView;
  readonly onNavigate?: (() => void) | undefined;
}) {
  return (
    <ul className="nav-sub" aria-label={copy.shell.pinnedProjects}>
      {samples.projects.map((project) => (
        <li key={project.id}>
          <RouteLink
            route="project"
            params={{ workspaceId, projectId: project.id }}
            className="nav-sublink"
            {...(onNavigate ? { onNavigate } : {})}
          >
            <span className="nav-sublabel" dir="auto">
              {project.name}
            </span>
            <span className="nav-subnote">
              <span className="visually-hidden">, </span>
              {copy.shell.ends(project.ends)}
            </span>
          </RouteLink>
        </li>
      ))}
      <li>
        <RouteLink
          route="work"
          params={{ workspaceId }}
          className="nav-sublink"
          {...(onNavigate ? { onNavigate } : {})}
        >
          <span className="nav-sublabel">{copy.shell.everydayWork}</span>
          <Icon name="forward" size={16} />
        </RouteLink>
      </li>
    </ul>
  );
}

/** Team: Morrow is always on it; agents and people come with their reads (samples today). */
function TeamMembers({
  workspaceId,
  samples,
  onNavigate,
}: {
  readonly workspaceId: Id;
  readonly samples: HomeSamplesView | null;
  readonly onNavigate?: (() => void) | undefined;
}) {
  const agents =
    samples?.team.agents.filter(
      (a): a is Exclude<AgentKind, "morrow" | "specialist"> => a !== "morrow" && a !== "specialist",
    ) ?? [];
  const link = { route: "agents", params: { workspaceId }, className: "nav-sublink" } as const;
  const navigate = onNavigate ? { onNavigate } : {};
  return (
    <ul className="nav-sub" aria-label={copy.shell.teamMembers}>
      {(["morrow", ...agents] as const).map((agent) => (
        <li key={agent}>
          <RouteLink {...link} {...navigate}>
            <AgentAvatar agent={agent} size={28} />
            <span className="nav-sublabel">
              {agentNames[agent]}
              <span className="visually-hidden">{copy.shell.agentSuffix}</span>
            </span>
          </RouteLink>
        </li>
      ))}
      {(samples?.team.people ?? []).map((person) => (
        <li key={person.name}>
          <RouteLink {...link} {...navigate}>
            <PersonAvatar name={person.name} size={28} presence={person.presence} />
            <span className="nav-sublabel">
              <span dir="auto">{person.name}</span>
              <span className="visually-hidden">
                {person.presence === "online" ? copy.shell.online : copy.shell.away}
              </span>
            </span>
          </RouteLink>
        </li>
      ))}
    </ul>
  );
}

export function Navigation({
  workspaceId,
  currentRoute,
  onNavigate,
  waiting = null,
  samples = null,
}: {
  readonly workspaceId: string;
  readonly currentRoute: string;
  readonly onNavigate?: () => void;
  readonly waiting?: string | null;
  readonly samples?: HomeSamplesView | null;
}) {
  const ancestry = routeAncestry(workspaceRoutes, currentRoute);
  const all = [...destinations, ...bottom];
  const current = all.find((d) => ancestry.includes(d.route))?.route ?? null;
  const row = (d: { readonly route: string; readonly icon: IconName }) => (
    <NavLink
      workspaceId={workspaceId}
      route={d.route}
      icon={d.icon}
      current={d.route === current}
      waiting={d.route === "inbox" ? waiting : null}
      onNavigate={onNavigate}
    />
  );
  return (
    <nav aria-label="Main" className="nav">
      <ul className="nav-list">
        {destinations.map((d) => (
          <li key={d.route}>
            {row(d)}
            {d.route === "work" && samples ? (
              <PinnedProjects workspaceId={workspaceId} samples={samples} onNavigate={onNavigate} />
            ) : null}
            {d.route === "agents" ? (
              <TeamMembers workspaceId={workspaceId} samples={samples} onNavigate={onNavigate} />
            ) : null}
          </li>
        ))}
      </ul>
      <ul className="nav-list nav-bottom">
        {bottom.map((d) => (
          <li key={d.route}>{row(d)}</li>
        ))}
      </ul>
    </nav>
  );
}

/** Menu button pattern: arrows, Home/End, Escape and Tab close; focus returns to the button. */
export function WorkspaceSwitcher({
  current,
  workspaces,
  onNavigate,
}: {
  readonly current: WorkspaceView;
  readonly workspaces: readonly WorkspaceSummary[] | null;
  readonly onNavigate?: () => void;
}) {
  const services = useServices();
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const items: readonly WorkspaceSummary[] = workspaces ?? [
    { workspaceId: current.id, displayName: current.displayName, organizationName: null },
  ];
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[focusIndex]?.focus();
  }, [open, focusIndex]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const openAt = (index: number) => {
    setFocusIndex(index);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const select = (item: WorkspaceSummary) => {
    close(true);
    if (item.workspaceId === current.id) return;
    onNavigate?.();
    services.navigate(
      buildWorkspacePath(workspaceRoutes, "home", { workspaceId: item.workspaceId }),
    );
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(items.length - 1);
    }
  };
  const onMenuKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = items.length - 1;
    const moves: Readonly<Record<string, number>> = {
      ArrowDown: focusIndex === last ? 0 : focusIndex + 1,
      ArrowUp: focusIndex === 0 ? last : focusIndex - 1,
      Home: 0,
      End: last,
    };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault();
      setFocusIndex(moves[event.key]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(false);
  };
  return (
    <div className="switcher" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className="switcher-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${copy.workspace.switcherLabel}: ${current.displayName}`}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKey}
      >
        <StoreTile name={current.displayName} />
        <span className="switcher-name" dir="auto">
          {current.displayName}
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <div className="switcher-popover" hidden={!open}>
        <ul
          role="menu"
          id={menuId}
          ref={menu}
          aria-label={copy.workspace.switcherLabel}
          onKeyDown={onMenuKey}
        >
          {items.map((item) => (
            <li
              key={item.workspaceId}
              role="menuitemradio"
              aria-checked={item.workspaceId === current.id}
              tabIndex={-1}
              className="switcher-item"
              onClick={() => select(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select(item);
                }
              }}
            >
              <StoreTile name={item.displayName} size={28} />
              <span className="switcher-item-text">
                <span dir="auto">{item.displayName}</span>
                {item.organizationName !== null ? (
                  <span className="switcher-item-org" dir="auto">
                    {item.organizationName}
                  </span>
                ) : null}
              </span>
              {item.workspaceId === current.id ? <Icon name="check" size={18} /> : null}
            </li>
          ))}
        </ul>
        {workspaces === null ? (
          <p className="muted small switcher-note">{copy.workspace.switcherOnlyCurrent}</p>
        ) : null}
      </div>
    </div>
  );
}

/** The Ask Morrow button on every page (ADR-0032; the contract's entry action). */
export function AskMorrowButton({
  workspaceId,
  variant = "secondary",
  onNavigate,
}: {
  readonly workspaceId: Id;
  readonly variant?: "primary" | "secondary";
  readonly onNavigate?: (() => void) | undefined;
}) {
  return (
    <RouteLink
      route="ask"
      params={{ workspaceId }}
      className={`button button-${variant} ask-morrow`}
      {...(onNavigate ? { onNavigate } : {})}
    >
      <MorrowMark />
      <span>{copy.shell.askMorrow}</span>
    </RouteLink>
  );
}

/** Drawn where the board draws it; search itself arrives with its own read. */
function SidebarSearch({ store }: { readonly store: string }) {
  const id = useId();
  return (
    <div className="sidebar-search">
      <label htmlFor={id} className="visually-hidden">
        {copy.shell.searchLabel(store)}
      </label>
      <Icon name="search" />
      <input
        id={id}
        type="search"
        placeholder={copy.shell.searchPlaceholder}
        disabled
        aria-describedby={`${id}-later`}
      />
      <span id={`${id}-later`} className="visually-hidden">
        {copy.shell.searchLater}
      </span>
    </div>
  );
}

/** The store connection line: real data from the connections read; silent until it settles. */
function ConnectionLine({
  workspaceId,
  onNavigate,
}: {
  readonly workspaceId: Id;
  readonly onNavigate?: (() => void) | undefined;
}) {
  const [connections] = useConnections(workspaceId);
  if (connections.kind !== "ok") return null;
  const store = primaryStore(connections.value);
  const status = store?.status ?? "none";
  const label = Object.hasOwn(copy.shell.connection, status)
    ? copy.shell.connection[status]!
    : status;
  return (
    <RouteLink
      route="connections"
      params={{ workspaceId }}
      className="sidebar-status"
      {...(onNavigate ? { onNavigate } : {})}
    >
      <Icon name="store" />
      {status === "linked" ? <span className="status-dot" aria-hidden="true" /> : null}
      <span>{label}</span>
    </RouteLink>
  );
}

const narrowQuery = `(max-width: ${breakpoints.navigationCollapseBelow - 1}px)`;
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(narrowQuery);
    const change = () => setNarrow(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return narrow;
}
/** React 18.3.1 needs the string form of `inert`. */
const inertWhen = (on: boolean): Readonly<Record<string, string>> => (on ? { inert: "" } : {});

export function AppShell({
  workspace,
  currentRoute,
  switcherWorkspaces,
  onSignOut,
  signOutBusy,
  notices,
  fixture,
  children,
}: {
  readonly workspace: WorkspaceView;
  readonly currentRoute: string;
  readonly switcherWorkspaces: readonly WorkspaceSummary[] | null;
  readonly onSignOut: () => void;
  readonly signOutBusy: boolean;
  readonly notices?: ReactNode;
  readonly fixture?: ReactNode;
  readonly children: ReactNode;
}) {
  const narrow = useNarrow();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const modal = narrow && drawerOpen;
  const ws = workspace.id;
  const [questions] = useOpenQuestions(ws);
  const samples = useHomeSamples(ws);
  const waiting =
    questions.kind === "ok" && questions.value.items.length > 0
      ? waitingCount(questions.value)
      : null;
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  useEffect(() => {
    if (modal) drawer.current?.querySelector<HTMLElement>(".drawer-close")?.focus();
  }, [modal]);
  // Focus returns to the menu button once the background is no longer inert.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!modal && restoreFocus.current) {
      restoreFocus.current = false;
      menuButton.current?.focus();
    }
  }, [modal]);
  const closeDrawer = (refocus: boolean) => {
    restoreFocus.current = refocus;
    setDrawerOpen(false);
  };
  const navigated = () => setDrawerOpen(false);
  return (
    <>
      <div {...inertWhen(modal)}>
        <SkipLink />
        <ProvisionalBar fixture={fixture} />
      </div>
      <div className="shell">
        {modal ? (
          <div className="drawer-backdrop" aria-hidden="true" onClick={() => closeDrawer(true)} />
        ) : null}
        {/* One element, so opening the drawer keeps its state: a complementary landmark
            (as an <aside> would be), and below 760 px, while open, a labelled modal
            dialog (a role <aside> may not take). */}
        <div
          ref={drawer}
          id="workspace-navigation"
          className={modal ? "sidebar is-open" : "sidebar"}
          aria-label={copy.navigationLabel}
          {...(modal ? { role: "dialog", "aria-modal": true } : { role: "complementary" })}
          onKeyDown={(event) => {
            if (!modal) return;
            if (event.key === "Escape") {
              event.preventDefault();
              closeDrawer(true);
            } else trapTab(event, drawer.current);
          }}
        >
          {modal ? (
            <div className="sidebar-head">
              <button
                type="button"
                className="button button-quiet icon-button drawer-close"
                aria-label={copy.closeNavigation}
                onClick={() => closeDrawer(true)}
              >
                <Icon name="close" />
              </button>
            </div>
          ) : null}
          <WorkspaceSwitcher
            current={workspace}
            workspaces={switcherWorkspaces}
            onNavigate={navigated}
          />
          <AskMorrowButton workspaceId={ws} onNavigate={navigated} />
          <SidebarSearch store={workspace.displayName} />
          <Navigation
            workspaceId={ws}
            currentRoute={currentRoute}
            onNavigate={navigated}
            waiting={waiting}
            samples={samples}
          />
          <div className="sidebar-foot">
            <ConnectionLine workspaceId={ws} onNavigate={navigated} />
            {samples ? (
              <RouteLink
                route="settings_section"
                params={{ workspaceId: ws, section: "billing" }}
                className="sidebar-status"
                onNavigate={navigated}
              >
                <Icon name="credits" />
                <span>{copy.shell.credits(samples.creditsLeft)}</span>
              </RouteLink>
            ) : null}
            <Button variant="quiet" onClick={onSignOut} disabled={signOutBusy}>
              {signOutBusy ? copy.signOut.working : copy.signOut.button}
            </Button>
          </div>
        </div>
        <div className="main-column" {...inertWhen(modal)}>
          <header className="topbar">
            <button
              ref={menuButton}
              type="button"
              className="button button-quiet icon-button"
              aria-label={copy.openNavigation}
              aria-expanded={modal}
              aria-controls="workspace-navigation"
              onClick={() => setDrawerOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <StoreTile name={workspace.displayName} size={28} />
            <span className="topbar-name" dir="auto">
              {workspace.displayName}
            </span>
            <RouteLink
              route="ask"
              params={{ workspaceId: ws }}
              className="button button-quiet icon-button topbar-action"
            >
              <MorrowMark />
              <span className="visually-hidden">{copy.shell.askMorrow}</span>
            </RouteLink>
            <RouteLink
              route="inbox"
              params={{ workspaceId: ws }}
              className="button button-quiet icon-button topbar-action"
            >
              <Icon name="inbox" />
              <span className="visually-hidden">{labels.inbox}</span>
              {waiting ? (
                <>
                  <span className="count-pill" aria-hidden="true">
                    {waiting}
                  </span>
                  <span className="visually-hidden">{`, ${waiting} waiting`}</span>
                </>
              ) : null}
            </RouteLink>
          </header>
          <main id="main" tabIndex={-1} className="workspace-main">
            {notices}
            {children}
          </main>
        </div>
      </div>
    </>
  );
}

export function Tabs({
  label,
  tabs,
  selected,
  onSelect,
  idPrefix,
}: {
  readonly label: string;
  readonly tabs: readonly { readonly id: string; readonly label: string }[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly idPrefix: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === selected);
    const last = tabs.length - 1;
    const next: Readonly<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    if (!Object.hasOwn(next, event.key)) return;
    event.preventDefault();
    const target = tabs[next[event.key]!]!;
    onSelect(target.id);
    list.current?.querySelector<HTMLElement>(`#${idPrefix}-tab-${target.id}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={list} onKeyDown={move}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`${idPrefix}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={tab.id === selected}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          tabIndex={tab.id === selected ? 0 : -1}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function PaneSwitch({
  label,
  panes,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly panes: readonly { readonly id: string; readonly label: string }[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <div className="pane-switch" role="group" aria-label={label}>
      {panes.map((pane) => (
        <button
          key={pane.id}
          type="button"
          className="button button-secondary"
          aria-pressed={pane.id === selected}
          onClick={() => onSelect(pane.id)}
        >
          {pane.label}
        </button>
      ))}
    </div>
  );
}
