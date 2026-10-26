// Build order PR 7 (ADR-0029 items 1, 4, 5 and 8): the computer's profile, closed job,
// minimised inputs, output checks and caps (packages/policy/src/runtime-computer.ts), and the
// caps' SQL twin in migration 0043 (drift).
//   * The profile: no internet, 900 s life, 120 s exec, 2 vCPU and 1 GiB, the fixed command run
//     by the non-root user `agent`; the worst case at list rates is US$0.03.
//   * RuntimeJob@1 is closed: any unknown key, value or bound refuses the whole job, and nothing
//     in it names a command, template, network, environment or limit.
//   * Inputs are closed extract kinds with fixed columns; a URL, a shop domain, a workers.dev
//     host, a presigned-URL parameter or an email in a cell or in the script refuses the job;
//     customer fields cannot be expressed at all.
//   * Outputs: PNG (structure and CRCs checked, metadata chunks dropped), CSV (formula cells
//     escaped, numbers kept) and XLSX (no macros, objects, external links or remote formulas
//     or cloud functions in any part, every part read as strict XML; zip tricks and bytes
//     outside the listed entries refused), each within its size.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkRuntimeOutput,
  computerProfile,
  csvEscapeCell,
  extractColumns,
  extractKinds,
  parseRuntimeJob,
  renderJobInputs,
  runtimeCaps,
  runtimeJobCanonical,
  runtimeJobLimits,
  sandboxWorstCaseUsd,
} from "../packages/policy/src/runtime-computer.ts";
import { runtimeTiming } from "../apps/broker/src/runtime-gateway.ts";
import { runtimeGatewayLimits } from "../packages/identity/src/broker-protocol.ts";
import { makePng, makeXlsx, makeZip, zipLocal } from "./fixtures/runtime-files.mjs";

const product = (over = {}) => [
  "7001",
  over.title ?? "Linen shirt",
  "Shirts",
  "Morrow Lab",
  "active",
  "summer, linen",
  3,
  "19.50",
  "24.00",
  12,
  "2026-10-01T10:00:00Z",
  "2026-10-20T10:00:00.250Z",
];
export const job = (over = {}) => ({
  schemaVersion: 1,
  kind: "python_analysis",
  callKey: "step-1",
  script: "print('hello')\n",
  inputs: [{ name: "products", kind: "products", rows: [product()] }],
  outputs: [{ name: "chart", type: "png" }],
  ...over,
});
const text = (value) => JSON.stringify(value);

test("the profile: no internet, fixed lifetime, exec, size, user and command", () => {
  assert.equal(computerProfile.id, "morrow.computer");
  assert.equal(computerProfile.version, 1);
  assert.equal(computerProfile.internet, false);
  assert.equal(computerProfile.sandboxTimeoutSeconds, 900);
  assert.equal(computerProfile.execTimeoutSeconds, 120);
  assert.equal(computerProfile.vcpu, 2);
  assert.equal(computerProfile.memoryMiB, 1024);
  assert.equal(computerProfile.user, "agent");
  assert.deepEqual(
    [...computerProfile.command],
    ["/usr/bin/python3", "-I", "-B", "/home/agent/work/job.py"],
  );
  assert.ok(Object.isFrozen(computerProfile) && Object.isFrozen(computerProfile.command));
  // US$0.000014 per vCPU second and US$0.0000045 per GiB second: 900 x 0.0325 = US$0.02925.
  assert.equal(sandboxWorstCaseUsd(), "0.03");
  assert.equal(runtimeCaps.worstCaseUsd, sandboxWorstCaseUsd());
  // ADR-0039 item 6: no monthly runtime budget in code; E2B's own usage limit is recorded
  // (it is the outside backstop, enforced by E2B, never by Morrow's code).
  assert.equal(Object.hasOwn(runtimeCaps, "monthlyBudgetUsd"), false);
  assert.equal(runtimeCaps.providerUsageLimitUsd, "20.00");
  assert.equal(runtimeCaps.concurrentSandboxes, 10);
  assert.equal(runtimeCaps.sandboxesPerWorkspace, 3);
});

test("migration 0056 holds the same caps, deadline, grace and staleness in SQL", () => {
  const sql = readFileSync("migrations/0043.runtime-operations.sql", "utf8");
  const staleSeconds = runtimeGatewayLimits.executeBudgetMaxMs / 1000 + 60;
  // 0043 is applied and immutable: its US$10 monthly budget stays in its text, and migration
  // 0056 (ADR-0039 item 6) replaced runtime_caps() without it. The latest definition is the
  // code's twin.
  const caps0043 =
    /CREATE FUNCTION morrow_work\.runtime_caps\(\)[\s\S]*?AS \$\$\n SELECT ([^\n]+)\n\$\$;/.exec(
      sql,
    );
  assert.ok(caps0043);
  const rest = `${runtimeCaps.concurrentSandboxes},${runtimeCaps.sandboxesPerWorkspace},${runtimeCaps.worstCaseUsd}::numeric(20,8),${computerProfile.sandboxTimeoutSeconds + computerProfile.createAllowanceSeconds},${computerProfile.absentGraceSeconds},${staleSeconds}`;
  assert.equal(caps0043[1], `10.00::numeric(20,8),${rest}`);
  const credits = readFileSync("migrations/0056.credits-only-catalogue.sql", "utf8");
  const caps =
    /CREATE FUNCTION morrow_work\.runtime_caps\(\)\nRETURNS TABLE\(concurrent_sandboxes integer,[\s\S]*?AS \$\$\n SELECT ([^\n]+)\n\$\$;/.exec(
      credits,
    );
  assert.ok(caps);
  assert.equal(caps[1], rest);
  // The staleness the sweep waits for is the longest execute the broker admits plus a minute,
  // and that minute covers the execute's last status read and ledger write: raising the
  // execute ceiling without the migration fails here, so the sweep never kills a live job.
  assert.equal(staleSeconds, runtimeGatewayLimits.executeBudgetMaxMs / 1000 + 60);
  assert.ok(
    staleSeconds * 1000 >=
      runtimeGatewayLimits.executeBudgetMaxMs +
        runtimeTiming.statusMaxMs +
        runtimeTiming.ledgerMaxMs,
  );
  assert.match(
    sql,
    /CONSTRAINT runtime_operations_deadline CHECK \(deadline_at=send_started_at\+interval '960 seconds'\)/,
  );
  assert.match(sql, /open_operations integer NOT NULL CHECK \(open_operations BETWEEN 0 AND 10\)/);
  assert.match(sql, /month_committed_usd>=0 AND month_committed_usd<=10\)/);
  assert.match(sql, /profile text NOT NULL CHECK \(profile='morrow\.computer'\)/);
});

test("RuntimeJob@1 is closed: shape, bounds and no command, template, network or limit", () => {
  const parsed = parseRuntimeJob(text(job()));
  assert.ok(parsed);
  assert.equal(parsed.callKey, "step-1");
  assert.deepEqual(parsed.outputs, [{ name: "chart", type: "png" }]);
  // Deterministic canonical text for the ledger's job digest.
  assert.equal(runtimeJobCanonical(parsed), runtimeJobCanonical(parseRuntimeJob(text(job()))));
  const refused = [
    ["not json", "{"],
    ["array", "[]"],
    ["extra key", text({ ...job(), command: ["sh"] })],
    ["template", text({ ...job(), template: "other" })],
    ["network", text({ ...job(), internet: true })],
    ["environment", text({ ...job(), env: { KEY: "x" } })],
    ["timeout", text({ ...job(), timeoutSeconds: 3600 })],
    ["schema version", text(job({ schemaVersion: 2 }))],
    ["kind", text(job({ kind: "shell" }))],
    ["call key", text(job({ callKey: "Step 1" }))],
    ["call key long", text(job({ callKey: "a".repeat(65) }))],
    ["empty script", text(job({ script: "" }))],
    ["NUL in script", text(job({ script: "print(1)\u0000" }))],
    ["lone surrogate", text(job({ script: "x='\ud800'" }))],
    ["script too large", text(job({ script: "#".repeat(runtimeJobLimits.scriptMaxBytes + 1) }))],
    ["no outputs", text(job({ outputs: [] }))],
    [
      "five outputs",
      text(job({ outputs: ["a", "b", "c", "d", "e"].map((name) => ({ name, type: "csv" })) })),
    ],
    ["output type", text(job({ outputs: [{ name: "page", type: "html" }] }))],
    ["svg output", text(job({ outputs: [{ name: "page", type: "svg" }] }))],
    ["output name path", text(job({ outputs: [{ name: "../x", type: "csv" }] }))],
    [
      "duplicate output",
      text(
        job({
          outputs: [
            { name: "a", type: "csv" },
            { name: "a", type: "png" },
          ],
        }),
      ),
    ],
    ["upload kind", text(job({ inputs: [{ name: "upload", kind: "upload", rows: [] }] }))],
    ["customer kind", text(job({ inputs: [{ name: "c", kind: "customers", rows: [] }] }))],
    [
      "row width",
      text(job({ inputs: [{ name: "products", kind: "products", rows: [["7001"]] }] })),
    ],
    [
      "object cell",
      text(
        job({
          inputs: [{ name: "products", kind: "products", rows: [[...product().slice(0, 11), {}]] }],
        }),
      ),
    ],
    [
      "duplicate input",
      text(
        job({
          inputs: [
            { name: "p", kind: "products", rows: [] },
            { name: "p", kind: "stock", rows: [] },
          ],
        }),
      ),
    ],
    [
      "five inputs",
      text(
        job({
          inputs: ["a", "b", "c", "d", "e"].map((name) => ({ name, kind: "stock", rows: [] })),
        }),
      ),
    ],
    [
      "input extra key",
      text(job({ inputs: [{ name: "p", kind: "products", rows: [], columns: ["email"] }] })),
    ],
    [
      "too many rows",
      text(
        job({
          inputs: [
            {
              name: "p",
              kind: "order_aggregates",
              rows: Array(runtimeJobLimits.rowsMax + 1).fill([
                "2026-10-01",
                "USD",
                1,
                1,
                "1",
                "0",
                "0",
                "1",
              ]),
            },
          ],
        }),
      ),
    ],
  ];
  for (const [name, value] of refused) assert.equal(parseRuntimeJob(value), null, name);
  assert.equal(parseRuntimeJob(42), null);
});

test("the extract kinds are fixed allowlists with no customer field, order id or URL column", () => {
  assert.deepEqual(Object.keys(extractKinds).sort(), ["order_aggregates", "products", "stock"]);
  const every = Object.keys(extractKinds).flatMap((k) => extractColumns(k));
  for (const name of every)
    assert.doesNotMatch(
      name,
      /customer|email|phone|address|name$|order_id|url|domain|shop|token|key/,
      name,
    );
  assert.deepEqual(extractColumns("order_aggregates"), [
    "day",
    "currency",
    "orders",
    "units",
    "gross_sales",
    "discounts",
    "refunds",
    "net_sales",
  ]);
});

test("inputs: each cell is checked against its column and rendered as RFC 4180 CSV", () => {
  const rendered = renderJobInputs(
    parseRuntimeJob(
      text(
        job({
          inputs: [
            { name: "products", kind: "products", rows: [product({ title: 'Shirt, "linen"' })] },
          ],
        }),
      ),
    ),
  );
  assert.equal(rendered.ok, true);
  assert.equal(rendered.files.length, 1);
  assert.equal(rendered.files[0].path, "/home/agent/input/products.csv");
  const csv = new TextDecoder().decode(rendered.files[0].bytes);
  assert.equal(csv.split("\n")[0], extractColumns("products").join(","));
  assert.match(csv, /^7001,"Shirt, ""linen""",Shirts,/m);
  const refuse = (row, code, kind = "products") =>
    assert.deepEqual(
      renderJobInputs(parseRuntimeJob(text(job({ inputs: [{ name: "x", kind, rows: [row] }] })))),
      { ok: false, code },
      JSON.stringify(row),
    );
  // Never in the guest: URLs (Morrow's, R2's, presigned, a provider's), a shop domain, a
  // workers.dev host, an email address.
  for (const title of [
    "See https://morrow.example/app",
    "ftp://files",
    "www.example.com sale",
    "brand.myshopify.com",
    "api.morrow-staging.workers.dev",
    "bucket.r2.cloudflarestorage.com/x",
    "x?X-Amz-Signature=abc",
    "write to owner@shop.example",
  ])
    refuse(product({ title }), "input_content_forbidden");
  refuse(product({ title: "tab\tinside" }), "input_value_invalid");
  refuse(product({ title: "x".repeat(256) }), "input_value_invalid");
  refuse([...product().slice(0, 4), "deleted", ...product().slice(5)], "input_value_invalid");
  refuse(["7001", "7002", null, "Shirt", 1.5, null, null], "input_value_invalid", "stock");
  refuse(["7001", "7002", null, "Shirt", 1, "1e5", null], "input_value_invalid", "stock");
  refuse(["7001", "7002", null, "Shirt", 1, null, "Warehouse 1"], "input_value_invalid", "stock");
  refuse(
    ["2026-13-01", "USD", 1, 1, "1", "0", "0", "1"],
    "input_value_invalid",
    "order_aggregates",
  );
  refuse(
    ["2026-10-01", "usd", 1, 1, "1", "0", "0", "1"],
    "input_value_invalid",
    "order_aggregates",
  );
  refuse(
    ["2026-10-01", "USD", -1, 1, "1", "0", "0", "1"],
    "input_value_invalid",
    "order_aggregates",
  );
  refuse([null, ...product().slice(1)], "input_value_invalid");
  // The script goes into the guest as written, so it gets the same screen as a cell: a URL,
  // a shop domain, a workers.dev or R2 host, a signed-URL marker or an email address in it
  // (a comment or a string included) refuses the job, whatever the inputs hold.
  for (const script of [
    'print("https://acme.myshopify.com jane@example.com")\n',
    "# see https://pandas.example/docs\nprint(1)\n",
    'd = "acme.myshopify.com"\n',
    'd = "api.morrow-staging.workers.dev"\n',
    'd = "b.r2.cloudflarestorage.com"\n',
    'q = "X-Amz-Credential=x"\n',
    'm = "jane@example.com"\n',
    'w = "www.example.com"\n',
    'print("ｊａｎｅ＠ｅｘａｍｐｌｅ.ｃｏｍ")\n',
  ])
    assert.deepEqual(
      renderJobInputs(parseRuntimeJob(text(job({ script })))),
      { ok: false, code: "input_content_forbidden" },
      script,
    );
  for (const script of [
    "import pandas as pd\ndf = pd.read_csv('/home/agent/input/products.csv')\n",
    "x = a @ b.T\n",
    "@dataclass\nclass Row:\n    sku: str\n",
  ])
    assert.equal(renderJobInputs(parseRuntimeJob(text(job({ script })))).ok, true, script);
  // A product title with an @ that is not an address is data, not an email.
  assert.equal(
    renderJobInputs(
      parseRuntimeJob(
        text(
          job({
            inputs: [{ name: "p", kind: "products", rows: [product({ title: "Two @ 50% off" })] }],
          }),
        ),
      ),
    ).ok,
    true,
  );
});

test("PNG outputs: structure, CRCs, size and dimensions; metadata chunks are dropped", async () => {
  const png = makePng();
  const ok = await checkRuntimeOutput("png", png);
  assert.equal(ok.outcome, "accepted");
  assert.deepEqual([...ok.bytes], [...png]);
  const tagged = makePng({
    extra: [
      ["tEXt", "Comment\u0000https://example"],
      ["tIME", "\u0007ê\u000a\u0017\u0000\u0000\u0000"],
    ],
  });
  const stripped = await checkRuntimeOutput("png", tagged);
  assert.equal(stripped.outcome, "accepted");
  assert.deepEqual([...stripped.bytes], [...png]);
  for (const [name, bytes] of [
    ["not a png", new TextEncoder().encode("<svg/>")],
    ["bad crc", makePng({ crcBreak: true })],
    ["trailing bytes", makePng({ trailing: "<script>" })],
    [
      "animation chunk",
      makePng({ extra: [["acTL", "\u0000\u0000\u0000\u0001\u0000\u0000\u0000\u0000"]] }),
    ],
    ["unknown critical chunk", makePng({ extra: [["ABCD", "x"]] })],
    ["too wide", makePng({ width: 10_001, height: 1 })],
  ])
    assert.deepEqual(
      await checkRuntimeOutput("png", bytes),
      { outcome: "rejected", code: "png_invalid" },
      name,
    );
  assert.deepEqual(
    await checkRuntimeOutput("png", new Uint8Array(runtimeJobLimits.outputBytesMax.png + 1)),
    {
      outcome: "rejected",
      code: "output_too_large",
    },
  );
});

test("CSV outputs: formula cells escaped, numbers kept, malformed text refused", async () => {
  assert.equal(csvEscapeCell('=HYPERLINK("http://x")'), '\'=HYPERLINK("http://x")');
  for (const cell of ["+1+1", "-cmd", "@SUM(A1)", "\tx", "\rx", "＝1+1"])
    assert.equal(csvEscapeCell(cell), "'" + cell, cell);
  for (const cell of ["-5", "+3.25", "-1e5", "12", "plain", ""])
    assert.equal(csvEscapeCell(cell), cell, cell);
  const input = '﻿sku,price,note\nA1,-5,"=1+2"\nA2,3.5,"multi\nline, ""quoted"""\n';
  const checked = await checkRuntimeOutput("csv", new TextEncoder().encode(input));
  assert.equal(checked.outcome, "accepted");
  assert.equal(
    new TextDecoder().decode(checked.bytes),
    'sku,price,note\r\nA1,-5,\'=1+2\r\nA2,3.5,"multi\nline, ""quoted"""\r\n',
  );
  for (const [name, bytes] of [
    ["invalid utf-8", new Uint8Array([0x61, 0xff, 0x0a])],
    ["NUL", new TextEncoder().encode("a,\u0000\n")],
    ["unterminated quote", new TextEncoder().encode('a,"b\n')],
    ["quote mid-field", new TextEncoder().encode('a,b"c\n')],
    ["empty", new Uint8Array(0)],
  ])
    assert.deepEqual(
      await checkRuntimeOutput("csv", bytes),
      { outcome: "rejected", code: "csv_invalid" },
      name,
    );
});

test("XLSX outputs: macros, objects, links and remote formulas are refused; zip tricks too", async () => {
  const ok = await checkRuntimeOutput("xlsx", makeXlsx());
  assert.equal(ok.outcome, "accepted");
  const cases = [
    [
      "vba project",
      makeXlsx({ parts: [["xl/vbaProject.bin", Buffer.from([1, 2, 3])]] }),
      "xlsx_macro",
    ],
    [
      "macro content type",
      makeXlsx({
        types:
          '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>',
      }),
      "xlsx_macro",
    ],
    ["macro sheet", makeXlsx({ parts: [["xl/macrosheets/sheet1.xml", "<x/>"]] }), "xlsx_macro"],
    [
      "embedded object",
      makeXlsx({ parts: [["xl/embeddings/oleObject1.xml", "<x/>"]] }),
      "xlsx_object",
    ],
    ["activex", makeXlsx({ parts: [["xl/activeX/activeX1.xml", "<x/>"]] }), "xlsx_object"],
    ["vml drawing", makeXlsx({ parts: [["xl/drawings/vmlDrawing1.vml", "<x/>"]] }), "xlsx_object"],
    [
      "external link part",
      makeXlsx({ parts: [["xl/externalLinks/externalLink1.xml", "<x/>"]] }),
      "xlsx_link",
    ],
    ["data connection", makeXlsx({ parts: [["xl/connections.xml", "<x/>"]] }), "xlsx_link"],
    [
      "external relationship",
      makeXlsx({
        rels: '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.example" TargetMode="External"/>',
      }),
      "xlsx_link",
    ],
    [
      "hyperlink formula",
      makeXlsx({
        cells: '<row r="1"><c r="A1"><f>HYPERLINK("https://evil.example","x")</f></c></row>',
      }),
      "xlsx_link",
    ],
    [
      "webservice formula",
      makeXlsx({
        cells:
          '<row r="1"><c r="A1"><f t="shared" si="0">WEBSERVICE("https://evil.example")</f></c></row>',
      }),
      "xlsx_link",
    ],
    [
      "external reference",
      makeXlsx({ cells: '<row r="1"><c r="A1"><f>[1]Sheet1!A1</f></c></row>' }),
      "xlsx_link",
    ],
    [
      "dde",
      makeXlsx({ cells: '<row r="1"><c r="A1"><f>cmd|\' /C calc\'!A0</f></c></row>' }),
      "xlsx_link",
    ],
    [
      "defined name",
      makeXlsx({
        names:
          '<definedNames><definedName name="x">WEBSERVICE("https://e")</definedName></definedNames>',
      }),
      "xlsx_link",
    ],
    ["missing workbook", makeXlsx({ drop: ["xl/workbook.xml"] }), "xlsx_invalid"],
    ["encrypted entries", makeXlsx({ options: { flags: 1 } }), "xlsx_invalid"],
    ["trailing bytes", makeXlsx({ options: { trailing: "junk" } }), "xlsx_invalid"],
    ["zip64 marker", makeXlsx({ options: { zip64: true } }), "xlsx_invalid"],
    [
      "local name differs",
      makeXlsx({
        options: { localNameOf: (n) => (n === "xl/workbook.xml" ? "xl/workbooK.xml" : n) },
      }),
      "xlsx_invalid",
    ],
    ["path traversal", makeXlsx({ parts: [["../evil.xml", "<x/>"]] }), "xlsx_invalid"],
    ["absolute path", makeXlsx({ parts: [["/etc/x.xml", "<x/>"]] }), "xlsx_invalid"],
    ["duplicate names", makeXlsx({ parts: [["XL/WORKBOOK.XML", "<x/>"]] }), "xlsx_invalid"],
    ["not a zip", new TextEncoder().encode("PK but not really"), "xlsx_invalid"],
  ];
  for (const [name, bytes, code] of cases)
    assert.deepEqual(await checkRuntimeOutput("xlsx", bytes), { outcome: "rejected", code }, name);
  // A bomb: a 2 MiB part deflated far beyond the ratio.
  const bomb = makeZip([
    ["[Content_Types].xml", "<Types/>"],
    ["_rels/.rels", "<Relationships/>"],
    ["xl/workbook.xml", "<workbook/>"],
    ["xl/worksheets/sheet1.xml", Buffer.alloc(2 * 1024 * 1024, 0x20)],
  ]);
  assert.deepEqual(await checkRuntimeOutput("xlsx", bomb), {
    outcome: "rejected",
    code: "xlsx_invalid",
  });
});

test("XLSX outputs: every byte belongs to a listed entry, so no hidden entry rides along (review R3)", async () => {
  // A local header and data the central directory does not list: a streaming reader that
  // walks local headers would still find it.
  const hidden = zipLocal("xl/vbaProject.bin", Buffer.from([1, 2, 3]));
  const workbookOnly = (n, size) => (n === "xl/workbook.xml" ? size - 1 : size);
  const cases = [
    ["a hidden entry before the first", makeXlsx({ options: { prefix: hidden } })],
    ["bytes before the first entry", makeXlsx({ options: { prefix: Buffer.alloc(4) } })],
    ["a hidden entry between entries", makeXlsx({ options: { gap: [1, hidden] } })],
    ["a hidden entry after the last", makeXlsx({ options: { gap: [4, hidden] } })],
    ["one stray byte between entries", makeXlsx({ options: { gap: [2, Buffer.alloc(1)] } })],
    ["an archive comment", makeXlsx({ options: { comment: "x" } })],
    ["a hidden entry in the archive comment", makeXlsx({ options: { comment: hidden } })],
    [
      "a local size the directory disagrees with",
      makeXlsx({ options: { localSizeOf: workbookOnly } }),
    ],
    [
      "a data descriptor the directory disagrees with",
      makeXlsx({ options: { descriptor: "wrong" } }),
    ],
    [
      "a hidden entry after a data descriptor",
      makeXlsx({ options: { descriptor: "signed", gap: [0, hidden] } }),
    ],
  ];
  for (const [name, bytes] of cases)
    assert.deepEqual(
      await checkRuntimeOutput("xlsx", bytes),
      { outcome: "rejected", code: "xlsx_invalid" },
      name,
    );
  // Data descriptors that agree with the directory, signed or bare, are an ordinary zip, and
  // what is served is exactly what was checked.
  for (const descriptor of ["signed", "bare"]) {
    const bytes = makeXlsx({ options: { descriptor } });
    assert.deepEqual(await checkRuntimeOutput("xlsx", bytes), { outcome: "accepted", bytes });
  }
});

test("XLSX outputs: cloud functions and prefixed functions outside the pure list are refused (review R3)", async () => {
  const cell = (f) => `<row r="1"><c r="A1"><f>${f}</f></c></row>`;
  const refused = [
    // The review's five probes: each was accepted before.
    '_xlfn.COPILOT("x",A1)',
    '_xlfn.TRANSLATE(A1,"en","fr")',
    '_xlfn.STOCKHISTORY("MSFT",1)',
    "_xlfn._xlws.PY(0,1)",
    "_xlfn.DETECTLANGUAGE(A1)",
    // The same names without a prefix, in any case, and the other remote or linked ones.
    'copilot("x",A1)',
    "SUM(1,PY (0,1))",
    '_xlfn.FIELDVALUE(A1,"Price")',
    '_xlfn.ENCODEURL("x")',
    '_xlfn.IMAGE("https://evil.example/x.png")',
    'CUBEVALUE("c","m")',
    // An add-in's user-defined functions and a prefixed name not on the list.
    "_xludf.SEND(A1)",
    "_xldudf_CONTOSO_SEND(A1)",
    "_xlfn.SOMEFUTUREAI(A1)",
    "_xlfn._xlws.SOMEFUTUREAI(A1)",
    "_xlfn.(A1)",
  ];
  for (const formula of refused)
    assert.deepEqual(
      await checkRuntimeOutput("xlsx", makeXlsx({ cells: cell(formula) })),
      { outcome: "rejected", code: "xlsx_link" },
      formula,
    );
  // A defined name is a formula too.
  assert.deepEqual(
    await checkRuntimeOutput(
      "xlsx",
      makeXlsx({
        names:
          '<definedNames><definedName name="x">_xlfn.COPILOT("x",Sheet1!A1)</definedName></definedNames>',
      }),
    ),
    { outcome: "rejected", code: "xlsx_link" },
  );
  // Pure calculations Excel writes with a prefix still pass.
  for (const formula of [
    "_xlfn.XLOOKUP(B1,B1:B3,C1:C3)",
    "_xlfn._xlws.SORT(B1:B3)",
    "_xlfn._xlws.FILTER(B1:B3,B1:B3>1)",
    "_xlfn.STDEV.S(B1:B3)+_xlfn.T.DIST.2T(1,2)",
    "_xlfn.LET(_xlpm.x,B1,_xlpm.x*2)",
    '_xlfn.IFS(B1&gt;1,1,TRUE,0)&amp;_xlfn.TEXTJOIN(",",TRUE,B1:B3)',
  ]) {
    const bytes = makeXlsx({ cells: cell(formula) });
    assert.deepEqual(
      await checkRuntimeOutput("xlsx", bytes),
      { outcome: "accepted", bytes },
      formula,
    );
  }
});

test("XLSX outputs: every part is read as strict XML, so hidden formulas and links are refused", async () => {
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const worksheet = (inner, after = "") =>
    decl +
    `<worksheet xmlns="${main}" xmlns:r="${rel}"><sheetData>${inner}</sheetData>${after}</worksheet>`;
  const cell = (f) => `<row r="1"><c r="A1"><f>${f}</f></c></row>`;
  // Replaces sheet1 with the given text.
  const withSheet = (sheetXml) => makeXlsx({ sheetXml });
  const rels = (inner) =>
    decl +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    inner +
    "</Relationships>";
  const cases = [
    // The review's five probes: each was accepted before.
    [
      "a worksheet part not named sheetN.xml",
      makeXlsx({
        rels: `<Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/data.xml"/>`,
        parts: [["xl/worksheets/data.xml", worksheet(cell('WEBSERVICE("http://evil")'))]],
      }),
      "xlsx_link",
    ],
    [
      "a numeric character reference",
      withSheet(worksheet(cell('&#87;EBSERVICE("http://evil")'))),
      "xlsx_invalid",
    ],
    [
      "a prefixed SpreadsheetML namespace",
      withSheet(
        decl +
          `<x:worksheet xmlns:x="${main}"><x:sheetData><x:row r="1"><x:c r="A1"><x:f>WEBSERVICE("http://evil")</x:f></x:c></x:row></x:sheetData></x:worksheet>`,
      ),
      "xlsx_link",
    ],
    [
      "a CDATA section",
      withSheet(worksheet(cell('<![CDATA[WEBSERVICE("http://evil")]]>'))),
      "xlsx_invalid",
    ],
    [
      "an external relationship written with character references",
      makeXlsx({
        parts: [
          [
            "xl/worksheets/_rels/sheet1.xml.rels",
            rels(
              `<Relationship Id="rId1" Type="${rel}/hyperlink" Target="&#104;ttps://evil/x" TargetMode="&#69;xternal"/>`,
            ),
          ],
        ],
      }),
      "xlsx_invalid",
    ],
    // Other ways to hide the same text from a pattern.
    [
      "a hexadecimal reference",
      withSheet(worksheet(cell('&#x57;EBSERVICE("http://evil")'))),
      "xlsx_invalid",
    ],
    [
      "a comment inside a formula",
      withSheet(worksheet(cell('WEB<!-- -->SERVICE("http://evil")'))),
      "xlsx_invalid",
    ],
    [
      "an element inside a formula",
      withSheet(worksheet(cell('WEB<x/>SERVICE("http://evil")'))),
      "xlsx_invalid",
    ],
    [
      "a DTD entity",
      withSheet(
        decl +
          `<!DOCTYPE worksheet [<!ENTITY w "WEBSERVICE">]><worksheet xmlns="${main}"><sheetData>${cell('&w;("http://evil")')}</sheetData></worksheet>`,
      ),
      "xlsx_invalid",
    ],
    ["a processing instruction", withSheet(worksheet(cell("1") + "<?evil x?>")), "xlsx_invalid"],
    ["an undefined entity", withSheet(worksheet(cell("&w;"))), "xlsx_invalid"],
    [
      "another declared encoding",
      withSheet(worksheet(cell("1")).replace("UTF-8", "UTF-7")),
      "xlsx_invalid",
    ],
    [
      "UTF-16 text",
      withSheet(Buffer.from(worksheet(cell('WEBSERVICE("http://evil")')), "utf16le")),
      "xlsx_invalid",
    ],
    ["two roots", withSheet(worksheet(cell("1")) + "<worksheet/>"), "xlsx_invalid"],
    [
      "an unclosed element",
      withSheet(worksheet(cell("1")).replace("</worksheet>", "")),
      "xlsx_invalid",
    ],
    [
      "a duplicate attribute",
      makeXlsx({
        parts: [
          [
            "xl/worksheets/_rels/sheet1.xml.rels",
            rels(
              `<Relationship Id="rId1" Type="${rel}/image" Target="../media/a.png" TargetMode="Internal" TargetMode="External"/>`,
            ),
          ],
        ],
      }),
      "xlsx_invalid",
    ],
    [
      "a self-closing look-alike in an attribute",
      withSheet(
        worksheet('<row r="1"><c r="A1"><f a="/>">WEBSERVICE("http://evil")</f></c></row>'),
      ),
      "xlsx_link",
    ],
    // Formulas outside cells, in every part.
    [
      "a conditional format",
      withSheet(
        worksheet(
          "",
          '<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>WEBSERVICE("http://evil")</formula></cfRule></conditionalFormatting>',
        ),
      ),
      "xlsx_link",
    ],
    [
      "a data validation",
      withSheet(
        worksheet(
          "",
          '<dataValidations count="1"><dataValidation type="list" sqref="A1"><formula1>[1]Sheet1!$A$1:$A$3</formula1></dataValidation></dataValidations>',
        ),
      ),
      "xlsx_link",
    ],
    [
      "an x14 extension formula",
      withSheet(
        worksheet(
          "",
          '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list"><x14:formula1><xm:f>IMAGE("http://evil/x.png")</xm:f></x14:formula1><xm:sqref>A1</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>',
        ),
      ),
      "xlsx_link",
    ],
    [
      "a chart series reference",
      makeXlsx({
        parts: [
          [
            "xl/charts/chart1.xml",
            decl +
              '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>[1]Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
          ],
        ],
      }),
      "xlsx_link",
    ],
    [
      "a table column",
      makeXlsx({
        parts: [
          [
            "xl/tables/table1.xml",
            decl +
              `<table xmlns="${main}" id="1" name="T" displayName="T" ref="A1:A2"><tableColumns count="1"><tableColumn id="1" name="c"><calculatedColumnFormula>WEBSERVICE("http://evil")</calculatedColumnFormula></tableColumn></tableColumns></table>`,
          ],
        ],
      }),
      "xlsx_link",
    ],
    [
      "a pivot's calculated field",
      makeXlsx({
        parts: [
          [
            "xl/pivotCache/pivotCacheDefinition1.xml",
            decl +
              `<pivotCacheDefinition xmlns="${main}"><cacheFields count="1"><cacheField name="x" formula="WEBSERVICE(&quot;http://evil&quot;)"/></cacheFields></pivotCacheDefinition>`,
          ],
        ],
      }),
      "xlsx_link",
    ],
    // Relationships in every part, by mode, target and type.
    [
      "an external mode in a drawing's relationships",
      makeXlsx({
        parts: [
          [
            "xl/drawings/_rels/drawing1.xml.rels",
            rels(
              `<Relationship Id="rId1" Type="${rel}/image" Target="https://evil/x.png" TargetMode="external"/>`,
            ),
          ],
        ],
      }),
      "xlsx_link",
    ],
    [
      "a UNC target",
      makeXlsx({
        rels: `<Relationship Id="rId2" Type="${rel}/worksheet" Target="\\\\evil\\share\\x.xml"/>`,
      }),
      "xlsx_link",
    ],
    [
      "a network-path target",
      makeXlsx({ rels: `<Relationship Id="rId2" Type="${rel}/worksheet" Target="//evil/x.xml"/>` }),
      "xlsx_link",
    ],
    [
      "an object relationship to an innocently named part",
      makeXlsx({
        rels: `<Relationship Id="rId2" Type="${rel}/oleObject" Target="stuff/a.xml"/>`,
        parts: [["xl/stuff/a.xml", "<a/>"]],
      }),
      "xlsx_object",
    ],
    [
      "an embedded package relationship",
      makeXlsx({
        rels: `<Relationship Id="rId2" Type="${rel}/package" Target="stuff/a.xml"/>`,
        parts: [["xl/stuff/a.xml", "<a/>"]],
      }),
      "xlsx_object",
    ],
    [
      "a macro relationship",
      makeXlsx({
        rels: '<Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="stuff/a.xml"/>',
        parts: [["xl/stuff/a.xml", "<a/>"]],
      }),
      "xlsx_macro",
    ],
    [
      "an external link relationship",
      makeXlsx({
        rels: `<Relationship Id="rId2" Type="${rel}/externalLink" Target="stuff/a.xml"/>`,
        parts: [["xl/stuff/a.xml", "<a/>"]],
      }),
      "xlsx_link",
    ],
    [
      "a hyperlink with a renamed relationship prefix",
      withSheet(
        decl +
          `<worksheet xmlns="${main}" xmlns:q="${rel}"><sheetData/><hyperlinks><hyperlink ref="A1" q:id="rId9"/></hyperlinks></worksheet>`,
      ),
      "xlsx_link",
    ],
    [
      "the IMAGE function",
      withSheet(worksheet(cell('_xlfn.IMAGE("http://evil/x.png")'))),
      "xlsx_link",
    ],
    [
      "an obfuscated macro content type",
      makeXlsx({
        types:
          '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.macro&#69;nabled.main+xml"/>',
      }),
      "xlsx_invalid",
    ],
    // Binary parts: only images, by their magic bytes.
    [
      "an image that is not one",
      makeXlsx({ parts: [["xl/media/image1.png", "<worksheet/>"]] }),
      "xlsx_invalid",
    ],
    [
      "a binary part",
      makeXlsx({ parts: [["xl/stuff/blob.dat", Buffer.from([0xff, 0xfe, 0x00, 0x01])]] }),
      "xlsx_invalid",
    ],
    [
      "a text part that is not XML",
      makeXlsx({ parts: [["xl/stuff/notes.txt", "plain text"]] }),
      "xlsx_invalid",
    ],
  ];
  for (const [name, bytes, code] of cases)
    assert.deepEqual(await checkRuntimeOutput("xlsx", bytes), { outcome: "rejected", code }, name);

  // What a Python library writes is accepted as it is: styles, shared strings, a theme with
  // prefixed names, core properties, a chart over the sheet, a drawing and its image, an
  // escaped string, an attribute newline written as &#10; and a filter's defined name.
  const realistic = makeXlsx({
    cells:
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(B2:B3)&amp;""</f><v>3</v></c></row>',
    names:
      '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Sheet1!$A$1:$B$3</definedName></definedNames>',
    parts: [
      [
        "docProps/core.xml",
        decl +
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>openpyxl</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-10-24T10:00:00Z</dcterms:created></cp:coreProperties>',
      ],
      [
        "xl/styles.xml",
        decl +
          `<styleSheet xmlns="${main}"><numFmts count="1"><numFmt numFmtId="164" formatCode="[$-409]#,##0.00;[Red]-#,##0.00"/></numFmts></styleSheet>`,
      ],
      [
        "xl/sharedStrings.xml",
        decl +
          `<sst xmlns="${main}" count="1" uniqueCount="1"><si><t xml:space="preserve">Shirts &amp; tees &lt;summer&gt;</t></si></sst>`,
      ],
      [
        "xl/theme/theme1.xml",
        decl +
          '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>',
      ],
      [
        "xl/worksheets/_rels/sheet1.xml.rels",
        rels(`<Relationship Id="rId1" Type="${rel}/drawing" Target="../drawings/drawing1.xml"/>`),
      ],
      [
        "xl/drawings/drawing1.xml",
        decl +
          '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Chart" descr="line one&#10;line two"/></xdr:nvPicPr></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>',
      ],
      [
        "xl/drawings/_rels/drawing1.xml.rels",
        rels(
          `<Relationship Id="rId1" Type="${rel}/image" Target="../media/image1.png"/><Relationship Id="rId2" Type="${rel}/chart" Target="/xl/charts/chart1.xml" TargetMode="Internal"/>`,
        ),
      ],
      [
        "xl/charts/chart1.xml",
        decl +
          "<c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>'Sheet 1'!$B$2:$B$3</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>",
      ],
      ["xl/media/image1.png", makePng()],
    ],
  });
  const accepted = await checkRuntimeOutput("xlsx", realistic);
  assert.equal(accepted.outcome, "accepted");
  assert.deepEqual(accepted.bytes, realistic);
  // Excel's own nesting (an x14 validation's formula1 wraps an xm:f), an internal hyperlink
  // and tab, newline and carriage-return references are read, not refused.
  for (const [name, bytes] of [
    [
      "x14 validation",
      withSheet(
        worksheet(
          "",
          '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list"><x14:formula1><xm:f>Sheet2!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>A1</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>',
        ),
      ),
    ],
    [
      "internal hyperlink",
      withSheet(
        worksheet("", '<hyperlinks><hyperlink ref="A1" location="Sheet1!B2"/></hyperlinks>'),
      ),
    ],
    [
      "whitespace references",
      withSheet(
        worksheet(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>a&#13;&#10;b&#x9;c</t></is></c></row>',
        ),
      ),
    ],
  ])
    assert.equal((await checkRuntimeOutput("xlsx", bytes)).outcome, "accepted", name);
});
