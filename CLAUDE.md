# Blackline

Estimating and cost-control platform for NZ construction contractors. Read `ARCHITECTURE.md` first: it is the spec.

## Rules
- Money and quantities are decimal strings and `decimal.js` values. Never use JS floats for them. Round to cents with `cents()` (half-up).
- Calculation engines (`packages/engine`, `packages/tender`) are the only places totals are computed. They must give identical results on the client and the server.
- Offline work uses package checkout (`packages/checkout`), not a sync engine. A check-in is refused unless the lock is still held and the base version matches; refused changes are parked for a person to compare. Money is never merged silently.
- Issued tender revisions are frozen and can only be superseded.
- AI never computes totals. It drafts and flags; the estimator approves (QSi Pro rules 1-4).
- UI style: black, white and greys only, dense grids, square corners, no gradients.

## Commands
- `npm test` runs vitest across packages.
- `npx tsc -b packages/engine packages/checkout packages/tender` typechecks.

## Two engines, two rounding models (do not mix them)
- `packages/engine` is **QSi** (small contractors): rick284/blackline-estimating-standalone. Each resource line is rounded to the cent; risk rows are % of categories; overhead is % of cost base; sell = cost / (1 - margin).
- `packages/tender` is **TQSi / QSi Pro**: rick284/tender-estimating-platform (`engine/tender_engine`). It carries full precision and **never rounds inside the chain**, as the Master Estimate Workbook does (it displays 2dp but keeps full precision). Round only for display and reconciliation with `cents()`.
- The TQSi pricing stack lives in one place, `priceStack` in `commercial.ts` (overhead, profit, bonds, finance). Own-works tender, consolidated package and client schedule all use it. Do not re-derive it elsewhere (a QSi Pro review found exactly that bug).

## Server and data model (`packages/server`)
- Fastify 5 API over Postgres SQL. Schema in `src/migrations/001_init.sql`; run by `migrate()`. Dev and tests use PGlite (a real in-process Postgres); production passes the same SQL to a `pg` pool behind the two-method `Db` interface in `db.ts` (the `pg` adapter is not written yet).
- **Every tenant table has `org_id`, and child tables reference their parent on `(id, org_id)`**, so a row can never point at another company's data (tested at the database level). Every repository call takes a `Ctx` and filters by `ctx.orgId`. Another company's id gets the same 404 as an id that does not exist.
- **Checkout is by package, and a package is a QS section** (plus Rate Library, Commercial, Subcontract Packages, Risk and Reserve, Register/Quotes/Scope, Programme and Schedule, Job Settings). `tender/src/packaging.ts` splits a `TenderInputs` into packages and assembles it back; the round trip is exact (tested on Hobsonville). Records are `{kind, seq?, body}`; money is a decimal string inside jsonb, never a float.
- Check-in runs `@blackline/checkout` as the single authority: the repo loads the package's lock into its Store, asks it, then makes the database match. One transaction per call, `select ... for update` on the package row. A refused check-in is applied nowhere and parked in `parked_changes` for a manager to compare; a manager can break a lock; add-only records need no lock (first write wins).
- Roles: viewer (read) < estimator (checkout, check-in, add-only records, create jobs) < manager (break locks, import, resolve parked, add estimators/viewers) < owner (adds managers).
- Auth: scrypt password hashes, opaque session tokens stored as SHA-256, 14-day sessions, minimum password 10 characters. Not done: rate limiting, password reset, email verification, session listing.
- Endpoints: `/auth/*`, `/me`, `/org/members`, `/audit`, `/jobs`, `/jobs/:id/{packages,estimate,parked,append,import-workbook}`, `/packages/:id/{checkout,checkin,release,break-lock}`, `/parked/:id/resolve`. `GET /jobs/:id/estimate` recalculates from checked-in records with the same engine the clients use.
- Run: `npm start -w @blackline/server` (uses vite-node; set `PORT`, and `DATA_DIR` to keep the database between runs). Smoke-tested: starts, migrates, answers `/health`.

## Web client (`packages/web`)
- Vite 5 + React 19 + AG Grid Community (grouped column headers, in-cell editing), Geist fonts, greys only. Screens: sign-in / new company, Tender Register (job list), and per job: **Estimate** (QS takeoff over resource build-up), **Packages**, **Rate Library** (add a rate as a new line in the grid; the labour true-cost builder opens as a panel under the grid), **Scope Register** (requirements with owner, treatment and a backed-up check; a register / quotes reference panel links items with one click), **Parked changes**, **Summary**. The other modules appear in the navigator as "Coming later". Every screen that edits a package uses the shared PackageBar (check out / check in / release / break, same wording everywhere).
- **The maths runs in the browser**: `src/lib/model.ts` assembles the job's records and runs `@blackline/tender/core` (the browser-safe entry; the Node-only importer is excluded), so every edit recalculates the whole job locally, as on the server. White cells are inputs, shaded cells are calculated; inputs are editable only on a package you have checked out.
- **Drafts** (`src/lib/draft.ts`, pure and tested): your edits to packages you hold, kept in `localStorage` (`bl:ws:<job>`) together with the lock version, so a refresh or a lost connection loses nothing. Check-in sends the change set; the server decides. A refused check-in clears the local draft and says the work was parked for a manager.
- **Status bar** on every screen: Online/Offline, packages checked out by you, changes waiting (black badge = needs you). Offline: the last loaded copy of the job (`bl:cache:<job>`) is shown and edits to held packages still work; checking out, checking in, releasing and breaking need a connection.
- **No pop-ups**: nothing opens over the work. Adding a rate or requirement is a pinned new line in the grid (code/requirement cell opens, then the next cell); questions (release, break lock) are a bar above the grid (`ConfirmBar`); notices are in-page bars. Do not use `window.confirm/prompt/alert`.
- **Labour builder** (`lib/labour.ts`, `screens/LabourBuilder.tsx`): percentages typed as %, engine takes fractions; live build-up from `computeLabourRate`; save writes `library:<CODE>` (Labour, hr, price/wording/source from the build) and `labour:<CODE>` (`{inputs, history}`) into the Rate Library package. A rate typed in by hand is never overwritten; built rates cannot be deleted; a rebuild keeps a note of the earlier rate/status/evidence in `history`.
- **Scope Register** (`lib/scope.ts`, `screens/Scope.tsx`): edits go through `scope.setField`/`buildItem` from the tender package; status, gate and unhomed QS items come from `estimate.scope`. Register items and quotes are shown read-only (no editing screen for them yet).
- Not done: Documents and other modules, adding QS items, editing register items and quotes, phone layout, code-splitting (the bundle is about 1.5 MB).
- Run locally (two terminals): `npm run demo -w @blackline/server` (API on :3000 with the demo company; sign-in details are in the header of `packages/server/src/devSeed.ts`, local development only) and `npm run dev -w @blackline/web` (open http://localhost:5173). The dev server proxies `/api` to the API. `.claude/launch.json` has both.
## Status
Built (all with tests, 304 passing plus 1 skipped without the private workbook):
- `packages/engine` (QSi): cost base with include/exclude, risk rows, register risks, overhead, margin, GST; variations, full-potential scenario; commercial control (budget, forecast, earned value, programme summary); payment schedule and retention. Checked against QSi's 33 server-generated cases. Known difference: QSi rounds with Python floats, so an exact half cent rounds down there and up here (11 cases, `HALF_CENT_TIES`).
- `packages/tender` (TQSi): resource build-up (4 calc modes, QA flags), QS takeoff, commercial stack CA01-CA25, consolidated package, weather allowance, Risk Truth (checked against the workbook's own formulas, 41 golden scenarios), Management Reserve adjudication, NZ labour true-cost build-up (reproduces the NZIQS handbook example), client price schedule mapping, scope coverage, register, quotes, programme/critical path, revision diff, weather tool (NIWA normals, checked against the real tool workbook's golden scenarios), and the assembler `computeTenderEstimate`.
- `packages/checkout`: lock, check-in, break-lock and parking rules.

- Master Estimate Workbook importer (`src/importers/masterWorkbook.ts`, ExcelJS). It strips XML namespace prefixes and merged-cell ranges first, because the Rev34E file uses `<x:...>` elements and overlapping merges that ExcelJS cannot load. The **Hobsonville Rev34E golden test passes** (`test/golden_hobsonville.test.ts`): every build-up row, QS amounts, section totals, weather allowance, tender chain (614,700.22), consolidated all-in (1,226,916.81), Risk Truth, reserve and the 55-day programme. It needs `private/Rev34E.xlsx` (git-ignored client file; copy from Drive 01_329_Hobsonville_Road_Estimate_Rev34E.xlsx) and skips without it.

Not yet ported from QSi Pro:
- Importer parts: Scope Coverage sheet (Hobsonville has none) and the MS Project Import fallback. The cover register (documents, A#, EX-#, RFI-#) and the Supplier Quote Register are read (Hobsonville: 9 documents, 9 assumptions, 3 exclusions, 13 RFIs, 15 risks, 14 quotes).
- Edit operations (`edits.py`), blank-tender template, brief, saved-inputs JSON round trip, Excel/PDF outputs.
- The app layer in QSi Pro `api/` (AI drafting and takeoff, Drive, Gmail, steps, timesheets).
- QSi warning generators (variation, claim, programme, margin drop).

The Eastglen spreadsheet's contingency, site overhead and revenue steps are not in either repo's code; its formulas still need explaining.
Next: `pg` adapter and deployment settings, issued (frozen) tender revisions in the schema, blank-tender template, register and quote editing, adding QS items, Xero link.
