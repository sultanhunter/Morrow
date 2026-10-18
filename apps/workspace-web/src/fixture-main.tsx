// The fixture entry (P14.T01a §4.11): the only path to src/fixtures. It boots only in a
// `--mode fixture` build and only on 127.0.0.1 or localhost. No environment variable,
// query, storage key or header selects fixtures; `?scenario=` only picks a script, is
// read once and is stripped.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@morrow/workspace-ui/styles.css";
import { copy } from "@morrow/workspace-ui";
import { App, createAppRuntime } from "./app";
import { createFixtureAdapter, fixtureCanary, fixtureComposed } from "./fixtures/adapter";
import { fixtureBootAllowed, readScenario, scenarioNames } from "./fixtures/scenarios";
import { fixtureWorkspace } from "./fixtures/seed";
import { createPending } from "./pending";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
if (!fixtureBootAllowed(import.meta.env.MODE, window.location.hostname)) {
  root.textContent = "Fixture mode runs only in a fixture build on 127.0.0.1 or localhost.";
} else {
  const scenario = readScenario(window.location.search);
  if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
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
        composed={fixtureComposed}
        loginBodyVersion={2}
        assignLocation={(url) => {
          if (url === "/") window.location.assign("/");
        }}
        fixture={fixture}
      />
    </StrictMode>,
  );
}
