// T7 PR 16: the fixed copy of Team, agent pages, Add agents, Settings, Shop knowledge and
// Files, in plain words for shop owners (ADR-0032 item 4): short sentences, buttons that
// start with a verb, and none of the internal words a test scans for. Model and effort keys
// are opaque: their labels live here, and a key without one shows as itself.
const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const credits = (n: number) => plural(n, "credit", "credits");
export const number = (n: number) => n.toLocaleString("en-US");
const stores = (n: number) => plural(n, "store", "stores");

export const sunriseCopy = {
  pills: { agent: "Agent", specialist: "Specialist · one-time" },
  hidden: {
    agent: ", agent",
    specialist: ", specialist, one-time",
    online: ", online",
    away: ", away",
  },
  status: {
    active: "Active",
    working: "Working",
    needs_you: "Needs you",
    paused: "Paused",
    done: "Done",
    needs_review: "Needs review",
    on_track: "On track",
    behind: "Behind",
    added: "Added",
    default: "Default",
    ready: "Ready",
    coming_soon: "Coming soon",
    waiting_review: "Waiting for review",
    owner_only: "Owner only",
    suggested: "Suggested",
    updated_in_shopify: "Updated in Shopify",
    sent: "Sent",
  },
  roles: { owner: "Owner", admin: "Admin", member: "Member" },
  presence: { online: "Online", away: "Away" },
  models: {
    claude_haiku_5_5: { name: "Haiku 5.5", about: "Fastest, lowest cost" },
    claude_sonnet_5_5: { name: "Sonnet 5.5", about: "Good all-rounder" },
    claude_opus_5_5: { name: "Opus 5.5", about: "Most capable, uses more credits" },
  } as Readonly<Record<string, { readonly name: string; readonly about: string }>>,
  efforts: {
    low: { name: "Low", about: "Quick, for everyday jobs" },
    medium: { name: "Medium", about: "Thinks a little longer" },
    high: { name: "High", about: "Thinks longest, for harder jobs" },
  } as Readonly<Record<string, { readonly name: string; readonly about: string }>>,
  thinking: {
    title: "How this agent thinks",
    intro: (name: string, usual: string) =>
      `The model and thinking effort ${name} uses for its jobs. Added agents start on ${usual}.`,
    model: "Model",
    modelHint: "The AI that does the work.",
    effort: "Thinking effort",
    effortHint: "How long it thinks before it answers.",
    choice: (model: string, effort: string) => `${model} · ${effort}`,
    long: (model: string, effort: string) => `${model} · ${effort} thinking effort`,
    perJob: (typical: number, most: number) =>
      `About ${credits(typical)} a job · at most ${number(most)}`,
    perJobOver: (typical: number, most: number) =>
      `About ${number(typical)} a job · needs up to ${number(most)}, over its limit`,
    perProduct: (n: number) => `About ${credits(n)} a product`,
    perProductOver: (n: number, limit: number) =>
      `${credits(n)} a product · over your limit of ${number(limit)}`,
    notOffered: "Not offered right now",
    note: (choice: string, estimate: string) =>
      `${choice}: ${estimate}. Higher settings use more credits for each job, and the agent still stays within its spending limit.`,
    overTitle: (choice: string) => `${choice} doesn’t fit the spending limit`,
    overJob: (most: number, limit: number) =>
      `One job can need up to ${credits(most)}, and this agent can use ${credits(limit)} a day. Pick a lower setting, or raise the limit.`,
    overProduct: (credit: number, ceiling: number) =>
      `This setting uses ${credits(credit)} a product, and your shop’s limit is ${credits(ceiling)} a product. Pick a lower setting, or raise the limit in Settings.`,
    editLimits: "Edit limits",
    applies: "Applies from the next job. It doesn’t change what this agent can do.",
    appliesSpecialists:
      "Applies to specialists you start from now on. It doesn’t change what a specialist can do.",
    pending: (name: string, choice: string) =>
      `From its next job, ${name} will use ${choice}. A job it has already started finishes as it is.`,
    saved: (name: string, choice: string) => `Saved. From its next job, ${name} uses ${choice}.`,
    pendingSpecialists: (choice: string) =>
      `Specialists you start after you save will use ${choice}.`,
    savedSpecialists: (choice: string) => `Saved. New specialists will start on ${choice}.`,
    usual: (choice: string) => `Usual choice: ${choice}`,
    usualSpecialists: (choice: string) => `Usual choice for specialists: ${choice}`,
    onlyOwner: (owner: string, name: string) =>
      `Only ${owner}, the Owner, can change this. Ask them if ${name} needs a different setting.`,
    onlyOwnerOrAdmin: (owner: string, name: string) =>
      `Only ${owner}, the Owner, or an Admin can change this. Ask them if ${name} needs a different setting.`,
    changed: "This changed since you opened it. The current setting is shown; pick again.",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    change: "Change",
    changeLabel: (name: string) => `Change how ${name} thinks`,
    dialogTitle: (name: string) => `Change how ${name} thinks`,
    dialogTitleSpecialists: "Change how new specialists think",
    summary: (model: string, effort: string) => `${model} · Thinking effort: ${effort}`,
  },
  team: {
    title: "Team",
    intro: (shop: string) =>
      `Who works at ${shop}, and what each one may do. Agents ask before changing anything in your store.`,
    addAgents: "Add agents",
    mainAgent: "Main agent",
    mainAgentTag: "Main agent",
    morrowAbout:
      "Your main helper. It answers questions, plans work with you and picks the right helper for each job.",
    morrowWorksIn: "Everywhere: the Ask Morrow button, or @Morrow in a project",
    agents: "Agents",
    agentsEmpty: "No agents yet",
    agentsEmptyBody:
      "Agents each do one job, like keeping product pages complete. Add one to start. It asks before changing anything.",
    spending: "Spending by helper",
    worksIn: "Works in",
    creditsThisMonth: "Credits this month",
    model: "Model",
    lines: {
      last: "Last",
      now: "Now",
      next: "Next",
      waiting: "Waiting for you",
      cannot: "What it can’t do",
      access_ends: "Access ends",
      credits: "Credits",
    },
    titleNote:
      "A title never gives an agent more power. Each agent does only what its permission allows, never more than the person who asked, and asks before changing anything in your store.",
    specialists: "One-time specialists",
    specialistsIntro:
      "Built for one task that no agent covers. Only the Owner can start one, and its access ends 24 hours after it starts.",
    specialistsEmpty: "No specialists right now. Morrow suggests one when no agent fits a task.",
    newSpecialists: "New specialists",
    newSpecialistsIntro:
      "What each new specialist starts on. You can pick another on its card before you start it.",
    people: "People",
    you: "(you)",
    canApprove: "Can approve",
    givenBy: (who: string) => `given by ${who}`,
    ownerOnly:
      "Only the Owner can start one-time specialists and choose how Morrow and specialists think.",
    countLabel: (n: number, noun: string) => `${n} ${noun}`,
  },
  agent: {
    breadcrumb: "Team",
    addedBy: (who: string, on: string, places: number) =>
      `Added by ${who} on ${on} · Works in ${plural(places, "place", "places")} · Asks before changing anything in your store`,
    giveTask: (name: string) => `Give ${name} a task`,
    whatItDoes: "What it does",
    worksToward: "Works toward",
    progress: (percent: number, target: string) => `${percent}% now · ${target}`,
    goalNote: "Goals live in their project.",
    worksIn: "Works in",
    allowed: "What this agent is allowed to do",
    stricter: "You can make these rules stricter at any time.",
    recent: "Recent work",
    recentEmpty: "Nothing yet. Its work shows here once it starts.",
    columns: { what: "What", where: "Where", when: "When", result: "Result", credits: "Credits" },
    status: "Status",
    lastJob: "Last job",
    next: "Next",
    credits: "Credits",
    thisMonth: "This month",
    today: "Today",
    of: (used: number, limit: number) => `${number(used)} of ${number(limit)}`,
    resets: (on: string) => `Starts again on ${on}`,
    limitText: (day: number, month: number, name: string) =>
      `Spending limit: up to ${credits(day)} a day and ${number(month)} a month. If ${name} reaches a limit, it stops and tells you.`,
    permission: "Permission",
    permissionFrom: (who: string, on: string) => `Permission from ${who} · ${on}`,
    renewEvery: "Agents need your OK every 90 days.",
    nextRenewal: (on: string, days: number) =>
      `Next renewal: ${on} · in ${plural(days, "day", "days")}`,
    renewBy: (owner: string) => `Only ${owner} can renew it.`,
    access: "Access in Shopify",
    noAccess: "No extra access in Shopify",
    when: "When it works",
    whenNote: "Repeating tasks live in the project they serve.",
    notes: "Notes it keeps",
    notesIntro: (name: string) =>
      `${name} keeps these notes between jobs so it remembers what it learned.`,
    notesEmpty: "No notes yet.",
    onTrack: "On track",
  },
  add: {
    breadcrumb: "Team",
    title: "Add agents",
    intro:
      "Ready-made agents from Morrow. Each one has a job and its own everyday work, and asks before changing anything in your store.",
    filterLabel: "Show agents for",
    filters: {
      all: "All",
      product_pages: "Product pages",
      sales: "Sales and numbers",
      stock: "Stock",
      customer_emails: "Customer emails",
      promotions: "Promotions",
    },
    yours: "Your agents",
    yoursIntro: (shop: string) =>
      `Already working for ${shop}, alongside Morrow, your main helper.`,
    more: "More agents",
    moreIntro: "Ready to add. You see exactly what each one may do before it starts.",
    noMatch: "No agents match this filter. Choose All to see every agent.",
    byMorrow: "By Morrow",
    view: "View",
    worksIn: (text: string) => text,
    how: "What happens when you add an agent",
    steps: [
      {
        title: "You check what it may do",
        body: "Its permission, its credit limit, and its model and thinking effort. Nothing starts before you say OK.",
      },
      {
        title: "A teammate may review it too",
        body: "When someone else on your team has access to the same parts of your store, they approve its permission before it starts.",
      },
      {
        title: "Shopify asks you, if it needs new access",
        body: "Morrow uses that access only for this agent, and gives it back if no agent needs it.",
      },
      {
        title: "It gets its own everyday work",
        body: "It asks before changing anything, and needs your OK again every 90 days.",
      },
    ],
    addButton: (name: string) => `Add ${name}`,
    preparing: "Preparing…",
    addNote: "You’ll see exactly what it can do first.",
    addNoteReview: (reviewer: string) =>
      `You’ll see exactly what it can do first. ${reviewer} reviews it before it starts.`,
    cannotAdd: (owner: string) => `Only ${owner}, the Owner, or an Admin can add agents.`,
    openPage: (name: string) => `Open ${name}’s page`,
    whatItDoes: "What it does",
    whereItWorks: "Where it works",
    when: "When it works",
    allowed: "What it’s allowed to do",
    access: "Access it needs in Shopify",
    noAccess: "No new access in Shopify.",
    thinking: "Model and thinking effort",
    startsOn: (choice: string) => `Starts on ${choice}.`,
    thinkingNote:
      "Higher effort, or Opus 5.5, does more careful work and uses more credits. You can change this later on the agent’s page.",
    credits: "Credits",
    limit: "Limit",
    limitSuffix: "credits a month",
    limitHint: (name: string, left: number, renews: string) =>
      `${name} pauses and tells you if it reaches this. You have ${credits(left)} left until ${renews}.`,
    limitError: (min: number, max: number) =>
      `Enter a whole number from ${number(min)} to ${number(max)}.`,
    example: "Example of its work",
    exampleNote: "Example only. Not about your shop.",
    footnote: "Agents never change your store or email a customer without your OK.",
    dialogTitle: (name: string, shop: string) => `Add ${name} to ${shop}?`,
    willBeAble: (name: string) => `${name} will be able to`,
    willNotBeAble: (name: string) => `${name} will not be able to`,
    everydayWork: "Everyday work",
    creditLimit: "Credit limit",
    creditLimitValue: (n: number) => `${number(n)} credits a month`,
    nextReview: (reviewer: string) =>
      `Next, ${reviewer} reviews this. They also have access to your products, so this agent starts only after they approve this exact permission.`,
    nextShopify:
      "Then Shopify asks you to allow the access below. It is only for this agent. If you remove the agent and no other agent needs it, Morrow gives it back.",
    renewal: "Agents need your OK every 90 days to keep working.",
    exact: "You’re approving exactly what you see. If anything changes, it needs a new OK.",
    confirm: "Add agent",
    confirmReview: (reviewer: string) => `Send to ${reviewer} to review`,
    adding: "Adding…",
    cancel: "Cancel",
    expired:
      "This review expired, was already used, or no longer matches. Nothing changed. Start again.",
    addedTitle: (name: string) => `${name} was added`,
    addedBody:
      "It starts on its schedule, and asks before changing anything. If it needs new access, Shopify asks you next.",
    reviewTitle: (name: string, reviewer: string) => `${name} was sent to ${reviewer} to review`,
    reviewBody: (reviewer: string) =>
      `It’s in ${reviewer}’s Inbox with the exact permission you approved. The agent starts only after they approve it.`,
    dismiss: "Dismiss",
    waiting: "Waiting for review",
  },
  settings: {
    title: "Settings",
    intro: (shop: string) => `Your plan, your team and how Morrow works for ${shop}.`,
    menu: "Settings",
    items: {
      plan: { title: "Plan and credits", about: "Your plan, credits left and where they went." },
      people: {
        title: "People and roles",
        about: "Who works here and what each person can approve.",
      },
      notifications: {
        title: "Notifications",
        about: "What Morrow tells you about, and when. Everyone chooses their own.",
      },
      email: { title: "Email addresses", about: "Where replies to your customers are sent from." },
      shopify: { title: "Shopify connection", about: "Your store and the access Morrow has." },
      activity: {
        title: "Activity",
        about: "Everything people, agents and Morrow did. Stop all AI work from here.",
      },
      governance: {
        title: "Model default",
        about: "The model your shop starts on, and the most a product may use.",
      },
    },
    stopAll: "Stop all AI work",
  },
  notifications: {
    title: "Notifications",
    intro: (name: string, shop: string) =>
      `What Morrow tells you about, and when. These are your own settings, ${name}. Everyone at ${shop} chooses their own.`,
    where: "Where Morrow reaches you",
    inMorrow: "In Morrow",
    inMorrowValue: "Your Inbox and Home. Always on.",
    email: "Email",
    emailHint:
      "The email you sign in with. Emails hold counts and links only, never customer details or product text.",
    phone: "On your phone",
    phoneValue: "Open the link in any email. Morrow works in your phone’s browser.",
    what: "What to tell you, and where",
    columns: { what: "What", inMorrow: "In Morrow", byEmail: "By email" },
    topics: {
      soon: {
        title: "Something needs you soon",
        about:
          "A change about to expire, a customer waiting, the store disconnected or a limit reached",
        inMorrow: "Right away",
        switchLabel: "Email me when something needs me soon",
        note: "If it’s still waiting after 4 hours",
      },
      summary: {
        title: "Morning summary",
        about: "Yesterday’s numbers, today’s plan and what’s waiting for you",
        inMorrow: "On Home",
        switchLabel: "Email me the morning summary",
        note: "",
      },
      monday: {
        title: "Monday project updates",
        about: "One update for each active project, every Monday at 8:00 am",
        inMorrow: "In each project",
        switchLabel: "Email me each Monday project update",
        note: "",
      },
      mentions: {
        title: "Mentions",
        about: "When someone mentions you by name in a project",
        inMorrow: "Right away",
        switchLabel: "Email me when someone mentions me",
        note: "",
      },
    } as Readonly<
      Record<
        string,
        {
          readonly title: string;
          readonly about: string;
          readonly inMorrow: string;
          readonly switchLabel: string;
          readonly note: string;
        }
      >
    >,
    mondayOff: "You still see each update in its project.",
    everythingElse: "Everything else",
    everythingElseAbout: "Finished jobs and small changes",
    inActivity: "In Activity",
    neverByEmail: "Never by email",
    on: "On",
    off: "Off",
    sendAt: "Send at",
    quiet: "Quiet hours",
    quietAbout:
      "During quiet hours Morrow holds notifications, except things that need you soon. Agents also wait until quiet hours end to start work on a schedule.",
    from: "From",
    until: "Until",
    everyDay: (zone: string) => `Every day · ${zone}`,
    timeZone: "Time zone",
    timeZoneLabel: (shop: string) => `${shop}’s time zone`,
    timeZoneHint: (shop: string) =>
      `Schedules, summaries and quiet hours use it. It’s the same for everyone at ${shop}, and only the Owner can change it.`,
    timeZoneOwner: (owner: string) => `Only ${owner} (Owner) can change the time zone.`,
    zones: {
      toronto: "Eastern Time (Toronto)",
      winnipeg: "Central Time (Winnipeg)",
      edmonton: "Mountain Time (Edmonton)",
      vancouver: "Pacific Time (Vancouver)",
    } as Readonly<Record<string, string>>,
    hour: (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "am" : "pm"}`,
    preview: "Your morning email",
    previewFrom: (time: string) => `From Morrow · ${time}`,
    previewSubject: (shop: string, n: number) =>
      `Your morning at ${shop}: ${n === 1 ? "1 thing is" : `${number(n)} things are`} waiting`,
    previewLines: {
      toReview: (n: number) => plural(n, "change to review", "changes to review"),
      questions: (n: number) => plural(n, "question", "questions"),
      tasks: (n: number) => plural(n, "task for you", "tasks for you"),
      alerts: (n: number) => plural(n, "alert", "alerts"),
    },
    previewOpen: "Open Morrow",
    previewWhy: "You get this because the morning summary is on. Change it in Notifications.",
    previewOff: "The morning summary email is off. You still see the summary on Home.",
    unsaved: "You have unsaved changes",
    discard: "Discard",
    save: "Save",
    saving: "Saving…",
    saved: "Notifications saved.",
    changed: "These settings changed since you opened them. Here they are now; choose again.",
  },
  activity: {
    title: "Activity",
    intro: (shop: string) =>
      `Everything people, agents and Morrow did at ${shop}. Nobody can change or delete it.`,
    download: "Download",
    list: "What happened",
    filtersLabel: "Show in Activity",
    filters: {
      all: "Everything",
      store: "Store changes",
      approvals: "Approvals",
      access: "Access and stops",
    },
    empty: "Nothing here yet.",
    emptyFiltered: "Nothing of this kind yet.",
    private:
      "Conversations with Morrow are private, so they aren’t listed. When an Admin reads someone’s conversation, that read is listed here.",
    listLater: "The full list arrives with the activity log.",
  },
  // What this stops today is the Listings agent on each store (the only AI work that can
  // change a store yet); the words say so, and never claim more stopped than did.
  stop: {
    title: "Stop all AI work",
    body: "Today this stops the Listings agent on each of your stores, the AI work that can change your store. Nothing new starts, and nothing it would send or change goes ahead until a person turns it back on. Only people can do this. Agents can’t.",
    on: (n: number) => `AI work is on · Listings can be stopped on ${stores(n)}`,
    open: "Stop all AI work",
    stoppedTitle: (n: number) => `Listings is stopped on ${stores(n)}`,
    stoppedBody:
      "Nothing it would send or change goes ahead. Changes waiting for approval stay in your Inbox, and nothing is applied until a person turns it back on.",
    turnOnHow:
      "To turn it back on, resume Listings from each store’s page. Work that was stopped doesn’t restart by itself.",
    openStore: "Open Shopify connection",
    nothing: "No AI work is on, so there’s nothing to stop.",
    notAllowed: "Only a person who may stop agents can do this. Ask your shop’s Owner.",
    someNotAllowed: (n: number) =>
      `AI work is still on in ${stores(n)} you can’t stop. Ask the Owner.`,
    loading: "Checking what’s working…",
    readFailed: "Couldn’t check what’s working. Try again.",
    tryAgain: "Try again",
    dialogTitle: "Stop all AI work?",
    dialogBody:
      "Listings stops now on the stores below, and nothing new starts. Nothing it would send or change goes ahead until a person turns it back on. You don’t need anyone else to approve this.",
    whatStops: "What stops",
    target: (store: string) => `Listings on ${store}`,
    whatStays: "What stays",
    stays: [
      "Changes waiting in your Inbox. None are applied while Listings is stopped.",
      "Your store connection. To cut Morrow off from your store, disconnect it instead.",
    ],
    typeLabel: (word: string) => `To confirm, type: ${word}`,
    typeHint: "Type the word, then press Stop all AI work.",
    cancel: "Cancel",
    close: "Close",
    confirm: "Stop all AI work",
    stopping: "Stopping…",
    reason: "Stop all AI work, from Settings",
    rows: {
      sending: "Stopping…",
      stopped: "Stopped",
      uncertain: "We couldn’t confirm this stopped. Check again before you do anything else.",
      checking: "Checking whether it stopped…",
      refused: "Not stopped.",
      notSent: "Not stopped. Nothing was sent; try again.",
    },
    checkAgain: "Check again",
    done: (n: number) => `Listings is stopped on ${stores(n)}.`,
    partly: "Some work isn’t confirmed as stopped yet. Check each store again before you go on.",
  },
  plan: {
    title: "Plan and credits",
    intro: (shop: string) =>
      `One credit balance for ${shop}. See what’s left, where it went this month, and what uses credits.`,
    ownerOnly: (owner: string) => `Only ${owner}, the Owner, can change the plan or the limits.`,
    thisMonth: "Credits this month",
    left: "credits left",
    usedOf: (used: number, monthly: number, renews: string) =>
      `${number(used)} of ${number(monthly)} used · ${number(monthly)} new credits on ${renews}`,
    usedSoFar: "Used so far",
    projected: (end: string) => `Left on ${end}, at this pace`,
    extra: "Extra credits",
    extraOff: "Off",
    extraOffSub: "AI work pauses when credits are used up",
    extraOn: (n: number) => `Up to ${number(n)} a month`,
    cameBack: "Credits that came back from finished jobs are already added to what’s left.",
    yourPlan: "Your plan",
    plan: "Plan",
    paidThrough: "Paid through",
    paidShopify: "Your Shopify bill",
    paidMorrow: "Morrow",
    creditsRow: "Credits",
    creditsEvery: (n: number) => `${number(n)} every month`,
    renews: "Renews",
    unused: "Unused credits",
    extraNote:
      "Morrow, agents and specialists can’t raise a limit or turn on extra credits. They can only suggest it to you.",
    where: "Where your credits went",
    whereSub: (asOf: string, used: number) => `Oct 1 to ${asOf.toLowerCase()} · ${credits(used)}`,
    byProject: "By project",
    byHelper: "By helper",
    viewLabel: "Show spending",
    groups: {
      dated: "Projects with an end date",
      everyday: "Everyday work",
      none: "Not in a project",
      agents: "Morrow and your agents",
      specialists: "One-time specialists",
    },
    columns: {
      project: "Project",
      who: "Who worked on it",
      used: "Credits used",
      helper: "Helper",
      thinking: "Model and thinking effort",
      ofLimit: "Used of its limit",
    },
    total: "Total this month",
    totalOf: (n: number) => `of ${number(n)} plan credits`,
    ofLimit: (used: number, limit: number) => `${number(used)} of ${number(limit)} a month`,
    projectNote: "A project’s plan is an estimate; the limits below are what stop spending.",
    helperNote:
      "An agent that reaches its monthly limit stops and tells you. Opus 5.5, or more thinking effort, uses more credits for the same job.",
    uses: "What uses credits",
    usesYes: "Uses credits",
    usesNo: "Never uses credits",
    usesList: [
      "Asking Morrow. Each answer, and each card it drafts, uses a few credits.",
      "An agent or specialist reading, planning or writing for you.",
      "Longer jobs that build a file, such as a report, for the time they take.",
      "Sending a customer reply you approved.",
    ],
    freeList: [
      "Approving, declining or editing a change, and putting it into Shopify",
      "Alerts that only watch a number, like low stock",
      "Notifications, reminders and your Inbox",
      "Stopping work, pausing an agent, or Stop all AI work",
      "A job that fails. It costs nothing.",
    ],
    limits: "Limits that keep spending in check",
    limitsList: [
      "Every job gets a limit before it starts. Credits it doesn’t use come back when it ends.",
      "Each agent has a monthly limit. If it reaches it, it stops and tells you.",
      "Your shop has a daily safety limit too. If today’s is reached, new work waits until tomorrow.",
      "When your credits are used up, AI work pauses until they renew, unless you allow extra credits.",
      "Morrow never raises a limit or turns on extra credits. An agent can suggest it; only the Owner can say yes.",
    ],
  },
  email: {
    title: "Email addresses",
    intro: "Where replies to your customers are sent from. Only the Owner can change these.",
    memberIntro: (owner: string) =>
      `Only ${owner} (Owner) can change these. You can still send from this address when you approve a reply.`,
    yours: "Your shop’s addresses",
    morrowMade:
      "Morrow made this address for your shop. Replies to customers are sent from it unless you choose another.",
    usedFor: "Used for:",
    usedForValue: "replies to customers",
    senderName: "Sender name",
    senderNameHint: "Customers see this name next to every reply.",
    answersGoTo: "Customers’ answers go to",
    answersHint:
      "When a customer writes back, it reaches this inbox. A copy of every reply goes here too.",
    answersNotSet: "Not set yet",
    noDirect:
      "Customers can’t write to this address directly. It stays the same even if you rename your shop.",
    copy: "Copy address",
    copied: "Address copied.",
    copyFailed: "Couldn’t copy. Select the address and copy it yourself.",
    link: "Link your own email address",
    linkIntro:
      "Send replies from an address your customers already know. Once one is linked, you can make it your default or pick it when you approve a reply.",
    linkable: {
      google_mailbox: { title: "Gmail", body: "Send from your Gmail or Google Workspace address." },
      microsoft_mailbox: {
        title: "Outlook",
        body: "Send from your Outlook or Microsoft 365 address.",
      },
      merchant_domain: {
        title: "Your own domain",
        body: "Send from an address at your own website.",
      },
    } as Readonly<Record<string, { readonly title: string; readonly body: string }>>,
    comingSoon: "Coming soon",
    until: (address: string) => `Until then, replies are sent from ${address}.`,
    defaultTitle: "Default address for new emails",
    defaultIntro:
      "Morrow uses this address for each new reply to a customer. Replies already waiting for an OK keep the address they were written with.",
    sendFrom: "Send new replies from",
    morrowAddress: "Your shop’s Morrow address",
    ownAddress: "Your own email address",
    ownAddressSoon: "Coming soon. You can choose it here once it’s linked.",
    defaultOwner: (owner: string) => `Only ${owner} (Owner) can change the default.`,
    waiting: "Replies waiting to be sent",
    waitingEmpty: "No replies are waiting.",
    seeInbox: "See all in Inbox",
    sendsFrom: (address: string) => `Sends from ${address}`,
    never: "Agents never email a customer without a person’s OK.",
  },
  people: {
    title: "People and roles",
    intro: (shop: string) => `Who works at ${shop}, and what each person can approve.`,
  },
  knowledge: {
    title: "Shop knowledge",
    intro:
      "What Morrow and your agents know about your shop. They read it before they write anything for you.",
    tabs: "Shop knowledge sections",
    kinds: { fact: "Shop facts", suggested: "Suggested notes", lesson: "Lessons" },
    empty: {
      fact: "No shop facts yet. Facts from your Shopify store show here once your store is connected.",
      suggested: "No suggested notes. Agents suggest one when they learn something useful.",
      lesson: "No lessons yet. Lessons are notes you saved from an agent’s work.",
    },
    later: "Adding and editing shop knowledge is coming soon.",
  },
  files: {
    title: "Files",
    intro: "Reports, plans and lists that you and your agents made.",
    upload: "Upload a file",
    uploadLater: "Uploading your own files is coming soon.",
    columns: { name: "Name", from: "From", where: "Where", date: "Date", size: "Size" },
    types: { pdf: "PDF", csv: "CSV", xlsx: "Spreadsheet", image: "Image" },
    empty: "No files yet",
    emptyBody: "Reports and lists your agents make show here.",
  },
  notBuilt: "This isn’t available in this build yet.",
} as const;
