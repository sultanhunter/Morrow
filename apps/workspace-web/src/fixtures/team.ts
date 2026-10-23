// T7 PR 16: the fixture side of Team, agent pages, Add agents, Settings, Shop knowledge
// and Files (the Sunrise brief's sample day: Linen & Form, Friday, October 23). Synthetic
// data only. Scripted, not simulated: it models the rules the screens must respect (who may
// change how a helper thinks, a revision conflict, an add document bound to its fingerprint
// and used once) so the screens can be checked; the server proves the real ones.
import type {
  ActivityEntryView,
  ActivityLineView,
  ActivityView,
  AddDocumentView,
  AddResultView,
  AgentCharacter,
  AgentDetailView,
  AgentSummaryView,
  CatalogueEntryView,
  CatalogueView,
  Command,
  EmailAddressesView,
  FilesView,
  KnowledgeView,
  LibraryPort,
  NotificationChoices,
  NotificationsView,
  Outcome,
  PersonRole,
  PlanView,
  PortMethod,
  SettingsPort,
  SpecialistProp,
  TeamPort,
  TeamView,
  ThinkingChoice,
  ThinkingEstimate,
  ThinkingView,
} from "@morrow/workspace-ui";
import {
  emailTopics,
  monthlyLimitRange,
  quietFromHours,
  quietUntilHours,
  shopTimeZones,
  summaryHours,
  thinkingEfforts,
  thinkingModels,
} from "@morrow/workspace-ui";

export interface TeamFixtureDeps {
  readonly viewer: PersonRole;
  /** The scenario's empty variant: Morrow and people only, no files or knowledge. */
  readonly empty: boolean;
  /** A one-person shop: nobody else reviews an agent's permission. */
  readonly solo: boolean;
  /**
   * A teammate's change to how a helper thinks lands just before the viewer's first one:
   * the record moves on (a new choice and revision), so that save meets a real 409.
   */
  readonly teammateSavesFirst: boolean;
  readonly isWorkspace: (id: string) => boolean;
  /** The workspace model default (the Listings agent's choice; models.* revises it). */
  readonly workspaceDefault: () => ThinkingChoice & { readonly revision: number | null };
  readonly reply: <T>(method: PortMethod, fallback: () => Outcome<T>) => Promise<Outcome<T>>;
  readonly command: <T>(
    method: PortMethod,
    c: Command<unknown>,
    apply: () => Outcome<T>,
  ) => Promise<Outcome<T>>;
}

const ok = <T>(value: T): Outcome<T> => ({ kind: "ok", value, replayed: false });
const notFound = { kind: "not_found" } as const;
const denied = (message: string): Outcome<never> => ({ kind: "denied", message, reference: null });
const changed = (message: string): Outcome<never> => ({ kind: "conflict", recheck: true, message });

const sonnetLow = { model: "claude_sonnet_5_5", effort: "low" } as const;
const opusHigh = { model: "claude_opus_5_5", effort: "high" } as const;
const opusMedium = { model: "claude_opus_5_5", effort: "medium" } as const;
const haikuMedium = { model: "claude_haiku_5_5", effort: "medium" } as const;
// Sample credits per job: [typical, most one job can use] (the Agent board's sample).
const perJob: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  claude_haiku_5_5: { low: [1, 4], medium: [1, 6], high: [2, 9] },
  claude_sonnet_5_5: { low: [6, 40], medium: [9, 40], high: [14, 40] },
  claude_opus_5_5: { low: [12, 40], medium: [18, 40], high: [28, 42] },
};
const estimates: readonly ThinkingEstimate[] = thinkingModels.flatMap((model) =>
  thinkingEfforts.map((effort) => {
    const [typical, most] = perJob[model]![effort]!;
    return { model, effort, typical, most };
  }),
);
// The sample agents' daily spending limit: their page's "Credits today" and the limit one
// job's most must fit within when someone changes how they think.
const agentDailyLimit = 40;
const isModel = (v: string) => (thinkingModels as readonly string[]).includes(v);
const isEffort = (v: string) => (thinkingEfforts as readonly string[]).includes(v);

const owner = "Maya Chen";
const teammate = "Leo Martin";
type Target = "morrow" | "specialists" | "agent";

export function createTeamFixture(deps: TeamFixtureDeps): {
  readonly team: TeamPort;
  readonly settings: SettingsPort;
  readonly library: LibraryPort;
} {
  const { viewer, empty, solo, reply, command } = deps;
  let teammateFirst = deps.teammateSavesFirst;
  // The server's rule as the fixture models it (ADR-0027 item 12): the Owner changes how
  // any helper thinks; an Admin only added agents'; a member none.
  const mayChange = (target: Target) =>
    viewer === "owner" || (viewer === "admin" && target === "agent");
  const own: Record<string, { choice: ThinkingChoice; revision: number }> = {
    morrow: { choice: opusHigh, revision: 1 },
    specialists: { choice: opusMedium, revision: 1 },
    "agent-analyst": { choice: sonnetLow, revision: 1 },
    "agent-inventory": { choice: sonnetLow, revision: 1 },
    "agent-support": { choice: sonnetLow, revision: 1 },
  };
  const ownThinking = (
    key: string,
    target: Target,
    usual: ThinkingChoice,
    dailyLimit: number | null,
  ): ThinkingView => ({
    ...own[key]!.choice,
    source: "own",
    usual,
    revision: own[key]!.revision,
    canChange: mayChange(target),
    estimates,
    dailyLimit,
  });
  const listingsThinking = (): ThinkingView => {
    const d = deps.workspaceDefault();
    return {
      model: d.model,
      effort: d.effort,
      source: "workspace_default",
      usual: sonnetLow,
      revision: d.revision,
      // models.list's canRevise decides on the page; the fixture's reviser is the Owner.
      canChange: viewer === "owner",
      estimates: [],
      dailyLimit: null,
    };
  };

  // ---- the catalogue (Add agents) and its add state
  // The fixture's own copy of the catalogue: adding an agent changes its entry.
  const catalogue: { -readonly [K in keyof CatalogueEntryView]: CatalogueEntryView[K] }[] = [
    {
      releaseId: "release-listings",
      character: "listings",
      name: "Listings",
      summary: "Keeps product pages complete and easy to find.",
      category: "product_pages",
      addedAs: "agent-listings",
      waitingReview: false,
      worksIn: "Product pages, Autumn collection, Everyday Tote in AI answers",
      does: [
        "Writes titles, descriptions and search engine listings in your brand voice",
        "Adds tags and photo descriptions (alt text)",
        "Checks your catalog every Monday",
      ],
      schedule: ["Every Monday at 9:00 am: catalog check", "When a product is added or changed"],
      permissions: {
        onItsOwn: ["Read products", "Write drafts, reports, ideas and notes"],
        asksFirst: ["Every change to a product"],
        never: ["Change prices", "Delete products", "Email customers"],
      },
      shopifyAccess: [],
      accessNote: null,
      startsOn: sonnetLow,
      usualCredits: "Usually 150 to 300 credits a month on Sonnet 5.5 · Low.",
      defaultMonthlyLimit: 300,
      example: null,
      reviewer: null,
    },
    {
      releaseId: "release-analyst",
      character: "business_analyst",
      name: "Business Analyst",
      summary: "Sends a morning summary and spots what changed.",
      category: "sales",
      addedAs: "agent-analyst",
      waitingReview: false,
      worksIn: "Sales and numbers, Everyday Tote in AI answers, Autumn collection",
      does: ["Sends a summary every morning", "Explains what changed and why"],
      schedule: ["Every day at 8:00 am: morning summary"],
      permissions: {
        onItsOwn: ["Read order totals, with no customer details", "Write reports"],
        asksFirst: [],
        never: ["Change your store", "See customer names, emails or addresses"],
      },
      shopifyAccess: [],
      accessNote: null,
      startsOn: sonnetLow,
      usualCredits: "Usually 100 to 200 credits a month on Sonnet 5.5 · Low.",
      defaultMonthlyLimit: 200,
      example: null,
      reviewer: null,
    },
    {
      releaseId: "release-inventory",
      character: "inventory",
      name: "Inventory",
      summary: "Watches stock and suggests what to reorder.",
      category: "stock",
      addedAs: "agent-inventory",
      waitingReview: false,
      worksIn: "Stock, Autumn collection, Black Friday sale",
      does: ["Checks stock every morning", "Suggests what to reorder and how much"],
      schedule: ["Every day at 6:00 am: stock check"],
      permissions: {
        onItsOwn: ["Read products and stock", "Write reorder plans"],
        asksFirst: ["Every change to stock in Shopify"],
        never: ["Place an order with a supplier", "Change prices"],
      },
      shopifyAccess: [],
      accessNote: null,
      startsOn: sonnetLow,
      usualCredits: "Usually 50 to 100 credits a month on Sonnet 5.5 · Low.",
      defaultMonthlyLimit: 100,
      example: null,
      reviewer: null,
    },
    {
      releaseId: "release-support",
      character: "support",
      name: "Support",
      summary: "Drafts replies to customer emails for you to approve.",
      category: "customer_emails",
      addedAs: "agent-support",
      waitingReview: false,
      worksIn: "Customer emails",
      does: ["Drafts a reply to each customer email", "Looks up the customer’s order"],
      schedule: ["When a customer email comes in"],
      permissions: {
        onItsOwn: ["Read the email and the order it is about", "Write draft replies"],
        asksFirst: ["Every reply to a customer"],
        never: ["Refund or cancel an order", "Send a reply without your OK"],
      },
      shopifyAccess: [],
      accessNote: null,
      startsOn: sonnetLow,
      usualCredits: "Usually 150 to 300 credits a month on Sonnet 5.5 · Low.",
      defaultMonthlyLimit: 300,
      example: null,
      reviewer: null,
    },
    {
      releaseId: "release-marketing",
      character: "marketing",
      name: "Marketing",
      summary: "Plans promotions and writes campaign copy for you to paste.",
      category: "promotions",
      addedAs: null,
      waitingReview: false,
      worksIn: "Its everyday work: Promotions",
      does: [
        "Makes a promotion plan each week: what to offer, on which products, and for how long",
        "Works out what each discount does to your profit",
        "Writes email and social copy for you to paste",
        "Suggests discount codes with a limit, and ends them when a promotion is over",
      ],
      schedule: [
        "Every Tuesday at 9:00 am: weekly promotion plan",
        "When someone gives it a task in a project",
        "When a promotion ends: it suggests ending its discount code",
        "Once a day it looks for promotion ideas and suggests them on Home",
      ],
      permissions: {
        onItsOwn: [
          "Read products, prices and stock",
          "Read order totals, with no customer details",
          "Write promotion plans and copy",
        ],
        asksFirst: ["Creating or ending any discount code"],
        never: [
          "Send emails, texts or social posts",
          "Change prices",
          "See customer names, emails or addresses",
          "Spend money on ads",
        ],
      },
      shopifyAccess: ["Create and end discount codes, only after you approve"],
      accessNote:
        "Shopify asks you to allow this once. It can’t see customer names, emails or addresses.",
      startsOn: sonnetLow,
      usualCredits: "Usually 100 to 200 credits a month on Sonnet 5.5 · Low.",
      defaultMonthlyLimit: 200,
      example: {
        title: "Sample plan: Weekend offer on slow sellers",
        points: [
          "15% off 3 products that haven’t sold in 60 days, Friday to Sunday",
          "One discount code for up to 100 orders, ending Sunday night",
          "Profit stays above 40% on every order",
          "Email and social copy for you to paste",
        ],
      },
      // A teammate who also holds the store access it names reviews it (ADR-0024 item 2).
      reviewer: solo ? null : viewer === "owner" ? teammate : owner,
    },
  ];
  const documents = new Map<string, AddDocumentView>();
  const usedDocuments = new Set<string>();
  let issued = 0;
  const mayAdd = viewer === "owner" || viewer === "admin";

  // ---- Team
  const line = (label: ActivityLineView["label"], text: string): ActivityLineView => ({
    label,
    text,
  });
  const addedAgents = (): AgentSummaryView[] => {
    if (empty) return [];
    const agents: AgentSummaryView[] = [
      {
        agentId: "agent-listings",
        character: "listings",
        name: "Listings",
        summary: "Keeps product pages complete and easy to find.",
        status: "active",
        worksIn: ["Product pages", "Autumn collection", "Everyday Tote in AI answers"],
        lines: [
          line(
            "last",
            "4 changes to the Everyday Tote page · Approved by Maya Chen · Updated in Shopify at 11:52 am",
          ),
          line("waiting", "2 changes in Autumn collection · expire Mon, Oct 26"),
          line("next", "Catalog check · Mon, Oct 26, 9:00 am"),
        ],
        credits: { used: 132, limit: 300 },
        thinking: listingsThinking(),
      },
      {
        agentId: "agent-analyst",
        character: "business_analyst",
        name: "Business Analyst",
        summary:
          "Sends a morning summary and spots what changed. Only people who can see orders see its numbers.",
        status: "active",
        worksIn: ["Sales and numbers", "Everyday Tote in AI answers", "Autumn collection"],
        lines: [
          line("last", "Morning summary · today, 8:00 am"),
          line("next", "Morning summary · Sat, Oct 24, 8:00 am"),
        ],
        credits: { used: 118, limit: 200 },
        thinking: ownThinking("agent-analyst", "agent", sonnetLow, agentDailyLimit),
      },
      {
        agentId: "agent-inventory",
        character: "inventory",
        name: "Inventory",
        summary: "Watches stock and suggests what to reorder.",
        status: "needs_you",
        worksIn: ["Stock", "Autumn collection", "Black Friday sale"],
        lines: [
          line(
            "last",
            "Daily stock check · today, 6:04 am · 3 best sellers have less than 2 weeks of stock",
          ),
          line("waiting", "Order 50 Utility Overshirts, or wait?"),
          line("next", "Daily stock check · Mon, Oct 26, 6:00 am"),
        ],
        credits: { used: 58, limit: 100 },
        thinking: ownThinking("agent-inventory", "agent", sonnetLow, agentDailyLimit),
      },
      {
        agentId: "agent-support",
        character: "support",
        name: "Support",
        summary: "Drafts replies to customer emails for a person to approve.",
        status: "working",
        worksIn: ["Customer emails"],
        lines: [
          line("now", "Drafting a reply to a new customer email · since 1:52 pm"),
          line("waiting", "Reply to Hannah K. about order #10421 · expires in 14 hours"),
          line("next", "Drafts a reply when the next customer email comes in."),
        ],
        credits: { used: 196, limit: 300 },
        thinking: ownThinking("agent-support", "agent", sonnetLow, agentDailyLimit),
      },
    ];
    const marketing = catalogue.find((e) => e.releaseId === "release-marketing")!;
    if (marketing.addedAs !== null) {
      own["agent-marketing"] ??= { choice: sonnetLow, revision: 1 };
      agents.push({
        agentId: marketing.addedAs,
        character: "marketing",
        name: "Marketing",
        summary: marketing.summary,
        status: "active",
        worksIn: ["Promotions"],
        lines: [line("next", "Weekly promotion plan · Tue, Oct 27, 9:00 am")],
        credits: { used: 0, limit: marketing.defaultMonthlyLimit },
        thinking: ownThinking("agent-marketing", "agent", sonnetLow, agentDailyLimit),
      });
    }
    return agents;
  };
  const teamView = (): TeamView => ({
    shopName: "Linen & Form",
    ownerName: owner,
    viewerRole: viewer,
    morrow: {
      status: "active",
      lines: [
        line("last", "Planned Everyday Tote in AI answers with you · 10:32 am"),
        line(
          "next",
          "Nothing on a schedule. It works only when someone asks, and plans again when you ask it to.",
        ),
        line("cannot", "See or change your store, or start work on its own"),
      ],
      creditsThisMonth: 124,
      thinking: ownThinking("morrow", "morrow", opusHigh, null),
    },
    agents: addedAgents(),
    specialists: empty
      ? []
      : [
          {
            name: "AI answers check-up",
            prop: "magnifier",
            summary: "Checked the Everyday Tote page against 5 buying questions.",
            status: "done",
            worksIn: "Everyday Tote in AI answers · step 2",
            lines: [
              line("last", "Finished at 11:12 am · Found 7 gaps · Started by Maya Chen"),
              line("access_ends", "Sat, Oct 24, 10:33 am"),
              line("credits", "16 used, 24 came back"),
            ],
            thinking: opusMedium,
          },
          {
            name: "Sale planner",
            prop: "calendar",
            summary: "Drafts a plan for the Black Friday sale.",
            status: "needs_you",
            worksIn: "Black Friday sale",
            lines: [
              line("waiting", "Should the sale leave out the Autumn collection?"),
              line("cannot", "See orders, customer names, emails or addresses"),
              line("credits", "50 used so far"),
            ],
            thinking: opusMedium,
          },
        ],
    specialistDefault: ownThinking("specialists", "specialists", opusMedium, null),
    people: [
      {
        name: owner,
        initials: "MC",
        role: "owner",
        presence: "online",
        isViewer: viewer === "owner",
        canApprove: "Everything at Linen & Form",
        approveGivenBy: null,
      },
      ...(solo
        ? []
        : [
            {
              name: teammate,
              initials: "LM",
              role: viewer === "admin" ? ("admin" as const) : ("member" as const),
              presence: "away" as const,
              isViewer: viewer !== "owner",
              canApprove: "Product changes, customer replies",
              approveGivenBy: "Maya Chen, Oct 2",
            },
          ]),
    ],
    canAddAgents: mayAdd,
  });

  // ---- one agent's page
  const detail = (summary: AgentSummaryView): AgentDetailView => {
    const entry = catalogue.find((e) => e.addedAs === summary.agentId)!;
    const listings = summary.character === "listings";
    return {
      agentId: summary.agentId,
      character: summary.character,
      name: summary.name,
      status: summary.status,
      addedBy: owner,
      addedOn: listings ? "Oct 6" : "Oct 8",
      about: listings
        ? "Keeps your product pages complete and easy to find. Writes titles, descriptions, search engine listings, tags and photo descriptions (alt text) in your brand voice."
        : summary.summary,
      worksToward: listings
        ? {
            area: "Product pages",
            goal: "Every product has a complete listing",
            percent: 94,
            target: "Goal: 100% by Nov 30",
            health: "on_track",
            measuredBy: "Checklist · counted from your Shopify products · updated 11:52 am",
          }
        : null,
      worksIn: listings
        ? [
            {
              name: "Product pages",
              detail: "Everyday work · Its own area · Next: catalog check, Mon, Oct 26",
              status: "active",
            },
            {
              name: "Autumn collection",
              detail: "Ends Mon, Nov 16 · 2 product descriptions waiting for your review",
              status: "needs_review",
            },
            {
              name: "Everyday Tote in AI answers",
              detail: "Ends Fri, Dec 4 · Its step is done: 4 changes approved by Maya Chen",
              status: "done",
            },
          ]
        : summary.worksIn.map((name) => ({
            name,
            detail: "Works here",
            status: "active" as const,
          })),
      thinking: summary.thinking,
      permissions: listings
        ? {
            onItsOwn: ["Read products", "Write drafts, reports, ideas and notes"],
            asksFirst: [
              "Every change to a product: title, description, search engine listing, tags, alt text, collections",
            ],
            never: [
              "Change prices",
              "Delete products",
              "See orders or customer details",
              "Email customers",
              "Create discounts",
            ],
          }
        : entry.permissions,
      recentWork: listings
        ? [
            {
              what: "Updated the Everyday Tote page",
              where: "Everyday Tote in AI answers",
              when: "Today, 11:31 am",
              result: "4 changes · Approved by Maya Chen",
              credits: 20,
            },
            {
              what: "Size chart check for this week’s new products",
              where: "Product pages",
              when: "Today, 11:00 am",
              result: "Nothing to change",
              credits: 2,
            },
            {
              what: "Wrote 3 changes for Autumn products",
              where: "Autumn collection",
              when: "Today, 9:40 am",
              result: "2 to review · 1 replaced by a newer change",
              credits: 4,
            },
            {
              what: "Catalog check",
              where: "Product pages",
              when: "Mon, Oct 19",
              result: "12 photos without a description",
              credits: 3,
            },
          ]
        : [],
      now:
        summary.status === "working"
          ? "Working on a reply to a customer email."
          : "Not working on anything right now.",
      lastJob: listings ? "Updated the Everyday Tote page · 11:31 am" : null,
      next: summary.lines.find((l) => l.label === "next")?.text ?? null,
      creditsMonth: summary.credits,
      creditsToday: { used: listings ? 26 : 4, limit: agentDailyLimit },
      creditsResetOn: "Nov 1",
      permission: {
        grantedBy: owner,
        grantedOn: listings ? "Oct 6" : "Oct 8",
        nextRenewal: listings ? "Jan 4, 2027" : "Jan 6, 2027",
        daysLeft: listings ? 73 : 75,
      },
      shopifyAccess: listings
        ? [
            { text: "See and edit products (edits only after you approve)", has: true },
            { text: "Add photo descriptions (alt text)", has: true },
            { text: "No access to orders or customers", has: false },
          ]
        : entry.shopifyAccess.map((text) => ({ text, has: true })),
      schedule: listings
        ? [
            {
              icon: "calendar",
              title: "Catalog check",
              detail: "Every Monday, 9:00 am · Product pages",
            },
            {
              icon: "repeat",
              title: "Size chart check for new products",
              detail: "Every Friday, 11:00 am · Product pages · Turned on by Maya",
            },
            { icon: "store", title: "When a product is added or changed in Shopify", detail: null },
            { icon: "task", title: "When someone gives it a task", detail: null },
            { icon: "mention", title: "When someone @mentions it in a project", detail: null },
            {
              icon: "idea",
              title: "Once a day it looks for useful work and suggests it on Home",
              detail: null,
            },
          ]
        : entry.schedule.map((title) => ({ icon: "calendar" as const, title, detail: null })),
      notes: listings
        ? [
            "Maya prefers ‘linen’ in lowercase in titles.",
            "Size advice applies to shirts, not totes.",
            "Next: photo descriptions for 12 Autumn photos.",
          ]
        : [],
      ownerName: owner,
    };
  };

  const team: TeamPort = {
    overview: (ws) =>
      reply<TeamView>("team.overview", () => (deps.isWorkspace(ws) ? ok(teamView()) : notFound)),
    agent: (ws, agentId) =>
      reply<AgentDetailView>("team.agent", () => {
        const summary = addedAgents().find((a) => a.agentId === agentId);
        return deps.isWorkspace(ws) && summary ? ok(detail(summary)) : notFound;
      }),
    reviseThinking: (ws, target, c) =>
      command<{ readonly revision: number }>("team.reviseThinking", c, () => {
        if (!deps.isWorkspace(ws)) return notFound;
        const kind: Target | null =
          target === "morrow" || target === "specialists"
            ? target
            : Object.hasOwn(own, target)
              ? "agent"
              : null;
        // The Listings agent's choice is the workspace default: models.reviseDefault.
        if (kind === null) return notFound;
        if (!mayChange(kind))
          return denied(
            kind === "agent"
              ? "Only the Owner or an Admin can change how an agent thinks."
              : "Only the Owner can change this.",
          );
        const body = c.body as { model: string; effort: string; expectedRevision: number | null };
        if (!isModel(body.model) || !isEffort(body.effort)) return { kind: "invalid", field: null };
        const record = own[target]!;
        if (teammateFirst) {
          teammateFirst = false;
          const moved =
            record.choice.model === haikuMedium.model && record.choice.effort === haikuMedium.effort
              ? sonnetLow
              : haikuMedium;
          record.choice = moved;
          record.revision += 1;
        }
        if (body.expectedRevision !== record.revision)
          return changed("This changed since you opened it.");
        record.choice = { model: body.model, effort: body.effort };
        record.revision += 1;
        return ok({ revision: record.revision });
      }),
    catalogue: (ws) =>
      reply<CatalogueView>("team.catalogue", () =>
        deps.isWorkspace(ws)
          ? ok({
              shopName: "Linen & Form",
              ownerName: owner,
              entries: catalogue.map((e) => ({ ...e })),
              canAdd: mayAdd,
              creditsLeft: 1202,
              creditsRenewOn: "Nov 1",
            })
          : notFound,
      ),
    addDocument: (ws, releaseId, c) =>
      command<AddDocumentView>("team.addDocument", c, () => {
        const entry = catalogue.find((e) => e.releaseId === releaseId);
        if (!deps.isWorkspace(ws) || !entry) return notFound;
        if (!mayAdd) return denied("Only the Owner or an Admin can add agents.");
        if (entry.addedAs !== null || entry.waitingReview)
          return changed("This agent was already added.");
        const body = c.body as { model: string; effort: string; monthlyCreditLimit: number };
        const limit = body.monthlyCreditLimit;
        if (!isModel(body.model) || !isEffort(body.effort)) return { kind: "invalid", field: null };
        if (
          !Number.isSafeInteger(limit) ||
          limit < monthlyLimitRange.min ||
          limit > monthlyLimitRange.max
        )
          return { kind: "invalid", field: "monthlyCreditLimit" };
        issued += 1;
        const document: AddDocumentView = {
          documentDigest: issued.toString(16).padStart(64, "a"),
          nonce: issued.toString(16).padStart(64, "b"),
          expiresAt: new Date(Date.UTC(2026, 9, 23, 14, 5 + issued)).toISOString(),
          releaseId,
          character: entry.character,
          name: entry.name,
          summary: entry.summary,
          willBeAbleTo: [
            "Read your products, prices, stock and order totals",
            "Write promotion plans and copy for you to paste",
            "Suggest discount codes for you to approve",
          ],
          willNotBeAbleTo: [
            "Send emails, texts or social posts",
            "Change prices",
            "Create or end a discount without your OK",
            "See customer names, emails or addresses",
          ],
          worksIn: "Promotions",
          thinking: { model: body.model, effort: body.effort },
          monthlyCreditLimit: limit,
          shopifyAccess: [...entry.shopifyAccess],
          reviewer: entry.reviewer,
        };
        // One live document per agent: a new one replaces the last.
        documents.set(releaseId, document);
        return ok(document);
      }),
    addConfirm: (ws, releaseId, c) =>
      command<AddResultView>("team.addConfirm", c, () => {
        const entry = catalogue.find((e) => e.releaseId === releaseId);
        if (!deps.isWorkspace(ws) || !entry) return notFound;
        if (!mayAdd) return denied("Only the Owner or an Admin can add agents.");
        const body = c.body as { documentDigest: string; nonce: string };
        const document = documents.get(releaseId);
        if (
          !document ||
          usedDocuments.has(document.nonce) ||
          document.documentDigest !== body.documentDigest ||
          document.nonce !== body.nonce
        )
          return changed("This review expired, was already used, or no longer matches.");
        usedDocuments.add(document.nonce);
        documents.delete(releaseId);
        if (entry.reviewer !== null) {
          entry.waitingReview = true;
          return ok({ status: "waiting_review" as const, agentId: null });
        }
        entry.addedAs = "agent-" + entry.character;
        return ok({ status: "added" as const, agentId: entry.addedAs });
      }),
  };

  // ---- Settings
  const plan = (): PlanView => ({
    asOf: "Today, 2:00 pm",
    periodStart: "Oct 1",
    projectedOn: "Oct 31",
    creditsLeft: 1202,
    used: 798,
    monthly: 2000,
    renewsOn: "Sun, Nov 1",
    dailyAverage: "About 35 a day since Oct 1",
    projectedLeft: "About 900",
    planName: "Sample plan",
    paidThrough: "shopify",
    carryOver: "Carry over for one month",
    extraCredits: { enabled: false, upTo: null },
    byProject: [
      {
        group: "dated",
        name: "Everyday Tote in AI answers",
        detail: "Ends Fri, Dec 4",
        who: "AI answers check-up, Listings",
        credits: 36,
        planned: "About 60 to 100 planned",
      },
      {
        group: "dated",
        name: "Autumn collection",
        detail: "Ends Mon, Nov 16",
        who: "Listings, Copywriter, Business Analyst, Inventory",
        credits: 152,
        planned: "About 200 to 300 planned",
      },
      {
        group: "dated",
        name: "Black Friday sale",
        detail: "Ends Mon, Nov 30",
        who: "Sale planner, Inventory",
        credits: 56,
        planned: "About 150 to 250 planned",
      },
      {
        group: "everyday",
        name: "Product pages",
        detail: "No end date",
        who: "Listings",
        credits: 48,
        planned: null,
      },
      {
        group: "everyday",
        name: "Stock",
        detail: "No end date",
        who: "Inventory",
        credits: 40,
        planned: null,
      },
      {
        group: "everyday",
        name: "Customer emails",
        detail: "No end date",
        who: "Support",
        credits: 196,
        planned: null,
      },
      {
        group: "everyday",
        name: "Sales and numbers",
        detail: "No end date",
        who: "Business Analyst",
        credits: 104,
        planned: null,
      },
      {
        group: "everyday",
        name: "Quick tasks",
        detail: "One-off jobs",
        who: "Researcher",
        credits: 42,
        planned: null,
      },
      {
        group: "none",
        name: "Conversations with Morrow",
        detail: "Your questions, and the cards Morrow drafted",
        who: "Morrow",
        credits: 124,
        planned: null,
      },
    ],
    byHelper: [
      {
        group: "agents",
        character: "morrow",
        prop: null,
        name: "Morrow",
        where: "Your questions and the cards it drafts",
        thinking: own.morrow!.choice,
        used: 124,
        limit: null,
        note: "Counts toward your shop’s limits",
      },
      ...addedAgents().map((a) => ({
        group: "agents" as const,
        character: a.character,
        prop: null,
        name: a.name,
        where: a.worksIn.join(", "),
        thinking: { model: a.thinking.model, effort: a.thinking.effort },
        used: a.credits.used,
        limit: a.credits.limit,
        note: null,
      })),
      {
        group: "specialists",
        character: "specialist",
        prop: "magnifier",
        name: "AI answers check-up",
        where: "Everyday Tote in AI answers · finished today, 11:12 am",
        thinking: opusMedium,
        used: 16,
        limit: 40,
        note: "24 came back",
      },
      {
        group: "specialists",
        character: "specialist",
        prop: "calendar",
        name: "Sale planner",
        where: "Black Friday sale · waiting for your answer",
        thinking: opusMedium,
        used: 50,
        limit: 100,
        note: "so far",
      },
    ],
    ownerName: owner,
    viewerIsOwner: viewer === "owner",
  });
  // ---- Notifications: the viewer's own choices, and the shop's time zone (the Owner's).
  const prefs: { choices: NotificationChoices; revision: number } = {
    choices: {
      email: { soon: true, summary: true, monday: true, mentions: true },
      summaryHour: 8,
      quiet: { on: true, from: 21, until: 7 },
      timeZone: "toronto",
    },
    revision: 1,
  };
  const viewerName = viewer === "owner" ? owner : teammate;
  const notifications = (): NotificationsView => ({
    ...prefs.choices,
    viewerName: viewerName.split(" ")[0]!,
    signInEmail: viewer === "owner" ? "maya@linenandform.example" : "leo@linenandform.example",
    ownerName: owner,
    canChangeTimeZone: viewer === "owner",
    revision: prefs.revision,
    morning: empty
      ? { toReview: 0, questions: 0, tasks: 0, alerts: 0 }
      : { toReview: 3, questions: 2, tasks: 1, alerts: 1 },
  });
  // Closed values only: a choice outside the board's lists is refused, as the server would.
  const validChoices = (c: NotificationChoices & { expectedRevision: number }) =>
    typeof c === "object" &&
    c !== null &&
    typeof c.email === "object" &&
    c.email !== null &&
    Object.keys(c.email).length === emailTopics.length &&
    emailTopics.every((t) => typeof c.email[t] === "boolean") &&
    (summaryHours as readonly number[]).includes(c.summaryHour) &&
    typeof c.quiet === "object" &&
    c.quiet !== null &&
    typeof c.quiet.on === "boolean" &&
    (quietFromHours as readonly number[]).includes(c.quiet.from) &&
    (quietUntilHours as readonly number[]).includes(c.quiet.until) &&
    (shopTimeZones as readonly string[]).includes(c.timeZone) &&
    Number.isSafeInteger(c.expectedRevision);
  // ---- Activity (the board's sample day). Conversations with Morrow are not listed.
  const today = "Today, Friday, October 23";
  const earlier = "Earlier this month";
  const maya = { kind: "person" as const, name: owner, initials: "MC" };
  const leo = { kind: "person" as const, name: teammate, initials: "LM" };
  const helper = (name: string, character: AgentCharacter, prop: SpecialistProp | null = null) => ({
    kind: "helper" as const,
    name,
    character,
    prop,
  });
  const entries: readonly ActivityEntryView[] = empty
    ? []
    : [
        {
          id: "a-support-reply",
          day: today,
          time: "1:52 pm",
          actor: helper("Support", "support"),
          what: "started a reply to a new customer email",
          detail: "Customer emails · Nothing is sent until a person approves it",
          category: "work",
          badge: "working",
        },
        {
          id: "a-morrow-repeat",
          day: today,
          time: "1:40 pm",
          actor: helper("Morrow", "morrow"),
          what: "drafted a repeating task for Maya: products that stopped selling",
          detail: "Stock · Not turned on",
          category: "work",
          badge: "suggested",
        },
        {
          id: "a-approve-tote",
          day: today,
          time: "11:52 am",
          actor: maya,
          what: "approved 4 changes to the Everyday Tote",
          detail: "Written by Listings · Saved in Shopify and checked",
          category: "approvals",
          badge: "updated_in_shopify",
        },
        {
          id: "a-checkup-done",
          day: today,
          time: "11:12 am",
          actor: helper("AI answers check-up", "specialist", "magnifier"),
          what: "finished checking the Everyday Tote page",
          detail: "One-time specialist · 16 credits used, 24 came back",
          category: "work",
          badge: "done",
        },
        {
          id: "a-checkup-start",
          day: today,
          time: "10:33 am",
          actor: maya,
          what: "started the AI answers check-up, a one-time specialist",
          detail: "Limit 40 credits · Its access ends Sat, Oct 24, 10:33 am",
          category: "access",
          badge: null,
        },
        {
          id: "a-sale-question",
          day: today,
          time: "9:52 am",
          actor: helper("Sale planner", "specialist", "calendar"),
          what: "asked Maya: Should the sale leave out the Autumn collection?",
          detail: "One-time specialist · Black Friday sale",
          category: "work",
          badge: "needs_you",
        },
        {
          id: "a-summary",
          day: today,
          time: "8:00 am",
          actor: helper("Business Analyst", "business_analyst"),
          what: "sent the morning summary",
          detail: "Sales and numbers · 4 credits",
          category: "work",
          badge: null,
        },
        {
          id: "a-stock",
          day: today,
          time: "6:04 am",
          actor: helper("Inventory", "inventory"),
          what: "checked stock: 3 best sellers have less than 2 weeks left",
          detail: "Stock · Daily stock check",
          category: "work",
          badge: null,
        },
        {
          id: "a-reply-sent",
          day: earlier,
          time: "Oct 22",
          actor: leo,
          what: "approved a reply to a customer about order #10388",
          detail: "Written by Support · Sent from your shop’s Morrow address",
          category: "approvals",
          badge: "sent",
        },
        {
          id: "a-undo-tags",
          day: earlier,
          time: "Oct 21",
          actor: maya,
          what: "undid a tag change on the Utility Overshirt",
          detail: "Morrow put back the tags it read before the change, then checked them",
          category: "store",
          badge: "updated_in_shopify",
        },
        {
          id: "a-renew",
          day: earlier,
          time: "Oct 20",
          actor: maya,
          what: "renewed Listings’ permission for 90 days",
          detail: "Ends Mon, Jan 18",
          category: "access",
          badge: null,
        },
        {
          id: "a-listings-on",
          day: earlier,
          time: "Oct 14",
          actor: maya,
          what: "turned Listings back on",
          detail: "Read what Listings may do, then confirmed",
          category: "access",
          badge: null,
        },
        {
          id: "a-stop-all",
          day: earlier,
          time: "Oct 14",
          actor: maya,
          what: "stopped all AI work",
          detail: "Listings on Linen & Form · Changes waiting in the Inbox were kept",
          category: "access",
          badge: "stopped",
        },
        {
          id: "a-leo-approve",
          day: earlier,
          time: "Oct 2",
          actor: maya,
          what: "let Leo Martin approve product changes and customer replies",
          detail: "Typed to confirm",
          category: "access",
          badge: null,
        },
        {
          id: "a-linked",
          day: earlier,
          time: "Oct 2",
          actor: maya,
          what: "linked Linen & Form to Morrow",
          detail: "Morrow can see products and change them after a person approves",
          category: "store",
          badge: null,
        },
      ];
  const activity: ActivityView = { shopName: "Linen & Form", entries };

  const settings: SettingsPort = {
    notifications: (ws) =>
      reply<NotificationsView>("settings.notifications", () =>
        deps.isWorkspace(ws) ? ok(notifications()) : notFound,
      ),
    reviseNotifications: (ws, c) =>
      command<{ revision: number }>("settings.reviseNotifications", c, () => {
        if (!deps.isWorkspace(ws)) return notFound;
        const body = c.body;
        if (!validChoices(body)) return { kind: "invalid", field: null };
        if (body.expectedRevision !== prefs.revision)
          return changed("These settings changed since you opened them.");
        if (body.timeZone !== prefs.choices.timeZone && viewer !== "owner")
          return denied("Only the Owner can change the time zone.");
        prefs.choices = {
          email: { ...body.email },
          summaryHour: body.summaryHour,
          quiet: { ...body.quiet },
          timeZone: body.timeZone,
        };
        prefs.revision += 1;
        return ok({ revision: prefs.revision });
      }),
    activity: (ws) =>
      reply<ActivityView>("settings.activity", () =>
        deps.isWorkspace(ws) ? ok(activity) : notFound,
      ),
    plan: (ws) =>
      reply<PlanView>("settings.plan", () => (deps.isWorkspace(ws) ? ok(plan()) : notFound)),
    emailAddresses: (ws) =>
      reply<EmailAddressesView>("settings.emailAddresses", () =>
        deps.isWorkspace(ws)
          ? ok({
              addresses: [
                {
                  id: "sender-morrow-1",
                  kind: "morrow_managed" as const,
                  address: "linen-form@replies.[Morrow’s domain]",
                  displayName: "Linen & Form",
                  status: "active" as const,
                  isDefault: true,
                },
              ],
              supportAddress: "support@linenandform.example",
              linkable: ["google_mailbox", "microsoft_mailbox", "merchant_domain"] as const,
              waiting: empty
                ? []
                : [
                    {
                      title: "Reply to Hannah K. about order #10421",
                      agentName: "Support",
                      character: "support" as const,
                      where: "Customer emails",
                      expires: "Expires in 14 hours",
                      sender: "linen-form@replies.[Morrow’s domain]",
                    },
                  ],
              ownerName: owner,
              viewerIsOwner: viewer === "owner",
            })
          : notFound,
      ),
  };

  // ---- Shop knowledge and Files
  const knowledge: KnowledgeView = {
    items: empty
      ? []
      : [
          {
            id: "k-voice",
            kind: "fact",
            title: "Brand voice",
            text: "Calm, plain and warm. Write ‘linen’ in lowercase.",
            source: "Added by Maya Chen · Oct 6",
          },
          {
            id: "k-shipping",
            kind: "fact",
            title: "Shipping",
            text: "Free shipping in the US on orders over $75.",
            source: "From your Shopify store · updated Oct 20",
          },
          {
            id: "k-returns",
            kind: "fact",
            title: "Returns",
            text: "30 days from delivery. Items must be unworn.",
            source: "From your Shopify store · updated Oct 20",
          },
          {
            id: "k-supplier",
            kind: "fact",
            title: "Supplier",
            text: "Weave Co. makes our linen. A new order takes about 3 weeks.",
            source: "Added by Maya Chen · Oct 9",
          },
          {
            id: "k-shirt",
            kind: "fact",
            title: "Product facts: Linen Shirt",
            text: "100% European flax linen, garment washed. Off white.",
            source: "From your Shopify store · updated Oct 20",
          },
          {
            id: "k-fit",
            kind: "suggested",
            title: "Fit complaints",
            text: "When fit complaints rise, check the size chart first.",
            source: "Suggested by Listings · Oct 22",
          },
          {
            id: "k-sizes",
            kind: "lesson",
            title: "Size advice",
            text: "Size advice applies to shirts, not totes.",
            source: "Saved from Listings’ notes · Oct 16",
          },
        ],
  };
  const files: FilesView = {
    files: empty
      ? []
      : [
          {
            id: "f-summary",
            name: "Morning summary, Oct 23.pdf",
            type: "pdf",
            from: "Business Analyst",
            character: "business_analyst",
            where: "Sales and numbers",
            date: "Oct 23",
            size: "84 KB",
          },
          {
            id: "f-checkup",
            name: "AI answers check-up, Everyday Tote.pdf",
            type: "pdf",
            from: "AI answers check-up",
            character: "specialist",
            where: "Everyday Tote in AI answers",
            date: "Oct 23",
            size: "132 KB",
          },
          {
            id: "f-reorder",
            name: "Reorder plan, Utility Overshirt.xlsx",
            type: "xlsx",
            from: "Inventory",
            character: "inventory",
            where: "Stock",
            date: "Oct 22",
            size: "21 KB",
          },
          {
            id: "f-weekly",
            name: "Weekly sales, week 42.csv",
            type: "csv",
            from: "Business Analyst",
            character: "business_analyst",
            where: "Sales and numbers",
            date: "Oct 19",
            size: "9 KB",
          },
          {
            id: "f-autumn",
            name: "Autumn collection product list.csv",
            type: "csv",
            from: "Maya Chen",
            character: null,
            where: "Autumn collection",
            date: "Oct 12",
            size: "6 KB",
          },
        ],
  };
  const library: LibraryPort = {
    knowledge: (ws) =>
      reply<KnowledgeView>("library.knowledge", () =>
        deps.isWorkspace(ws) ? ok(knowledge) : notFound,
      ),
    files: (ws) =>
      reply<FilesView>("library.files", () => (deps.isWorkspace(ws) ? ok(files) : notFound)),
  };
  return { team, settings, library };
}
