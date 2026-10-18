// The production entry (P14.T01a §4.3): HTTP only. Fixture code is unreachable from
// here (`boundary-checks` rejects any import of src/fixtures outside fixture-main).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@morrow/workspace-ui/styles.css";
import { App, createAppRuntime } from "./app";
import { createHttpPort } from "./http/api";
import { createClient } from "./http/client";
import { composed, loginBodyVersion } from "./http/composed";
import { isWorkosAuthorizeUrl } from "./http/identity-decoders";
import { navigationSignal } from "./router";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const port = createHttpPort({
  client: createClient(),
  composed,
  loginBodyVersion,
  navigationSignal,
});
// Sign-in leaves only for the pinned WorkOS authorize endpoint.
const assignLocation = (url: string) => {
  if (isWorkosAuthorizeUrl(url)) window.location.assign(url);
};
createRoot(root).render(
  <StrictMode>
    <App
      runtime={createAppRuntime()}
      port={port}
      composed={composed}
      loginBodyVersion={loginBodyVersion}
      assignLocation={assignLocation}
    />
  </StrictMode>,
);
