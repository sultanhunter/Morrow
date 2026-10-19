// Local workerd fixture only; never deployed or imported by an application.
import {
  validators,
  validateEventPayload,
} from "../../packages/contracts/src/generated/runtime-validators.mjs";
import { validateCurrentDefinition } from "../../packages/contracts/src/validation";
import { createNeonIdentityClient, withNeonIdentityRead } from "../../packages/identity/src/neon";
import { withDriverIdentityRead } from "../../packages/identity/src/neon-request";
import { identitySql } from "../../packages/identity/src/index";
import { previewSelection } from "../../packages/policy/src/review";

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/validators") {
      const corpus = (await request.json()) as unknown[];
      return Response.json(
        Object.fromEntries(
          Object.entries(validators).map(([key, validator]) => [
            key,
            corpus.map((value) => validator(value)),
          ]),
        ),
      );
    }
    // P01.T02c (ADR-0016): exact-selector cases, the event registry selector and
    // the current-definition rules beyond the schemas.
    if (path === "/collaboration") {
      const { schema, events, current, payloads } = (await request.json()) as {
        schema: { selector: string; value: unknown }[];
        events: unknown[];
        current: { definition: "AskAdminReadRecord"; value: unknown }[];
        payloads: { eventType: string; aggregateType: string; payload: unknown }[];
      };
      return Response.json({
        schema: schema.map(({ selector, value }) =>
          Object.hasOwn(validators, selector) ? validators[selector]!(value) : null,
        ),
        events: events.map((envelope) => validateCurrentDefinition("EventEnvelope", envelope)),
        current: current.map(({ definition, value }) =>
          validateCurrentDefinition(definition, value),
        ),
        payloads: payloads.map(({ eventType, aggregateType, payload }) =>
          validateEventPayload(eventType, aggregateType, payload),
        ),
      });
    }
    // P01.T02a: the deterministic derived proposal, compared with Node by the lab.
    if (path === "/review-preview") {
      const { parent, selections } = (await request.json()) as {
        parent: Parameters<typeof previewSelection>[0];
        selections: Parameters<typeof previewSelection>[1][];
      };
      return Response.json(selections.map((selection) => previewSelection(parent, selection)));
    }
    if (path === "/sdk") {
      const binding = {
        environment: "staging" as const,
        projectId: "fixture-project",
        branchId: "br-fixture",
        hostname: "ep-fixture.us-east-2.aws.neon.tech",
        database: "morrow",
      };
      const client = createNeonIdentityClient(binding, "synthetic-" + "x".repeat(16));
      let invalidProof = false,
        dynamicCodeDenied = false;
      try {
        await withNeonIdentityRead(
          binding,
          "synthetic-" + "x".repeat(16),
          "invalid",
          "workspace_a",
          async () => true,
        );
      } catch (error) {
        invalidProof = (error as { code: string }).code === "IDENTITY_DENIED";
      }
      try {
        new Function("return 1")();
      } catch {
        dynamicCodeDenied = true;
      }
      return Response.json({
        secure: client.neonConfig.useSecureWebSocket,
        proxy: client.neonConfig.wsProxy,
        invalidProof,
        dynamicCodeDenied,
      });
    }
    if (path === "/identity-a" || path === "/identity-b") {
      const tenant = path.endsWith("a") ? "a" : "b";
      let closed = false;
      const driver = {
        on() {
          return this;
        },
        async connect() {},
        async end() {
          closed = true;
        },
        async query(text: string) {
          if (text === identitySql.role)
            return {
              rows: [
                {
                  role: "morrow_api",
                  login: "morrow_api",
                  rolsuper: false,
                  rolbypassrls: false,
                  rolcreatedb: false,
                  rolcreaterole: false,
                  owner_member: false,
                },
              ],
            };
          if (text === identitySql.resolve)
            return {
              rows: [
                {
                  principal_id: `human_${tenant}`,
                  organization_id: `org_${tenant}`,
                  workspace_id: `workspace_${tenant}`,
                  membership_id: `membership_${tenant}`,
                  policy_revision: "1",
                },
              ],
            };
          if (text === identitySql.workspace)
            return {
              rows: [
                {
                  id: `workspace_${tenant}`,
                  organization_id: `org_${tenant}`,
                  display_name: "Synthetic fixture",
                },
              ],
            };
          return { rows: [] };
        },
      };
      const workspace = await withDriverIdentityRead(
        () => driver,
        tenant.repeat(64),
        `workspace_${tenant}`,
        (scope) => scope.readWorkspace(),
      );
      return Response.json({ organizationId: workspace.organizationId, closed });
    }
    return new Response(null, { status: 404 });
  },
};
