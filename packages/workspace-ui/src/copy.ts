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
  destinations: {
    home: "Home",
    work: "Work",
    inbox: "Inbox",
    agents: "Agents",
    assets: "Assets",
    knowledge: "Knowledge",
    settings: "Settings",
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
  home: {
    questionsTitle: "Questions for you",
    questionsCount: (count: string) => `${count} open`,
    noQuestions: "No open questions for you.",
    goalsTitle: "Goals",
    noGoals: "No goals yet.",
    goToWork: "Go to Work",
    goToInbox: "Go to Inbox",
    prepaymentTitle: "Paid work",
    prepayment:
      "Paid work starts once this workspace has an active plan. Plans aren't available in this provisional build.",
  },
  work: {
    title: "Work",
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
    breadcrumb: "Work",
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
  inbox: {
    title: "Inbox",
    questionsTitle: "Questions for you",
    noQuestions: "No open questions for you.",
    otherTitle: "Other updates",
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
    title: "Connections",
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
    back: "Back to Connections",
    shop: "Store",
    status: "Status",
    // M2 PR-3 review: an uninstall or a scope change ends the store's connection for good in
    // this build (no reinstall under the same app); reconnecting needs a new app from Morrow.
    statusHelp: {
      unlinked: "Installed on Shopify, not linked to this workspace yet.",
      linked: "Linked to this workspace.",
      suspended:
        "Disconnected. Morrow no longer uses this store. Reconnecting isn't available in this build; contact Morrow support to connect it again.",
      uninstalled:
        "The app was uninstalled from Shopify, so Morrow no longer uses this store. Reconnecting isn't available in this build; contact Morrow support to connect it again.",
    } as Readonly<Record<string, string>>,
    disconnectLater: "Disconnecting a store isn't available in this build.",
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
    },
    body: (kind: string) =>
      `A change you started earlier (${kind}) may have been saved. Check Work before creating it again.`,
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
      "Ask the Listings agent to draft better listings for products you pick. It only proposes changes; you review and approve each one, and nothing is published in this build.",
    request: "What should change?",
    requestHint:
      "Up to 8,192 characters. The agent treats product text as data, never as instructions.",
    store: "Store",
    noStores: "Connect a store and enable the Listings agent for it first.",
    products: "Products",
    productsHint:
      "One product per line, as its Shopify product number or product:<number>. Up to 25. A product picker arrives with the catalog in a later build.",
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
