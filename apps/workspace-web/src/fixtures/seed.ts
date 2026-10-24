// The Linen & Form sample (P14.T01a §4.11): synthetic data only (invariant 16).
// One workspace, three goals, six tasks and four questions. Creates append here, in
// memory, for the life of the page.
import type {
  ConnectionsView,
  GoalView,
  HomeSamplesView,
  PersonRef,
  QuestionView,
  StoreConnectionView,
  TaskView,
} from "@morrow/workspace-ui";

export const fixtureWorkspace = { id: "ws-linen", displayName: "Linen & Form", policyRevision: 7 };
export const fixtureOrganizationName = "Linen & Form (sample)";
// M3 PR-1: catalogue version 1 as GET /models lists it (docs/decisions/model-policy.json;
// credits per product and the run product limit). The Listings agent's store is M2 PR-2's
// sample store (fixtureStore below).
export const fixtureCatalogue = [
  { model: "claude_haiku_5_5", effort: "low", creditsPerProduct: 1, runProductLimit: 25 },
  { model: "claude_haiku_5_5", effort: "medium", creditsPerProduct: 1, runProductLimit: 25 },
  { model: "claude_haiku_5_5", effort: "high", creditsPerProduct: 1, runProductLimit: 25 },
  { model: "claude_sonnet_5_5", effort: "low", creditsPerProduct: 1, runProductLimit: 25 },
  { model: "claude_sonnet_5_5", effort: "medium", creditsPerProduct: 2, runProductLimit: 25 },
  { model: "claude_sonnet_5_5", effort: "high", creditsPerProduct: 3, runProductLimit: 19 },
  { model: "claude_opus_5_5", effort: "low", creditsPerProduct: 2, runProductLimit: 25 },
  { model: "claude_opus_5_5", effort: "medium", creditsPerProduct: 4, runProductLimit: 12 },
  { model: "claude_opus_5_5", effort: "high", creditsPerProduct: 6, runProductLimit: 9 },
] as const;
const person = (principalId: string): PersonRef => ({
  principalId,
  kind: "human",
  label: null,
  isSelf: null,
});
export const people = {
  owner: person("prn-sample-7f3a"),
  editor: person("prn-sample-2c91"),
  reviewer: person("prn-sample-b04e"),
};
const at = (day: number, hour: number) =>
  `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

export interface FixtureSeed {
  goals: GoalView[];
  tasks: TaskView[];
  questions: QuestionView[];
  answers: Record<string, { text: string; by: PersonRef; at: string }>;
  /** M2 PR-2: the workspace's one sample development store and the install-link offer. */
  connections: ConnectionsView;
}
// M2 PR-2: a synthetic development store (never a real shop) and the fixture continuation's
// fixed values. The token and the CSRF value only have the api guard's shape.
export const fixtureStore = {
  installationId: "inst-sample-1",
  connectionId: "conn-sample-1",
  storeId: "store-sample-1",
  shopDomain: "linen-and-form-dev.myshopify.com",
};
export const fixtureHandoffToken = "Hx" + "1".repeat(40) + "A";
export const fixtureCsrfToken = "Cx" + "2".repeat(40) + "A";
export const fixtureInstallUrl =
  "https://admin.shopify.com/oauth/install_custom_app?client_id=sample&signature=sample";
export function fixtureConnection(status: string): StoreConnectionView {
  return {
    ...fixtureStore,
    status,
    grantedScopes: ["read_products", "write_products"],
    updatedAt: at(16, 9),
  };
}
export function createSeed(): FixtureSeed {
  return {
    goals: [
      {
        id: "goal-autumn",
        objective: "Launch the autumn linen collection with accurate product details",
        status: "active",
        criteria: ["Every product page names its linen source", "Images reviewed by the owner"],
        owner: people.owner,
        revision: 3,
        updatedAt: at(12, 9),
      },
      {
        id: "goal-care",
        objective: "Publish clear care instructions for every linen item",
        status: "draft",
        criteria: ["Care guide covers washing and drying"],
        owner: people.editor,
        revision: 1,
        updatedAt: at(13, 14),
      },
      {
        id: "goal-returns",
        objective: "Shorten the returns policy page",
        status: "paused",
        criteria: ["Policy fits on one screen"],
        owner: people.owner,
        revision: 2,
        updatedAt: at(10, 11),
      },
    ],
    tasks: [
      {
        id: "task-titles",
        goalId: "goal-autumn",
        objective: "Draft product titles for the autumn range",
        status: "draft",
        owner: people.editor,
        revision: 2,
        updatedAt: at(14, 10),
      },
      {
        id: "task-source",
        goalId: "goal-autumn",
        objective: "Confirm the linen source with the supplier",
        status: "waiting_input",
        owner: people.owner,
        revision: 4,
        updatedAt: at(14, 16),
      },
      {
        id: "task-images",
        goalId: "goal-autumn",
        objective: "Choose the lead image for each product",
        status: "ready",
        owner: people.reviewer,
        revision: 1,
        updatedAt: at(15, 9),
      },
      {
        id: "task-care-copy",
        goalId: "goal-care",
        objective: "Write the washing guide",
        status: "draft",
        owner: people.editor,
        revision: 1,
        updatedAt: at(13, 15),
      },
      {
        id: "task-care-icons",
        goalId: "goal-care",
        objective: "Pick care symbols for the labels",
        status: "archived_by_future_version",
        owner: people.editor,
        revision: 1,
        updatedAt: at(13, 16),
      },
      {
        id: "task-returns",
        goalId: "goal-returns",
        objective: "Trim the returns page to one screen",
        status: "paused",
        owner: people.owner,
        revision: 3,
        updatedAt: at(10, 12),
      },
    ],
    questions: [
      {
        id: "q-source",
        taskId: "task-source",
        prompt: "Which supplier certificate should product pages cite?",
        status: "open",
        respondent: people.owner,
        revision: 1,
        updatedAt: at(14, 16),
        expiresAt: null,
      },
      {
        id: "q-images",
        taskId: "task-images",
        prompt: "Should the lead image show the garment folded or worn?",
        status: "open",
        respondent: people.owner,
        revision: 1,
        updatedAt: at(15, 9),
        expiresAt: null,
      },
      {
        id: "q-titles",
        taskId: "task-titles",
        prompt: "May titles include the colour name?",
        status: "answered",
        respondent: people.owner,
        revision: 2,
        updatedAt: at(14, 11),
        expiresAt: null,
      },
      {
        id: "q-returns",
        taskId: "task-returns",
        prompt: "Keep the 30-day window?",
        status: "cancelled",
        respondent: people.reviewer,
        revision: 2,
        updatedAt: at(10, 13),
        expiresAt: null,
      },
    ],
    answers: {
      "q-titles": {
        text: "Yes, after the product type: Linen Shirt, Off White.",
        by: people.owner,
        at: at(14, 11),
      },
    },
    connections: {
      installations: [fixtureConnection("linked")],
      installLink: { offered: false, url: null, reason: "linked" },
    },
  };
}

/**
 * ADR-0032 Home preview: the Sunrise brief's sample day at Linen & Form (a fictional shop),
 * for the board's sections that have no backend yet. Answered only where the scenario
 * composes `samples.home` (`home_preview`); synthetic, and labelled as samples on screen.
 */
export const fixtureHomeSamples: HomeSamplesView = {
  viewerName: "Maya",
  waiting: { review: 3, tasks: 1, alerts: 1 },
  creditsLeft: "1,240",
  projects: [
    {
      id: "proj-tote-ai",
      name: "Everyday Tote in AI answers",
      ends: "Dec 4",
      summary: "Page facts 11 of 12",
      health: "on_track",
    },
    {
      id: "proj-autumn",
      name: "Autumn collection",
      ends: "Nov 16",
      summary: "Launch Mon, Nov 2 · 2 of 3 products ready",
      health: "on_track",
    },
    {
      id: "proj-black-friday",
      name: "Black Friday sale",
      ends: "Nov 30",
      summary: "Sale starts Fri, Nov 27 · Sale plan due today",
      health: "working",
    },
  ],
  everyday: [
    {
      name: "Product pages",
      summary: "Every product has a complete listing · 94%",
      health: "on_track",
    },
    { name: "Stock", summary: "Best sellers with 2+ weeks of stock · 3 at risk", health: "behind" },
    {
      name: "Customer emails",
      summary: "Replied within a day · 9 of 10 this week",
      health: "on_track",
    },
    {
      name: "Sales and numbers",
      summary: "Repeat customers 18% · Goal 25% by Dec 31",
      health: "on_track",
    },
    { name: "Quick tasks", summary: "2 open · One-off jobs that fit nowhere else", health: null },
  ],
  team: {
    agents: [
      { agent: "listings", installationId: "inst-sample-listings" },
      { agent: "analyst", installationId: "inst-sample-analyst" },
      { agent: "inventory", installationId: "inst-sample-inventory" },
      { agent: "support", installationId: "inst-sample-support" },
    ],
    people: [
      { name: "Maya Chen", presence: "online" },
      { name: "Leo Martin", presence: "away" },
    ],
  },
  today: [
    {
      when: "11:00 am",
      title: "Size chart check for this week's new products",
      who: "Listings",
      agent: "listings",
      where: "Product pages",
      status: "done",
    },
    {
      when: "2:00 pm",
      title: "This week's numbers so far",
      who: "Business Analyst",
      agent: "analyst",
      where: "Sales and numbers",
      status: "working",
    },
    {
      when: "Due today",
      title: "Sale plan",
      who: "Sale planner",
      agent: "specialist",
      where: "Black Friday sale",
      status: "working",
    },
    {
      when: "5:00 pm",
      title: "Summary of open customer emails",
      who: "Support",
      agent: "support",
      where: "Customer emails",
      status: "to_do",
    },
  ],
  glance: {
    source: "From your Shopify orders · updated 8:00 am · Only people who can see orders see this",
    metrics: [
      { label: "Sales", value: "$1,284", note: "Up 12% on a usual Thursday" },
      { label: "Orders", value: "23", note: null },
      { label: "Average order", value: "$55.83", note: null },
      { label: "Refunds", value: "2", note: null },
    ],
    take: "Linen Shirt sold 9, the most in one day this month. Utility Overshirt has about 11 days of stock left at this pace.",
  },
  ideas: [
    {
      id: "idea-alt-text",
      agent: "listings",
      text: "12 Autumn photos have no description. Listings can write them for you to approve.",
      helps: "Helps Product pages reach 100% · About 4 credits",
    },
    {
      id: "idea-size-chart",
      agent: "analyst",
      text: "Linen Shirt refunds are 3 times higher than usual. A clearer size chart could help.",
      helps: "Helps Product pages · About 3 credits",
    },
    {
      id: "idea-slow-sellers",
      agent: "inventory",
      text: "6 products had no sales in 60 days. Inventory can suggest what to do with each one.",
      helps: "Helps Stock · About 2 credits",
    },
  ],
  recentAsks: [
    {
      asked: "Tell me each month which products stopped selling",
      when: "Today, 1:40 pm",
      outcome: "Drafted: repeating task in Stock",
    },
    {
      asked: "I want to rank in AI chat bots for one of my products",
      when: "Today, 10:30 am",
      outcome: "Started: Everyday Tote in AI answers",
    },
    { asked: "What sold best this week?", when: "Oct 22", outcome: "Answer only" },
  ],
};
