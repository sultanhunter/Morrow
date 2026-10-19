// The production entry (P14.T01a §4.3): HTTP only. Fixture code is unreachable from
// here (`boundary-checks` rejects any import of src/fixtures outside fixture-main).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@morrow/workspace-ui/styles.css";
import { App, createAppRuntime } from "./app";
import { createHttpPort } from "./http/api";
import { createTurnstileChallengeHost } from "./http/challenge";
import { createClient } from "./http/client";
import { composed, loginBodyVersion } from "./http/composed";
import { isWorkosAuthorizeUrl } from "./http/identity-decoders";
import { navigationSignal } from "./router";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const client = createClient();
const port = createHttpPort({ client, composed, loginBodyVersion, navigationSignal });
// P05.T01ab: the sign-in start carries a Turnstile token when the api asks for one.
const challenge = createTurnstileChallengeHost({ client });
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
      loadRoot={() => window.location.assign("/")}
      challenge={challenge}
    />
  </StrictMode>,
);
