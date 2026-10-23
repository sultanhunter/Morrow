// T7 PR 16: Sunrise parts for Team, agent pages, Add agents, Settings, Shop knowledge and
// Files (ADR-0032 item 2; the Sunrise brief §1.5). They live in their own files so PR 14's
// shell and Home can adopt or replace them without touching the option 1 components. Every
// colour comes from a token class in `styles/sunrise-team.css`.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { RouteLink } from "../components/controls";
import type { AgentCharacter, PermissionsView } from "../team-model";
import { sunriseCopy } from "./copy";

const icons = {
  plus: ["M12 5v14", "M5 12h14"],
  chevronRight: ["m9 6 6 6-6 6"],
  check: ["m5 12 4.5 4.5L19 7"],
  hand: [
    "M8 13V6.5a1.5 1.5 0 0 1 3 0V12",
    "M11 11V5a1.5 1.5 0 0 1 3 0v6",
    "M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.6 14a1.5 1.5 0 0 1 2.4-1.8L8 14.5",
  ],
  slash: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M5.6 5.6l12.8 12.8"],
  calendar: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  repeat: [
    "M17 2l3 3-3 3",
    "M4 11V9a4 4 0 0 1 4-4h12",
    "M7 22l-3-3 3-3",
    "M20 13v2a4 4 0 0 1-4 4H4",
  ],
  store: [
    "M4 9l1.5-5h13L20 9",
    "M4 9h16v1a2.67 2.67 0 0 1-5.33 0 2.67 2.67 0 0 1-5.34 0A2.67 2.67 0 0 1 4 10z",
    "M5 12v8h14v-8",
    "M10 20v-5h4v5",
  ],
  task: ["M9 11l3 3 8-8", "M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11"],
  mention: [
    "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z",
    "M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1",
  ],
  idea: [
    "M9 18h6",
    "M10 21h4",
    "M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z",
  ],
  folder: ["M3 6h7l2 2h9v11H3z"],
  tag: ["M3 12V4h8l10 10-7 7z", "M7.5 7.5h.01"],
  mail: ["M3 5h18v14H3z", "M3 6l9 7 9-7"],
  copy: ["M8 8h12v12H8z", "M16 8V4H4v12h4"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
  globe: [
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    "M3 12h18",
    "M12 3a14 14 0 0 1 0 18",
    "M12 3a14 14 0 0 0 0 18",
  ],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v6", "M12 7.5h.01"],
  people: [
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M2 21v-1a7 7 0 0 1 14 0v1",
    "M16 3.5a4 4 0 0 1 0 7.5",
    "M22 21v-1a7 7 0 0 0-4-6.3",
  ],
  coins: [
    "M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z",
    "M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7",
    "M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5",
  ],
  file: ["M6 2h8l5 5v15H6z", "M14 2v5h5"],
  alert: ["M12 3l10 18H2z", "M12 10v5", "M12 18h.01"],
  lock: ["M6 11h12v10H6z", "M8 11V8a4 4 0 0 1 8 0v3"],
  upload: ["M12 16V4", "M7 9l5-5 5 5", "M4 20h16"],
  book: ["M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z", "M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"],
  gear: ["M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z", "M12 2v3 M12 19v3 M2 12h3 M19 12h3"],
  bell: ["M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0"],
  activity: ["M4 6h10", "M4 11h7", "M4 16h5", "M16.5 11.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
  stop: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M9 9h6v6H9z"],
  download: ["M12 4v12", "M7 11l5 5 5-5", "M4 20h16"],
  close: ["m6 6 12 12", "M6 18 18 6"],
} as const;
export type SrIconName = keyof typeof icons;

export function SrIcon({ name, size = 20 }: { readonly name: SrIconName; readonly size?: number }) {
  return (
    <svg
      className="sr-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The closed badge words (ADR-0032 item 2): each a tone, a glyph and a word. */
export type BadgeKind = keyof typeof sunriseCopy.status;
const badgeTone: Readonly<Record<BadgeKind, string>> = {
  active: "success",
  working: "info",
  needs_you: "caution",
  paused: "neutral",
  done: "success",
  needs_review: "caution",
  on_track: "success",
  behind: "warning",
  added: "success",
  default: "neutral",
  ready: "success",
  coming_soon: "neutral",
  waiting_review: "caution",
  owner_only: "neutral",
  suggested: "neutral",
  updated_in_shopify: "success",
  sent: "success",
};
function BadgeGlyph({ kind }: { readonly kind: BadgeKind }) {
  const tick = (
    <>
      <circle cx="7" cy="7" r="5.2" />
      <path d="M4.7 7.2 L6.3 8.8 L9.4 5.5" />
    </>
  );
  const dashed = <circle cx="7" cy="7" r="5.2" strokeDasharray="2.4 1.68" />;
  const shape: Readonly<Record<BadgeKind, ReactNode>> = {
    active: tick,
    done: tick,
    on_track: tick,
    added: tick,
    ready: tick,
    default: tick,
    updated_in_shopify: tick,
    sent: tick,
    suggested: (
      <>
        <circle cx="7" cy="7" r="5.2" />
        <path d="M7 4.6 V9.4 M4.6 7 H9.4" />
      </>
    ),
    working: (
      <>
        <circle cx="7" cy="7" r="5.2" />
        <path className="sr-glyph-fill" d="M7 3.6 A3.4 3.4 0 0 1 7 10.4 Z" />
      </>
    ),
    needs_you: dashed,
    needs_review: dashed,
    waiting_review: dashed,
    paused: (
      <>
        <circle cx="7" cy="7" r="5.2" />
        <path d="M5.8 5 V9 M8.2 5 V9" />
      </>
    ),
    behind: (
      <>
        <circle cx="7" cy="7" r="5.2" />
        <path d="M7 4.3 V7.5" />
        <circle className="sr-glyph-fill" cx="7" cy="9.8" r="0.95" />
      </>
    ),
    coming_soon: (
      <>
        <circle cx="7" cy="7" r="5.2" />
        <path d="M7 4.4 V7 L8.8 8.2" />
      </>
    ),
    owner_only: (
      <>
        <circle cx="7" cy="7" r="5.2" />
        <path d="M4.6 7 H9.4" />
      </>
    ),
  };
  return (
    <svg
      className="sr-badge-glyph"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape[kind]}
    </svg>
  );
}
export function Badge({ kind }: { readonly kind: BadgeKind }) {
  return (
    <span className={`sr-badge sr-tone-${badgeTone[kind]}`}>
      <BadgeGlyph kind={kind} />
      {sunriseCopy.status[kind]}
    </span>
  );
}

/** The "Agent" pill in the agent's own colours, or the neutral specialist pill. */
export function AgentPill({ character }: { readonly character: AgentCharacter }) {
  const specialist = character === "specialist";
  return (
    <span className={`sr-pill sa-${character}`}>
      <span aria-hidden="true">
        {specialist ? sunriseCopy.pills.specialist : sunriseCopy.pills.agent}
      </span>
      <span className="visually-hidden">
        {specialist ? sunriseCopy.hidden.specialist : sunriseCopy.hidden.agent}
      </span>
    </span>
  );
}

/** A white card with a 56-tall header: a title, and optionally one link or action. */
export function Card({
  title,
  headingLevel = 2,
  action,
  children,
  className,
  flush = false,
}: {
  readonly title: ReactNode;
  readonly headingLevel?: 2 | 3;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /** Lists and tables run edge to edge under the header. */
  readonly flush?: boolean;
}) {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      className={`sr-card${flush ? " is-flush" : ""}${className ? " " + className : ""}`}
      aria-labelledby={id}
    >
      <div className="sr-card-head">
        <Heading id={id} className="sr-card-title">
          {title}
        </Heading>
        {action ? <div className="sr-card-action">{action}</div> : null}
      </div>
      <div className="sr-card-body">{children}</div>
    </section>
  );
}

/** "What this agent is allowed to do": three groups, never red. */
export function PermissionList({ permissions }: { readonly permissions: PermissionsView }) {
  const groups = [
    {
      key: "own",
      title: "Does on its own",
      tone: "success",
      icon: "check",
      items: permissions.onItsOwn,
    },
    {
      key: "ask",
      title: "Asks you first",
      tone: "caution",
      icon: "hand",
      items: permissions.asksFirst,
    },
    { key: "never", title: "Never does", tone: "neutral", icon: "slash", items: permissions.never },
  ] as const;
  return (
    <div className="sr-permissions">
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <div key={g.key} className="sr-permission-group">
            <span className={`sr-glyph-tile sr-tone-${g.tone}`}>
              <SrIcon name={g.icon} size={18} />
            </span>
            <div>
              <h3 className="sr-subheading">{g.title}</h3>
              <ul className="sr-bullets">
                {g.items.map((item) => (
                  <li key={item} dir="auto">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
    </div>
  );
}

/** "Will be able to" and "will not be able to" (the consent variant). */
export function CanCannot({
  can,
  cannot,
  canTitle,
  cannotTitle,
}: {
  readonly can: readonly string[];
  readonly cannot: readonly string[];
  readonly canTitle: string;
  readonly cannotTitle: string;
}) {
  return (
    <div className="sr-permissions">
      {[
        { key: "can", title: canTitle, tone: "success", icon: "check", items: can },
        { key: "cannot", title: cannotTitle, tone: "neutral", icon: "slash", items: cannot },
      ].map((g) => (
        <div key={g.key} className="sr-permission-group">
          <span className={`sr-glyph-tile sr-tone-${g.tone}`}>
            <SrIcon name={g.icon as SrIconName} size={18} />
          </span>
          <div>
            <h3 className="sr-subheading">{g.title}</h3>
            <ul className="sr-bullets">
              {g.items.map((item) => (
                <li key={item} dir="auto">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}

/** An ink bar on a track; the figure is always written beside it, so the bar is hidden. */
export function Progress({ value, max }: { readonly value: number; readonly max: number }) {
  const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="sr-progress" aria-hidden="true">
      <span className="sr-progress-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** At most one banner per page: a tinted head with a glyph and a title, then a white body. */
export function Banner({
  tone,
  title,
  children,
  onDismiss,
  focusOnShow = false,
}: {
  readonly tone: "info" | "success" | "warning";
  readonly title: string;
  readonly children?: ReactNode;
  readonly onDismiss?: () => void;
  /** The result of an action whose control went away: focus moves to its title. */
  readonly focusOnShow?: boolean;
}) {
  const titleRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusOnShow) titleRef.current?.focus();
  }, [focusOnShow, title]);
  return (
    <div className={`sr-banner sr-banner-${tone}`} role="status">
      <div className="sr-banner-head">
        <SrIcon name={tone === "success" ? "check" : tone === "warning" ? "alert" : "info"} />
        <p className="sr-banner-title" ref={titleRef} tabIndex={focusOnShow ? -1 : undefined}>
          {title}
        </p>
        {onDismiss ? (
          <button
            type="button"
            className="sr-icon-button"
            aria-label={sunriseCopy.add.dismiss}
            onClick={onDismiss}
          >
            <SrIcon name="close" />
          </button>
        ) : null}
      </div>
      {children ? <div className="sr-banner-body">{children}</div> : null}
    </div>
  );
}

/** A "Coming soon" control: not a button, so nothing pretends to work. */
export function ComingSoon({ label }: { readonly label?: string }) {
  return (
    <span className="sr-coming-soon">
      <SrIcon name="clock" size={16} />
      {label ? <span className="visually-hidden">{label}: </span> : null}
      {sunriseCopy.status.coming_soon}
    </span>
  );
}

/** Breadcrumb, title row and scope line (the Sunrise page header). */
export function PageHeader({
  workspaceId,
  parent,
  title,
  lead,
  after,
  actions,
  scope,
}: {
  readonly workspaceId: string;
  readonly parent?: { readonly route: string; readonly label: string } | undefined;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly after?: ReactNode;
  readonly actions?: ReactNode;
  readonly scope?: ReactNode;
}) {
  return (
    <header className="sr-header">
      {parent ? (
        <nav aria-label="Breadcrumb" className="sr-breadcrumb">
          <RouteLink route={parent.route} params={{ workspaceId }} className="sr-link">
            {parent.label}
          </RouteLink>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">{title}</span>
        </nav>
      ) : null}
      <div className="sr-title-row">
        <div className="sr-title">
          {lead}
          <h1 dir="auto">{title}</h1>
          {after}
        </div>
        {actions ? <div className="sr-actions">{actions}</div> : null}
      </div>
      {scope ? <p className="sr-scope">{scope}</p> : null}
    </header>
  );
}

/** Sunrise pill tabs over real tabs (arrows, Home and End move between them). */
export function SrTabs({
  label,
  tabs,
  selected,
  onSelect,
  idPrefix,
}: {
  readonly label: string;
  readonly tabs: readonly {
    readonly id: string;
    readonly label: string;
    readonly count?: number;
  }[];
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
    <div className="sr-tabs" role="tablist" aria-label={label} ref={list} onKeyDown={move}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`${idPrefix}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={tab.id === selected}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          tabIndex={tab.id === selected ? 0 : -1}
          className="sr-tab"
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="sr-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export type SettingsSection =
  | "plan"
  | "people"
  | "notifications"
  | "email"
  | "shopify"
  | "activity"
  | "governance";
/**
 * The Settings menu, in the board's order. The route contract's `settings_section` has six
 * values (people, governance, usage, billing, notifications, stores) and no `email` or
 * `activity`: until it does (a route-contract change, the brief's open question 1), Email
 * addresses uses `stores` (the shop's own addresses), Activity
 * uses `governance` (the stops and the record of who did what), and M3's model default
 * moves to `billing` (what a product may cost). One rename re-homes each.
 */
export const settingsRoutes: Readonly<Record<SettingsSection, string | null>> = {
  plan: "usage",
  people: "people",
  notifications: "notifications",
  email: "stores",
  shopify: null,
  activity: "governance",
  governance: "billing",
};
const settingsLinks: readonly {
  readonly id: SettingsSection;
  readonly route: string;
  readonly section: string | null;
  readonly icon: SrIconName;
}[] = (
  [
    ["plan", "coins"],
    ["people", "people"],
    ["notifications", "bell"],
    ["email", "mail"],
    ["shopify", "store"],
    ["activity", "activity"],
    ["governance", "gear"],
  ] as const
).map(([id, icon]) => ({
  id,
  route: settingsRoutes[id] === null ? "connections" : "settings_section",
  section: settingsRoutes[id],
  icon,
}));
/** The Settings menu beside each settings page. */
export function SettingsMenu({
  workspaceId,
  current,
}: {
  readonly workspaceId: string;
  readonly current: SettingsSection | null;
}) {
  return (
    <nav className="sr-settings-menu" aria-label={sunriseCopy.settings.menu}>
      <p className="sr-settings-menu-title" aria-hidden="true">
        {sunriseCopy.settings.menu}
      </p>
      <ul>
        {settingsLinks.map((link) => (
          <li key={link.id}>
            <RouteLink
              route={link.route}
              params={
                link.section === null ? { workspaceId } : { workspaceId, section: link.section }
              }
              current={link.id === current}
              className="sr-settings-link"
            >
              <SrIcon name={link.icon} />
              {sunriseCopy.settings.items[link.id].title}
            </RouteLink>
          </li>
        ))}
      </ul>
      {/* The stop itself is on Activity, with what it stops and the typed confirmation. */}
      <div className="sr-settings-menu-stop">
        <RouteLink
          route="settings_section"
          params={{ workspaceId, section: settingsRoutes.activity! }}
          className="sr-settings-link sr-settings-link-stop"
        >
          <SrIcon name="stop" />
          {sunriseCopy.settings.stopAll}
        </RouteLink>
      </div>
    </nav>
  );
}
export const settingsSections = settingsLinks;
