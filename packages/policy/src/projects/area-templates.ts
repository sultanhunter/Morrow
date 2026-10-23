import type {
  Current_AreaTemplateId,
  Current_CriteriaList,
  Current_EverydayAreaTemplate,
  Current_PlanStartRecords,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";

// ADR-0033 items 6 and 7: Everyday work areas come from fixed templates, closed data per
// first-party agent release (EverydayAreaTemplate@1), and Quick tasks is one built-in
// record per workspace. A person creates an area with one tap after adding its agent, at
// most one per template, on a card code builds with no model, so areas never wait on
// ADR-0034's plan-drafts switch. An area changes no agent package, install document or
// mandate; uninstalling the agent keeps the area and stops its routines. Repeating tasks
// stay off until a person turns them on (workspace.routine.activate, human_only).
//
// The release ids of the four agents after Listings are working ids until T12 publishes
// their packages; the goals and thresholds are working values until T5's catalogue and
// T17's merchant test (ADR-0033 item 12).

const template = (t: Current_EverydayAreaTemplate): Current_EverydayAreaTemplate => {
  if (!validateCurrentDefinition("EverydayAreaTemplate", t))
    throw new TypeError("AREA_TEMPLATE_INVALID");
  return Object.freeze(t);
};
const undated = { dueAt: null, startRef: null } as const;
export const everydayAreaTemplates: readonly Current_EverydayAreaTemplate[] = Object.freeze([
  template({
    schemaVersion: 1,
    id: "product_pages",
    releaseId: "morrow.listings",
    label: "Product pages",
    objective: "Every product has a complete listing",
    goal: {
      key: "pages_complete",
      description: "Every product has a complete listing",
      measure: {
        kind: "checklist",
        checklistId: "product_facts_complete",
        productIds: [],
        target: 100,
        ...undated,
      },
      direction: "at_least",
      onTrackThreshold: 90,
    },
    repeatingTasks: [
      { key: "facts_check", title: "Product facts check", cadence: "weekly", defaultOn: false },
    ],
  }),
  template({
    schemaVersion: 1,
    id: "stock",
    releaseId: "morrow.inventory",
    label: "Stock",
    objective: "No best seller runs out",
    goal: {
      key: "best_sellers_safe",
      description: "No best seller is at risk of running out",
      measure: { kind: "metric", metricId: "best_sellers_at_risk", target: 0, ...undated },
      direction: "at_most",
      onTrackThreshold: 0,
    },
    repeatingTasks: [
      { key: "stock_check", title: "Stock check", cadence: "daily", defaultOn: false },
      { key: "weekly_stock_list", title: "Weekly stock list", cadence: "weekly", defaultOn: false },
    ],
  }),
  template({
    schemaVersion: 1,
    id: "customer_emails",
    releaseId: "morrow.support",
    label: "Customer emails",
    objective: "Every customer gets a reply within a day",
    goal: {
      key: "replied_in_a_day",
      description: "Replied within a day",
      measure: { kind: "metric", metricId: "replied_within_a_day", target: 95, ...undated },
      direction: "at_least",
      onTrackThreshold: 90,
    },
    repeatingTasks: [
      { key: "inbox_check", title: "Customer email check", cadence: "daily", defaultOn: false },
    ],
  }),
  template({
    schemaVersion: 1,
    id: "sales_and_numbers",
    releaseId: "morrow.analyst",
    label: "Sales and numbers",
    objective: "Orders keep coming every week",
    goal: {
      key: "weekly_orders",
      description: "Orders a week",
      measure: { kind: "metric", metricId: "orders_per_week", target: 1, ...undated },
      direction: "at_least",
      onTrackThreshold: 1,
    },
    repeatingTasks: [
      { key: "weekly_numbers", title: "Weekly numbers", cadence: "weekly", defaultOn: false },
    ],
  }),
  template({
    schemaVersion: 1,
    id: "promotions",
    releaseId: "morrow.marketing",
    label: "Promotions",
    objective: "Promotions grow sales without giving margin away",
    goal: {
      key: "discount_share",
      description: "Orders with a discount",
      measure: { kind: "metric", metricId: "discounted_order_share", target: 30, ...undated },
      direction: "at_most",
      onTrackThreshold: 30,
    },
    repeatingTasks: [
      {
        key: "promotion_plan",
        title: "Weekly promotion plan",
        cadence: "weekly",
        defaultOn: false,
      },
    ],
  }),
]);

export type AreaId = Exclude<Current_AreaTemplateId, "quick_tasks">;
export function areaTemplate(id: Current_AreaTemplateId): Current_EverydayAreaTemplate | null {
  return everydayAreaTemplates.find((t) => t.id === id) ?? null;
}
/** The area an installed first-party release offers, if any. */
export function areaTemplateOfRelease(releaseId: string): Current_EverydayAreaTemplate | null {
  return everydayAreaTemplates.find((t) => t.releaseId === releaseId) ?? null;
}

/** The records one tap on an area card creates: the goal record and its unpinned project. */
export function areaStartRecords(id: AreaId): Current_PlanStartRecords {
  const t = areaTemplate(id);
  if (!t) throw new RangeError("AREA_TEMPLATE_UNKNOWN");
  const criteria: Current_CriteriaList = [
    {
      description: t.goal.description,
      verificationCapabilityId: null,
      evidenceRequired: false,
      key: t.goal.key,
      measure: t.goal.measure,
    },
  ];
  return {
    goal: { objective: t.objective, dueAt: null, areaTemplateId: t.id, successCriteria: criteria },
    project: { title: t.label, pin: false },
    tasks: [],
    repeating: [],
  };
}

/**
 * Quick tasks (ADR-0033 item 7): one built-in goal record per workspace, created at setup
 * by the Owner's tap, always open and unmeasured, so no task is loose. Its one criterion is
 * hidden and has no measure.
 */
export const quickTasksKey = "quick_tasks";
export function quickTasksStartRecords(): Current_PlanStartRecords {
  return {
    goal: {
      objective: "Quick tasks",
      dueAt: null,
      areaTemplateId: "quick_tasks",
      successCriteria: [
        {
          description: "One-off jobs that fit nowhere else",
          verificationCapabilityId: null,
          evidenceRequired: false,
          key: quickTasksKey,
          measure: null,
        },
      ],
    },
    project: { title: "Quick tasks", pin: false },
    tasks: [],
    repeating: [],
  };
}

export interface OpenQuickTask {
  readonly taskId: string;
  readonly productIds: readonly string[];
  readonly installationId: string | null;
}
export type MakeProjectIdea =
  | { readonly kind: "product"; readonly productId: string; readonly taskIds: readonly string[] }
  | {
      readonly kind: "agent";
      readonly installationId: string;
      readonly taskIds: readonly string[];
    };
/**
 * "Make a project?" (ADR-0033 item 7): a code rule, never Morrow. When 3 or more open
 * Quick tasks name one product, or go to one agent, it offers one idea: the product with
 * the most tasks first (ties by id), else the agent. It creates nothing.
 */
export function makeProjectIdea(open: readonly OpenQuickTask[]): MakeProjectIdea | null {
  const group = (key: (t: OpenQuickTask) => readonly string[]) => {
    const map = new Map<string, string[]>();
    for (const t of open)
      for (const k of new Set(key(t))) map.set(k, [...(map.get(k) ?? []), t.taskId]);
    return [...map.entries()]
      .filter(([, ids]) => ids.length >= 3)
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
  };
  const product = group((t) => t.productIds);
  if (product) return { kind: "product", productId: product[0], taskIds: product[1] };
  const agent = group((t) => (t.installationId === null ? [] : [t.installationId]));
  if (agent) return { kind: "agent", installationId: agent[0], taskIds: agent[1] };
  return null;
}
