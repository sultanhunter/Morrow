// P14.T01a §4.11: the production build has one input (index.html → main.tsx, HTTP only)
// and goes to dist/, which the api Worker serves through Static Assets. Only
// `--mode fixture` adds fixture.html, and that build goes outside the repository's dist
// to $MORROW_ARTIFACTS_DIR/workspace-web/fixture-dist. A module report of every chunk is
// written next to it (never into dist) for `verify:workspace-web`. No manifest is emitted.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const artifacts = () =>
  process.env.MORROW_ARTIFACTS_DIR
    ? resolve(process.env.MORROW_ARTIFACTS_DIR)
    : join(repository, ".artifacts");

// Repository-relative module names; virtual ids keep their leading NUL marker.
const moduleName = (id: string) => {
  const virtual = id.startsWith("\0");
  const raw = virtual ? id.slice(1) : id;
  const name = isAbsolute(raw) ? relative(repository, raw).split("\\").join("/") : raw;
  return (virtual ? "\0" : "") + name;
};
function moduleReport(name: string): Plugin {
  return {
    name: "morrow-module-report",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((item) => item.type === "chunk")
        .map((chunk) => ({
          fileName: chunk.fileName,
          isEntry: chunk.isEntry,
          moduleIds: Object.keys(chunk.modules).map(moduleName).sort(),
        }));
      const path = join(artifacts(), "workspace-web", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ generatedAt: new Date().toISOString(), chunks }, null, 2) + "\n",
      );
    },
  };
}

// Under fixture mode every page path serves fixture.html, in dev and in preview.
function fixturePages(): Plugin {
  const rewrite = (url: string | undefined) =>
    url &&
    !/^\/(?:@|src\/|node_modules\/|assets\/|fixture\.html)/.test(url) &&
    !/\.[a-z0-9]+(?:\?|$)/i.test(url);
  return {
    name: "morrow-fixture-pages",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (rewrite(request.url)) request.url = "/fixture.html";
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (rewrite(request.url)) request.url = "/fixture.html";
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const fixture = mode === "fixture";
  return {
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    preview: { host: "127.0.0.1", strictPort: true },
    plugins: fixture
      ? [fixturePages(), moduleReport("fixture-modules.json")]
      : [moduleReport("modules.json")],
    build: {
      sourcemap: false,
      manifest: false,
      emptyOutDir: true,
      outDir: fixture ? join(artifacts(), "workspace-web", "fixture-dist") : resolve(here, "dist"),
      rollupOptions: {
        input: fixture
          ? { fixture: resolve(here, "fixture.html") }
          : { main: resolve(here, "index.html") },
      },
    },
  };
});
