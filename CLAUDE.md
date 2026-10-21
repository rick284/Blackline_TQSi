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

## Status
Built (all with tests, 210 passing):
- `packages/engine` (QSi): cost base with include/exclude, risk rows, register risks, overhead, margin, GST; variations, full-potential scenario; commercial control (budget, forecast, earned value, programme summary); payment schedule and retention. Checked against QSi's 33 server-generated cases. Known difference: QSi rounds with Python floats, so an exact half cent rounds down there and up here (11 cases, `HALF_CENT_TIES`).
- `packages/tender` (TQSi): resource build-up (4 calc modes, QA flags), QS takeoff, commercial stack CA01-CA25, consolidated package, weather allowance, Risk Truth (checked against the workbook's own formulas, 41 golden scenarios), Management Reserve adjudication, NZ labour true-cost build-up (reproduces the NZIQS handbook example), client price schedule mapping, scope coverage, register, quotes, programme/critical path, revision diff, weather tool (NIWA normals, checked against the real tool workbook's golden scenarios), and the assembler `computeTenderEstimate`.
- `packages/checkout`: lock, check-in, break-lock and parking rules.

Not yet ported from QSi Pro:
- The Excel importer (`importers/master_workbook.py`), needed to run the Hobsonville Rev34E golden test. Expected: base direct 435,521.88; subtotal 474,995.63; own-works tender 614,700.22; all-in 1,226,916.81; weather allowance 18,204.69; CA16 18,269.06. Needs the workbook locally (Drive: 01_329_Hobsonville_Road_Estimate_Rev34E.xlsx) and a TS xlsx reader.
- Edit operations (`edits.py`), blank-tender template, brief, saved-inputs JSON round trip, Excel/PDF outputs.
- The app layer in QSi Pro `api/` (AI drafting and takeoff, Drive, Gmail, steps, timesheets).
- QSi warning generators (variation, claim, programme, margin drop).

The Eastglen spreadsheet's contingency, site overhead and revenue steps are not in either repo's code; its formulas still need explaining.
Next: Rev34E importer and golden test, then the data model and server (multi-company from the first table), then Rate Library and Estimate screens.
