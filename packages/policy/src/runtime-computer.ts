// The computer (ADR-0029 items 1, 4, 5 and 8; build order PR 7): the profile
// `morrow.computer` v1, the closed job a caller may ask the broker to run, the minimised
// inputs it may carry, the only outputs it may bring back, and the runtime caps. Pure: no
// I/O, clock or randomness; the broker's runtime gateway (apps/broker/src/runtime-gateway.ts)
// and its conformance suite use it, and migration 0039 holds the same caps in SQL
// (drift-tested by tests/runtime-computer.test.mjs).
//
// Inside the sandbox there is no internet, no credential, no Morrow or provider URL and no
// browser. A job is fixed Python run by the profile's own command as the non-root user
// `agent`; nothing a caller sends chooses the command, the user, the environment, the
// network, the template or a limit. Its inputs are closed extract kinds with fixed column
// allowlists (never a customer field or id, an order id, the shop's domain or any URL), and
// its outputs are only PNG, CSV (formula cells escaped) and XLSX (no macros, links or
// objects), checked by content and size and returned as untrusted downloads.

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
 * every create (migration 0039, morrow_vault.runtime_operation_begin): a monthly budget
 * below E2B's US$20 usage limit, half of Hobby's 20 concurrent sandboxes, and three open
 * sandboxes per workspace. At a cap the caller's TypeScript fallback runs; cleanup is never
 * blocked.
 */
export const runtimeCaps = Object.freeze({
  monthlyBudgetUsd: "10.00",
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
// header (no ZIP64, encryption, data descriptors' disagreement, path tricks or bombs). The
// parts that would carry macros, objects or links reject it, and so does any external
// relationship, macro content type, or formula naming a link or a remote function.
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
function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--)
    if (u32le(bytes, at) === 0x06054b50 && at + 22 + u16le(bytes, at + 20) === bytes.length) {
      eocd = at;
      break;
    }
  if (eocd < 0) return null;
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
  const names = new Set<string>();
  let total = 0;
  let at = cdStart;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || u32le(bytes, at) !== 0x02014b50) return null;
    const flags = u16le(bytes, at + 8);
    const method = u16le(bytes, at + 10);
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
    if (
      u16le(bytes, local + 8) !== method ||
      localNameLength !== nameLength ||
      !localName.every((b, i) => b === raw[i])
    )
      return null;
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > cdStart) return null;
    entries.push(Object.freeze({ name, method, compressedSize, size, dataStart }));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return at === eocd ? entries : null;
}
async function inflatePart(
  bytes: Uint8Array,
  entry: ZipEntry,
  max: number,
): Promise<string | null> {
  if (entry.size > max) return null;
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) out = data;
  else {
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
    out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch {
    return null;
  }
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
];
const xlsxLinkParts = [/^xl\/externallinks\//i, /^xl\/connections\.xml$/i, /^xl\/querytables\//i];
const remoteFormula =
  /\b(HYPERLINK|WEBSERVICE|FILTERXML|IMPORTDATA|IMPORTXML|IMPORTRANGE|IMPORTHTML|IMPORTFEED|RTD|CALL|REGISTER(\.ID)?|EXEC|DDE)\b|\[|\|/i;
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
  const types = await inflatePart(bytes, named.get("[Content_Types].xml")!, 1024 * 1024);
  if (types === null) return reject("xlsx_invalid");
  if (/macroenabled|vbaproject|ms-office\.vba|activex/i.test(types)) return reject("xlsx_macro");
  if (/oleobject|vnd\.ms-excel\.controlproperties/i.test(types)) return reject("xlsx_object");
  if (/externallink|connections\+xml/i.test(types)) return reject("xlsx_link");
  for (const entry of entries) {
    const rels = /\.rels$/i.test(entry.name);
    const sheet = /^xl\/(worksheets\/sheet[0-9]+|workbook)\.xml$/i.test(entry.name);
    if (!rels && !sheet) continue;
    const text = await inflatePart(bytes, entry, rels ? 1024 * 1024 : zipLimits.partInflate);
    if (text === null) return reject("xlsx_invalid");
    if (rels) {
      if (
        /TargetMode\s*=\s*["']External["']/i.test(text) ||
        /Target\s*=\s*["'][a-z][a-z0-9+.-]*:/i.test(text)
      )
        return reject("xlsx_link");
      continue;
    }
    for (const match of text.matchAll(/<(f|definedName)\b[^>]*>([^<]*)<\/\1>/gi))
      if (remoteFormula.test(match[2]!.replaceAll("&amp;", "&"))) return reject("xlsx_link");
    if (/<hyperlink\b[^>]*\br:id=/i.test(text)) return reject("xlsx_link");
  }
  return accept(bytes);
}
