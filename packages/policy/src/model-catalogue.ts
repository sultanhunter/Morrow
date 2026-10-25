// The model catalogue rules (ADR-0022 items 10, 11 and 16; mvp-architecture §9). Pure:
// no I/O, clock or randomness. The data is generated from docs/decisions/model-policy.json
// (scripts/generate-model-catalogue.mjs); keys stay opaque strings checked against a
// catalogue version, never contract enums. Money is an exact bigint count of 10^-8 USD.
//
// - A client sends only `{model, effort}` keys (ModelSelection@1). A provider model string,
//   an unknown key, a retired version or an entry above the member's ceiling is refused
//   before any run exists; a missing selection means the workspace default.
// - A member without governance.model_default.revise may pick only entries whose credits
//   per product are at most the workspace ceiling (by default the default selection's
//   credits: 4 for Opus 5.5 at medium since version 3, ADR-0036); holders may pick any entry,
//   since they could raise the ceiling.
// - No unrecovered-cost cap (ADR-0036): the per-run and per-day caps are the USD limits.
// - A run is booked at its own recorded catalogue version, even after a newer one is active.
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { generatedModelCatalogue } from "./generated/model-catalogue";

export type CatalogueStatus = "active" | "retired" | "proposed";
export interface ModelSelectionKeys {
  readonly model: string;
  readonly effort: string;
}
/** One selection of one catalogue version, as the api's checks and the broker see it. */
export interface CatalogueEntry {
  readonly catalogueVersion: number;
  readonly status: CatalogueStatus;
  readonly model: string;
  readonly effort: string;
  readonly creditsPerProduct: number;
  /** The worst case of one product: every attempt at the input cap and the effort's max_tokens. */
  readonly worstCasePerProductUsd8: bigint;
  /** The worst case of one attempt, booked for an `uncertain` outcome (ADR-0022 item 10). */
  readonly worstCasePerAttemptUsd8: bigint;
  /** min(maxProductsPerRun, floor(runCostCap / worstCasePerProduct)). */
  readonly runProductLimit: number;
  readonly maxOutputTokens: number;
  readonly inputUsd8PerToken: bigint;
  readonly outputUsd8PerToken: bigint;
}
/** The listing a member sees: no provider, provider model ID, rate or cost. */
export interface CatalogueListingEntry {
  readonly model: string;
  readonly effort: string;
  readonly creditsPerProduct: number;
  readonly runProductLimit: number;
}
export interface CatalogueLimits {
  readonly maxInputTokensPerCall: number;
  readonly maxAttemptsPerProduct: number;
  readonly maxProductsPerRun: number;
  readonly maxConsecutiveFailedProducts: number;
  readonly runCostCapUsd8: bigint;
  readonly workspaceDailyCostCapUsd8: bigint;
}
export type SelectionRefusal =
  /** Not a ModelSelection@1 (a provider model string, an extra field, a non-key). */
  | "selection_invalid"
  /** Well-formed keys that the version does not list (xhigh, an unknown model). */
  | "selection_unknown"
  /** No version is active. */
  | "catalogue_version_inactive"
  /** Above the member ceiling, for a member without governance.model_default.revise. */
  | "selection_above_ceiling";
export type SelectionResult =
  | { readonly ok: true; readonly entry: CatalogueEntry; readonly defaulted: boolean }
  | { readonly ok: false; readonly code: SelectionRefusal };
export type WorkspaceDefaultResult =
  | { readonly ok: true; readonly entry: CatalogueEntry }
  | {
      readonly ok: false;
      readonly code: SelectionRefusal | "ceiling_below_default" | "ceiling_invalid";
    };

export class ModelCatalogueError extends Error {
  constructor(readonly code: "MODEL_CATALOGUE_INPUT_INVALID") {
    super(code);
    this.name = "ModelCatalogueError";
  }
}

/** One generated version (scripts/generate-model-catalogue.mjs catalogueVersionData). */
export interface ModelCatalogueVersionData {
  readonly version: number;
  readonly status: string;
  readonly digest: string;
  readonly effectiveFrom: string | null;
  readonly defaultSelection: ModelSelectionKeys;
  readonly defaultMemberCreditCeiling: number;
  readonly limits: {
    readonly maxInputTokensPerCall: number;
    readonly maxAttemptsPerProduct: number;
    readonly maxProductsPerRun: number;
    readonly maxConsecutiveFailedProducts: number;
    readonly runCostCapUsd8: number;
    readonly workspaceDailyCostCapUsd8: number;
  };
  readonly efforts: readonly { readonly key: string; readonly maxOutputTokens: number }[];
  readonly models: readonly {
    readonly key: string;
    readonly provider: string;
    readonly providerModelId: string;
    readonly inputUsd8PerToken: number;
    readonly outputUsd8PerToken: number;
    readonly creditsPerProduct: Readonly<Record<string, number>>;
  }[];
}
/** The generated catalogue's shape. */
export interface ModelCatalogueData {
  readonly id: string;
  readonly activeVersion: number | null;
  readonly versions: readonly ModelCatalogueVersionData[];
}

const invalid = () => new ModelCatalogueError("MODEL_CATALOGUE_INPUT_INVALID");

/** Whether a member may pick an entry: holders of the revise capability always may. */
export function memberMayPick(
  creditsPerProduct: number,
  ceiling: number,
  holdsRevise: boolean,
): boolean {
  if (
    !Number.isSafeInteger(creditsPerProduct) ||
    creditsPerProduct < 1 ||
    !Number.isSafeInteger(ceiling) ||
    ceiling < 1 ||
    typeof holdsRevise !== "boolean"
  )
    throw invalid();
  return holdsRevise || creditsPerProduct <= ceiling;
}

function limitsOf(v: ModelCatalogueVersionData): CatalogueLimits {
  return Object.freeze({
    maxInputTokensPerCall: v.limits.maxInputTokensPerCall,
    maxAttemptsPerProduct: v.limits.maxAttemptsPerProduct,
    maxProductsPerRun: v.limits.maxProductsPerRun,
    maxConsecutiveFailedProducts: v.limits.maxConsecutiveFailedProducts,
    runCostCapUsd8: BigInt(v.limits.runCostCapUsd8),
    workspaceDailyCostCapUsd8: BigInt(v.limits.workspaceDailyCostCapUsd8),
  });
}

function entryOf(
  v: ModelCatalogueVersionData,
  model: string,
  effort: string,
): CatalogueEntry | null {
  const m = v.models.find((x) => x.key === model);
  const e = v.efforts.find((x) => x.key === effort);
  if (!m || !e || !Object.hasOwn(m.creditsPerProduct, effort)) return null;
  const credits = m.creditsPerProduct[effort]!;
  const input = BigInt(m.inputUsd8PerToken);
  const output = BigInt(m.outputUsd8PerToken);
  const attempt =
    BigInt(v.limits.maxInputTokensPerCall) * input + BigInt(e.maxOutputTokens) * output;
  const product = BigInt(v.limits.maxAttemptsPerProduct) * attempt;
  const most = BigInt(v.limits.maxProductsPerRun);
  const fit = product === 0n ? most : BigInt(v.limits.runCostCapUsd8) / product;
  return Object.freeze({
    catalogueVersion: v.version,
    status: v.status as CatalogueStatus,
    model,
    effort,
    creditsPerProduct: credits,
    worstCasePerProductUsd8: product,
    worstCasePerAttemptUsd8: attempt,
    runProductLimit: Number(fit < most ? fit : most),
    maxOutputTokens: e.maxOutputTokens,
    inputUsd8PerToken: input,
    outputUsd8PerToken: output,
  });
}

/**
 * The rules over one catalogue: the generated one (the exports below) or, in tests, a
 * synthetic later version built with the same generator.
 */
export function createModelCatalogue(data: ModelCatalogueData) {
  const versions = data.versions;
  const versionData = (version: number) => versions.find((v) => v.version === version) ?? null;
  const published = (version: number) => {
    const v = Number.isSafeInteger(version) ? versionData(version) : null;
    return v && v.status !== "proposed" ? v : null;
  };
  const activeVersion = (): ModelCatalogueVersionData | null => {
    const active = data.activeVersion;
    const v = typeof active === "number" ? versionData(active) : null;
    return v && v.status === "active" ? v : null;
  };
  const findEntry = (version: number, model: string, effort: string) => {
    if (typeof model !== "string" || typeof effort !== "string") return null;
    const v = published(version);
    return v ? entryOf(v, model, effort) : null;
  };
  function resolveSelection(input: {
    readonly selection: unknown;
    readonly workspaceDefault: ModelSelectionKeys | null;
    readonly ceiling: number;
    readonly holdsRevise: boolean;
  }): SelectionResult {
    const v = activeVersion();
    if (!v) return Object.freeze({ ok: false, code: "catalogue_version_inactive" });
    let keys: ModelSelectionKeys;
    let defaulted = false;
    if (input.selection === null || input.selection === undefined) {
      defaulted = true;
      const stored = input.workspaceDefault;
      keys =
        stored && entryOf(v, stored.model, stored.effort)
          ? stored
          : { model: v.defaultSelection.model, effort: v.defaultSelection.effort };
    } else {
      if (!validateCurrentDefinition("ModelSelection", input.selection))
        return Object.freeze({ ok: false, code: "selection_invalid" });
      keys = input.selection as ModelSelectionKeys;
    }
    const entry = entryOf(v, keys.model, keys.effort);
    if (!entry) return Object.freeze({ ok: false, code: "selection_unknown" });
    if (!memberMayPick(entry.creditsPerProduct, input.ceiling, input.holdsRevise))
      return Object.freeze({ ok: false, code: "selection_above_ceiling" });
    return Object.freeze({ ok: true, entry, defaulted });
  }
  return Object.freeze({
    /** The active catalogue version, or null when none is active (nothing is selectable). */
    activeCatalogueVersion: (): number | null => activeVersion()?.version ?? null,
    /** The pinned digest of a published version (the run manifest records it). */
    catalogueVersionDigest: (version: number): string | null => published(version)?.digest ?? null,
    /** The limits of a published version, active or retired (a run is booked at its own). */
    catalogueLimits: (version: number): CatalogueLimits | null => {
      const v = published(version);
      return v ? limitsOf(v) : null;
    },
    /**
     * One entry of a published version, active or retired, for booking a run at its
     * recorded version. Null for an unknown or proposed version or keys it does not list.
     */
    findCatalogueEntry: findEntry,
    /** findCatalogueEntry, throwing MODEL_CATALOGUE_INPUT_INVALID for no entry. */
    catalogueEntry(version: number, model: string, effort: string): CatalogueEntry {
      const entry = findEntry(version, model, effort);
      if (!entry) throw invalid();
      return entry;
    },
    /** The default selection of the active version. */
    defaultSelection(): ModelSelectionKeys | null {
      const v = activeVersion();
      return v
        ? Object.freeze({ model: v.defaultSelection.model, effort: v.defaultSelection.effort })
        : null;
    },
    /** The default member ceiling of the active version (1 in version 1, 4 in version 3). */
    defaultMemberCreditCeiling: (): number | null =>
      activeVersion()?.defaultMemberCreditCeiling ?? null,
    /**
     * Resolves a requested selection against the active version. `selection` is the
     * client's value, or null/undefined for "the workspace default"; `workspaceDefault` is
     * the stored default (null for the catalogue default). A stored default that is not an
     * entry of the active version falls back to the catalogue default. The ceiling applies
     * to every choice of a non-holder, defaults included.
     */
    resolveSelection,
    /**
     * A workspace default and ceiling set by a holder of governance.model_default.revise:
     * the keys are an entry of the active version, and the ceiling admits that default (a
     * ceiling below it would refuse every member's default).
     */
    checkWorkspaceDefault(selection: unknown, ceiling: unknown): WorkspaceDefaultResult {
      if (!validateCurrentDefinition("CreditsPerProductCeiling", ceiling))
        return Object.freeze({ ok: false, code: "ceiling_invalid" });
      const resolved = resolveSelection({
        selection,
        workspaceDefault: null,
        ceiling: 99,
        holdsRevise: true,
      });
      if (!resolved.ok) return resolved;
      if (resolved.entry.creditsPerProduct > (ceiling as number))
        return Object.freeze({ ok: false, code: "ceiling_below_default" });
      return Object.freeze({ ok: true, entry: resolved.entry });
    },
    /** The active version's entries for GET /models: keys, credits and run limits only. */
    catalogueListing(): {
      readonly catalogueVersion: number;
      readonly entries: readonly CatalogueListingEntry[];
    } | null {
      const v = activeVersion();
      if (!v) return null;
      const entries: CatalogueListingEntry[] = [];
      for (const m of v.models)
        for (const e of v.efforts) {
          const entry = entryOf(v, m.key, e.key);
          if (entry)
            entries.push(
              Object.freeze({
                model: entry.model,
                effort: entry.effort,
                creditsPerProduct: entry.creditsPerProduct,
                runProductLimit: entry.runProductLimit,
              }),
            );
        }
      return Object.freeze({ catalogueVersion: v.version, entries: Object.freeze(entries) });
    },
  });
}

const generated = createModelCatalogue(generatedModelCatalogue);
export const {
  activeCatalogueVersion,
  catalogueVersionDigest,
  catalogueLimits,
  findCatalogueEntry,
  catalogueEntry,
  defaultSelection,
  defaultMemberCreditCeiling,
  resolveSelection,
  checkWorkspaceDefault,
  catalogueListing,
} = generated;
