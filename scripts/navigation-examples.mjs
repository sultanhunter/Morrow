// P02 URL examples only. Matching a URL never authenticates or authorizes it.
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const parameterNames = (route) =>
  [...route.pattern.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
export function buildWorkspacePath(catalogue, id, params = {}, host = "standalone") {
  const route = catalogue.routes.find((r) => r.id === id);
  if (!route || !route.hosts.includes(host)) throw new Error("ROUTE_SURFACE_DENIED");
  const names = parameterNames(route);
  if (
    Object.keys(params).length !== names.length ||
    names.some(
      (k) =>
        typeof params[k] !== "string" ||
        !idPattern.test(params[k]) ||
        (route.parameter_enums?.[k] && !route.parameter_enums[k].includes(params[k])),
    )
  )
    throw new Error("ROUTE_PARAMETERS_INVALID");
  const path = route.pattern.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, key) =>
    encodeURIComponent(params[key]),
  );
  if (matchWorkspacePath(catalogue, path, host)?.id !== id)
    throw new Error("ROUTE_PARAMETERS_INVALID");
  return path;
}
export function matchWorkspacePath(catalogue, path, host = "standalone") {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\\]/.test(path)
  )
    return null;
  const segments = path.replace(/\/$/, "").split("/");
  const matches = [];
  for (const route of catalogue.routes.filter((r) => r.hosts.includes(host))) {
    const pattern = route.pattern.split("/");
    if (pattern.length !== segments.length) continue;
    const params = {};
    let valid = true,
      staticCount = 0;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(":")) {
        const key = pattern[i].slice(1);
        let value;
        try {
          value = decodeURIComponent(segments[i]);
        } catch {
          valid = false;
          break;
        }
        if (
          !idPattern.test(value) ||
          (route.parameter_enums?.[key] && !route.parameter_enums[key].includes(value))
        ) {
          valid = false;
          break;
        }
        params[key] = value;
      } else if (pattern[i] !== segments[i]) {
        valid = false;
        break;
      } else staticCount++;
    }
    if (valid) matches.push({ id: route.id, params, staticCount });
  }
  matches.sort((a, b) => b.staticCount - a.staticCount);
  if (!matches.length || matches[1]?.staticCount === matches[0].staticCount) return null;
  const { id, params } = matches[0];
  return { id, params };
}
