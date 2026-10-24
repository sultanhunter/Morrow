// The Settings frame (ADR-0032; the ConnectStore, PlanCredits and SettingsActivity boards):
// a white sub-navigation card beside every settings screen. It lists the board's pages in
// order (Plan and credits, People and roles, Notifications, Email addresses, Shopify
// connection, Activity, Model default) and ends with Stop all AI work, which opens Activity,
// where the stop and its typed confirmation are. Activity sits here, under Settings, and
// never in the sidebar. The frame only links: each screen's actions are checked by the
// server.
import { useId, type ReactNode } from "react";
import { copy } from "../copy";
import type { Id } from "../model";
import { RouteLink } from "./controls";
import { Icon, type IconName } from "./display";

/** The Settings pages, in the board's order. */
export type SettingsPage =
  | "plan"
  | "people"
  | "notifications"
  | "email"
  | "shopify"
  | "activity"
  | "governance";
/**
 * Where each page lives in the route contract: a `settings_section` value, or null for the
 * store connection screens (`connections`). The contract's `settings_section` has six
 * values (people, governance, usage, billing, notifications, stores) and no `email` or
 * `activity`: until it does (a route-contract change, T7 PR 16's open question 1), Email
 * addresses uses `stores` (the shop's own addresses), Activity uses `governance` (the stops
 * and the record of who did what), and M3's model default moves to `billing` (what a
 * product may cost). One rename here re-homes each.
 */
export const settingsRoutes: Readonly<Record<SettingsPage, string | null>> = {
  plan: "usage",
  people: "people",
  notifications: "notifications",
  email: "stores",
  shopify: null,
  activity: "governance",
  governance: "billing",
};
const icons: Readonly<Record<SettingsPage, IconName>> = {
  plan: "credits",
  people: "agents",
  notifications: "bell",
  email: "mail",
  shopify: "store",
  activity: "activity",
  governance: "sliders",
};

export interface SettingsItem {
  readonly page: SettingsPage;
  /** The item's key: a `settings_section` value, or `connections`. */
  readonly key: string;
  readonly route: "settings_section" | "connections";
  readonly icon: IconName;
  readonly label: string;
}
/** The board's order, each on its contract destination. */
export const settingsItems: readonly SettingsItem[] = (
  Object.keys(settingsRoutes) as SettingsPage[]
).map((page) => {
  const section = settingsRoutes[page];
  return section === null
    ? {
        page,
        key: "connections",
        route: "connections",
        icon: icons[page],
        label: copy.settings.connection,
      }
    : {
        page,
        key: section,
        route: "settings_section",
        icon: icons[page],
        label: copy.settings.sections[section]!,
      };
});

/** The item a route sits under: a section by its parameter, the store screens by route. */
export function settingsCurrent(route: string, sectionParam: string | undefined): string | null {
  if (route === "connections" || route === "connection") return "connections";
  if (route !== "settings_section" || sectionParam === undefined) return null;
  return settingsItems.some((item) => item.key === sectionParam) ? sectionParam : null;
}

/** Whether a route renders inside the Settings frame. */
export function inSettings(route: string): boolean {
  return (
    route === "settings" ||
    route === "settings_section" ||
    route === "connections" ||
    route === "connection"
  );
}

export function SettingsNavigation({
  workspaceId,
  current,
}: {
  readonly workspaceId: Id;
  readonly current: string | null;
}) {
  const labelId = useId();
  return (
    <nav className="settings-nav" aria-labelledby={labelId}>
      <p id={labelId} className="settings-nav-label">
        {copy.settings.navLabel}
      </p>
      <ul className="settings-nav-list">
        {settingsItems.map((item) => (
          <li key={item.key}>
            <RouteLink
              route={item.route}
              params={
                item.route === "settings_section"
                  ? { workspaceId, section: item.key }
                  : { workspaceId }
              }
              current={item.key === current}
              className="settings-link"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </RouteLink>
          </li>
        ))}
      </ul>
      {/* The stop itself is on Activity, with what it stops and the typed confirmation. */}
      <div className="settings-nav-stop">
        <RouteLink
          route="settings_section"
          params={{ workspaceId, section: settingsRoutes.activity! }}
          className="settings-link settings-link-stop"
        >
          <Icon name="stop" />
          <span>{copy.settings.stopAll}</span>
        </RouteLink>
      </div>
    </nav>
  );
}

export function SettingsFrame({
  workspaceId,
  route,
  sectionParam,
  children,
}: {
  readonly workspaceId: Id;
  readonly route: string;
  readonly sectionParam?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-frame">
      <SettingsNavigation
        workspaceId={workspaceId}
        current={settingsCurrent(route, sectionParam)}
      />
      <div className="settings-content">{children}</div>
    </div>
  );
}
