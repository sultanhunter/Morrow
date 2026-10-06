import { index, route, type RouteConfig } from "@react-router/dev/routes";
export default [
  index("routes/index.tsx"),
  route("dev/fixture", "routes/fixture.tsx"),
  route("auth/*", "routes/auth.tsx"),
] satisfies RouteConfig;
