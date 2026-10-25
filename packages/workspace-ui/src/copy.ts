// Fixed interface copy (P14.T01a §4.4). Actions name their effect, and nothing reads
// as success before a confirmed response. Server text appears only as an envelope's
// safeMessage and reference (§4.8); identity replies always map to this copy.
export const copy = {
  provisional: "Provisional workspace · design under review",
  fixture: "Fixture data · not connected to Morrow",
  skip: "Skip to content",
  brand: "Morrow",
  navigationLabel: "Workspace navigation",
  openNavigation: "Open navigation",
  closeNavigation: "Close navigation",
  signIn: {
    title: "Sign in to Morrow",
    landing: "You'll continue to the sign-in page, then come back to your workspaces.",
    sessionEndedTitle: "Sign in to continue",
    sessionEnded: "Your session ended. Sign in again to open this workspace.",
    button: "Sign in",
    starting: "Starting sign-in…",
    failed: "Sign-in couldn't start. Try again in a moment.",
    needWorkspaceLink: "Open the workspace link you were given to sign in.",
    draftsDropped: "Unsent text wasn't kept.",
  },
  signOut: {
    button: "Sign out",
    working: "Signing out…",
    incomplete: "Sign-out didn't complete. You're still signed in.",
    unconfirmedTitle: "We couldn't confirm you were signed out",
    unconfirmed:
      "This tab no longer shows your workspace. Try again to confirm the session has ended.",
    tryAgain: "Try again",
    doneTitle: "You're signed out",
    done: "Your session on this device has ended.",
  },
  account: {
    title: "Your workspaces",
    landing: "Open the workspace link you were given to sign in.",
    choose: "Choose a workspace to open.",
    truncated: "Showing the first 100 workspaces.",
    invite: "You don't have a workspace yet. Ask an owner to invite you.",
    createTitle: "Create your organization",
    createIntro:
      "This creates one organization with its first workspace. You can link a store and invite people afterwards.",
    organizationName: "Organization name",
    workspaceName: "Workspace name",
    nameHint: "1 to 100 characters.",
    create: "Create organization",
    creating: "Creating…",
    created: "Your organization was created.",
    invalidName: "Check this name and try again.",
    unavailable: "Creating an organization isn't available for this account.",
    alreadyOnboarded: "You already created an organization. Your workspaces are listed again.",
    keyConflict: "This request didn't match an earlier one. Edit the form and submit again.",
    rateLimited: (seconds: number) => {
      const wait =
        seconds < 60
          ? `${seconds} ${seconds === 1 ? "second" : "seconds"}`
          : `${Math.ceil(seconds / 60)} ${Math.ceil(seconds / 60) === 1 ? "minute" : "minutes"}`;
      return `Too many attempts. Nothing was created. You can try again in ${wait}.`;
    },
  },
  workspace: {
    unavailableTitle: "This workspace isn't available to you",
    unavailable:
      "The link may be wrong, or your access may have changed. Nothing from this workspace is shown.",
    backToAccount: "Go to your workspaces",
    loadFailedTitle: "This workspace couldn't load",
    loadFailed: "Morrow couldn't reach the workspace. Nothing was changed.",
    switcherLabel: "Switch workspace",
    switcherOnlyCurrent: "Other workspaces aren't listed in this build.",
  },
  notFound: {
    title: "Page not found",
    body: "This address doesn't match a page in Morrow.",
    back: "Go to Morrow",
  },
  // ADR-0032, the Sunrise sidebar: the seven destinations of the route contract, with
  // three labels changed for shop owners ("Work" is Projects, "Agents" is Team, "Assets"
  // is Files). Route ids, paths and the contract's titles don't change.
  destinations: {
    home: "Home",
    work: "Projects",
    inbox: "Inbox",
    agents: "Team",
    assets: "Files",
    knowledge: "Shop knowledge",
    settings: "Settings",
  },
  /** Tab titles and unbuilt-page names for routes whose label differs from the contract's. */
  routeTitles: {
    work: "Projects",
    agents: "Team",
    assets: "Files",
    knowledge: "Shop knowledge",
    ask: "Ask Morrow",
    agent_store: "Add agents",
    connections: "Shopify connection",
  } as Readonly<Record<string, string>>,
  shell: {
    askMorrow: "Ask Morrow",
    searchLabel: (store: string) => `Search ${store}`,
    searchPlaceholder: "Search…",
    searchLater: "Search isn't available in this build yet.",
    pinnedProjects: "Pinned projects",
    teamMembers: "Team members",
    everydayWork: "Everyday work",
    agentSuffix: ", agent",
    online: ", online",
    away: ", away",
    inboxWaiting: (count: string) => `Inbox, ${count} waiting`,
    ends: (date: string) => `Ends ${date}`,
    credits: (count: string) => `${count} credits left`,
    sampleData: "Sample data",
    sampleSuffix: ", sample data",
    connection: {
      linked: "Shopify connected",
      unlinked: "Finish connecting your store",
      suspended: "Store disconnected",
      uninstalled: "Store disconnected",
      none: "Connect your store",
    } as Readonly<Record<string, string>>,
  },
  // ADR-0032: the Settings sub-navigation the ConnectStore board draws, by the route
  // contract's section values (`settingsRoutes` in components/settings-frame.tsx says which
  // page each holds; T7 PR 16). Activity sits under Settings, never in the sidebar.
  settings: {
    navLabel: "Settings",
    sections: {
      usage: "Plan and credits",
      people: "People and roles",
      notifications: "Notifications",
      stores: "Email addresses",
      governance: "Activity",
      billing: "Model default",
    } as Readonly<Record<string, string>>,
    connection: "Shopify connection",
    stopAll: "Stop all AI work",
  },
  unavailableDestination: (title: string) =>
    `${title} isn't available in this provisional build. Nothing here is hidden from you; it hasn't been built yet.`,
  states: {
    loading: "Loading…",
    empty: "Nothing here yet.",
    denied: "You don't have access to view this.",
    notFound: "This item doesn't exist or isn't available to you.",
    unavailable: "This couldn't load. Nothing was changed.",
    offline: "You're offline. Reconnect, then try again.",
    notInBuild: "This isn't available in this provisional build.",
    retry: "Retry",
    reference: (reference: string) => `Reference: ${reference}`,
  },
  // ADR-0032 Home: the day at a glance. Real data today: what waits for you in the Inbox
  // (open questions), recent work and the store connection. The rest of the board shows
  // only from fixtures behind the default-off `samples.home` switch.
  home: {
    greeting: (hour: number) =>
      hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening",
    scope: (store: string) => `Here's your day at ${store}.`,
    scopeClear: (store: string) => `Nothing needs you right now. Here's your day at ${store}.`,
    review: (count: string) => `Review ${count} ${count === "1" ? "item" : "items"}`,
    waitingLabel: "Waiting for you",
    questionsChip: (count: string) => `${count} ${count === "1" ? "question" : "questions"}`,
    reviewChip: (count: number) => `${count} to review`,
    tasksChip: (count: number) => `${count} ${count === 1 ? "task" : "tasks"} for you`,
    alertChip: (count: number) => `${count} ${count === 1 ? "alert" : "alerts"}`,
    needsTitle: "Needs you",
    seeAllInbox: (count: string) => `See all ${count} in Inbox`,
    questionLine: "A question for you",
    expires: (date: string) => `Expires ${date}`,
    needsYou: "Needs you",
    nothingWaiting: "Nothing needs you right now.",
    recentTitle: "Recent work",
    seeAllProjects: "See all in Projects",
    updated: (date: string) => `Updated ${date}`,
    noWork: "No work yet. Work you and your agents start shows up here.",
    storeTitle: "Your store",
    storeOpen: "See connection",
    storeConnect: "Connect your store",
    noStore:
      "No store is connected yet. Connect your Shopify store so agents can suggest changes for you to approve.",
    footer: "Agents never change your store or reply to a customer without your OK.",
    prepaymentTitle: "Paid work",
    prepayment:
      "Paid work starts once this workspace has an active plan. Plans aren't available in this provisional build.",
    samples: {
      note: "Sample data · a preview of what's coming",
      todayTitle: "Today",
      todaySource: "From your schedules and due dates",
      next: "Next",
      projectsTitle: "Your projects",
      projectsGroup: "Projects",
      everydayGroup: "Everyday work",
      glanceTitle: "Yesterday at a glance",
      take: (name: string) => `${name}'s take`,
      ideasTitle: "Ideas",
      ideasNote: "From your agents. Nothing is added unless you choose.",
      dismiss: "Dismiss",
      dismissIdea: (agent: string) => `Dismiss the idea from ${agent}`,
      noIdeas: "No more ideas for now. New ones show up here.",
      askIntro:
        "Tell Morrow what you want to get done. It answers, or drafts a task or project for you to start.",
      recent: "Recent",
      openAsk: "Open Ask Morrow",
      privacy:
        "Private to you. Admins can read your conversations with Morrow, and each read is recorded.",
    },
    status: {
      done: "Done",
      working: "Working",
      to_do: "To do",
      on_track: "On track",
      behind: "Behind",
      needs_you: "Needs you",
    } as Readonly<Record<string, string>>,
  },
  work: {
    title: "Projects",
    empty: "No work yet",
    emptyBody: "Create a goal to start organising tasks.",
    denied: "You don't have access to view work",
    createGoal: "Create goal",
    createGoalTitle: "Create a goal",
    objective: "Objective",
    objectiveHint: "Up to 8,192 characters.",
    criteria: "Success criteria",
    criterion: (n: number) => `Criterion ${n}`,
    criteriaHint: "1 to 20 criteria, each up to 2,048 characters.",
    addCriterion: "Add criterion",
    removeCriterion: (n: number) => `Remove criterion ${n}`,
    saveGoal: "Create goal",
    goalCreated: "Goal created.",
    createTask: "Create task",
    createTaskTitle: "Create a task",
    saveTask: "Create task",
    taskCreated: "Task created.",
    showTasks: "Show tasks",
    hideTasks: "Hide tasks",
    noTasks: "No tasks for this goal yet.",
    loadMore: "Load more",
    cancel: "Cancel",
  },
  task: {
    breadcrumb: "Projects",
    tabsLabel: "Task sections",
    brief: "Brief",
    questions: "Questions",
    goal: "Goal",
    status: "Status",
    owner: "Owner",
    revision: (n: number) => `Revision ${n}`,
    markReady: "Mark ready",
    markedReady: "Task marked ready.",
    conflictRefreshed:
      "This task changed. The current values are shown; review them and try again.",
    noQuestions: "No questions on this task.",
    openQuestion: "Open question",
    showAnswer: "Show answer",
    hideAnswer: "Hide answer",
    cancelQuestion: "Cancel question",
    questionCancelled: "Question cancelled.",
    peopleUnavailable:
      "Assigning the task and asking someone a question need the people list, which isn't available in this build.",
    panesLabel: "Task panels",
    paneTask: "Task",
    paneConversation: "Conversation",
    paneActivity: "Activity",
    conversationTitle: "Conversation",
    activityTitle: "Activity",
  },
  // v1 PR 15: the Inbox's own words are in sunrise/inbox-copy.ts.
  inbox: {
    title: "Inbox",
  },
  question: {
    title: "Question",
    back: "Back to Inbox",
    answerLabel: "Your answer",
    answerTitle: "Answer",
    answerHint: "Up to 8,192 characters.",
    answerNote: "Answering doesn't approve any change.",
    send: "Send answer",
    sent: "Answer sent.",
    answeredBy: "Answered by",
    cancelled: "This question was cancelled.",
    expired: "This question expired.",
  },
  // M2 PR-2: the store connections screens and the install-continuation link step.
  connections: {
    title: "Shopify connection",
    storesTitle: "Stores",
    noStores: "No store is connected to this workspace yet.",
    installTitle: "Connect your Shopify store",
    installOffered:
      "Install the Morrow app on your development store from its private install link. Shopify then sends you back here to finish connecting.",
    installLink: "Open the install link",
    installLinkNote: "Opens Shopify in a new tab.",
    installReason: {
      linked: "This workspace already has a connected store.",
      not_permitted: "Only the workspace owner sees the install link.",
      not_registered:
        "Your store's install link isn't ready yet. Morrow sets it up for each beta store.",
      route_not_ready: "Subscribe before connecting a store.",
    },
    scopes: "Access",
    scopeLabels: {
      read_products: "Read products",
      write_products: "Edit products",
    } as Readonly<Record<string, string>>,
    updated: "Updated",
    viewConnection: (shop: string) => `View ${shop}`,
    // Shown on signed-in screens: the reader is already signed in (M2 PR-2 review).
    finishFromShopify: "Reopen Morrow from your Shopify admin to finish connecting.",
    // For a reader who cannot finish the link (only the owner links a store).
    finishByOwner: "The workspace owner needs to finish connecting this store.",
    linkTitle: "Finish connecting your store",
    checking: "Checking this connection…",
    confirm: (shop: string) => `Link ${shop} to this workspace?`,
    confirmUnknownShop: "Link this store to this workspace?",
    confirmBody:
      "Morrow can then read your products and propose listing changes for your approval. Nothing is published without your approval.",
    link: "Link store",
    linking: "Linking…",
    notNow: "Not now",
    linked: "Store linked.",
    linkDenied:
      "Morrow couldn't link this store. Nothing was changed. Reopen Morrow from your Shopify admin to try again.",
    linkExpired:
      "This connection link expired or was already used. Reopen Morrow from your Shopify admin to get a new one.",
    routeRequired: "Subscribe before connecting a store.",
    routeRequiredBody: "Linking a store needs an active Morrow subscription. Nothing was changed.",
    linkRefused:
      "This request was refused. Nothing was changed. Reopen Morrow from your Shopify admin and try again.",
    linkConflict: "This link request didn't match an earlier one. Nothing was changed.",
    notLinkedYet: "The store isn't linked yet. You can link it now.",
    detailTitle: "Connection",
    back: "Back to Shopify connection",
    shop: "Store",
    status: "Status",
    // v1 PR 5: an uninstall or a disconnect still ends this connection, but the same app can
    // be installed again (a scope change no longer ends it). The install link stays on the
    // Shopify connection page until Morrow deletes the ended store's data, 48 hours after the
    // uninstall; a reinstall is a new connection that a person links again, and the ended
    // one's data is deleted anyway (ADR-0031 owner question 2). After a disconnect the app
    // must be uninstalled first (PR 5 review finding F4, after integration with main).
    statusHelp: {
      unlinked: "Installed on Shopify, not linked to this workspace yet.",
      linked: "Linked to this workspace.",
      suspended:
        "Disconnected. Morrow no longer reads or changes this store, and its access to the store is erased.",
      uninstalled:
        "The app was uninstalled from Shopify, so Morrow no longer uses this store. To connect it again within 48 hours, install the app from the install link on the Shopify connection page, then link the store. It comes back as a new connection, and Morrow still deletes the data it kept for this one. After 48 hours, ask Morrow support for a new install link.",
    } as Readonly<Record<string, string>>,
    // "Disconnect store" (ADR-0022 item 15): the person's kill switch for the whole store.
    disconnect: {
      title: "Disconnect store",
      intro:
        "Stops all AI work on this store at once and ends Morrow's access to it. Running jobs stop at their next step.",
      button: "Disconnect store",
      dialogTitle: "Disconnect this store from Morrow?",
      dialogBody: [
        "Every agent stops working on this store, and Morrow no longer reads or changes it.",
        "Morrow erases its access token for the store. Drafts already in Morrow stay for you to review.",
        "The Morrow app stays installed in your Shopify admin until you uninstall it there.",
      ],
      reconnectNote:
        "To connect this store again, install the Morrow app again from the install link on the Shopify connection page, then link the store. After a disconnect, uninstall the app in your Shopify admin first. Do it within 48 hours of the uninstall, or ask Morrow support for a new install link. You can't undo a disconnect here.",
      reason: "Reason",
      reasonHint: "Required. Up to 1,024 characters. Recorded with the disconnect.",
      confirm: "Disconnect store",
      cancel: "Cancel",
      done: "Store disconnected. No AI work runs on it, and Morrow no longer reads or changes it.",
      credential: {
        destroyed: "Morrow's access token for this store is erased.",
        pending:
          "Morrow is still erasing its access token for this store. That finishes on its own within a few minutes; the store is already disconnected.",
      } as Readonly<Record<string, string>>,
      byPerson: "Disconnected in Morrow.",
      bySystem: "Stopped because the app was uninstalled or its access changed in Shopify.",
      notPermitted: "Only the workspace owner can disconnect this store.",
    },
  },
  outcome: {
    uncertain:
      "We couldn't confirm whether this was saved. Check again before doing anything else.",
    checkAgain: "Check again",
    checking: "Checking…",
    notSaved: "Couldn't save. Nothing was changed.",
    tryAgain: "Try again",
    invalid: "Check the highlighted fields and try again.",
    // A 400 that names no field (a guard refusal, or a request refused before sending):
    // nothing on the form is highlighted, and editing it can't fix the request.
    refused: "This request was refused. Nothing was changed. Reload the page and try again.",
    rateLimited: "Too many attempts. Wait a moment, then try again.",
  },
  reentry: {
    label: "Unconfirmed change",
    kinds: {
      goal: "a new goal",
      task: "a new task",
      ready: "marking a task ready",
      assignment: "an assignment",
      question: "a new question",
      answer: "an answer",
      cancel: "cancelling a question",
      agent: "a change to the Listings agent",
      model_default: "the default model",
      run: "a Listings run",
      project: "a change to a project",
      plan: "starting a plan",
      thinking: "a change to how a helper thinks",
      add_agent: "adding an agent",
      disconnect: "disconnecting a store",
    },
    body: (kind: string) =>
      `A change you started earlier (${kind}) may have been saved. Check Projects before creating it again.`,
    dismiss: "Dismiss",
  },
  // M3 PR-1: the Listings agent card (connection screen) and the model default
  // (Settings > Governance). Model and effort keys are opaque: these labels are copy, not
  // contract (a key without a label shows as itself).
  agents: {
    listingsTitle: "Listings agent",
    listingsIntro:
      "Drafts better titles, descriptions, SEO fields and tags for products you pick. It only proposes changes; nothing is published without your approval.",
    notEnabled: "Not enabled for this store.",
    active: "Active",
    stopped: "Stopped. No AI work runs for this store until you resume it.",
    disabled: "Off",
    blocked: "Paused",
    blockedDetail:
      "A platform or connection stop is in effect, so no AI work runs for this store. It resumes when that stop is lifted.",
    notLinked: "This store isn't connected, so the agent can't be enabled or resumed.",
    startAgain: "Start again",
    enable: "Enable Listings agent",
    resume: "Resume Listings agent",
    preparing: "Preparing…",
    reviewTitle: (purpose: "enable" | "resume") =>
      purpose === "enable" ? "Review before enabling" : "Review before resuming",
    reviewIntro:
      "This is exactly what the agent gets. Confirming applies this document only; any change needs a new review.",
    version: (n: number) => `Agent version ${n}`,
    permissions: "Permissions on this store",
    fields: "Product fields it may draft",
    expires: "This review expires at",
    confirmEnable: "Confirm and enable",
    confirmResume: "Confirm and resume",
    cancel: "Cancel",
    enabled: "Listings agent enabled.",
    resumed: "Listings agent resumed.",
    stop: "Stop AI work",
    stopTitle: "Stop AI work for this store",
    stopIntro:
      "Stops every Listings run for this store at once. Drafts already proposed stay for your review. You can resume later.",
    reason: "Reason",
    reasonHint: "Required. Up to 1,024 characters. Recorded with the stop.",
    confirmStop: "Stop AI work",
    stoppedDone: "AI work stopped for this store.",
    expired:
      "This review expired, was already used, or no longer matches the agent. Nothing changed. Start again.",
    capabilities: {
      "catalog.products.read": "Read products",
      "catalog.content.propose": "Draft listing changes",
      "catalog.content.publish": "Propose changes for your approval",
    } as Readonly<Record<string, string>>,
    fieldLabels: {
      title: "Title",
      descriptionHtml: "Description",
      "seo.title": "SEO title",
      "seo.description": "SEO description",
      tags: "Tags",
    } as Readonly<Record<string, string>>,
  },
  models: {
    title: "Model default",
    intro:
      "The model and thinking effort new runs use unless the person asking picks another. Members can pick only entries within the ceiling.",
    catalogue: (version: number) => `Catalogue version ${version}`,
    model: "Model",
    effort: "Effort",
    credits: (n: number) => `${n} ${n === 1 ? "credit" : "credits"} per product`,
    limit: (n: number) => `Up to ${n} products per run`,
    ceiling: "Member ceiling",
    ceilingHint: "Credits per product a member may pick without this permission (1 to 99).",
    default: "Default",
    withinCeiling: "Within the ceiling",
    aboveCeiling: "Above the ceiling",
    youCanPick: "You can pick it",
    save: "Save default",
    saved: "Model default saved.",
    readOnly: "You can view the default but not change it.",
    changed: "The default changed. The current values are shown; review them and try again.",
    labels: {
      claude_haiku_5_5: "Claude Haiku 5.5",
      claude_sonnet_5_5: "Claude Sonnet 5.5",
      claude_opus_5_5: "Claude Opus 5.5",
      low: "Low",
      medium: "Medium",
      high: "High",
    } as Readonly<Record<string, string>>,
  },
  // M3 PR-2: Ask (a Listings run on picked products) and the task's Runs tab.
  ask: {
    title: "Ask",
    intro:
      "Ask the Listings agent to draft better listings for products you pick. It only proposes changes; you review each one, and nothing reaches your store until you approve and apply that exact change.",
    request: "What should change?",
    requestHint:
      "Up to 8,192 characters. The agent treats product text as data, never as instructions.",
    store: "Store",
    noStores: "Connect a store and enable the Listings agent for it first.",
    products: "Products",
    productsHint:
      "One product per line, as its Shopify product number or product:<number>. Up to 25. Or pick them below.",
    // v1 PR 4: the product picker (the linked store's catalogue: ids and titles only).
    picker: "Pick products",
    pickerIntro: "Search this store's products, or show a collection's, and add them to the list.",
    pickerSearch: "Search products",
    pickerSearchHint: "Letters and numbers only, up to five words.",
    pickerSearchInvalid: "Use letters and numbers only, up to five words and 64 characters.",
    pickerCollection: "Collection",
    pickerAllProducts: "All products",
    pickerShow: "Show products",
    pickerMore: "Show more",
    pickerAdd: (title: string) => `Add ${title}`,
    pickerEmpty: "No products match.",
    pickerStatus: (status: string) =>
      ({ active: "Active", draft: "Draft", archived: "Archived" })[status] ?? status,
    pickerFull: "The list already has 25 products.",
    fields: "Fields to improve",
    fieldsHint: "SEO title and description are drafted together.",
    seoPair: "SEO title and description",
    model: "Model and effort",
    modelDefault: (label: string) => `Workspace default (${label})`,
    modelNotAllowed: "above your ceiling",
    estimate: (credits: number, products: number) =>
      `Reserves up to ${credits} ${credits === 1 ? "credit" : "credits"} for ${products} ${products === 1 ? "product" : "products"}. Only products drafted are charged; the rest is returned.`,
    overLimit: (limit: number) => `This model and effort allow up to ${limit} products per run.`,
    invalidProducts: "Each line must be a product number or product:<number>, without repeats.",
    submit: "Start drafting",
    starting: "Starting…",
    goalCriterion: "Listing drafts ready for review",
    stepGoal: "Creating the goal",
    stepTask: "Creating the task",
    stepRun: "Starting the run",
    started: "Drafting started. Opening the task…",
    unavailable:
      "AI drafting isn't available in this workspace yet. Nothing is saved from this page until it is.",
    taskSaved:
      "Your request is saved as a task. Change the choices and start drafting again, or open the task.",
    openTask: "Open the task",
    refusals: {
      unavailable:
        "AI drafting isn't available right now. Your request was saved as a task and nothing was reserved.",
      invalid:
        "Drafting couldn't start with these choices. Your request was saved as a task and nothing was reserved.",
    },
  },
  runs: {
    tab: "Runs",
    empty: "No runs on this task yet.",
    run: (n: number) => `Run ${n}`,
    runUnnumbered: "Run",
    selection: (model: string, effort: string) => `${model} · ${effort}`,
    progress: (drafted: number, failed: number, total: number) =>
      `${drafted} drafted · ${failed} failed · ${total} products`,
    showDetails: "Show details",
    hideDetails: "Hide details",
    creditsReserved: (n: number) => `${n} ${n === 1 ? "credit" : "credits"} reserved`,
    creditsSettled: (n: number) => `${n} ${n === 1 ? "credit" : "credits"} charged`,
    creditsReleased: "Credits returned",
    usage: (attempts: number, input: number, output: number) =>
      `${attempts} model ${attempts === 1 ? "call" : "calls"} · ${input} input and ${output} output tokens`,
    product: "Product",
    attempts: (n: number) => `${n} ${n === 1 ? "attempt" : "attempts"}`,
    proposal: "In a proposal for review",
    review: "Review the changes",
    flags: (f: {
      newUrls: number;
      newEmails: number;
      newPhones: number;
      tagsAdded: number;
      tagsRemoved: number;
    }) =>
      [
        f.newUrls ? `${f.newUrls} new ${f.newUrls === 1 ? "link" : "links"}` : null,
        f.newEmails ? `${f.newEmails} new ${f.newEmails === 1 ? "email" : "emails"}` : null,
        f.newPhones
          ? `${f.newPhones} new ${f.newPhones === 1 ? "phone number" : "phone numbers"}`
          : null,
        f.tagsAdded ? `${f.tagsAdded} ${f.tagsAdded === 1 ? "tag" : "tags"} added` : null,
        f.tagsRemoved ? `${f.tagsRemoved} ${f.tagsRemoved === 1 ? "tag" : "tags"} removed` : null,
      ]
        .filter((x) => x !== null)
        .join(" · "),
    interrupted:
      "This run was stopped or ran out of time before it finished. Close it to return its unused credits.",
    reconcile: "Close and return credits",
    reconciled: (n: number) =>
      n === 0
        ? "Nothing to close."
        : `${n} ${n === 1 ? "run" : "runs"} closed; unused credits returned.`,
    endedReasons: {
      breaker: "Stopped after three products in a row failed",
      // Runs that ended before ADR-0036 removed this limit (migration 0051).
      unrecovered_cost_cap: "Stopped: this period's limit for failed products is reached",
      spend_limit: "Stopped: the AI provider's spending limit is reached",
      provider_error: "Stopped: the AI provider returned an error",
      cost_overflow: "Stopped: the run's AI cost limit is reached",
      reservation_exhausted: "Stopped: the run's reservation is used up",
      time_budget: "Stopped: the run ran out of time",
      delegation_denied: "Stopped: the agent's permission changed",
      entitlement: "Stopped: the workspace's plan isn't active",
      broker_held: "Stopped: AI drafting became unavailable",
      read_unavailable: "Stopped: the store couldn't be read",
      proposal_refused: "Stopped: the drafts couldn't be sent for review",
      nothing_drafted: "No product could be drafted",
      stopped: "Stopped by Stop AI work",
      lease_ended: "Closed after it ran out of time",
    } as Readonly<Record<string, string>>,
    failureCodes: {
      validation: "The draft didn't pass the checks",
      product_mismatch: "The draft named another product",
      incomplete: "The draft was cut off",
      refusal: "The model declined",
      invalid_output: "The model's answer wasn't valid",
      uncertain: "The model's answer was lost",
      input_over_cap: "The product is too long to draft",
      read_failed: "The product couldn't be read",
      too_large: "The product is too large",
      provider_error: "The AI provider returned an error",
      spend_limit: "The AI provider's spending limit is reached",
      reservation_exhausted: "The run's reservation is used up",
      interrupted: "The run was stopped while drafting it",
    } as Readonly<Record<string, string>>,
  },
  // v1 PR 3: review, approve and apply to Shopify.
  review: {
    title: "Review changes",
    intro:
      "This is exactly what Listings drafted. Approving binds this exact set of changes; to change a value, ask Listings again, which makes a new proposal to review.",
    store: (id: string) => `Store ${id}`,
    productsTitle: (n: number) => `${n} ${n === 1 ? "product" : "products"}`,
    untrusted:
      "Listings drafted these from your Shopify product text, which Morrow treats as data, never as instructions. Check each change before approving.",
    taskLink: "Open the task",
    expires: "Approve by",
    fields: {
      title: "Title",
      descriptionHtml: "Description (HTML, shown as text)",
      "seo.title": "SEO title",
      "seo.description": "SEO description",
      tags: "Tags",
    } as Readonly<Record<string, string>>,
    field: "Field",
    before: "Now",
    after: "Proposed",
    empty: "(empty)",
    tagsAdded: "Tags added",
    tagsRemoved: "Tags removed",
    flagsNotice: "Check before approving:",
    expired:
      "The product as Listings read it is no longer kept (90 days), so only the proposed values are shown.",
    blocked: {
      redacted:
        "This store's data was deleted at Shopify's request. These changes can't be approved or applied.",
      link_changed:
        "This store was disconnected or reconnected, so these changes can no longer be approved or applied.",
      not_reviewer: "You can see these changes, but you can't approve them.",
    } as Readonly<Record<string, string>>,
    include: (productId: string) => `Include ${productId}`,
    approveAll: "Approve all",
    approveSome: (n: number) => `Approve ${n} selected`,
    reject: "Reject",
    confirmLabel: "Type the confirmation to approve",
    confirmHint: (phrase: string) => `Type exactly: ${phrase}`,
    approved: "Approved. Nothing has changed in Shopify yet.",
    rejected: "Rejected. Nothing will change in Shopify.",
    approvalStatus: (status: string) =>
      ({
        pending: "Waiting for your approval",
        approved: "Approved, not applied yet",
        rejected: "Rejected",
        expired: "Expired",
        invalidated: "No longer valid",
        withdrawn: "Withdrawn",
      })[status] ?? status,
    approvalClaimed: "Approved. Each product's result is below.",
    apply: "Apply to Shopify",
    applyIntro:
      "Morrow checks your permission, the stops and your plan, reads each product again, writes only the approved fields once and reads the product back. A product changed in Shopify since the draft is not written.",
    applyUnavailable: "Applying changes to Shopify isn't switched on yet. Nothing was changed.",
    pending: (n: number) =>
      `${n} more ${n === 1 ? "product is" : "products are"} waiting. Continue to apply ${n === 1 ? "it" : "them"}.`,
    continue: "Continue applying",
    results: "Results",
    history: "Changes applied",
    historyEmpty: "No changes have been applied from this task.",
    open: "Open the review",
    checkAgain: "Check again",
    setAside: "I checked it in Shopify",
    setAsideHint:
      "If you have looked at this product in Shopify yourself, you can set this result aside. Nothing is sent again, and Morrow keeps checking.",
    setAsideNote:
      "You checked this in Shopify and set it aside. Nothing was sent again; Morrow still checks it.",
    reasons: {
      source_changed: "Not applied: the product changed in Shopify since the draft.",
      product_busy: "Not applied: another change to this product is still being checked.",
      product_missing: "Not applied: the product no longer exists in Shopify.",
      stopped: "Not applied: AI work was stopped for this store.",
      member_removed: "Not applied: the person who applied it lost access.",
      lease_ended: "Not applied: it ran out of time. Approve and apply again.",
      window_passed: "Not applied: it ran out of time. Approve and apply again.",
      link_lost: "Not applied: the store was disconnected.",
      installation_inactive: "Not applied: the Listings agent isn't enabled for this store.",
      scope_missing: "Not applied: Morrow can't edit products in this store.",
      credential_unavailable: "Not applied: the store's connection changed.",
      parameters_redacted: "Not applied: the store's data was deleted.",
      approval_expired: "Not applied: the approval expired.",
      approval_invalid: "Not applied: the approval is no longer valid.",
      authority_lost: "Not applied: you no longer have permission to apply it.",
      not_entitled: "Not applied: the workspace's plan isn't active.",
      request_mismatch: "Not applied: the change didn't match what was approved.",
      provider_rejected: "Not applied: Shopify rejected the change.",
      throttled: "Not applied: Shopify was busy. Ask again later.",
      connection_unauthorized: "Not applied: Shopify refused the store's connection.",
      access_denied: "Not applied: Shopify refused the store's connection.",
      not_sent: "Not applied: it was never sent.",
      readback_no_effect: "Not applied: Shopify shows it never changed.",
      readback_differs:
        "Needs your attention: Shopify now shows different values, perhaps from an edit made at the same moment.",
      fence_expired: "Needs your attention: Morrow can't tell yet whether Shopify applied it.",
      credential_gone:
        "Needs your attention: the store disconnected before Morrow could check the product.",
      superseded:
        "Needs your attention: a later change to this product was applied before Morrow could confirm this one. Check the product in Shopify.",
    } as Readonly<Record<string, string>>,
    uncertain:
      "Needs your attention: Morrow can't tell yet whether Shopify applied it. It is never sent twice; check again to read the product back.",
    // v1 PR 4: Undo. The server decides whether it is offered; the screen shows its state.
    undo: "Undo",
    undoAvailable: "You can undo this change until",
    undoIntro:
      "Undo reads the product first. If Shopify still shows what this change wrote, Morrow makes a new change back to the earlier values, which you review and approve like any other. Nothing is written until you apply it.",
    undoRequested:
      "Morrow made a change back to the earlier values. Review and approve it to apply it.",
    undoWaiting: "An undo of this change is waiting.",
    undoOpen: "Open the undo",
    undone: "This change was undone.",
    undoChanged: "Morrow changed this product again after this, so Undo isn't offered here.",
    undoUnavailable:
      "Undo is no longer available: it lasts 90 days, and ends early if the shop's data is deleted.",
    undoOf: "This change undid an earlier change.",
    undoBanner: (productId: string) =>
      `This change undoes an earlier change to ${productId}. It sets each field back to the value Morrow read before that change. "Now" is what Shopify shows today.`,
    undoBannerApplied: "The earlier change was applied",
    // v1 PR 4: "Approve several at once" (ADR-0024 item 9).
    batch: "Approve several at once",
    batchTitle: "Changes waiting on this task",
    batchIntro:
      "One confirmation approves each of these exact changes. If any of them changed or can't be approved, none is approved. Each one is still applied on its own, and Morrow checks it again before it writes.",
    batchItem: (n: number) => `${n} ${n === 1 ? "product" : "products"}`,
    batchConfirm: (n: number) => `Approve these ${n} changes`,
    batchCancel: "Cancel",
    batchApproved: (n: number) =>
      `Approved ${n} changes. Nothing has changed in Shopify yet; apply each one from its review.`,
    batchUnavailable: {
      too_few: "Only this change is waiting on this task, so approve it here.",
      cost_confirmation:
        "One of these changes has a cost that needs its own confirmation, so approve them one at a time.",
      mixed_confirmation:
        "Only some of these changes need your typed confirmation, so approve them one at a time.",
    } as Readonly<Record<string, string>>,
    batchConfirmLabel: "Type the confirmation to approve all of them",
    batchExpires: "Confirm by",
  },
  leave: {
    title: "Leave this page?",
    body: "Unsent text will be lost.",
    stay: "Stay",
    leave: "Leave",
  },
  dialogClose: "Close",
  status: {
    task: {
      draft: "Draft",
      ready: "Ready",
      queued: "Queued",
      running: "Running",
      waiting_input: "Waiting for input",
      waiting_approval: "Waiting for approval",
      paused: "Paused",
      cancelling: "Cancelling",
      cancelled: "Cancelled",
      succeeded: "Succeeded",
      failed: "Failed",
    },
    goal: {
      draft: "Draft",
      active: "Active",
      paused: "Paused",
      achieved: "Achieved",
      cancelled: "Cancelled",
    },
    question: { open: "Open", answered: "Answered", cancelled: "Cancelled", expired: "Expired" },
    run: {
      queued: "Queued",
      running: "Drafting",
      succeeded: "Done",
      failed: "Ended",
      cancelled: "Closed",
    },
    runProduct: {
      pending: "Waiting",
      in_progress: "Drafting",
      drafted: "Drafted",
      failed: "Failed",
      skipped: "Skipped",
    },
    operation: {
      authorized: "Queued",
      dispatching: "Applying",
      submitted: "Sent",
      verifying: "Checking",
      verified: "Applied",
      conflict: "Not applied",
      failed: "Not applied",
      uncertain: "Needs attention",
      cancel_requested: "Checked by you",
    },
    installation: {
      unlinked: "Not linked",
      linked: "Connected",
      suspended: "Disconnected",
      uninstalled: "Uninstalled",
    },
  },
} as const;

type StatusFamily = keyof typeof copy.status;
/** Every v1 status has a label; an unknown value renders as its own text (§4.8). */
export function statusLabel(family: StatusFamily, status: string): string {
  const labels: Readonly<Record<string, string>> = copy.status[family];
  return Object.hasOwn(labels, status) ? labels[status]! : status;
}
