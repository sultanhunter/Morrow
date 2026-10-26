// The computer (ADR-0029 items 1, 4, 5 and 8; build order PR 7): the profile
// `morrow.computer` v1, the closed job a caller may ask the broker to run, the minimised
// inputs it may carry, the only outputs it may bring back, and the runtime caps. Pure: no
// I/O, clock or randomness; the broker's runtime gateway (apps/broker/src/runtime-gateway.ts)
// and its conformance suite use it, and migration 0043 holds the same caps in SQL
// (drift-tested by tests/runtime-computer.test.mjs).
//
// Inside the sandbox there is no internet, no credential, no Morrow or provider URL and no
// browser. A job is fixed Python run by the profile's own command as the non-root user
// `agent`; nothing a caller sends chooses the command, the user, the environment, the
// network, the template or a limit. Its inputs are closed extract kinds with fixed column
// allowlists (never a customer field or id, an order id, the shop's domain or any URL), its
// script gets the same content screen as a cell, and its outputs are only PNG, CSV (formula
// cells escaped) and XLSX (no macros, links, objects or remote formulas, with every part read
// as strict XML), checked by content and size and returned as untrusted downloads.

/** The one execution profile (ADR-0029 item 1). */
export const computerProfile = Object.freeze({
  id: "morrow.computer",
  version: 1,
  /** Internet is off at creation, outside the guest. */
  internet: false,
  /** The sandbox's own lifetime: it is killed at the job's end and dies by itself here. */
  sandboxTimeoutSeconds: 900,
  /** One exec, model code included. */
  execTimeoutSeconds: 120,
  vcpu: 2,
  memoryMiB: 1024,
  user: "agent",
  workDirectory: "/home/agent/work",
  inputDirectory: "/home/agent/input",
  outputDirectory: "/home/agent/output",
  jobPath: "/home/agent/work/job.py",
  /** The fixed command: isolated mode (-I) ignores PYTHON* variables and the user site. */
  command: Object.freeze(["/usr/bin/python3", "-I", "-B", "/home/agent/work/job.py"]),
  /**
   * A sandbox the provider no longer finds counts as absent (`absent_verified`) only this
   * long after its deadline, and only on a qualified profile (ADR-0029 item 2); otherwise it
   * stays `unknown_effect`.
   */
  absentGraceSeconds: 600,
  /** The create's own allowance beyond the sandbox's lifetime (the deadline's margin). */
  createAllowanceSeconds: 60,
});

// E2B's list rates (Hobby and Pro alike, e2b.dev/pricing, read 2026-10-22): US$0.000014 per
// vCPU second and US$0.0000045 per GiB second, here in billionths of a dollar.
export const computerRates = Object.freeze({
  vcpuNanoUsdPerSecond: 14_000,
  memoryGiBNanoUsdPerSecond: 4_500,
});
/** One sandbox's worst case at list rates, rounded up to whole cents (US$0.02925 -> 0.03). */
export function sandboxWorstCaseUsd(): string {
  const nano =
    computerProfile.sandboxTimeoutSeconds *
    (computerProfile.vcpu * computerRates.vcpuNanoUsdPerSecond +
      (computerProfile.memoryMiB / 1024) * computerRates.memoryGiBNanoUsdPerSecond);
  const cents = Math.ceil(nano / 10_000_000);
  return (cents / 100).toFixed(2);
}

/**
 * The runtime caps (ADR-0029 item 8), checked in SQL under one platform row lock before
 * every create (migration 0043's morrow_vault.runtime_operation_begin, revised by 0055):
 * half of Hobby's 20 concurrent sandboxes and three open sandboxes per workspace, both
 * counts, not money. At a cap the caller's TypeScript fallback runs; cleanup is never
 * blocked. ADR-0039 item 6 removed the US$10 monthly budget: credits are the only spend
 * limit, and E2B's usage limit in the owner's E2B account (US$20, recorded here and in
 * docs/decisions/runtime-staging.json, enforced by E2B, never by Morrow's code) is the outside
 * backstop. E2B's refusal sets the runtime hold that only a person lifts (ADR-0029 item 9).
 */
export const runtimeCaps = Object.freeze({
  providerUsageLimitUsd: "20.00",
  concurrentSandboxes: 10,
  sandboxesPerWorkspace: 3,
  worstCaseUsd: "0.03",
});

// ---------------------------------------------------------------------------
// The job: RuntimeJob@1, checked by hand (closed shape and bounds).

export const runtimeJobLimits = Object.freeze({
  jobMaxBytes: 6 * 1024 * 1024,
  scriptMaxBytes: 64 * 1024,
  inputsMax: 4,
  rowsMax: 10_000,
  inputBytesMax: 4 * 1024 * 1024,
  outputsMin: 1,
  outputsMax: 4,
  outputBytesMax: Object.freeze({
    png: 5 * 1024 * 1024,
    csv: 5 * 1024 * 1024,
    xlsx: 5 * 1024 * 1024,
  }),
  outputsBytesMax: 10 * 1024 * 1024,
  logBytesMax: 4 * 1024,
});
export type RuntimeOutputType = "png" | "csv" | "xlsx";
export const runtimeOutputTypes: readonly RuntimeOutputType[] = Object.freeze([
  "png",
  "csv",
  "xlsx",
]);
export type ExtractKind = "products" | "stock" | "order_aggregates";

type ColumnType =
  | "id"
  | "text"
  | "tags"
  | "sku"
  | "status"
  | "count"
  | "quantity"
  | "money"
  | "date"
  | "timestamp"
  | "currency"
  | "location_ref";
interface Column {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
}
const col = (name: string, type: ColumnType, nullable = false): Column =>
  Object.freeze({ name, type, nullable });
/**
 * The closed extract kinds and their fixed column allowlists (ADR-0029 item 4). Level 1
 * order aggregates are per day and currency only: no order, customer or line item. `upload`
 * opens only with its header screen and deletion path (ADR-0029 item 6; build order PR 13),
 * so it is not a kind here yet.
 */
export const extractKinds: Readonly<Record<ExtractKind, readonly Column[]>> = Object.freeze({
  products: Object.freeze([
    col("product_id", "id"),
    col("title", "text"),
    col("product_type", "text", true),
    col("vendor", "text", true),
    col("status", "status"),
    col("tags", "tags", true),
    col("variants_count", "count"),
    col("price_min", "money", true),
    col("price_max", "money", true),
    col("inventory_total", "quantity", true),
    col("created_at", "timestamp"),
    col("updated_at", "timestamp"),
  ]),
  stock: Object.freeze([
    col("product_id", "id"),
    col("variant_id", "id"),
    col("sku", "sku", true),
    col("title", "text"),
    col("inventory_quantity", "quantity"),
    col("price", "money", true),
    col("location_ref", "location_ref", true),
  ]),
  order_aggregates: Object.freeze([
    col("day", "date"),
    col("currency", "currency"),
    col("orders", "count"),
    col("units", "count"),
    col("gross_sales", "money"),
    col("discounts", "money"),
    col("refunds", "money"),
    col("net_sales", "money"),
  ]),
});
export const extractColumns = (kind: ExtractKind): readonly string[] =>
  extractKinds[kind].map((c) => c.name);

type Cell = string | number | null;
export interface RuntimeJobInput {
  readonly name: string;
  readonly kind: ExtractKind;
  readonly rows: readonly (readonly Cell[])[];
}
export interface RuntimeJobOutput {
  readonly name: string;
  readonly type: RuntimeOutputType;
}
export interface RuntimeJob {
  readonly schemaVersion: 1;
  readonly kind: "python_analysis";
  /** The caller's step key: one job per run and key, so a retried step never runs twice. */
  readonly callKey: string;
  readonly script: string;
  readonly inputs: readonly RuntimeJobInput[];
  readonly outputs: readonly RuntimeJobOutput[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keysExactly = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const fileName = /^[a-z][a-z0-9_]{0,31}$/;
const callKeyPattern = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const utf8Length = (s: string) => new TextEncoder().encode(s).length;
// Lone surrogates cannot be encoded; NUL and the other C0 controls (but tab, newline and
// carriage return) never belong in a script.
const scriptText = (s: string) =>
  s.length > 0 &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) &&
  !/[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));

/** RuntimeJob@1 text, or null: any unknown key, value or bound refuses the whole job. */
export function parseRuntimeJob(text: unknown): RuntimeJob | null {
  if (typeof text !== "string" || utf8Length(text) > runtimeJobLimits.jobMaxBytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isObject(v) ||
    !keysExactly(v, ["schemaVersion", "kind", "callKey", "script", "inputs", "outputs"]) ||
    v.schemaVersion !== 1 ||
    v.kind !== "python_analysis" ||
    typeof v.callKey !== "string" ||
    !callKeyPattern.test(v.callKey) ||
    typeof v.script !== "string" ||
    !scriptText(v.script) ||
    utf8Length(v.script) > runtimeJobLimits.scriptMaxBytes ||
    !Array.isArray(v.inputs) ||
    v.inputs.length > runtimeJobLimits.inputsMax ||
    !Array.isArray(v.outputs) ||
    v.outputs.length < runtimeJobLimits.outputsMin ||
    v.outputs.length > runtimeJobLimits.outputsMax
  )
    return null;
  const names = new Set<string>();
  const inputs: RuntimeJobInput[] = [];
  for (const input of v.inputs) {
    if (
      !isObject(input) ||
      !keysExactly(input, ["name", "kind", "rows"]) ||
      typeof input.name !== "string" ||
      !fileName.test(input.name) ||
      names.has(input.name) ||
      typeof input.kind !== "string" ||
      !Object.hasOwn(extractKinds, input.kind) ||
      !Array.isArray(input.rows) ||
      input.rows.length > runtimeJobLimits.rowsMax
    )
      return null;
    const width = extractKinds[input.kind as ExtractKind].length;
    for (const row of input.rows)
      if (
        !Array.isArray(row) ||
        row.length !== width ||
        !row.every((c) => c === null || typeof c === "string" || typeof c === "number")
      )
        return null;
    names.add(input.name);
    inputs.push(
      Object.freeze({
        name: input.name,
        kind: input.kind as ExtractKind,
        rows: input.rows as Cell[][],
      }),
    );
  }
  const outputNames = new Set<string>();
  const outputs: RuntimeJobOutput[] = [];
  for (const output of v.outputs) {
    if (
      !isObject(output) ||
      !keysExactly(output, ["name", "type"]) ||
      typeof output.name !== "string" ||
      !fileName.test(output.name) ||
      outputNames.has(output.name) ||
      typeof output.type !== "string" ||
      !(runtimeOutputTypes as readonly string[]).includes(output.type)
    )
      return null;
    outputNames.add(output.name);
    outputs.push(Object.freeze({ name: output.name, type: output.type as RuntimeOutputType }));
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "python_analysis",
    callKey: v.callKey,
    script: v.script,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
  });
}

// RFC 8785 text of plain JSON data (the broker's jcs).
const jcs = (value: unknown): string =>
  Array.isArray(value)
    ? "[" + value.map(jcs).join(",") + "]"
    : value !== null && typeof value === "object"
      ? "{" +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + jcs((value as Record<string, unknown>)[k]))
          .join(",") +
        "}"
      : JSON.stringify(value);
/** The canonical text a job's digest is taken over (the ledger binds it at the send mark). */
export const runtimeJobCanonical = (job: RuntimeJob): string => jcs(job);

// ---------------------------------------------------------------------------
// Inputs: the minimised extracts, rendered by the broker as CSV files for the guest.

export type InputRefusal = "input_value_invalid" | "input_content_forbidden" | "input_too_large";
// Text that must never enter the guest (ADR-0029 item 4): any URL (Morrow's, R2's, a
// presigned one or a provider's), a shop's myshopify domain, a workers.dev host and an email
// address. A cell or a script that holds one refuses the whole job; nothing is silently
// rewritten. The text is also read in its NFKC form, so full-width look-alikes are caught too.
const forbidden = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\./i,
  /myshopify\.(com|io)/i,
  /\.workers\.dev\b/i,
  /\.r2\.(dev|cloudflarestorage\.com)\b/i,
  /x-amz-|x-goog-|signature=/i,
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
];
const forbiddenText = (s: string): boolean => {
  const folded = s.normalize("NFKC");
  return forbidden.some((p) => p.test(s) || p.test(folded));
};
const controls = /[\u0000-\u001f\u007f]/;
function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
function cellValid(type: ColumnType, cell: Cell, nullable: boolean): InputRefusal | null {
  if (cell === null) return nullable ? null : "input_value_invalid";
  const textual = (max: number): InputRefusal | null => {
    if (typeof cell !== "string" || codePoints(cell) > max || controls.test(cell))
      return "input_value_invalid";
    if (/[\ud800-\udfff]/.test(cell.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")))
      return "input_value_invalid";
    return forbiddenText(cell) ? "input_content_forbidden" : null;
  };
  const integer = (min: number, max: number) =>
    typeof cell === "number" && Number.isSafeInteger(cell) && cell >= min && cell <= max
      ? null
      : "input_value_invalid";
  const matches = (p: RegExp) =>
    typeof cell === "string" && p.test(cell) ? null : "input_value_invalid";
  switch (type) {
    case "id":
      return matches(/^[1-9][0-9]{0,19}$/);
    case "text":
      return textual(255);
    case "tags":
      return textual(2048);
    case "sku":
      return textual(64);
    case "status":
      return matches(/^(active|draft|archived)$/);
    case "count":
      return integer(0, 1_000_000_000);
    case "quantity":
      return integer(-1_000_000_000, 1_000_000_000);
    case "money":
      return matches(/^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$/);
    case "date":
      return matches(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/);
    case "timestamp":
      return matches(
        /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?Z$/,
      );
    case "currency":
      return matches(/^[A-Z]{3}$/);
    case "location_ref":
      return matches(/^L[1-9][0-9]{0,2}$/);
  }
}
const csvField = (cell: Cell): string => {
  if (cell === null) return "";
  const text = String(cell);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};
export interface RenderedInput {
  readonly name: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}
/**
 * Screens the job's script, checks every input cell against its kind's column and renders
 * each input as an RFC 4180 CSV file (header first) for /home/agent/input/<name>.csv. The
 * script goes into the guest as written, so it gets the same screen as a cell: a URL, a shop
 * domain, a workers.dev or R2 host, a signed-URL marker or an email address in it (a comment
 * or a string included) refuses the job before the ledger. The first refusal wins.
 */
export function renderJobInputs(
  job: RuntimeJob,
):
  | { readonly ok: true; readonly files: readonly RenderedInput[] }
  | { readonly ok: false; readonly code: InputRefusal } {
  if (forbiddenText(job.script))
    return Object.freeze({ ok: false, code: "input_content_forbidden" });
  const files: RenderedInput[] = [];
  let total = 0;
  for (const input of job.inputs) {
    const columns = extractKinds[input.kind];
    const lines = [columns.map((c) => c.name).join(",")];
    for (const row of input.rows) {
      for (let i = 0; i < columns.length; i++) {
        const column = columns[i]!;
        const refusal = cellValid(column.type, row[i] ?? null, column.nullable);
        if (refusal !== null) return Object.freeze({ ok: false, code: refusal });
      }
      lines.push(row.map(csvField).join(","));
    }
    const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
    total += bytes.length;
    if (total > runtimeJobLimits.inputBytesMax)
      return Object.freeze({ ok: false, code: "input_too_large" });
    files.push(
      Object.freeze({
        name: input.name,
        path: computerProfile.inputDirectory + "/" + input.name + ".csv",
        bytes,
      }),
    );
  }
  return Object.freeze({ ok: true, files: Object.freeze(files) });
}
export const outputPath = (output: RuntimeJobOutput): string =>
  computerProfile.outputDirectory + "/" + output.name + "." + output.type;

// ---------------------------------------------------------------------------
// Outputs: untrusted downloads, checked by content and size (ADR-0029 item 5).

export type OutputRejection =
  | "output_too_large"
  | "png_invalid"
  | "csv_invalid"
  | "xlsx_invalid"
  | "xlsx_macro"
  | "xlsx_link"
  | "xlsx_object";
export type OutputCheck =
  | { readonly outcome: "accepted"; readonly bytes: Uint8Array }
  | { readonly outcome: "rejected"; readonly code: OutputRejection };
const reject = (code: OutputRejection): OutputCheck => Object.freeze({ outcome: "rejected", code });
const accept = (bytes: Uint8Array): OutputCheck => Object.freeze({ outcome: "accepted", bytes });

/** Checks one output by its declared type; the accepted bytes are what may be served. */
export async function checkRuntimeOutput(
  type: RuntimeOutputType,
  bytes: Uint8Array,
): Promise<OutputCheck> {
  if (!(bytes instanceof Uint8Array) || bytes.length > runtimeJobLimits.outputBytesMax[type])
    return reject("output_too_large");
  try {
    if (type === "png") return checkPng(bytes);
    if (type === "csv") return checkCsv(bytes);
    return await checkXlsx(bytes);
  } catch {
    return reject(type === "png" ? "png_invalid" : type === "csv" ? "csv_invalid" : "xlsx_invalid");
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Ancillary chunks a still image may keep; text, time and EXIF chunks are dropped, so an
// accepted PNG carries no metadata. Any other chunk (APNG's animation chunks, private or
// unknown critical chunks) rejects the file.
const pngKept = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "bKGD",
  "pHYs",
]);
const pngDropped = new Set(["tEXt", "zTXt", "iTXt", "tIME", "eXIf"]);
const pngDepths: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
function checkPng(bytes: Uint8Array): OutputCheck {
  if (bytes.length < 8 + 25 + 12 || pngSignature.some((v, i) => bytes[i] !== v))
    return reject("png_invalid");
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  let index = 0;
  let idat = false;
  let ended = false;
  let palette = false;
  let colorType = -1;
  while (at < bytes.length) {
    if (ended || at + 12 > bytes.length) return reject("png_invalid");
    const length = u32(bytes, at);
    if (length > bytes.length - at - 12) return reject("png_invalid");
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) return reject("png_invalid");
    const end = at + 8 + length;
    if (crc32(bytes, at + 4, end) !== u32(bytes, end)) return reject("png_invalid");
    if (index === 0) {
      if (type !== "IHDR" || length !== 13) return reject("png_invalid");
      const width = u32(bytes, at + 8);
      const height = u32(bytes, at + 12);
      const depth = bytes[at + 16]!;
      colorType = bytes[at + 17]!;
      if (
        width < 1 ||
        height < 1 ||
        width > 10_000 ||
        height > 10_000 ||
        !(pngDepths[colorType] ?? []).includes(depth) ||
        bytes[at + 18] !== 0 ||
        bytes[at + 19] !== 0 ||
        bytes[at + 20]! > 1
      )
        return reject("png_invalid");
    } else if (type === "IHDR") return reject("png_invalid");
    if (type === "PLTE") palette = true;
    if (type === "IDAT") idat = true;
    if (type === "IEND") {
      if (length !== 0 || !idat) return reject("png_invalid");
      ended = true;
    }
    if (pngKept.has(type)) kept.push(bytes.subarray(at, end + 4));
    else if (!pngDropped.has(type)) return reject("png_invalid");
    at = end + 4;
    index++;
  }
  if (!ended || (colorType === 3 && !palette)) return reject("png_invalid");
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return accept(out);
}

// OWASP's CSV injection rule: a cell that starts with = + - @, a tab or a carriage return
// (or a full-width = + - @) is prefixed with an apostrophe, so no spreadsheet runs it as a
// formula; a plain number is left as it is.
const formulaStart = /^[=+\-@\t\r＝＋－＠]/;
const plainNumber = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
export const csvEscapeCell = (cell: string): string =>
  formulaStart.test(cell) && !plainNumber.test(cell) ? "'" + cell : cell;
function checkCsv(bytes: Uint8Array): OutputCheck {
  let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  if (text.includes("\u0000")) return reject("csv_invalid");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  let started = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    started = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    if (rows.length > 200_000) throw Error("csv_rows");
  };
  if (text.length === 0) return reject("csv_invalid");
  if (!text.endsWith("\n")) text += "\n";
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        if (i < text.length && !",\r\n".includes(text[i]!)) return reject("csv_invalid");
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (started || cell.length) return reject("csv_invalid");
      quoted = true;
      started = true;
      i++;
      continue;
    }
    if (c === ",") {
      endCell();
      if (row.length > 1024) return reject("csv_invalid");
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += c;
    started = true;
    i++;
  }
  if (quoted) return reject("csv_invalid");
  const out = rows
    .map((r) =>
      r
        .map((value) => {
          const escaped = csvEscapeCell(value);
          return /[",\r\n]/.test(escaped) ? '"' + escaped.replaceAll('"', '""') + '"' : escaped;
        })
        .join(","),
    )
    .join("\r\n");
  return accept(new TextEncoder().encode(out + "\r\n"));
}

// XLSX: an OOXML zip, read from its central directory and checked against each local
// header (no ZIP64, encryption, data descriptors' disagreement, path tricks or bombs, and no
// byte outside the listed entries: no prefix, gap or archive comment; zipEntries). The
// parts that would carry macros, objects or links reject it, and so does any macro content
// type. Every part is then read whatever its name: an image (PNG, JPEG or GIF by its magic
// bytes) or strict UTF-8 XML (readXmlPart), and in every XML part any external or
// macro, object or link relationship, any formula (cell, defined name, conditional format,
// validation, table, chart or pivot) naming a link or a remote function, and any hyperlink
// relationship reject it. Text a pattern could read differently from Excel (a character
// reference, CDATA, a comment, a DTD) rejects the part instead of being decoded.
const zipLimits = Object.freeze({
  entries: 2000,
  uncompressedTotal: 64 * 1024 * 1024,
  ratio: 200,
  partInflate: 32 * 1024 * 1024,
});
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32le = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly dataStart: number;
}
// Every byte of an accepted archive belongs to an entry the central directory lists: the
// first local header at offset 0, each next one where the previous entry's data (and its data
// descriptor) ends, the last ending where the directory starts, and no archive comment. A
// streaming reader that walks local headers therefore finds exactly the entries checked here,
// and each local header agrees with the directory on its flags, method, name and sizes.
function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  // No archive comment: the end record is the last 22 bytes.
  const eocd = bytes.length - 22;
  if (eocd < 0 || u32le(bytes, eocd) !== 0x06054b50 || u16le(bytes, eocd + 20) !== 0) return null;
  const count = u16le(bytes, eocd + 10);
  const cdSize = u32le(bytes, eocd + 12);
  const cdStart = u32le(bytes, eocd + 16);
  if (
    u16le(bytes, eocd + 4) !== 0 ||
    u16le(bytes, eocd + 6) !== 0 ||
    u16le(bytes, eocd + 8) !== count ||
    count === 0 ||
    count === 0xffff ||
    count > zipLimits.entries ||
    cdStart + cdSize !== eocd
  )
    return null;
  const entries: ZipEntry[] = [];
  const spans: { readonly start: number; readonly end: number }[] = [];
  const names = new Set<string>();
  let total = 0;
  let at = cdStart;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || u32le(bytes, at) !== 0x02014b50) return null;
    const flags = u16le(bytes, at + 8);
    const method = u16le(bytes, at + 10);
    const crc = u32le(bytes, at + 16);
    const compressedSize = u32le(bytes, at + 20);
    const size = u32le(bytes, at + 24);
    const nameLength = u16le(bytes, at + 28);
    const extraLength = u16le(bytes, at + 30);
    const commentLength = u16le(bytes, at + 32);
    const local = u32le(bytes, at + 42);
    if (at + 46 + nameLength + extraLength + commentLength > eocd) return null;
    const raw = bytes.subarray(at + 46, at + 46 + nameLength);
    if (!raw.every((b) => b >= 0x20 && b < 0x7f)) return null;
    const name = String.fromCharCode(...raw);
    if (
      flags & 0x1 ||
      flags & 0x40 ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      local === 0xffffffff ||
      name.length === 0 ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes(":") ||
      name.split("/").some((part) => part === ".." || part === ".") ||
      names.has(name.toLowerCase())
    )
      return null;
    names.add(name.toLowerCase());
    total += size;
    if (
      total > zipLimits.uncompressedTotal ||
      (size > 1024 * 1024 && size > compressedSize * zipLimits.ratio) ||
      (method === 0 && size !== compressedSize)
    )
      return null;
    if (local + 30 > cdStart || u32le(bytes, local) !== 0x04034b50) return null;
    const localNameLength = u16le(bytes, local + 26);
    const localExtraLength = u16le(bytes, local + 28);
    const localName = bytes.subarray(local + 30, local + 30 + localNameLength);
    // With a data descriptor (flag 0x08) the local CRC and sizes may be zero; otherwise, and
    // whenever they are given, they are the directory's.
    const described = (flags & 0x08) !== 0;
    const localCrc = u32le(bytes, local + 14);
    const localCompressed = u32le(bytes, local + 18);
    const localSize = u32le(bytes, local + 22);
    if (
      u16le(bytes, local + 6) !== flags ||
      u16le(bytes, local + 8) !== method ||
      localNameLength !== nameLength ||
      !localName.every((b, i) => b === raw[i]) ||
      !(
        (localCrc === crc && localCompressed === compressedSize && localSize === size) ||
        (described && localCrc === 0 && localCompressed === 0 && localSize === 0)
      )
    )
      return null;
    const dataStart = local + 30 + localNameLength + localExtraLength;
    let end = dataStart + compressedSize;
    if (end > cdStart) return null;
    if (described) {
      // The descriptor repeats the directory's CRC and sizes, with or without its signature.
      const agrees = (from: number) =>
        from + 12 <= cdStart &&
        u32le(bytes, from) === crc &&
        u32le(bytes, from + 4) === compressedSize &&
        u32le(bytes, from + 8) === size;
      if (u32le(bytes, end) === 0x08074b50 && agrees(end + 4)) end += 16;
      else if (agrees(end)) end += 12;
      else return null;
    }
    entries.push(Object.freeze({ name, method, compressedSize, size, dataStart }));
    spans.push(Object.freeze({ start: local, end }));
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== eocd) return null;
  // Contiguous in file order, from offset 0 to the directory: no prefix, gap or overlap.
  spans.sort((a, b) => a.start - b.start);
  let next = 0;
  for (const span of spans) {
    if (span.start !== next) return null;
    next = span.end;
  }
  return next === cdStart ? entries : null;
}
async function inflateBytes(
  bytes: Uint8Array,
  entry: ZipEntry,
  max: number,
): Promise<Uint8Array | null> {
  if (entry.size > max) return null;
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  const stream = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max || length > entry.size) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (length !== entry.size) return null;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
async function inflateText(
  bytes: Uint8Array,
  entry: ZipEntry,
  max: number,
): Promise<string | null> {
  const out = await inflateBytes(bytes, entry, max);
  if (out === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch {
    return null;
  }
}

// One XML part, read the way a strict parser reads it. Whatever such a parser could read
// differently from these patterns is refused rather than decoded: UTF-8 only (no NUL, no
// other declared encoding, XML 1.0), no DTD, entity declaration, comment, CDATA section or
// processing instruction after the declaration, only the five predefined entities and the
// tab, newline and carriage-return character references, well-formed tags with quoted and
// unique attributes, one root element, and no element inside a formula but another formula
// (x14's `formula1` wraps an `xm:f`; the outer text still counts). Names are matched on their
// local part whatever the prefix, so a renamed namespace prefix hides nothing.
const xmlSpace = "[ \\t\\r\\n]";
const xmlName = "[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?";
const xmlValue = `(?:"([^"<]*)"|'([^'<]*)')`;
const xmlStartTag = new RegExp(
  `<(${xmlName})((?:${xmlSpace}+${xmlName}${xmlSpace}*=${xmlSpace}*(?:"[^"<]*"|'[^'<]*'))*)${xmlSpace}*(/?)>`,
  "y",
);
const xmlAttribute = new RegExp(
  `${xmlSpace}+(${xmlName})${xmlSpace}*=${xmlSpace}*${xmlValue}`,
  "y",
);
const xmlEndTag = new RegExp(`</(${xmlName})${xmlSpace}*>`, "y");
const xmlDeclaration = new RegExp(
  `^<\\?xml((?:${xmlSpace}+[a-z]+${xmlSpace}*=${xmlSpace}*(?:"[^"]*"|'[^']*'))*)${xmlSpace}*\\?>`,
);
const xmlReferences = "amp|lt|gt|quot|apos|#x0*[9aAdD]|#0*(?:9|10|13)";
const xmlReference = new RegExp(`&(${xmlReferences});`, "g");
const xmlKnownReference = new RegExp(`&(?:${xmlReferences});`, "y");
const xmlReferencesKnown = (text: string): boolean => {
  for (let i = text.indexOf("&"); i >= 0; i = text.indexOf("&", i + 1)) {
    xmlKnownReference.lastIndex = i;
    if (!xmlKnownReference.test(text)) return false;
  }
  return true;
};
const xmlEntities: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});
const xmlDecode = (s: string): string =>
  s.replace(xmlReference, (_, ref: string) =>
    ref.startsWith("#x")
      ? String.fromCharCode(parseInt(ref.slice(2), 16))
      : ref.startsWith("#")
        ? String.fromCharCode(parseInt(ref.slice(1), 10))
        : xmlEntities[ref]!,
  );
const xmlLocal = (name: string): string => name.slice(name.indexOf(":") + 1).toLowerCase();
// The elements whose text is a formula: cells (`f`, and a chart's `c:f`), defined names,
// conditional formats (`formula`), validations (`formula1`, `formula2`) and table columns.
// A pivot's calculated field or item carries its formula in a `formula` attribute.
const xmlFormulaElements = new Set([
  "f",
  "definedname",
  "formula",
  "formula1",
  "formula2",
  "calculatedcolumnformula",
  "totalsrowformula",
]);
interface XmlRelationship {
  readonly targets: readonly string[];
  readonly modes: readonly string[];
  readonly types: readonly string[];
}
interface XmlPart {
  readonly formulas: readonly string[];
  readonly relationships: readonly XmlRelationship[];
  readonly hyperlinkRelationship: boolean;
}
/** The formulas, relationships and hyperlinks of one XML part, or null if unreadable. */
function readXmlPart(text: string): XmlPart | null {
  if (text.includes("\u0000") || !xmlReferencesKnown(text)) return null;
  let at = 0;
  const declaration = xmlDeclaration.exec(text);
  if (declaration) {
    const pseudo = declaration[1]!;
    const version = /version[ \t\r\n]*=[ \t\r\n]*["']([^"']*)["']/.exec(pseudo);
    const encoding = /encoding[ \t\r\n]*=[ \t\r\n]*["']([^"']*)["']/.exec(pseudo);
    if (version?.[1] !== "1.0" || (encoding && encoding[1]!.toLowerCase() !== "utf-8")) return null;
    at = declaration[0].length;
  }
  const formulas: string[] = [];
  const relationships: XmlRelationship[] = [];
  let hyperlinkRelationship = false;
  // Each open element, with its text so far when it is a formula element.
  const open: { readonly name: string; text: string | null }[] = [];
  let roots = 0;
  while (at < text.length) {
    const lt = text.indexOf("<", at);
    const next = lt < 0 ? text.length : lt;
    if (next > at) {
      const top = open.at(-1);
      if (top === undefined) {
        if (/[^ \t\r\n]/.test(text.slice(at, next))) return null;
      } else if (top.text !== null) top.text += text.slice(at, next);
      at = next;
      continue;
    }
    xmlStartTag.lastIndex = at;
    const start = xmlStartTag.exec(text);
    if (start) {
      const name = start[1]!;
      const local = xmlLocal(name);
      const formula = xmlFormulaElements.has(local);
      if ((open.at(-1)?.text != null && !formula) || (open.length === 0 && roots > 0)) return null;
      if (open.length === 0) roots++;
      // Attribute values are decoded only where they are checked.
      const relationship =
        local === "relationship"
          ? { targets: [] as string[], modes: [] as string[], types: [] as string[] }
          : null;
      const list = start[2]!;
      const names: string[] = [];
      xmlAttribute.lastIndex = 0;
      while (xmlAttribute.lastIndex < list.length) {
        const attribute = xmlAttribute.exec(list);
        if (!attribute || names.includes(attribute[1]!)) return null;
        const key = attribute[1]!;
        names.push(key);
        const keyLocal = xmlLocal(key);
        const raw = attribute[2] ?? attribute[3]!;
        if (keyLocal === "formula") formulas.push(xmlDecode(raw));
        else if (relationship !== null && keyLocal === "target")
          relationship.targets.push(xmlDecode(raw));
        else if (relationship !== null && keyLocal === "targetmode")
          relationship.modes.push(xmlDecode(raw));
        else if (relationship !== null && keyLocal === "type")
          relationship.types.push(xmlDecode(raw));
        else if (local === "hyperlink" && keyLocal === "id" && key.includes(":"))
          hyperlinkRelationship = true;
      }
      if (relationship !== null) relationships.push(Object.freeze(relationship));
      if (start[3] !== "/") open.push({ name, text: formula ? "" : null });
      at = xmlStartTag.lastIndex;
      continue;
    }
    xmlEndTag.lastIndex = at;
    const end = xmlEndTag.exec(text);
    if (end) {
      const closed = open.pop();
      if (closed === undefined || closed.name !== end[1]) return null;
      if (closed.text !== null) formulas.push(xmlDecode(closed.text));
      at = xmlEndTag.lastIndex;
      continue;
    }
    // A comment, CDATA section, DTD, processing instruction or broken tag.
    return null;
  }
  return open.length === 0 && roots === 1
    ? Object.freeze({ formulas, relationships, hyperlinkRelationship })
    : null;
}

const xlsxMacroParts = [
  /vbaproject/i,
  /^xl\/macrosheets\//i,
  /^xl\/dialogsheets\//i,
  /^customui/i,
  /\.bin$/i,
];
const xlsxObjectParts = [
  /^xl\/embeddings\//i,
  /^xl\/activex\//i,
  /oleobject/i,
  /^xl\/ctrlprops\//i,
  /\.vml$/i,
  /^xl\/webextensions\//i,
];
const xlsxLinkParts = [/^xl\/externallinks\//i, /^xl\/connections\.xml$/i, /^xl\/querytables\//i];
// Relationship types, by their URI, whatever the part they point at is called.
const xlsxMacroRelationship = /vbaproject|macrosheet|dialogsheet|ui\/extensibility|customui/i;
const xlsxObjectRelationship =
  /oleobject|\/package$|activexcontrol|\/control$|ctrlprop|webextension/i;
const xlsxLinkRelationship = /externallink|connections|querytable/i;
// An internal relationship names a part by a relative path: a scheme, a backslash (UNC) or a
// network path is a link wherever it appears.
const xlsxLinkTarget = (target: string) =>
  target.includes(":") || target.includes("\\") || /^[ \t\r\n]*\/\//.test(target);
// The only binary parts a workbook may carry: images, recognised by their magic bytes.
const xlsxMedia: readonly (readonly [RegExp, readonly number[]])[] = Object.freeze([
  [/\.png$/i, pngSignature],
  [/\.jpe?g$/i, [0xff, 0xd8, 0xff]],
  [/\.gif$/i, [0x47, 0x49, 0x46, 0x38]],
]);
// A formula that reaches outside the workbook: a link or remote function by name (with or
// without a prefix), the cloud functions that send cell contents out when the workbook
// recalculates (COPILOT, TRANSLATE, DETECTLANGUAGE, STOCKHISTORY, Python's PY), OLAP cube
// queries, an add-in's user-defined function (_xludf., _xldudf), an external reference ([)
// or DDE (|).
const remoteFormula =
  /\b(HYPERLINK|WEBSERVICE|FILTERXML|IMPORTDATA|IMPORTXML|IMPORTRANGE|IMPORTHTML|IMPORTFEED|IMAGE|RTD|CALL|REGISTER(\.ID)?|EXEC|EVALUATE|DDE|COPILOT|TRANSLATE|DETECTLANGUAGE|STOCKHISTORY|PY|CUBE[A-Z]*)\b|_xludf\.|_xldudf|\[|\|/i;
// Excel stores every function newer than Excel 2007 with an `_xlfn.` prefix (some also with
// `_xlws.`), and the cloud functions are among them. Such a name passes only when it is a pure,
// local calculation listed here, so a cloud function Excel adds later fails closed. Left out
// on purpose: WEBSERVICE, FILTERXML, ENCODEURL, IMAGE, STOCKHISTORY, FIELDVALUE, COPILOT,
// TRANSLATE, DETECTLANGUAGE and PY.
const xlsxPrefixedFunction = /_xl(?:fn|ws)\.((?:_xl(?:fn|ws)\.)*)([A-Za-z0-9_.]*)/gi;
const xlsxPureFunctions: ReadonlySet<string> = new Set(
  [
    // Excel 2010.
    "AGGREGATE BETA.DIST BETA.INV BINOM.DIST BINOM.INV CEILING.PRECISE CHISQ.DIST",
    "CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CONFIDENCE.NORM CONFIDENCE.T COVARIANCE.P",
    "COVARIANCE.S ERF.PRECISE ERFC.PRECISE EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST",
    "FLOOR.PRECISE GAMMA.DIST GAMMA.INV GAMMALN.PRECISE HYPGEOM.DIST ISO.CEILING LOGNORM.DIST",
    "LOGNORM.INV MODE.MULT MODE.SNGL NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV",
    "NORM.S.DIST NORM.S.INV PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC",
    "POISSON.DIST QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ STDEV.P STDEV.S T.DIST T.DIST.2T",
    "T.DIST.RT T.INV T.INV.2T T.TEST VAR.P VAR.S WEIBULL.DIST WORKDAY.INTL Z.TEST",
    // Excel 2013.
    "ACOT ACOTH ARABIC BASE BINOM.DIST.RANGE BITAND BITLSHIFT BITOR BITRSHIFT BITXOR",
    "CEILING.MATH COMBINA COT COTH CSC CSCH DAYS DECIMAL ECMA.CEILING FLOOR.MATH FORMULATEXT",
    "GAMMA GAUSS IFNA IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOWEEKNUM",
    "MUNIT NUMBERVALUE PDURATION PERMUTATIONA PHI RRI SEC SECH SHEET SHEETS SKEW.P UNICHAR",
    "UNICODE XOR",
    // Excel 2016 and 2019.
    "CONCAT FORECAST.ETS FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT",
    "FORECAST.LINEAR IFS MAXIFS MINIFS SWITCH TEXTJOIN",
    // Dynamic arrays, LET and LAMBDA, and the text, array and regular-expression functions.
    "ANCHORARRAY SINGLE FILTER RANDARRAY SEQUENCE SORT SORTBY UNIQUE XLOOKUP XMATCH LET LAMBDA",
    "MAP REDUCE SCAN MAKEARRAY BYROW BYCOL ISOMITTED CHOOSECOLS CHOOSEROWS DROP TAKE EXPAND",
    "HSTACK VSTACK TOCOL TOROW WRAPCOLS WRAPROWS TEXTBEFORE TEXTAFTER TEXTSPLIT VALUETOTEXT",
    "ARRAYTOTEXT REGEXTEST REGEXEXTRACT REGEXREPLACE GROUPBY PIVOTBY PERCENTOF TRIMRANGE",
  ]
    .join(" ")
    .split(" "),
);
function formulaReachesOut(formula: string): boolean {
  if (remoteFormula.test(formula)) return true;
  for (const match of formula.matchAll(xlsxPrefixedFunction))
    if (!xlsxPureFunctions.has(match[2]!.toUpperCase())) return true;
  return false;
}
async function checkXlsx(bytes: Uint8Array): Promise<OutputCheck> {
  const entries = zipEntries(bytes);
  if (entries === null) return reject("xlsx_invalid");
  const named = new Map(entries.map((e) => [e.name, e]));
  for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"])
    if (!named.has(required)) return reject("xlsx_invalid");
  for (const entry of entries) {
    if (xlsxMacroParts.some((p) => p.test(entry.name))) return reject("xlsx_macro");
    if (xlsxObjectParts.some((p) => p.test(entry.name))) return reject("xlsx_object");
    if (xlsxLinkParts.some((p) => p.test(entry.name))) return reject("xlsx_link");
  }
  const typesText = await inflateText(bytes, named.get("[Content_Types].xml")!, 1024 * 1024);
  if (typesText === null || readXmlPart(typesText) === null) return reject("xlsx_invalid");
  const types = xmlDecode(typesText);
  if (/macroenabled|vbaproject|ms-office\.vba|activex/i.test(types)) return reject("xlsx_macro");
  if (/oleobject|vnd\.ms-excel\.controlproperties/i.test(types)) return reject("xlsx_object");
  if (/externallink|connections\+xml/i.test(types)) return reject("xlsx_link");
  for (const entry of entries) {
    if (entry.name === "[Content_Types].xml") continue;
    const media = xlsxMedia.find(([p]) => p.test(entry.name));
    if (media) {
      const data = await inflateBytes(bytes, entry, zipLimits.partInflate);
      if (data === null || !media[1].every((v, i) => data[i] === v)) return reject("xlsx_invalid");
      continue;
    }
    const text = await inflateText(bytes, entry, zipLimits.partInflate);
    const part = text === null ? null : readXmlPart(text);
    if (part === null) return reject("xlsx_invalid");
    for (const relationship of part.relationships) {
      if (relationship.types.some((t) => xlsxMacroRelationship.test(t)))
        return reject("xlsx_macro");
      if (relationship.types.some((t) => xlsxObjectRelationship.test(t)))
        return reject("xlsx_object");
      if (
        relationship.types.some((t) => xlsxLinkRelationship.test(t)) ||
        relationship.modes.some((m) => m !== "Internal") ||
        relationship.targets.some(xlsxLinkTarget)
      )
        return reject("xlsx_link");
    }
    if (part.formulas.some(formulaReachesOut)) return reject("xlsx_link");
    if (part.hyperlinkRelationship) return reject("xlsx_link");
  }
  return accept(bytes);
}
