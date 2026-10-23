// Build order PR 7 (ADR-0029 items 1, 4, 5 and 8): the computer's profile, closed job,
// minimised inputs, output checks and caps (packages/policy/src/runtime-computer.ts), and the
// caps' SQL twin in migration 0039 (drift).
//   * The profile: no internet, 900 s life, 120 s exec, 2 vCPU and 1 GiB, the fixed command run
//     by the non-root user `agent`; the worst case at list rates is US$0.03.
//   * RuntimeJob@1 is closed: any unknown key, value or bound refuses the whole job, and nothing
//     in it names a command, template, network, environment or limit.
//   * Inputs are closed extract kinds with fixed columns; a URL, a shop domain, a workers.dev
//     host, a presigned-URL parameter or an email refuses the job; customer fields cannot be
//     expressed at all.
//   * Outputs: PNG (structure and CRCs checked, metadata chunks dropped), CSV (formula cells
//     escaped, numbers kept) and XLSX (no macros, objects, external links or remote formulas;
//     zip tricks refused), each within its size.
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
import { makePng, makeXlsx, makeZip } from "./fixtures/runtime-files.mjs";

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
  assert.ok(Number(runtimeCaps.monthlyBudgetUsd) < Number(runtimeCaps.providerUsageLimitUsd));
  assert.equal(runtimeCaps.concurrentSandboxes, 10);
  assert.equal(runtimeCaps.sandboxesPerWorkspace, 3);
});

test("migration 0039 holds the same caps, deadline, grace and staleness in SQL", () => {
  const sql = readFileSync("migrations/0039.runtime-operations.sql", "utf8");
  const caps =
    /CREATE FUNCTION morrow_vault\.runtime_caps\(\)[\s\S]*?AS \$\$\n SELECT ([^\n]+)\n\$\$;/.exec(
      sql,
    );
  assert.ok(caps);
  assert.equal(
    caps[1],
    `${runtimeCaps.monthlyBudgetUsd}::numeric(20,8),${runtimeCaps.concurrentSandboxes},${runtimeCaps.sandboxesPerWorkspace},${runtimeCaps.worstCaseUsd}::numeric(20,8),${computerProfile.sandboxTimeoutSeconds + computerProfile.createAllowanceSeconds},${computerProfile.absentGraceSeconds},660`,
  );
  // The longest execute plus a minute is the staleness the sweep waits for.
  assert.equal(660, 600 + 60);
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
