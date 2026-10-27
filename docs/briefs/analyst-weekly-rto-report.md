# The Business Analyst's weekly COD and RTO report

- Status: brief, 2026-10-27. No branch yet. A launch deliverable of track T12 by the owner's decision OD-2026-10-27-1 (decision 1: lead in India with Listings, Inventory and the weekly RTO report). It extends the Business Analyst (v1 build order PR 22) and starts after PR 22 and CS8 (`docs/plan/connected-services-implementation.md`).
- Change class: routine, inside decided records. It reads only Level 1 order data (ADR-0025 item 8) through the Analyst's existing `read_orders` scope, and adds no provider, scope, customer field or money flow. If step 1 finds the report needs a field or scope those records do not allow (a return read under `read_returns`, an address, a pincode), that part stops and goes to the owner as its own decision.

## Goal

Every week the Business Analyst posts one report in rupees (the shop's currency) on cash-on-delivery orders and returned parcels (RTO, return to origin): COD share, cancellations, and returned or failed deliveries, by product, by courier where present, by payment class and by order week, with rupees lost at a cost per returned parcel that the Owner enters. It is the opening conversation with Indian brands, from data Morrow can read at launch.

## Scope

1. **First, check on the owner's store** (the owner's standing approval, reads through Morrow only; nothing about the store enters this repository). How a returned or failed delivery shows in Shopify is unverified: a fulfilment status or fulfilment event, a tag that a shipping app writes (Shiprocket, GoKwik or another), a return, or nothing at all. Record which signals exist, which Level 1 field carries each, and which scope each read needs against ADR-0025 item 6's list. The design below takes whatever step 1 finds; it assumes none of them.
2. **Fields.** Level 1 only, 60 days at most, through the broker's fixed order documents, which select no name, email, phone or address (ADR-0025 item 8). Today `apps/broker/src/shopify.ts`'s `shopifyReadDocuments` has no order document: PR 22 adds the order documents and the order data's deletion path, and this report uses them. ADR-0025 item 6's minimiser keeps ids, dates, lines, totals, refunds and statuses. Payment class (`cod`, `other_manual`, `prepaid`, from the store's COD list), chosen-tag booleans and the Owner-picked RTO tag or status come with CS8's minimiser mappings and lists (ADR-0042 items 18 and 25); before CS8 lands, the report says "payment class not connected yet" and "RTO data not connected yet", never 0%. The courier, where present, is a fulfilment's tracking company mapped to a closed list the Owner picks from values seen on the store, as CS8 does for gateways; never a tracking number or URL.
3. **Figures, computed in code.** One code module computes every number: orders, COD share, cancellations, RTO and failed deliveries as counts and rates, rupees lost (RTO count times the Owner's cost), grouped by product, courier, payment class and order week. Weeks whose orders have not all settled show "still in transit: N" and count only once settled (as ADR-0042 item 25 does). No model or tool writes a figure (ADR-0033 item 3); the Analyst's run explains them and may suggest work.
4. **The Owner's cost per returned parcel.** A number a person enters in rupees, never the model. Until it is set, the report shows counts only and says what to enter, never ₹0. Rupee figures are labelled estimates.
5. **Posting.** The weekly report is part of the Analyst's weekly review, in its Everyday work area, on the `order_aggregates` class and its 90-day clock (ADR-0031 item 1).

Not in it: a pincode or region view, which needs an address and so an owner decision on customer data (ADR-0025 item 8); any customer, phone or address field; COD Confirmation (ADR-0042, the first India add-on after launch); a goal measure for RTO, which would be a later catalogue entry.

## Interfaces touched

PR 22's fixed order documents and their decoders in `apps/broker/src/shopify.ts`; CS8's order minimiser mappings and the Owner's COD, RTO and courier lists; the Analyst's order read tool and its counts-only result; one report module beside `packages/policy/src/projects/measures.ts`; the Analyst's skill and role text; a settings field for the cost per returned parcel; the weekly review's post template; eval fixtures (`packages/policy/src/evals`).

## Security notes

- Level 1 only: no name, email, phone, address, pincode, tracking number or note is selected, stored, shown or sent to the model or the sandbox (ADR-0025 item 8; ADR-0029 item 4's `order_aggregates` extract).
- Raw strings (gateway names, tags, tracking companies) are mapped to closed values in the broker before storage, as CS8 does; free text never reaches a run, and payload text never selects anything.
- Numbers come from code; the model only explains them. Read authority is the requester's and the installation's intersection, as for every Analyst read.
- No external effect and no new scope. A scope beyond the Analyst's `read_orders` goes to the owner first.

## Test checklist

- [ ] Step 1 recorded: which RTO and failed-delivery signals the owner's store shows, with the Level 1 field and scope of each (no store data in the repository).
- [ ] The fixed order documents select no customer, address, phone or tracking-number field (`lab:shopify-privacy`).
- [ ] The report module, against synthetic orders: COD share, cancellations, RTO and failed deliveries by product, courier, payment class and week; settled weeks only; "not connected yet" before CS8's mappings or the RTO source; counts only until the cost is set; rupees equal count times cost.
- [ ] Eval: the Analyst's report numbers equal the module's, and an injection in a product title changes no figure.
- [ ] `order_aggregates` clock and deletion handlers cover what the report stores (S8).
- [ ] Hosted CI green; one AI review (separate context, same model family).
