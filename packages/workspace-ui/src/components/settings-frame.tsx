// The Settings frame (ADR-0032; the ConnectStore and SettingsActivity boards): a white
// sub-navigation card beside every settings screen. Plan and credits, People and roles,
// Notifications, Model default and Shopify connection are the route contract's own
// destinations; their paths don't change. Activity sits here, under Settings and not in
// the sidebar, and stays a labelled placeholder until the activity log has a route. The
// frame only links: each screen's actions are checked by the server.
import { useId, type ReactNode } from "react";
import { copy } from "../copy";
import type { Id } from "../model";
import { RouteLink } from "./controls";
import { Icon, type IconName } from "./display";

export interface SettingsItem {
  /** The item's key: a `settings_section` value, or `connections`. */
  readonly key: string;
  readonly route: "settings_section" | "connections";
  readonly icon: IconName;
  readonly label: string;
}
const section = (key: string, icon: IconName): SettingsItem => ({
  key,
  route: "settings_section",
  icon,
  label: copy.settings.sections[key]!,
});
/** The board's order. Usage and Stores have no screen of their own yet. */
export const settingsItems: readonly SettingsItem[] = [
  section("billing", "credits"),
  section("people", "agents"),
  section("notifications", "bell"),
  section("governance", "sliders"),
  { key: "connections", route: "connections", icon: "store", label: copy.settings.connection },
];

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
        <li>
          <span className="settings-link is-later">
            <Icon name="activity" />
            <span>
              {copy.settings.activity}
              <span className="visually-hidden">{copy.settings.activityLater}</span>
            </span>
          </span>
        </li>
      </ul>
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
