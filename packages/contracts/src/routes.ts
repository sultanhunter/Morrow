// The only route matcher and builder (P14.T01a §4.3), ported from the retired P02
// navigation examples. Matching a path never authenticates or authorizes it: a
// match only selects a screen, and every record still needs a server decision.
import { workspaceRouteCatalogue } from "./generated/workspace-routes";

export interface RouteDefinition {
  readonly id: string;
  readonly pattern: string;
  readonly title: string;
  readonly hosts: readonly string[];
  readonly parent: string | null;
  readonly parameter_enums?: Readonly<Record<string, readonly string[]>>;
}
export interface RouteCatalogue {
  readonly version: number;
  readonly routes: readonly RouteDefinition[];
}
export interface RouteMatch {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}
export type RouteHost = "standalone" | "shopify_admin" | "shopify_connector" | "operator_console";
export type RouteId = (typeof workspaceRouteCatalogue.routes)[number]["id"];

/** The generated subset of docs/contracts/workspace-routes.json. */
export const workspaceRoutes: RouteCatalogue = workspaceRouteCatalogue;
/** The record Id pattern of contracts v1 (`core.schema.json#/$defs/Id`). */
export const routeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const parameterName = /:([A-Za-z][A-Za-z0-9]*)/g;
const parameterNames = (route: RouteDefinition) =>
  [...route.pattern.matchAll(parameterName)].map((m) => m[1]!);
const allowedValue = (route: RouteDefinition, key: string, value: string) => {
  const allowed = route.parameter_enums?.[key];
  return routeIdPattern.test(value) && (allowed === undefined || allowed.includes(value));
};

export function matchWorkspacePath(
  catalogue: RouteCatalogue,
  path: unknown,
  host: RouteHost = "standalone",
): RouteMatch | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  if (/[?#\\]/.test(path)) return null;
  const routes = catalogue.routes.filter((r) => r.hosts.includes(host));
  // Root case: "/" matches only the route whose pattern is "/", and that route
  // matches no other path.
  if (path === "/") {
    const root = routes.find((r) => r.pattern === "/");
    return root ? { id: root.id, params: {} } : null;
  }
  const segments = path.replace(/\/$/, "").split("/");
  const matches: { id: string; params: Record<string, string>; staticCount: number }[] = [];
  for (const route of routes) {
    if (route.pattern === "/") continue;
    const pattern = route.pattern.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let valid = true;
    let staticCount = 0;
    for (let i = 0; i < pattern.length; i++) {
      const part = pattern[i]!;
      const segment = segments[i]!;
      if (part.startsWith(":")) {
        const key = part.slice(1);
        let value: string;
        try {
          value = decodeURIComponent(segment);
        } catch {
          valid = false;
          break;
        }
        if (!allowedValue(route, key, value)) {
          valid = false;
          break;
        }
        params[key] = value;
      } else if (part !== segment) {
        valid = false;
        break;
      } else staticCount++;
    }
    if (valid) matches.push({ id: route.id, params, staticCount });
  }
  matches.sort((a, b) => b.staticCount - a.staticCount);
  const [best, next] = matches;
  if (!best || next?.staticCount === best.staticCount) return null;
  return { id: best.id, params: best.params };
}

export function buildWorkspacePath(
  catalogue: RouteCatalogue,
  id: string,
  params: Readonly<Record<string, string>> = {},
  host: RouteHost = "standalone",
): string {
  const route = catalogue.routes.find((r) => r.id === id);
  if (!route || !route.hosts.includes(host)) throw new Error("ROUTE_SURFACE_DENIED");
  const names = parameterNames(route);
  if (
    Object.keys(params).length !== names.length ||
    names.some((k) => typeof params[k] !== "string" || !allowedValue(route, k, params[k]!))
  )
    throw new Error("ROUTE_PARAMETERS_INVALID");
  const path = route.pattern.replace(parameterName, (_, key: string) =>
    encodeURIComponent(params[key]!),
  );
  if (matchWorkspacePath(catalogue, path, host)?.id !== id)
    throw new Error("ROUTE_PARAMETERS_INVALID");
  return path;
}

/** The route and its ancestors, nearest first (breadcrumbs, current destination). */
export function routeAncestry(catalogue: RouteCatalogue, id: string): readonly string[] {
  const chain: string[] = [];
  let current: string | null = id;
  while (current !== null && !chain.includes(current)) {
    chain.push(current);
    current = catalogue.routes.find((r) => r.id === current)?.parent ?? null;
  }
  return chain;
}

export function routeTitle(catalogue: RouteCatalogue, id: string): string | null {
  return catalogue.routes.find((r) => r.id === id)?.title ?? null;
}
