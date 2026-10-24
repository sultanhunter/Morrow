// v1 PR 15: the fixed copy of the Inbox, the exception screen and the activity log, in plain
// words for shop owners (ADR-0032 item 4; the Inbox, EmptyStates, Phone and SettingsActivity
// boards). The words say what the records show and never more: a change is "updated in
// Shopify" only once Morrow read it back, an unknown outcome is never "done", and a store
// that is disconnected can't take the changes waiting for it.
const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const products = (n: number) => plural(n, "product", "products");

export const inboxCopy = {
  title: "Inbox",
  intro:
    "Things only a person can settle. Nothing changes in your store until someone approves it.",
  filtersLabel: "Show in Inbox",
  tabs: { all: "All", review: "To review", questions: "Questions", problems: "Problems" },
  countNote: (n: string) =>
    `Your Inbox count is ${n}: changes to review, questions and problems that need you. Changes that weren’t applied stay here for a week but aren’t counted.`,
  listLabel: "Inbox items",
  loading: "Loading your Inbox",
  failedTitle: "We couldn’t load your Inbox",
  failedBody: "Nothing was approved or sent. Your items are safe and will be here when it loads.",
  offlineTitle: "You’re offline",
  offlineBody: "Nothing was approved or sent. Your Inbox shows again when you’re back online.",
  tryAgain: "Try again",
  emptyTitle: "You’re all caught up",
  emptyBody:
    "Changes to review, questions and problems show up here. Nothing changes in your store until someone approves it.",
  filterEmptyTitle: "Nothing here right now",
  filterEmptyBody: "Show everything to see the rest of your Inbox.",
  showEverything: "Show everything",
  partTitle: "Some of your Inbox can’t be shown",
  part: {
    questions:
      "Questions for you need permission to see your shop’s work. Ask your shop’s Owner for it.",
    approvals: "Changes to review can’t be shown to you right now.",
    changes: "Changes Morrow couldn’t finish can’t be shown to you right now.",
    connections: "Your store connection can’t be shown to you right now.",
  },
  more: "More is waiting than fits here. The rest shows once you’ve dealt with some of these.",
  shopFallback: "Your Shopify store",
  home: {
    problemsChip: (n: number) => `${n} ${n === 1 ? "problem" : "problems"} to check`,
  },
  storeOf: (shop: string) => `for ${shop}`,
  approval: {
    title: (n: number) => `Changes to ${products(n)}`,
    by: "Suggested by Listings",
    expires: (date: string) => `Approve by ${date}`,
    blocked: "Can’t be applied: the store isn’t connected",
    badge: "Needs review",
    blockedBadge: "Can’t apply",
  },
  question: {
    sub: (date: string) => `Question for you · Asked ${date}`,
    badge: "Needs you",
  },
  exception: {
    uncertainTitle: "Morrow couldn’t confirm a change reached Shopify",
    failedTitle: "A change wasn’t applied",
    uncertainSub: "Morrow won’t send it again until it knows what happened.",
    uncertainBadge: "Needs attention",
    failedBadge: "Not applied",
    when: (date: string) => `Last update ${date}`,
  },
  connection: {
    disconnected: (shop: string) => `${shop} isn’t connected`,
    uninstalled: (shop: string) => `The Morrow app was removed from ${shop}`,
    scopes_changed: (shop: string) => `Shopify permissions changed for ${shop}`,
    stopped: (shop: string) => `${shop}’s connection is stopped`,
    sub: (date: string) =>
      `Since ${date} · Agents can’t read or change your store until it’s connected again.`,
    badge: "Needs you",
  },
  banner: {
    title: "Your Shopify store isn’t connected",
    body: "Changes waiting here can’t be applied to it. Once it’s connected again, ask Listings for new suggestions.",
    open: "Open Shopify connection",
  },
  samples: {
    tag: "Sample data",
    tagHidden: ", sample data",
    title: "Coming soon to your Inbox",
    intro:
      "A preview of what agents will bring here. Nothing in this list is real, and nothing in it can be approved.",
    agents: { listings: "Listings", inventory: "Inventory", analyst: "Business Analyst" },
    askedBy: (agent: string) => `Asked by ${agent}`,
    choices: (list: readonly string[]) => `Answers: ${list.join(" or ")}`,
    reconnectTitle: "Reconnect Shopify to give Morrow its new permissions",
    reconnectSub: (missing: readonly string[], stopped: readonly string[]) =>
      `Missing: ${missing.join(", ")} · Paused: ${stopped.join(", ")}`,
  },
  // The exception screen (the route contract's `exception`, under the Inbox).
  detail: {
    back: "Back to Inbox",
    title: "A change to check",
    uncertainTitle: "Morrow couldn’t confirm this change",
    setAsideTitle: "You checked this change in Shopify",
    setAsideBody:
      "Morrow still hasn’t confirmed it, so it won’t send the change again. It keeps checking the product on its own.",
    failedTitle: "This change wasn’t applied",
    settledTitle: "This change is settled",
    uncertainBody:
      "Shopify’s answer was lost or unclear. Morrow won’t send the change again until it knows what happened. It checks the product again on its own, and you can check now.",
    failedBody: "Nothing changed in your store because of it.",
    settledBody: "Morrow has an answer for this change now.",
    checks: (n: number) =>
      n === 0
        ? "Morrow hasn’t checked the product yet."
        : `Morrow checked the product ${plural(n, "time", "times")}.`,
    lastCheck: (date: string) => `Last checked ${date}.`,
    openReview: "Open the changes",
    openTask: "Open the task",
    resultTitle: "The result",
  },
  activity: {
    loadingList: "Loading what happened",
    showEarlier: "Show earlier",
    noneRecent: "Nothing you can see in the latest activity. Show earlier to look further back.",
    noneOfKindRecent:
      "Nothing of this kind in the activity shown so far. Show earlier to look further back.",
    earlierFailed: "Couldn’t load earlier activity. Try again.",
    today: (day: string) => `Today, ${day}`,
    yesterday: (day: string) => `Yesterday, ${day}`,
    earlier: "Earlier",
    actors: { morrow: "Morrow", shopify: "Shopify", listings: "Listings" },
    approved: (n: number) => `approved changes to ${products(n)}`,
    declined: (n: number) => `declined changes to ${products(n)}`,
    suggestedBy: "Suggested by Listings",
    declinedDetail: "Suggested by Listings · Nothing changed in your store",
    verified: "updated a product in Shopify and checked it saved",
    notApplied: "didn’t apply a change",
    unknown: "couldn’t confirm a change reached Shopify",
    unknownDetail: "Morrow won’t send it again until it knows what happened.",
    setAside: "noted that a change was checked in Shopify",
    setAsideDetail: "Morrow keeps checking it.",
    stopped: "stopped AI work for Listings",
    stoppedDetail: "Listings stays stopped until a person turns it back on.",
    alreadyStopped: "Listings was already stopped.",
    disconnected: "disconnected the store from Morrow",
    disconnectedDetail: "Morrow can’t read or change the store until it’s connected again.",
    alreadyDisconnected: "The store’s connection was already stopped.",
    removed: "ended the connection: the Morrow app was removed",
    permissions: "ended the connection: the app’s permissions changed",
    ended: "ended the connection",
    endedDetail: "Agents can’t work on the store until it’s connected again.",
    addedListings: "added Listings to the store",
    addedOther: "added an agent to the store",
    addedDetail: "It suggests changes. Nothing changes until a person approves it.",
    asked: (n: number) => `asked Listings to suggest changes for ${products(n)}`,
    working: "Listings is working on it.",
    ready: (drafted: number, failed: number) =>
      failed > 0
        ? `${plural(drafted, "suggestion", "suggestions")} ready to review · ${plural(failed, "product", "products")} couldn’t be done`
        : `${plural(drafted, "suggestion", "suggestions")} ready to review`,
    notFinished: "Listings couldn’t finish. No changes were made.",
    cancelled: "Stopped before it finished. No changes were made.",
  },
} as const;
