import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FoundationNotice } from "@morrow/workspace-ui";
import { contractVersion } from "@morrow/contracts";
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <main>
      <FoundationNotice />
      <small>{contractVersion}</small>
    </main>
  </StrictMode>,
);
