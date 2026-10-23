// The Linen & Form project sample (T7 PR 19): synthetic data only, as the Sunrise boards
// draw it (Friday, October 23, 2026; Maya Chen is the Owner, Leo Martin a member). Every
// sentence a server would write from its templates is written here by hand. Fixture
// code: reachable only from fixture-main.tsx.
import type {
  AlertRowView,
  GoalCheckView,
  GoalDetailView,
  MemberView,
  PlanCardView,
  ProjectDetailView,
  ProjectMessageView,
  ProjectRowView,
  ProjectTaskRowView,
  RepeatingRowView,
  RepeatingView,
} from "@morrow/workspace-ui";

export const members = {
  morrow: { kind: "morrow", name: "Morrow", role: null },
  maya: { kind: "person", name: "Maya Chen", role: "Owner" },
  leo: { kind: "person", name: "Leo Martin", role: "Member" },
  listings: { kind: "agent", name: "Listings", role: null },
  analyst: { kind: "agent", name: "Business Analyst", role: null },
  inventory: { kind: "agent", name: "Inventory", role: null },
  support: { kind: "agent", name: "Support", role: null },
  checkup: { kind: "specialist", name: "AI answers check-up", role: null },
  salePlanner: { kind: "specialist", name: "Sale planner", role: null },
} as const satisfies Readonly<Record<string, MemberView>>;
const m = members;

export const health = (word: string, reason: string | null = null) => ({ word, reason });

/** The 12 facts of "Product facts complete" (ADR-0033 item 3). */
export function pageFacts(missing: readonly string[]): readonly GoalCheckView[] {
  return [
    "A title that names the product type",
    "Material",
    "Size",
    "What fits inside",
    "Care",
    "Colour",
    "The most specific product category",
    "At least 3 photos",
    "A description on every photo",
    "A search listing title",
    "A search listing description",
    "At least 3 shopper questions and answers in the description",
  ].map((label) => ({
    label,
    done: !missing.includes(label),
    note: label === "At least 3 photos" && missing.includes(label) ? "Has 2" : null,
  }));
}
export const buyingQuestions = (product: string) => [
  `What’s a good linen ${product.toLowerCase().includes("tote") ? "tote" : "shirt"} for work?`,
  `Best ${product} for everyday use?`,
  `Is a ${product} strong enough for daily use?`,
  `Which ${product} looks smart and lasts?`,
  `What size ${product} do I need?`,
];
export const cannotDo = [
  "Promise a mention. No one can.",
  "Look at ChatGPT or Google answers, so you do the monthly check.",
  "See whether your product is offered in AI channels. You check that in Shopify (step 1).",
  "Add store pages or change your theme. Questions and answers go in the product description.",
];

// ---- The Projects page
export const datedRows: readonly ProjectRowView[] = [
  {
    projectId: "project-autumn",
    goalId: "goal-pj-autumn",
    title: "Autumn collection",
    endsOn: "2026-11-16",
    note: "2 changes need you",
    mainGoal: { title: "3 products ready for launch", value: "2 of 3 ready · launch Mon, Nov 2" },
    moreGoals: [],
    health: health("on_track"),
    members: [m.morrow, m.maya, m.leo, m.listings, m.inventory, m.analyst],
    credits: { used: 152, planned: "About 200 to 300 planned" },
  },
  {
    projectId: "project-tote",
    goalId: "goal-pj-tote",
    title: "Everyday Tote in AI answers",
    endsOn: "2026-12-04",
    note: "Started today",
    mainGoal: {
      title: "Everyday Tote’s page is complete",
      value: "11 of 12 facts · goal 12 of 12 by Fri, Nov 13",
    },
    moreGoals: ["AI assistants name it · first check Mon, Nov 2"],
    health: health("on_track"),
    members: [m.morrow, m.maya, m.listings, m.analyst],
    credits: { used: 36, planned: "About 60 to 100 planned" },
  },
  {
    projectId: "project-bfcm",
    goalId: "goal-pj-bfcm",
    title: "Black Friday sale",
    endsOn: "2026-11-30",
    note: "1 question needs you",
    mainGoal: {
      title: "A sale plan: up to 20% off, every item still in profit",
      value: "Plan due today · Sale planner finishes by 3:00 pm",
    },
    moreGoals: [],
    health: health("not_started", "The sale starts Fri, Nov 27."),
    members: [m.morrow, m.maya, m.salePlanner, m.inventory],
    credits: { used: 56, planned: "About 150 to 250 planned" },
  },
  {
    projectId: "project-summer",
    goalId: "goal-pj-summer",
    title: "Summer linen clearance",
    endsOn: "2026-10-21",
    note: "Ended · choose Finish or Extend",
    mainGoal: { title: "Summer stock sold through", value: "212 of 240 sold · goal 200 by Oct 21" },
    moreGoals: [],
    health: health("needs_you", "It reached its end date. Choose Finish or Extend."),
    members: [m.morrow, m.maya, m.inventory, m.analyst],
    credits: { used: 88, planned: "About 80 to 120 planned" },
  },
];
export const areaRows = [
  {
    projectId: "area-pages",
    goalId: "goal-area-pages",
    label: "Product pages",
    agent: m.listings,
    note: null,
    goal: {
      title: "Every product has a complete listing",
      value: "94% of products, up from 71% last week",
    },
    health: health("on_track"),
    repeating: 2,
    alerts: 0,
    creditsThisMonth: 48,
  },
  {
    projectId: "area-stock",
    goalId: "goal-area-stock",
    label: "Stock",
    agent: m.inventory,
    note: "1 question needs you",
    goal: { title: "Best sellers with 2+ weeks of stock", value: "3 best sellers at risk, down from 7" },
    health: health("behind", "At this pace, 3 best sellers could sell out within 2 weeks."),
    repeating: 1,
    alerts: 1,
    creditsThisMonth: 40,
  },
  {
    projectId: "area-emails",
    goalId: "goal-area-emails",
    label: "Customer emails",
    agent: m.support,
    note: "1 reply needs you",
    goal: { title: "Replied within a day", value: "9 of 10 this week" },
    health: health("on_track"),
    repeating: 1,
    alerts: 1,
    creditsThisMonth: 196,
  },
  {
    projectId: "area-sales",
    goalId: "goal-area-sales",
    label: "Sales and numbers",
    agent: m.analyst,
    note: null,
    goal: { title: "Repeat customers", value: "18% of orders · goal 25% by Dec 31" },
    health: health("on_track"),
    repeating: 3,
    alerts: 1,
    creditsThisMonth: 104,
  },
];
export const quickTasksRow = { projectId: "area-quick", goalId: "goal-area-quick", open: 2, creditsThisMonth: 42 };
export const starters = [
  "Get the Linen Shirt into AI answers",
  "Launch our winter scarves on Mon, Dec 7",
  "Sell through summer stock before Black Friday",
];

/** The Tasks tab, and the work API tasks behind it (same ids). */
export const taskRows: readonly ProjectTaskRowView[] = [
  {
    taskId: "task-pj-autumn-pages",
    title: "Write pages for 3 Autumn products",
    owner: m.listings,
    projectId: "project-autumn",
    projectTitle: "Autumn collection",
    bucket: "needs_you",
    when: "2 changes to review · expire Mon, Oct 26",
    note: null,
    mine: true,
  },
  {
    taskId: "task-pj-reorder",
    title: "Reorder Utility Overshirt",
    owner: m.inventory,
    projectId: "area-stock",
    projectTitle: "Stock",
    bucket: "needs_you",
    when: null,
    note: "1 question: order 50, or wait?",
    mine: true,
  },
  {
    taskId: "task-pj-reply",
    title: "Reply to Hannah K. about order 1042",
    owner: m.support,
    projectId: "area-emails",
    projectTitle: "Customer emails",
    bucket: "needs_you",
    when: "Draft to review · Expires in 14 hours",
    note: null,
    mine: true,
  },
  {
    taskId: "task-pj-photo",
    title: "Add a photo of the Everyday Tote in use",
    owner: m.maya,
    projectId: "project-tote",
    projectTitle: "Everyday Tote in AI answers",
    bucket: "to_do",
    when: "When you’re ready",
    note: "Page fact 12 of 12",
    mine: true,
  },
  {
    taskId: "task-pj-check",
    title: "Check AI answers in ChatGPT",
    owner: m.maya,
    projectId: "project-tote",
    projectTitle: "Everyday Tote in AI answers",
    bucket: "to_do",
    when: "Mon, Nov 2 · Repeats every 4 weeks",
    note: null,
    mine: true,
  },
  {
    taskId: "task-pj-hours",
    title: "Update holiday hours on your Contact page",
    owner: m.maya,
    projectId: "area-quick",
    projectTitle: "Quick tasks",
    bucket: "to_do",
    when: "Due Fri, Oct 30",
    note: null,
    mine: true,
  },
  {
    taskId: "task-pj-overshirt-photo",
    title: "Photograph the Utility Overshirt being worn",
    owner: m.leo,
    projectId: "project-autumn",
    projectTitle: "Autumn collection",
    bucket: "to_do",
    when: "Due Tue, Oct 27",
    note: null,
    mine: false,
  },
  {
    taskId: "task-pj-sale-plan",
    title: "Plan the Black Friday sale",
    owner: m.salePlanner,
    projectId: "project-bfcm",
    projectTitle: "Black Friday sale",
    bucket: "working",
    when: "Finishes by 3:00 pm",
    note: "1 question needs you",
    mine: true,
  },
  {
    taskId: "task-pj-numbers",
    title: "This week’s numbers so far",
    owner: m.analyst,
    projectId: "area-sales",
    projectTitle: "Sales and numbers",
    bucket: "working",
    when: "Started 2:00 pm · Repeats every Friday",
    note: null,
    mine: false,
  },
  {
    taskId: "task-pj-review",
    title: "Review the Everyday Tote changes",
    owner: m.maya,
    projectId: "project-tote",
    projectTitle: "Everyday Tote in AI answers",
    bucket: "done_today",
    when: "11:52 am · 4 changes updated in Shopify",
    note: null,
    mine: true,
  },
  {
    taskId: "task-pj-listings",
    title: "Update description, search listing, tags and photo descriptions",
    owner: m.listings,
    projectId: "project-tote",
    projectTitle: "Everyday Tote in AI answers",
    bucket: "done_today",
    when: "11:52 am · Written by Listings · Approved by Maya Chen",
    note: null,
    mine: true,
  },
  {
    taskId: "task-pj-checkup",
    title: "Check the page against the 5 buying questions",
    owner: m.checkup,
    projectId: "project-tote",
    projectTitle: "Everyday Tote in AI answers",
    bucket: "done_today",
    when: "11:12 am · 16 credits used, 24 came back",
    note: null,
    mine: true,
  },
];

const repeatingRows: readonly RepeatingRowView[] = [
  ["rep-launch", "Launch-week stock check", m.inventory, "project-autumn", "Autumn collection", "Every day, Nov 2 to Nov 8, at 7:00 am", "Mon, Nov 2, 7:00 am", "About 10", "active", null],
  ["rep-ai-check", "Check AI answers in ChatGPT", m.maya, "project-tote", "Everyday Tote in AI answers", "Every 4 weeks on Monday", "Mon, Nov 2", "None: you do it", "active", "About 8 minutes"],
  ["rep-catalog", "Catalog check", m.listings, "area-pages", "Product pages", "Every Monday at 9:00 am", "Mon, Oct 26, 9:00 am", "About 12", "active", null],
  ["rep-size", "Size chart check for this week’s new products", m.listings, "area-pages", "Product pages", "Every Friday at 11:00 am", "Fri, Oct 30, 11:00 am", "About 10", "active", null],
  ["rep-stock", "Daily stock check", m.inventory, "area-stock", "Stock", "Every weekday at 6:00 am", "Mon, Oct 26, 6:00 am", "About 20", "active", "Turned on by Maya Chen, Oct 6"],
  ["rep-emails", "Summary of open customer emails", m.support, "area-emails", "Customer emails", "Every day at 5:00 pm", "Today, 5:00 pm", "About 45", "active", null],
  ["rep-morning", "Morning summary", m.analyst, "area-sales", "Sales and numbers", "Every day at 8:00 am", "Tomorrow, 8:00 am", "About 30", "active", null],
  ["rep-week", "This week’s numbers so far", m.analyst, "area-sales", "Sales and numbers", "Every Friday at 2:00 pm", "Now", "About 8", "working", null],
  ["rep-review", "Weekly review", m.analyst, "area-sales", "Sales and numbers", "Every Monday at 8:00 am", "Mon, Oct 26, 8:00 am", "About 12", "active", null],
].map(([id, title, owner, projectId, projectTitle, schedule, next, credits, status, note]) => ({
  id: id as string,
  title: title as string,
  owner: owner as MemberView,
  projectId: projectId as string,
  projectTitle: projectTitle as string,
  schedule: schedule as string,
  next: next as string,
  credits: credits as string,
  status: status as string,
  note: note as string | null,
}));
const alertRows: readonly AlertRowView[] = [
  {
    id: "alert-stock",
    title: "When a best seller has less than 2 weeks of stock, tell me",
    owner: m.inventory,
    projectId: "area-stock",
    projectTitle: "Stock",
    watches: "Best sellers with 2+ weeks of stock",
    lastTold: "Today, 6:05 am · Linen Apron",
    status: "active",
    note: "Turned on Oct 9 · Checked every hour · No credits",
  },
  {
    id: "alert-emails",
    title: "When a customer email waits more than 20 hours, tell me",
    owner: m.support,
    projectId: "area-emails",
    projectTitle: "Customer emails",
    watches: "Replied within a day",
    lastTold: null,
    status: "active",
    note: null,
  },
  {
    id: "alert-refunds",
    title: "When a product’s refunds are more than twice the usual, tell me",
    owner: m.analyst,
    projectId: "area-sales",
    projectTitle: "Sales and numbers",
    watches: "Refund counts by product",
    lastTold: "Today, 8:00 am · Linen Shirt",
    status: "active",
    note: null,
  },
];
export const repeatingView: RepeatingView = {
  waiting: [
    {
      messageId: "msg-draft-no-sales",
      title: "Check products with no sales in 60 days",
      owner: m.inventory,
      projectTitle: "Stock",
      when: "On the 1st of each month at 9:00 am",
      youGet:
        "A list in Stock, with what Inventory suggests for each product. Nothing changes in your store without your OK.",
      credits: "About 6 a month",
      drafted: "Drafted by Morrow from your request at 1:40 pm. Nothing repeats until you turn it on.",
    },
  ],
  repeating: repeatingRows,
  alerts: alertRows,
};

// ---- Projects and areas
const areaLinks = [
  ...areaRows.map((a) => ({ projectId: a.projectId, label: a.label })),
  { projectId: quickTasksRow.projectId, label: "Quick tasks" },
];
const allActions = {
  planNextSteps: true,
  stopSteps: true,
  finish: false,
  extend: false,
  post: true,
  mentionMorrow: true,
};

const toteGoals: readonly GoalDetailView[] = [
  {
    key: "page_facts",
    title: "Everyday Tote’s page is complete",
    measure: "checklist",
    value: "11 of 12 facts",
    target: "Goal 12 of 12 by Fri, Nov 13",
    start: "Was 5 at the start, today at 10:32 am",
    source: "Checklist · counted from your Shopify product · updated 11:52 am",
    health: health(
      "on_track",
      "Ahead of a steady pace from 5 to 12 by Nov 13. The last fact is a third photo.",
    ),
    how: "A checklist of 12 facts, counted by code from your Shopify product. No agent decides this number.",
    checks: pageFacts(["At least 3 photos"]),
    questions: [],
    rows: [],
    steps: [
      {
        label: "Step 3 · Update description, search listing, tags and photo descriptions",
        owner: m.listings,
        status: "done",
      },
      { label: "Step 6 · Add a photo of the Everyday Tote in use", owner: m.maya, status: "to_do" },
    ],
  },
  {
    key: "ai_named",
    title: "AI assistants name the Everyday Tote",
    measure: "manual",
    value: null,
    target: "Goal: named in 2 of 5 buying questions, in one monthly check, by Fri, Dec 4",
    start: "First check Mon, Nov 2",
    source: "Checked by you in ChatGPT, the same assistant every month · about 8 minutes",
    health: health(
      "not_checked_yet",
      "Your first check is Mon, Nov 2. That first result is the starting point; health words start from the second check.",
    ),
    how: "Checked by you in ChatGPT, the same assistant every month, in a new chat that doesn’t use your history. It takes about 8 minutes, and a phone is fine. Answers change from one check to the next, so this goal is judged only on check dates.",
    checks: [],
    questions: buyingQuestions("Everyday Tote"),
    rows: [],
    steps: [{ label: "Step 5 · Check AI answers in ChatGPT", owner: m.maya, status: "to_do" }],
  },
];

function dated(
  row: ProjectRowView,
  detail: Partial<ProjectDetailView>,
): ProjectDetailView {
  return {
    projectId: row.projectId,
    goalId: row.goalId,
    revision: 3,
    kind: "dated",
    title: row.title,
    area: null,
    areas: [],
    state: "active",
    endsOn: row.endsOn,
    extendTo: null,
    health: row.health,
    scope: [],
    stopped: null,
    stopPreview: null,
    sinceLastVisit: null,
    goals: [],
    plan: [],
    latestUpdate: null,
    updateNote: "Your first update arrives Mon, Oct 26 at 8:00 am.",
    credits: null,
    brief: null,
    files: [],
    activity: [],
    repeating: [],
    alerts: [],
    members: row.members.map((member) => ({ member, note: null })),
    results: null,
    finish: null,
    actions: allActions,
    ...detail,
  };
}

export function projectDetails(): Map<string, ProjectDetailView> {
  const rows = new Map(datedRows.map((r) => [r.projectId, r]));
  const tote = dated(rows.get("project-tote")!, {
    scope: [
      "Started today",
      "Ends Fri, Dec 4",
      "First update Mon, Oct 26, 8:00 am",
      "Credits: 36 used, about 60 to 100 planned",
    ],
    stopPreview: "the monthly AI answers check turns off and step 6 is cancelled. Nothing is waiting for approval.",
    sinceLastVisit: {
      lastVisit: "today at 11:31 am",
      items: [
        {
          title: "Everyday Tote’s page updated in Shopify",
          detail: "Description, search listing, tags and 2 photo descriptions · Written by Listings · Approved by Maya Chen",
          at: "11:52 am",
          health: null,
        },
        {
          title: "Page facts went from 5 to 11 of 12",
          detail: "1 left: at least 3 photos. That’s step 6, and it’s yours.",
          at: "11:52 am",
          health: health("on_track"),
        },
      ],
    },
    goals: toteGoals,
    plan: [
      { index: 1, title: "Check the Everyday Tote is offered in Shopify’s AI channels", owner: m.maya, status: "done", detail: "Marked done 10:36 am", repeats: false, taskId: null },
      { index: 2, title: "Check the page against the 5 buying questions", owner: m.checkup, status: "done", detail: "Found 7 gaps · 16 credits used, 24 came back · Its access ends tomorrow at 10:33 am", repeats: false, taskId: "task-pj-checkup" },
      { index: 3, title: "Update description, search listing, tags and photo descriptions", owner: m.listings, status: "done", detail: "4 changes · 20 credits", repeats: false, taskId: "task-pj-listings" },
      { index: 4, title: "Review the changes", owner: m.maya, status: "done", detail: "Approved 4 changes at 11:52 am", repeats: false, taskId: "task-pj-review" },
      { index: 5, title: "Check AI answers in ChatGPT", owner: m.maya, status: "to_do", detail: "First Mon, Nov 2, then every 4 weeks · about 8 minutes", repeats: true, taskId: "task-pj-check" },
      { index: 6, title: "Add a photo of the Everyday Tote in use", owner: m.maya, status: "to_do", detail: "When you’re ready · the last page fact · from the check-up", repeats: false, taskId: "task-pj-photo" },
    ],
    credits: {
      used: 36,
      planned: "about 60 to 100",
      byHelper: [
        { name: "AI answers check-up", line: "16 used · 24 came back" },
        { name: "Listings", line: "20 used" },
      ],
      balance: "You have 1,202 credits left until Nov 1.",
      note: null,
    },
    brief: {
      byline: "Written by Morrow from Maya Chen’s request · started by Maya Chen · Oct 23, 2026",
      why: "Shoppers ask AI assistants what to buy. A page that answers their questions gives the assistants something to name.",
      doneWhen:
        "The Everyday Tote’s page has all 12 facts by Fri, Nov 13, and ChatGPT names it in at least 2 of the 5 buying questions, in one monthly check, by Fri, Dec 4.",
      honesty:
        "No one can promise that AI assistants will name the Everyday Tote. What helps most is a page with complete, specific facts and clear answers to what shoppers ask, then checking every month.",
      questions: buyingQuestions("Everyday Tote"),
      cannotDo,
      whoSees:
        "Your team sees this project, its plan and its conversation. Sales numbers show only to people who can see orders.",
    },
    files: [
      {
        id: "file-checkup",
        title: "AI answers check-up report",
        from: "From the AI answers check-up, a one-time specialist · Oct 23, 11:12 am · Found 7 gaps",
        note: "Morrow doesn’t read check-up reports. Listings used this one as a source, and every change it suggested said so.",
      },
    ],
    activity: [
      { at: "11:54 am", text: "Plan changed by Maya Chen: added step 6, Add a photo of the Everyday Tote in use." },
      { at: "11:52 am", text: "Maya Chen approved 4 changes. All 4 updated in Shopify, checked after saving." },
      { at: "11:31 am", text: "Listings suggested 4 changes for the Everyday Tote." },
      { at: "11:13 am", text: "Maya Chen let Listings start step 3." },
      { at: "11:12 am", text: "AI answers check-up finished. Found 7 gaps. 16 credits used, 24 came back." },
      { at: "10:36 am", text: "Maya Chen marked step 1 done." },
      { at: "10:33 am", text: "Maya Chen started the AI answers check-up on Opus 5.5 with Medium thinking effort. Up to 40 credits set aside." },
      { at: "10:32 am", text: "Maya Chen started this project from Ask Morrow, with 2 goals and 5 steps." },
    ],
  });
  const autumn = dated(rows.get("project-autumn")!, {
    scope: ["Started Oct 12", "Launch Mon, Nov 2", "Ends Mon, Nov 16", "Credits: 152 used, about 200 to 300 planned"],
    stopPreview: "the launch-week stock check turns off. 2 changes waiting for your approval stay in your Inbox.",
    goals: [
      {
        key: "launch_ready",
        title: "3 products ready for launch",
        measure: "checklist",
        value: "2 of 3 ready",
        target: "Goal 3 of 3 by Mon, Nov 2",
        start: "Was 0 of 3 on Oct 12",
        source: "Checklist · counted from your Shopify products · updated 9:10 am",
        health: health("on_track", "Ahead of a steady pace to 3 of 3 by Nov 2."),
        how: "Each product counts as ready when all 12 product facts are on its page.",
        checks: [],
        questions: [],
        rows: [
          { label: "Linen Shirt", value: "12 of 12 facts", note: null, health: health("done") },
          { label: "Utility Overshirt", value: "9 of 12 facts", note: "Waiting for a photo of it being worn", health: health("needs_you") },
          { label: "Linen Trousers", value: "12 of 12 facts", note: null, health: health("done") },
        ],
        steps: [],
      },
    ],
    plan: [
      { index: 1, title: "Write pages for 3 Autumn products", owner: m.listings, status: "needs_you", detail: "2 changes to review · expire Mon, Oct 26", repeats: false, taskId: "task-pj-autumn-pages" },
      { index: 2, title: "Photograph the Utility Overshirt being worn", owner: m.leo, status: "to_do", detail: "Due Tue, Oct 27", repeats: false, taskId: "task-pj-overshirt-photo" },
      { index: 3, title: "Launch-week stock check", owner: m.inventory, status: "not_started", detail: "Every day, Nov 2 to Nov 8, at 7:00 am", repeats: true, taskId: null },
    ],
    latestUpdate: {
      title: "Week 2 · On track",
      at: "Mon, Oct 19, 8:00 am",
      health: health("on_track"),
      summary: "2 of 3 products are ready. The Utility Overshirt needs one more photo.",
      rows: [
        { label: "Products ready", value: "2 of 3", health: health("on_track"), note: "Was 0 on Oct 12 · From your Shopify products" },
      ],
      doneSince: "Listings wrote 2 product pages · 2 changes approved",
      needsYou: "2 changes to review",
      credits: "120 used · about 200 to 300 planned",
    },
    updateNote: null,
    credits: { used: 152, planned: "about 200 to 300", byHelper: [{ name: "Listings", line: "118 used" }, { name: "Inventory", line: "34 used" }], balance: "You have 1,202 credits left until Nov 1.", note: null },
    activity: [{ at: "Oct 12", text: "Maya Chen started this project from Ask Morrow, with 1 goal and 3 steps." }],
  });
  const bfcm = dated(rows.get("project-bfcm")!, {
    scope: ["Started Oct 20", "Sale starts Fri, Nov 27", "Ends Mon, Nov 30", "Credits: 56 used, about 150 to 250 planned"],
    goals: [
      {
        key: "sale_plan",
        title: "A sale plan: up to 20% off, every item still in profit",
        measure: "checklist",
        value: "Plan due today",
        target: "Goal: a plan you approve by Fri, Oct 30",
        start: null,
        source: "Checklist · counted from the sale plan’s fixed fields",
        health: health("not_started", "The sale starts Fri, Nov 27."),
        how: null,
        checks: [],
        questions: [],
        rows: [],
        steps: [],
      },
    ],
    plan: [
      { index: 1, title: "Plan the Black Friday sale", owner: m.salePlanner, status: "working", detail: "Finishes by 3:00 pm · 1 question needs you", repeats: false, taskId: "task-pj-sale-plan" },
      { index: 2, title: "Approve the discount codes", owner: m.maya, status: "not_started", detail: "After step 1", repeats: false, taskId: null },
    ],
    credits: { used: 56, planned: "about 150 to 250", byHelper: [{ name: "Sale planner", line: "56 used" }], balance: null, note: null },
  });
  const summer = dated(rows.get("project-summer")!, {
    revision: 5,
    updateNote: null,
    state: "ended",
    extendTo: "2026-11-18",
    scope: ["Started Sep 1", "Ended Wed, Oct 21", "Credits: 88 used, about 80 to 120 planned"],
    goals: [
      {
        key: "sold_through",
        title: "Summer stock sold through",
        measure: "metric",
        value: "212 of 240 sold",
        target: "Goal 200 by Wed, Oct 21",
        start: "Was 0 on Sep 1",
        source: "From your Shopify store: units sold · updated 8:00 am",
        health: health("done"),
        how: "Units sold of the summer collection, counted by code from your Shopify orders. Only people who can see orders see this number.",
        checks: [],
        questions: [],
        rows: [],
        steps: [],
      },
    ],
    plan: [
      { index: 1, title: "Mark down summer linen by 15%", owner: m.maya, status: "done", detail: "Sep 1", repeats: false, taskId: null },
      { index: 2, title: "Weekly sell-through check", owner: m.inventory, status: "active", detail: "Every Monday at 7:00 am", repeats: true, taskId: null },
    ],
    results: {
      rows: [
        {
          goal: "Summer stock sold through",
          measure: "From your Shopify store",
          start: "0 of 240",
          now: "212 of 240",
          target: "200 · Done",
          health: health("done"),
        },
      ],
      note: null,
      done: "1 markdown · 7 weekly checks",
      credits: "88 used (about 80 to 120 planned)",
    },
    finish: {
      keepLabel: "Keep the weekly sell-through check in Stock",
      keepByDefault: true,
      keepNote:
        "Ticked because its goal was met. It moves to Stock and stays weekly. Untick to stop it; it won’t come back unless you turn it on.",
    },
    actions: { ...allActions, finish: true, extend: true },
  });
  const area = (
    index: number,
    detail: Partial<ProjectDetailView>,
  ): ProjectDetailView => {
    const row = areaRows[index]!;
    return {
      ...dated(
        {
          projectId: row.projectId,
          goalId: row.goalId,
          title: row.label,
          endsOn: "",
          note: null,
          mainGoal: null,
          moreGoals: [],
          health: row.health,
          members: [row.agent, m.morrow, m.maya, m.leo],
          credits: { used: row.creditsThisMonth, planned: null },
        },
        detail,
      ),
      kind: "area",
      endsOn: null,
      area: { label: row.label, agent: row.agent },
      areas: areaLinks,
      updateNote: null,
      ...detail,
    };
  };
  const stock = area(1, {
    scope: ["Inventory’s everyday work", "No end date", "Nothing is ordered without you"],
    stopPreview: "the daily stock check and the low-stock alert turn off, and Leo’s back-room count is cancelled.",
    goals: [
      {
        key: "stock_cover",
        title: "No best seller under 2 weeks of stock",
        measure: "metric",
        value: "9 of 12 best sellers have 2 weeks or more",
        target: "Goal: all 12",
        start: "Was 5 of 12 on Oct 6",
        source: "From your Shopify store: stock, and sales over the last 30 days · updated 6:04 am",
        health: health("behind", "At this pace, 3 best sellers could sell out within 2 weeks."),
        how: "Stock compared with the last 30 days of sales, by code, every hour. No agent decides this number.",
        checks: [],
        questions: [],
        rows: [
          { label: "Utility Overshirt", value: "About 11 days left · 12 in stock", note: "Inventory asked you: order 50, or wait?", health: health("needs_you") },
          { label: "Linen Trousers", value: "About 9 days left · 15 in stock", note: "40 on order from Weave Co. · Arriving Wed, Oct 28", health: null },
          { label: "Linen Apron", value: "About 13 days left · 26 in stock", note: "Waiting for Leo’s back-room count · Due Wed, Oct 28", health: null },
        ],
        steps: [],
      },
    ],
    repeating: repeatingRows.filter((r) => r.projectId === "area-stock"),
    alerts: alertRows.filter((r) => r.projectId === "area-stock"),
    members: [
      { member: m.inventory, note: "Does the work here. Asks you before anything is ordered. Sonnet 5.5 · Thinking effort: Low" },
      { member: m.morrow, note: "Answers when someone writes @Morrow here." },
      { member: m.maya, note: null },
      { member: m.leo, note: null },
    ],
    credits: {
      used: 40,
      planned: null,
      byHelper: [
        { name: "Stock checks (17)", line: "17" },
        { name: "Reorder suggestions (4)", line: "23" },
        { name: "Alerts", line: "No credits" },
      ],
      balance: "About 54 by Oct 31 at this pace.",
      note: "Inventory stops at its own limit of 100 credits a month. It has used 58 across all its work.",
    },
    activity: [
      { at: "Today, 6:05 am", text: "Alert sent to Maya Chen: Linen Apron is under 2 weeks." },
      { at: "Today, 6:04 am", text: "Stock check: 3 best sellers are under 2 weeks of stock. 1 credit." },
      { at: "Tue, Oct 20", text: "Reorder for Linen Trousers: 40 from Weave Co. Purchase order downloaded by Maya Chen. 4 credits." },
    ],
  });
  const simpleArea = (index: number) => {
    const row = areaRows[index]!;
    return area(index, {
      scope: [`${row.agent.name}’s everyday work`, "No end date"],
      goals: row.goal
        ? [
            {
              key: "area_goal",
              title: row.goal.title,
              measure: "metric",
              value: row.goal.value,
              target: null,
              start: null,
              source: "From your Shopify store",
              health: row.health,
              how: null,
              checks: [],
              questions: [],
              rows: [],
              steps: [],
            },
          ]
        : [],
      repeating: repeatingRows.filter((r) => r.projectId === row.projectId),
      alerts: alertRows.filter((r) => r.projectId === row.projectId),
      credits: { used: row.creditsThisMonth, planned: null, byHelper: [], balance: null, note: null },
    });
  };
  const quick: ProjectDetailView = {
    ...area(0, {}),
    projectId: quickTasksRow.projectId,
    goalId: quickTasksRow.goalId,
    kind: "quick_tasks",
    title: "Quick tasks",
    area: null,
    health: health("not_measured"),
    scope: ["One-off tasks that fit nowhere else", "No goal"],
    goals: [],
    repeating: [],
    alerts: [],
    members: [{ member: m.maya, note: null }, { member: m.leo, note: null }],
    credits: { used: 42, planned: null, byHelper: [], balance: null, note: null },
    actions: { ...allActions, planNextSteps: false, stopSteps: false },
  };
  return new Map<string, ProjectDetailView>([
    [tote.projectId, tote],
    [autumn.projectId, autumn],
    [bfcm.projectId, bfcm],
    [summer.projectId, summer],
    [stock.projectId, stock],
    ["area-pages", simpleArea(0)],
    ["area-emails", simpleArea(2)],
    ["area-sales", simpleArea(3)],
    [quick.projectId, quick],
  ]);
}

/** The Everyday Tote conversation, as the Project board draws it. */
export function toteMessages(): ProjectMessageView[] {
  return [
    { kind: "line", id: "pm-1", at: "10:32 am", text: "Maya Chen started this project from Ask Morrow" },
    { kind: "line", id: "pm-2", at: "11:12 am", text: "AI answers check-up finished · Found 7 gaps" },
    { kind: "line", id: "pm-3", at: "11:13 am", text: "Maya Chen let Listings start step 3" },
    {
      kind: "message",
      id: "pm-4",
      author: m.listings,
      at: "11:14 am",
      text: "Working on the Everyday Tote’s description, search listing, tags and photo descriptions, using the check-up.",
      restricted: null,
      written: false,
    },
    {
      kind: "message",
      id: "pm-5",
      author: m.listings,
      at: "11:31 am",
      text: "4 changes for the Everyday Tote are ready.",
      restricted: null,
      written: false,
    },
    { kind: "line", id: "pm-6", at: "11:52 am", text: "Maya Chen approved 4 changes · Updated in Shopify" },
    { kind: "line", id: "pm-7", at: "11:52 am", text: "Page facts: 11 of 12 · 1 left: at least 3 photos (step 6)" },
    {
      kind: "message",
      id: "pm-8",
      author: m.analyst,
      at: "11:58 am",
      text: "Everyday Tote sold 9 this week, about the same as the 4 weeks before.",
      restricted: "Only people who can see orders see this.",
      written: false,
    },
  ];
}

/** The Stock area's conversation, as the Everyday work board draws it. */
export function stockMessages(): ProjectMessageView[] {
  return [
    {
      kind: "message",
      id: "sm-1",
      author: m.inventory,
      at: "6:04 am",
      text: "3 best sellers have less than 2 weeks of stock: Utility Overshirt (about 11 days), Linen Trousers (about 9 days, 40 arriving Wed, Oct 28) and Linen Apron (about 13 days).",
      restricted: null,
      written: false,
    },
    {
      kind: "line",
      id: "sm-2",
      at: "6:05 am",
      text: "Alert sent to Maya Chen: Linen Apron is under 2 weeks",
    },
    {
      kind: "message",
      id: "sm-3",
      author: m.inventory,
      at: "6:06 am",
      text: "For Utility Overshirt I’d order 32, but Weave Co.’s minimum order is 50. I’ve asked Maya in the Inbox whether to order 50 or wait.",
      restricted: null,
      written: false,
    },
    {
      kind: "message",
      id: "sm-4",
      author: m.leo,
      at: "1:12 pm",
      text: "I found 6 more aprons in the back room. I’ll do a proper count on Wednesday before we reorder.",
      restricted: null,
      written: false,
    },
    {
      kind: "line",
      id: "sm-5",
      at: "1:13 pm",
      text: "Leo Martin added a task: Count stock in the back room",
    },
  ];
}

export function planChangeCard(index: number, projectId: string): ProjectMessageView {
  return {
    kind: "plan_change",
    id: `pm-change-${index}`,
    at: "Just now",
    card: {
      messageId: `msg-change-${projectId}-${index}`,
      draftDigest: digestOf(`change-${projectId}-${index}`),
      title: "Morrow suggests 1 change to the plan",
      intro: "The plan mostly holds. One small change would keep goal 1 on time.",
      changes: [
        {
          kind: "change",
          title: "Give step 6 a due date: Fri, Nov 6",
          owner: m.maya,
          detail: "No credits · you take and add the photo yourself",
        },
      ],
      because:
        "Page facts are 11 of 12, and the last one is a third photo, which only a person can add. Goal 1 is due Fri, Nov 13, so Nov 6 leaves a week to spare.",
      credits: "No extra credits. Still within about 60 to 100.",
      tainted: null,
      started: null,
      canStart: true,
      startNote: null,
    },
  };
}

/** A deterministic 64-hex sample digest (not a hash of anything real). */
export function digestOf(seed: string): string {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    for (const ch of seed + round) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

// ---- Ask Morrow
export const productOptions = [
  { id: "linen-shirt", label: "Linen Shirt", detail: "Natural linen, off white", recommended: false },
  { id: "everyday-tote", label: "Everyday Tote", detail: "Tan linen canvas", recommended: false },
  { id: "utility-overshirt", label: "Utility Overshirt", detail: "Olive linen blend", recommended: false },
];
export const endOptions = [
  { id: "six-weeks", label: "In about 6 weeks (Fri, Dec 4)", detail: null, recommended: true },
  { id: "black-friday", label: "By Black Friday (Fri, Nov 27)", detail: null, recommended: false },
];
export const endOn: Readonly<Record<string, string>> = {
  "six-weeks": "2026-12-04",
  "black-friday": "2026-11-27",
};

/** The project card for a product and an end date, as Morrow and code would write it. */
export function projectCard(options: {
  readonly messageId: string;
  readonly revision: number;
  readonly product: string;
  readonly endsOn: string;
  readonly title: string;
  readonly dayLabel: string;
  readonly dropGoals: readonly string[];
  readonly dropSteps: readonly number[];
  readonly teammate: boolean;
}): PlanCardView {
  const { product } = options;
  const goals = [
    {
      key: "page_facts",
      title: `${product}’s page is complete`,
      line: "5 of 12 facts now · goal 12 of 12 by Fri, Nov 13",
      source: "Checklist · counted from your Shopify product · just now",
      checks: pageFacts([
        "Size",
        "What fits inside",
        "Care",
        "At least 3 photos",
        "A description on every photo",
        "A search listing description",
        "At least 3 shopper questions and answers in the description",
      ]),
    },
    {
      key: "ai_named",
      title: `AI assistants name the ${product}`,
      line: `goal: named in 2 of 5 buying questions, in one monthly check, by ${options.dayLabel}`,
      source:
        "Checked by you in ChatGPT, the same assistant every month · about 8 minutes · Morrow wrote the 5 questions (in the full plan)",
      checks: [],
    },
  ].filter((g) => !options.dropGoals.includes(g.key));
  const steps = [
    { index: 1, title: `Check the ${product} is offered in Shopify’s AI channels`, owner: m.maya, when: "Today, about 2 minutes", repeats: false },
    { index: 2, title: "Check the page against the 5 buying questions", owner: m.checkup, when: "Today, about 1 hour", repeats: false },
    { index: 3, title: "Update description, search listing, tags and photo descriptions", owner: m.listings, when: "After step 2, when you say so", repeats: false },
    { index: 4, title: "Review the changes", owner: m.maya, when: "This week", repeats: false },
    { index: 5, title: "Check AI answers in ChatGPT", owner: m.maya, when: "Mon, Nov 2, then every 4 weeks", repeats: true },
  ].filter((s) => !options.dropSteps.includes(s.index));
  const asker = options.teammate ? m.leo : m.maya;
  return {
    messageId: options.messageId,
    draftDigest: digestOf(`${options.messageId}-${options.revision}`),
    revision: options.revision,
    kind: "project",
    title: options.title,
    scope: `Ends ${options.dayLabel} (we check results then) · A new project`,
    endsOn: options.endsOn,
    why: "Shoppers ask AI assistants what to buy. A page that answers their questions gives the assistants something to name.",
    goals,
    helpers: [
      { member: m.morrow, does: "Main agent. Planned this project. Re-plans when you tap Plan next steps, or when you ask it with @Morrow in the project.", note: null },
      { member: { ...asker, role: options.teammate ? "Member" : "Owner" }, does: "You own this project. You check one Shopify setting, review changes and do the monthly check.", note: null },
      {
        member: m.checkup,
        does: "Checks the page against the 5 questions and what AI assistants look for. Only you can start it, after you start the project.",
        note: options.teammate
          ? "Only Maya (Owner) can set up and start the check-up. You can still start the project; Maya then gets an Inbox item to set it up."
          : null,
      },
      { member: m.listings, does: "Updates the description, search listing, tags and photo descriptions after the check-up, when you say so. Asks you before changing anything.", note: null },
      { member: m.analyst, does: "Posts a short sales note each Monday. Only people who can see orders see it.", note: null },
    ],
    needsYou:
      "Check one setting in Shopify (about 2 minutes). Start the check-up (only you can). Say when Listings may start. Approve about 4 changes. Nothing changes in your store until you approve.",
    credits:
      "About 60 to 100 credits over 6 weeks. You have 1,202 left until Nov 1. The check-up sets aside up to 40 when it starts; unused credits come back.",
    shortfall: null,
    youllHear: "Every Monday at 8:00 am, starting Mon, Oct 26, and in your Inbox when something needs you.",
    steps,
    questions: buyingQuestions(product),
    cannotDo,
    related: null,
    visibility:
      "Your team will see your request and this plan. Sales numbers show only to people who can see orders. The rest of this conversation stays private.",
    tainted: null,
    started: null,
    canStart: true,
    startNote: null,
    canEdit: true,
    endChoices: [
      { on: "2026-11-27", recommended: false },
      { on: "2026-12-04", recommended: true },
      { on: "2026-12-11", recommended: false },
      { on: "2026-12-18", recommended: false },
    ],
  };
}
