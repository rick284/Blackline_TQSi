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
Built: engine (build-ups, on-costs, overhead, markup/margin, line/section roll-ups, sell allocation) and checkout logic, with tests.
Next: validate the engine against real priced jobs (329 Hobsonville Road, 48 Eastglen Road), then the data model and server, then Rate Library and Estimate screens.
