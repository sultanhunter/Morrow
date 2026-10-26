// The store-data foundation records (pull request 88): ADR-0043 (store events, schedules and
// standing action policies), ADR-0044 (collaboration grants for installed agents), their
// decision node OD-2026-10-26-11, their decision sheet Q-store-data-foundation and their plan,
// docs/plan/store-data-foundation-implementation.md. The second AI review of the records
// (separate context, same model family, head 6de55064) found seven defects; each test below
// holds one fix so that it cannot silently come undone:
// F1 what "Stop customer contact" covers, F2 tag removal through a paired policy, F3 one
// combined run per installation (the records agree that no review fix widens the answer),
// F4 a stopped run's `once` schedules, F5 a person's own respondent, F6 the shared stop
// check's derived tenant and fail-closed ids, F7 the rate rule for rows with no ids and
// `maxEventAge`'s value. Pure: no I/O beyond reading the repository files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
/** Whitespace collapsed, so wrapped lines in graph nodes match like one-line ADR items. */
const flat = (text) => text.replace(/\s+/g, " ");
const adr43 = read("docs/decisions/adr/ADR-0043-store-events-schedules-standing-policies.md");
const adr44 = read("docs/decisions/adr/ADR-0044-collaboration-grants-installed-agents.md");
const plan = read("docs/plan/store-data-foundation-implementation.md");
const decision = flat(read("docs/graph/decisions/OD-2026-10-26-11.md"));
const sheet = flat(read("docs/graph/questions/Q-store-data-foundation.md"));
const workApi = read("docs/contracts/work-api.md");

/** One numbered Decision item ("N. **…"), up to the next item or heading. */
const item = (text, n) => {
  const start = text.search(new RegExp(`^${n}\\. \\*\\*`, "m"));
  assert.ok(start >= 0, `item ${n}`);
  const body = text.indexOf("\n", start) + 1;
  const end = text.slice(body).search(/^(\d+\. \*\*|#{2,3} )/m);
  return flat(end < 0 ? text.slice(start) : text.slice(start, body + end));
};
/** One line of a record's header list, by the bold name it starts with. */
const amends = (text, name) => {
  const line = text.split("\n").find((l) => l.startsWith(`  - **${name}**`));
  assert.ok(line, name);
  return line;
};
/** One row of the plan's Order table. */
const row = (id) => {
  const line = plan.split("\n").find((l) => l.startsWith(`| ${id} |`));
  assert.ok(line, id);
  return line;
};
/** A "## " section of a record, up to the next "## " heading. */
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, heading);
  const end = text.indexOf("\n## ", start + 1);
  return end < 0 ? text.slice(start) : text.slice(start, end);
};

test("F1: contact.stop covers the domain's communication effects and every call-plan action, never its controls or reads", () => {
  const covers = item(adr43, 20);
  assert.ok(
    covers.includes(
      '`contact.stop` covers every capability of the "Customer contact" domain whose effect is `communication`',
    ),
  );
  assert.ok(
    covers.includes(
      "every action of a `contact_plan` policy, its outcome-map tag writes (`orders.tags.add`) included",
    ),
  );
  // Never the domain's stop controls or reads (ADR-0011 Q8: stop controls are never blocked).
  assert.ok(covers.includes("It never blocks the domain's controls, drafts or reads"));
  for (const id of [
    "contact.rule.pause",
    "contact.rule.revoke",
    "contact.stop",
    "contact.results.read",
  ])
    assert.ok(covers.includes("`" + id + "`"), id);
  assert.ok(covers.includes("`contact.stop` leaves it running"));
  // The old reach, which dropped the call plan's tag writes and caught the controls.
  assert.ok(!covers.includes('covers every capability in the "Customer contact" domain'));
  assert.ok(!amends(adr43, "ADR 0042").includes('covers the whole "Customer contact" domain'));
  assert.ok(
    amends(adr43, "ADR 0042").includes(
      "every action of a call plan, its tag writes included, and never blocks the domain's controls or reads",
    ),
  );
  // The shared check knows a call plan's tag write by its policy id, and the rows prove it.
  const stopRow =
    "a contact stop refuses a call plan's tag write and leaves a `morrow-late` tag policy running";
  assert.ok(item(adr43, 21).includes(stopRow));
  assert.ok(row("SD14").includes(stopRow));
  assert.ok(
    row("SD14").includes(
      "`contact.stop` over the domain's `communication` capabilities and every call-plan action, its tag writes included, never its controls or reads",
    ),
  );
});

test("F2: tag removal works through a removal policy paired with its add policy and approved with it", () => {
  // One capability a policy: the pair is bound in the removal policy's digest.
  assert.ok(
    item(adr43, 12).includes(
      "for `orders.tags.remove`, its paired `orders.tags.add` policy: that policy's id, of the same store, installation and tag (item 15)",
    ),
  );
  assert.ok(
    item(adr43, 14).includes(
      "A removal policy (item 15) is first approved together with its paired add policy, on one card under one phrase and one cool-down, each digest its own",
    ),
  );
  const allowlist = item(adr43, 15);
  assert.ok(
    allowlist.includes(
      "`orders.tags.remove`: only in a removal policy paired with one `orders.tags.add` policy of the same store, installation and tag",
    ),
  );
  assert.ok(allowlist.includes("It has its own trigger and subject audience"));
  assert.ok(
    allowlist.includes(
      "only when the paired policy has recorded a write that put the tag on that order (an add that found it `already_present` wrote nothing and is not one) and no removal of that tag on that order has been recorded since that write",
    ),
  );
  assert.ok(
    allowlist.includes(
      "an add that finds its own earlier tag still present records `already_present` and does not block the removal",
    ),
  );
  // The old rule, under which no removal could ever be admitted.
  assert.ok(!allowlist.includes("when no add by this policy is recorded for that order"));
  assert.ok(!item(adr43, 17).includes("this policy's add is recorded"));
  assert.ok(
    item(adr43, 17).includes(
      "for a tag removal, also that its pair's write is still the latest recorded write or removal of that tag on that order",
    ),
  );
  assert.ok(
    allowlist.includes(
      "`lab:standing-policies` rows for removal: a removal policy without a paired add policy of the same store, installation and tag refuses to activate",
    ),
  );
  // The worked example is two policies, not one policy with two capabilities.
  const example = section(adr43, "In plain words");
  assert.ok(example.includes("two standing policies approved as a pair"));
  assert.ok(!example.includes("and remove the tag once they ship, up to 200 a day"));
  assert.ok(
    row("SD13b").includes("only in a removal policy paired with an `orders.tags.add` policy"),
  );
  assert.ok(!row("SD13b").includes("(only a tag the policy added;"));
  assert.ok(row("SD17").includes("a removal policy without its pair refuses to activate"));
});

test("F3: waiting rows combine into one run per installation, and every record says no review fix widens the answer", () => {
  const resume = item(adr43, 22);
  assert.ok(
    resume.includes(
      "Trigger rows of one installation that wait on credits combine into one run per installation, as the owner answered (question 10)",
    ),
  );
  assert.ok(
    resume.includes(
      "one transaction re-checks each waiting row as it merges (its source revision still active, its trigger kind inside the mandate's, the mandate active, `effect_stops_clear`) and ends a row that fails `expired`",
    ),
  );
  assert.ok(resume.includes("A `once` schedule's row never combines"));
  assert.ok(!resume.includes("never across subscriptions, schedules, deadline rules or monitors"));
  assert.ok(
    amends(adr43, "ADR-0039").includes(
      "combined into one run per installation, each row re-checked as it merges",
    ),
  );
  assert.ok(!amends(adr43, "ADR-0039").includes("one run per installation and trigger source"));
  // The owner answered "combined into one run each"; no record may still describe the
  // per-source rule, which resumed an agent as two runs, as the state of the records.
  const approval = flat(section(adr43, "Approval"));
  assert.ok(
    approval.includes("each narrow or make exact what the owner approved and widen nothing"),
  );
  assert.ok(
    !approval.includes("Credits-waiting rows combine per trigger source, never across sources"),
  );
  assert.ok(
    decision.includes("Each narrows or makes exact what the owner approved, and none widens it:"),
  );
  assert.ok(!decision.includes("none widens it, except"));
  assert.ok(
    decision.includes(
      "agents waiting on credits are still combined into one run each, as answered",
    ),
  );
  assert.ok(!sheet.includes("except that question 10's can resume one agent as more than one run"));
  assert.ok(sheet.includes("waiting runs are still combined into one run per agent, as answered"));
  for (const id of ["SD15", "SD18"]) {
    assert.ok(row(id).includes("one run per installation"), id);
    assert.ok(!row(id).includes("trigger-source revision"), id);
  }
  assert.ok(!row("SD18").includes("rows of two subscriptions stay two"));
  assert.ok(
    row("SD18").includes(
      "waiting rows of two subscriptions and a deadline rule become one run when credits return",
    ),
  );
});

test("F4: a run's open once schedules end with it, and fire only under the mandate revision they were written under", () => {
  const firing = item(adr43, 9);
  assert.ok(
    firing.includes(
      "the transaction that ends its run by a stop, a revocation, a kill switch, an authority failure or the mandate's end also ends every open `once` schedule that run wrote, `cancelled`, so lifting the stop never starts a successor",
    ),
  );
  assert.ok(
    firing.includes("it fires only under the mandate revision that was active when it was written"),
  );
  assert.ok(!firing.includes("under the mandate as it then stands"));
  assert.ok(
    row("SD12").includes(
      "a run ended by Stop AI work, a mandate revoke, a kill switch or an authority failure leaves no open `once`, and lifting the stop admits no successor",
    ),
  );
  assert.ok(
    row("SD12").includes(
      "one written under a mandate revision since renewed or ended ends `cancelled` and admits nothing",
    ),
  );
});

test("F5: a person still names the respondent; only an installation's respondent comes from code", () => {
  const contracts = adr44.split("\n").filter((l) => l.startsWith("    - `"));
  const capabilities = contracts.find((l) => l.startsWith("    - `capabilities.json`"));
  assert.ok(capabilities);
  assert.ok(!capabilities.includes("no longer takes `respondentId` as an input"));
  assert.ok(capabilities.includes("a person still names the respondent"));
  assert.ok(
    capabilities.includes(
      "for an installation code sets it (item 4) and the scope rule refuses any value the caller supplies (`collab_out_of_scope`)",
    ),
  );
  const route = contracts.find((l) => l.startsWith("    - `work-api.md`"));
  assert.ok(route, "the Contracts line names work-api.md");
  assert.ok(
    route.includes(
      "`POST /tasks/:taskId/questions` keeps `{question, respondentId}` for people, unchanged",
    ),
  );
  // The work API this relies on still takes the respondent from the person.
  assert.ok(workApi.includes("| `POST /tasks/:taskId/questions` | `{question, respondentId}`"));
  assert.ok(
    item(adr44, 4).includes(
      "A person's own question is unchanged: the person names the respondent",
    ),
  );
  assert.ok(
    item(adr44, 4).includes(
      "an installation's call that supplies a `respondentId` is refused `collab_out_of_scope`",
    ),
  );
  assert.ok(!row("SD19").includes("without a `respondentId` input"));
  assert.ok(row("SD19").includes("`respondentId` kept for people and refused from installations"));
});

test("F6: effect_stops_clear takes no tenant or connection, derives them, and treats an unknown or mismatched id as not clear", () => {
  const check = item(adr43, 21);
  assert.ok(
    check.includes(
      "**One shared check: `effect_stops_clear`** (installation, store, capability, policy)",
    ),
  );
  assert.ok(!check.includes("(tenant, installation, capability, connection)"));
  assert.ok(
    check.includes(
      "The definer takes no tenant and no connection: it derives the tenant from the installation's row",
    ),
  );
  assert.ok(
    check.includes(
      "An unknown id, a store outside the installation's tenant, or a policy of another installation or store is not clear",
    ),
  );
  assert.ok(
    check.includes(
      "`stops.test.mjs` rows: an installation of another tenant, an unknown installation, store or policy, and another installation's policy each report not clear",
    ),
  );
  assert.ok(
    row("SD14").includes("an installation of another tenant or an unknown id is not clear"),
  );
  assert.ok(!row("SD14").includes("(tenant, installation, capability, connection)"));
});

test("F7: every catalogue setting item 3 names has its value, and rows with no ids wait over the rate", () => {
  const values = section(adr43, "Values");
  // Item 3's camelCase names are its settings, but for the Shopify record fields it measures.
  const shopifyFields = new Set(["createdAt", "updatedAt"]);
  const settings = [
    ...new Set([...item(adr43, 3).matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)].map((m) => m[1])),
  ].filter((name) => !shopifyFields.has(name));
  assert.deepEqual(settings.sort(), ["coalesceSeconds", "maxEventAge", "maxRunsPerHour"]);
  for (const name of settings) {
    const line = values.split("\n").find((l) => l.startsWith("| ") && l.includes("`" + name + "`"));
    assert.ok(line, `Values names ${name}`);
  }
  assert.match(
    values,
    /^\| Event age \(`maxEventAge`\) \| default 24 hours, the replay horizon; 5 minutes to 24 hours/m,
  );
  assert.ok(
    item(adr43, 5).includes(
      "A row with no ids to merge, a monitor's `alert_and_run` row or a `once` schedule's row (item 9), waits unchanged for the next slot the rate allows",
    ),
  );
  assert.ok(
    item(adr43, 9).includes(
      "over the hourly rate it waits for the next slot the rate allows and is never dropped inside the 24-hour replay horizon (item 5)",
    ),
  );
  assert.ok(!row("SD12").includes("a seventh run in an hour merged"));
  assert.ok(
    row("SD12").includes(
      "a seventh in an hour waits for the next slot the rate allows and is never dropped",
    ),
  );
});
