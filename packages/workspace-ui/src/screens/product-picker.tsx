// v1 PR 4: the product picker on Ask. Instead of typing product numbers, a person searches the
// chosen store's products, or shows one collection's, and adds them to the request's list.
// Every page is one read of M2 PR-3's catalogue routes: the server checks the session, the
// store's current link to this workspace and the product read rule on the store resource
// before the broker reads Shopify, and answers ids, titles and status only. Titles are store
// content: they are shown as plain text, never as markup. The search is letters, digits and
// single spaces (the server builds Shopify's search syntax itself); anything else is refused
// here before any request, as the server would refuse it.
import { useId, useState } from "react";
import { copy } from "../copy";
import type { CatalogCollectionView, CatalogProductView, Id } from "../model";
import { useRead, useServices } from "../services";
import { Button, TextField } from "../components/controls";
import { RecordText } from "../components/display";
import { outcomeState } from "../components/feedback";

const searchPattern = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+){0,4}$/u;
/**
 * The search as the catalogue route takes it: trimmed, inner runs of spaces made one, at most
 * 64 characters and five words of letters and digits. "" is no search; null is refused.
 */
export function normaliseSearch(value: string): string | null {
  const text = value.trim().replace(/\s+/gu, " ");
  if (text === "") return "";
  return [...text].length <= 64 && searchPattern.test(text) ? text : null;
}
const productNumber = (id: string) => /^product:([1-9][0-9]{0,19})$/.exec(id)?.[1] ?? null;
const lineNumber = (line: string) => /^(?:product:)?([1-9][0-9]{0,19})$/.exec(line.trim())?.[1];
/** The request's product list with `id` added as its number (once; the list is one per line). */
export function withProduct(text: string, id: string): string {
  const n = productNumber(id);
  if (n === null) return text;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.some((l) => lineNumber(l) === n)) return text;
  return [...lines, n].join("\n");
}
/** The product ids (product:<number>) of the list's well-formed lines, in order, once each. */
export function listedProducts(text: string): readonly string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const n = lineNumber(line);
    if (n !== undefined && !out.includes("product:" + n)) out.push("product:" + n);
  }
  return out;
}
/** The list without `id`, whether it was typed as a number or as product:<number>. */
export function withoutProduct(text: string, id: string): string {
  const n = productNumber(id);
  if (n === null) return text;
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && lineNumber(l) !== n)
    .join("\n");
}

type Query = { readonly search: string | null; readonly collectionId: string | null };

function PickerPage({
  ws,
  storeId,
  query,
  after,
  last,
  picked,
  full,
  disabled,
  onToggle,
  onMore,
}: {
  readonly ws: Id;
  readonly storeId: Id;
  readonly query: Query;
  readonly after: string | null;
  readonly last: boolean;
  readonly picked: readonly string[];
  readonly full: boolean;
  readonly disabled: boolean;
  readonly onToggle: (product: CatalogProductView, add: boolean) => void;
  readonly onMore: (cursor: string) => void;
}) {
  const services = useServices();
  const [page, reload] = useRead(
    `${ws}|picker|${storeId}|${query.collectionId ?? ""}|${query.search ?? ""}|${after ?? ""}`,
    () =>
      services.port.catalog.products(ws, storeId, {
        after,
        collectionId: query.collectionId,
        query: query.search,
      }),
  );
  if (page.kind !== "ok") return <li className="item">{outcomeState(page, reload)}</li>;
  const items = page.value.items;
  return (
    <>
      {after === null && items.length === 0 ? (
        <li className="item">
          <p className="muted">{copy.ask.pickerEmpty}</p>
        </li>
      ) : null}
      {items.map((p) => {
        const checked = picked.includes(p.id);
        return (
          <li key={p.id} className="item">
            <label className="check">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || (full && !checked)}
                aria-label={copy.ask.pickerAdd(p.title)}
                onChange={(e) => onToggle(p, e.target.checked)}
              />
              <RecordText>{p.title}</RecordText>
            </label>
            <p className="meta">
              <span>{copy.ask.pickerStatus(p.status)}</span>
              <RecordText>{p.id}</RecordText>
            </p>
          </li>
        );
      })}
      {last && page.value.nextCursor !== null ? (
        <li className="item">
          <Button disabled={disabled} onClick={() => onMore(page.value.nextCursor!)}>
            {copy.ask.pickerMore}
          </Button>
        </li>
      ) : null}
    </>
  );
}

export function ProductPicker({
  ws,
  storeId,
  picked,
  full,
  disabled,
  onToggle,
}: {
  readonly ws: Id;
  readonly storeId: Id;
  /** The product ids (product:<number>) already in the request's list. */
  readonly picked: readonly string[];
  /** The list holds 25 products: nothing more can be added. */
  readonly full: boolean;
  readonly disabled: boolean;
  readonly onToggle: (product: CatalogProductView, add: boolean) => void;
}) {
  const services = useServices();
  const ids = { collection: useId(), list: useId() };
  const [search, setSearch] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [checked, setChecked] = useState(false);
  const [query, setQuery] = useState<Query | null>(null);
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [collections, reloadCollections] = useRead<{
    readonly items: readonly CatalogCollectionView[];
    readonly nextCursor: string | null;
  }>(services.composed["catalog.collections"] ? `${ws}|picker-collections|${storeId}` : null, () =>
    services.port.catalog.collections(ws, storeId, null),
  );
  if (!services.composed["catalog.products"]) return null;
  const normalised = normaliseSearch(search);
  const show = () => {
    setChecked(true);
    if (normalised === null) return;
    setCursors([null]);
    setQuery({
      search: collectionId === "" && normalised !== "" ? normalised : null,
      collectionId: collectionId === "" ? null : collectionId,
    });
  };
  return (
    <fieldset className="field" aria-describedby={ids.list} data-testid="ask-picker">
      <legend>{copy.ask.picker}</legend>
      <small id={ids.list}>{copy.ask.pickerIntro}</small>
      <TextField
        label={copy.ask.pickerSearch}
        value={search}
        onChange={(value) => {
          setSearch(value);
          if (value.trim() !== "") setCollectionId("");
        }}
        hint={copy.ask.pickerSearchHint}
        error={checked && normalised === null ? copy.ask.pickerSearchInvalid : null}
        disabled={disabled}
        maxLength={128}
      />
      {services.composed["catalog.collections"] ? (
        <div className="field">
          <label htmlFor={ids.collection}>{copy.ask.pickerCollection}</label>
          {collections.kind === "ok" ? (
            <select
              id={ids.collection}
              value={collectionId}
              disabled={disabled}
              onChange={(e) => {
                setCollectionId(e.target.value);
                if (e.target.value !== "") setSearch("");
              }}
            >
              <option value="">{copy.ask.pickerAllProducts}</option>
              {collections.value.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          ) : (
            outcomeState(collections, reloadCollections)
          )}
        </div>
      ) : null}
      <div className="form-actions">
        <Button disabled={disabled} onClick={show}>
          {copy.ask.pickerShow}
        </Button>
      </div>
      {full ? <p className="muted">{copy.ask.pickerFull}</p> : null}
      {query !== null ? (
        <ul className="item-list" data-testid="ask-picker-products">
          {cursors.map((after, i) => (
            <PickerPage
              key={after ?? ""}
              ws={ws}
              storeId={storeId}
              query={query}
              after={after}
              last={i === cursors.length - 1}
              picked={picked}
              full={full}
              disabled={disabled}
              onToggle={onToggle}
              onMore={(cursor) => setCursors((list) => [...list, cursor])}
            />
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
