// Synthetic output files for the runtime tests (build order PR 7): a minimal PNG and a
// minimal XLSX (OOXML zip) built in-process, with switches for each thing the broker's output
// checks must refuse. Nothing here is read from disk or the network.
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.from(type, "latin1");
  return Buffer.concat([u32be(data.length), head, data, u32be(crc32(Buffer.concat([head, data])))]);
}
/** A valid width x height 8-bit RGB PNG, plus optional extra chunks before IEND. */
export function makePng({
  width = 2,
  height = 2,
  extra = [],
  ihdr = null,
  crcBreak = false,
  trailing = null,
} = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = [];
  for (let y = 0; y < height; y++)
    rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]));
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr ?? header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    ...extra.map(([type, data]) => chunk(type, Buffer.from(data))),
    chunk("IEND"),
  ];
  const png = Buffer.concat(parts);
  if (crcBreak) png[png.length - 20] ^= 0xff;
  return new Uint8Array(trailing ? Buffer.concat([png, Buffer.from(trailing)]) : png);
}

const u16le = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
/** A zip of [name, text|bytes] entries (deflated), with switches for malformed archives. */
export function makeZip(
  entries,
  { flags = 0, stored = false, trailing = null, zip64 = false, localNameOf = null } = {},
) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = stored ? data : deflateRawSync(data);
    const method = stored ? 0 : 8;
    const nameBytes = Buffer.from(name, "latin1");
    const localName = Buffer.from(localNameOf ? localNameOf(name) : name, "latin1");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32le(0x04034b50),
      u16le(20),
      u16le(flags),
      u16le(method),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(packed.length),
      u32le(data.length),
      u16le(localName.length),
      u16le(0),
      localName,
      packed,
    ]);
    centrals.push(
      Buffer.concat([
        u32le(0x02014b50),
        u16le(20),
        u16le(20),
        u16le(flags),
        u16le(method),
        u16le(0),
        u16le(0),
        u32le(crc),
        u32le(zip64 ? 0xffffffff : packed.length),
        u32le(data.length),
        u16le(nameBytes.length),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(offset),
        nameBytes,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(central.length),
    u32le(offset),
    u16le(0),
  ]);
  const zip = Buffer.concat([...locals, central, end]);
  return new Uint8Array(trailing ? Buffer.concat([zip, Buffer.from(trailing)]) : zip);
}

const contentTypes = (extra = "") =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  extra +
  "</Types>";
const rootRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const workbook = (names = "") =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
  names +
  "</workbook>";
const workbookRels = (extra = "") =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  extra +
  "</Relationships>";
const sheet = (cells) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  cells +
  "</sheetData></worksheet>";
/**
 * A minimal workbook. Options add what the checks refuse: a macro part or content type, an
 * external link part or relationship, a remote formula, an embedded object, a hyperlink.
 */
export function makeXlsx({
  cells = '<row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1"><v>3</v></c><c r="C1"><f>SUM(B1:B1)</f><v>3</v></c></row>',
  types = "",
  rels = "",
  names = "",
  parts = [],
  drop = [],
  options = {},
} = {}) {
  const entries = [
    ["[Content_Types].xml", contentTypes(types)],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbook(names)],
    ["xl/_rels/workbook.xml.rels", workbookRels(rels)],
    ["xl/worksheets/sheet1.xml", sheet(cells)],
    ...parts,
  ].filter(([name]) => !drop.includes(name));
  return makeZip(entries, options);
}
