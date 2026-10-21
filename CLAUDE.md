# Blackline

Estimating and cost-control platform for NZ construction contractors. Read `ARCHITECTURE.md` first: it is the spec.

## Rules
- Money and quantities are decimal strings and `decimal.js` values. Never use JS floats for them. Round to cents with `cents()` (half-up).
- The calculation engine (`packages/engine`) is the only place totals are computed. It must give identical results on the client and the server.
- Offline work uses package checkout (`packages/checkout`), not a sync engine. A check-in is refused unless the lock is still held and the base version matches; refused changes are parked for a person to compare. Money is never merged silently.
- Issued tender revisions are frozen and can only be superseded.
- UI style: black, white and greys only, dense grids, square corners, no gradients.

## Commands
- `npm test` runs vitest across packages.
- `npx tsc -b packages/engine packages/checkout` typechecks.

## Status
Built:
- `packages/engine`: the Blackline QSi pricing formulas (rick284/blackline-estimating-standalone, `backend/services/estimate_engine.py` and `pricing_engine.py`) on decimal arithmetic: zone/task/resource cost base with include/exclude flags, risk rows (legacy and rows model), register risks, overhead on cost base, margin on sell, GST, gross margin. Checked against QSi's 33 server-generated cases (`test/fixtures/qsi_pricing_cases.json`).
- `packages/checkout`: lock, check-in, break-lock and parking rules, with tests.

Known difference from QSi: QSi rounds with Python floats, so an exact half cent (5% of 36,902.50) rounds down there and up here. 11 cases differ by 1 to 2 cents for that reason (`HALF_CENT_TIES` in the fixture test). Everything else matches exactly.

Not yet ported from QSi: variations, full-potential scenario, commercial control (budget, actuals, claims, retentions), QSi Pro (rick284/tender-estimating-platform) additions.
Next: check against the Eastglen and Hobsonville spreadsheets, then the data model and server, then Rate Library and Estimate screens.
