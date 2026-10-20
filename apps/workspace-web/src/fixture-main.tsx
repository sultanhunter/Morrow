// The fixture entry (P14.T01a §4.11): the only path to src/fixtures. It boots only in a
// `--mode fixture` build and only on 127.0.0.1 or localhost. No environment variable,
// query, storage key or header selects fixtures; `?scenario=` only picks a script, is
// read once and is stripped (a fragment is kept for the app's own reading).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@morrow/workspace-ui/styles.css";
import { copy } from "@morrow/workspace-ui";
import { App, createAppRuntime } from "./app";
import { createFixtureAdapter, fixtureCanary, fixtureComposedFor } from "./fixtures/adapter";
import { fixtureChallengeFor } from "./fixtures/challenge";
import {
  fixtureBootAllowed,
  readScenario,
  scenarioNames,
  scenarioRoot,
} from "./fixtures/scenarios";
import { fixtureWorkspace } from "./fixtures/seed";
import { createPending } from "./pending";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
if (!fixtureBootAllowed(import.meta.env.MODE, window.location.hostname)) {
  root.textContent = "Fixture mode runs only in a fixture build on 127.0.0.1 or localhost.";
} else {
  const scenario = readScenario(window.location.search);
  // The fragment stays: an install continuation (M2 PR-2) is read by createAppRuntime.
  if (window.location.search)
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  // `/`, keeping a scenario that models the build's composition (a sign-in doesn't change it).
  const rootPath = scenarioRoot(scenario);
  // The re-entry scenario plants one text-free marker, as an earlier page load would have.
  if (scenario === "reentry") createPending().addMarker(fixtureWorkspace.id, "goal");
  const fixture = (
    <div className="fixture-controls" data-fixture={fixtureCanary}>
      <span>{copy.fixture}</span>
      <label>
        Scenario{" "}
        <select
          value={scenario}
          onChange={(event) =>
            window.location.assign(
              window.location.pathname + "?scenario=" + encodeURIComponent(event.target.value),
            )
          }
        >
          {scenarioNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
  createRoot(root).render(
    <StrictMode>
      <App
        runtime={createAppRuntime()}
        port={createFixtureAdapter(scenario)}
        composed={fixtureComposedFor(scenario)}
        loginBodyVersion={2}
        challenge={fixtureChallengeFor(scenario)}
        assignLocation={(url) => {
          if (url === "/") window.location.assign(rootPath);
        }}
        loadRoot={() => window.location.assign(rootPath)}
        fixture={fixture}
      />
    </StrictMode>,
  );
}
