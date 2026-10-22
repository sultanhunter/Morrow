import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { canonicalJson } from "../digest.js";
import { runFieldsValid, type ListingField } from "./drafting.js";

// The built-in Coordinator (ADR-0022 items 2 and 3; mvp-architecture §2 step 7 and §12):
// deterministic code in the beta, no model call. It routes one Ask to the store's Listings
// installation and records the route as CoordinatorRoute@1 (ids only), which run admission
// stores with the run and SQL checks against the run's own columns. A model-based Coordinator
// later writes the same record.

export const listingsWorkflowVersion = "listings-run@1";
export interface CoordinatorRouteInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly childTaskId: string;
  readonly installationId: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly products: readonly string[];
  readonly fields: readonly ListingField[];
}
export interface CoordinatorRoute {
  readonly route: Readonly<Record<string, unknown>>;
  readonly canonical: string;
}

/** The route record and its RFC 8785 text. Throws on anything outside CoordinatorRoute@1. */
export function coordinatorRoute(input: CoordinatorRouteInput): CoordinatorRoute {
  if (!runFieldsValid(input.fields)) throw Error("COORDINATOR_ROUTE_INVALID");
  const route = {
    schemaVersion: 1,
    dispatcher: "builtin_coordinator",
    specialist: "morrow.listings",
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    taskId: input.taskId,
    childTaskId: input.childTaskId,
    installationId: input.installationId,
    storeId: input.storeId,
    connectionId: input.connectionId,
    products: [...input.products],
    fields: [...input.fields],
  };
  if (!validateCurrentDefinition("CoordinatorRoute", route))
    throw Error("COORDINATOR_ROUTE_INVALID");
  return Object.freeze({ route: Object.freeze(route), canonical: canonicalJson(route) });
}
