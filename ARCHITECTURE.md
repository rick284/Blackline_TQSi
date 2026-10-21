# Blackline Platform — Concept Architecture

Oct 21, 2026 · @Rick Jones

## The short version

Blackline should be built as one job record that travels from the first phone call to the final cost report, with every screen simply a different view of that record. Nothing is retyped between stages. The enquiry becomes the tender, the tender becomes the estimate, the estimate becomes the budget, and the budget is what actuals are measured against.

It is an online platform first, with the cloud as the single source of truth. Each estimator keeps a cached local copy of the jobs they work on, and can check out packages before going offline. A checked-out package is locked to that person in the cloud, so nobody else can change it, and their offline edits are checked back in when they reconnect. That keeps the platform working on a remote site, on a plane between Christchurch and Brisbane, or when the office internet drops on tender day, without a general-purpose sync engine.

The look is deliberately that of serious industry software, in the family of the warehouse, marine and practice-management systems you sent: dense grids, a module navigator down the left, toolbars, tabs, status bars, and keyboard-first data entry. It is styled in black, white and shades of grey, with no chat bubbles, gradients or decoration anywhere.

The one idea that sets it apart from everything on the market is that scope is data, not notes. Assumptions, exclusions, clarifications and missing information are real records, linked to estimate items, carried into the tender letter, and checked again at handover and on every variation.

## The life of a job

A job moves through twelve stages, and at four gates a person has to make a decision before it goes any further: bid or no bid, commercial sign-off, issue of the tender, and conversion of the estimate into a budget on award.

&#91;embedded content: life of a job · 12 stages, 1 bid decision, 1 feedback loop\]

Read it left to right, then back, then forward again. The dashed line is the addendum path: a changed document flags the estimate lines it touches. The highlighted loop is the one that makes the business: actual productivity from site corrects the rate library that prices the next job.

The gates matter as much as the stages. A no-bid is logged with its reason, so you learn which work you walk away from. A tender cannot issue while any scope item or quote is still flagged. And on award the estimate is copied into a budget, while the issued tender stays frozen exactly as the client received it.

## The modules and the one record

There are twelve modules, and they are doors into the same job, not separate programs. Each one owns its own kind of data and hands it forward. None of them makes a private copy of another module's data.

The practical test is a late addendum that changes a pipe size. In Blackline the document register logs it, the scope item it touches is flagged, the quantity and the estimate lines linked to that scope item are marked for review, the affected subcontract quote shows as out of date, and the tender letter will not issue until each flag is cleared. Excel cannot do that, and in my judgement very few commercial platforms do it all the way through.

| Module | What it holds | What it hands on |
| --- | --- | --- |
| Contacts and Enquiries | Clients, consultants, subcontractors, suppliers; the enquiry register; go/no-go decision | A registered tender with its deadline and owner |
| Tender Documents | Drawings, specifications, client BOQ, addenda register, RFIs and clarifications, all revisioned | The current document set, and a change flag when anything is superseded |
| Scope (ScopeForge) | Work packages, assumptions, exclusions, missing information, choke points, risk items | Scope items that every quantity and estimate line must link to |
| Quantities | Take-off from QSi Pro, imported BOQ quantities, dimension sheets | Measured quantities against scope items |
| Estimate | Resource build-ups, crews, plant, materials, productivity, direct cost and sell side by side | Priced items, resource totals and hours |
| Tender Procurement | Subcontract and supplier enquiries, quote register, quote levelling and adjudication | Selected quotes, with their exclusions reconciled to scope |
| Programme | Activities and durations driven by production rates | Time-related costs and preliminaries |
| Commercial Review | Risk and opportunity, overheads, margin, scenarios, approval sign-off | An approved price |
| Submission | Tender letter, priced schedule, qualifications, alternatives | A frozen, issued revision |
| Contract Setup | Award, the estimate converted to budget, cost codes, contract form (NZS 3910, Construction Contracts Act) | The control budget |
| Cost Control | Commitments, actuals (timesheets, plant hours, invoices), variations, payment claims, retentions, forecast to complete | Cost to complete and margin at completion |
| Rate Library | Resources, crews, productivities, composite rates, with history | Rates corrected by real job performance |

The last row is the one that pays for the whole system. When actual productivity from Cost Control flows back into the Rate Library, every future estimate gets more accurate. That loop is how you stop contractors pricing on gut, which is the problem you set out to solve.

## How cloud and offline work together

The rule is online first, with checkout for offline work. While connected, the cloud is the live record. Before going offline, an estimator checks out the packages they will work on. The cloud locks each one to them and sends down a copy at a known version. Offline, every keystroke is saved to a local database on their machine, so the software stays instant. When they reconnect, they check the package back in: the cloud confirms the package is still at the version they took, applies the change set in one step, recalculates, and releases the lock.

The cloud holds the master copy of every job, applies the business rules and permissions, and keeps the full audit history. A laptop caches only the jobs that person is assigned to or has pinned, plus the rate library and contacts, read-only unless a package is checked out.

There is no general-purpose sync engine. Because checked-out packages cannot be edited by anyone else, a check-in is an upload of one person's change set, not a merge.

### Conflicts are where offline systems succeed or fail

The locks remove most conflicts, and what is left is handled by setting a rule for each kind of data. Money is never merged silently.

| Kind of data | Rule | Example |
| --- | --- | --- |
| Estimate sections and rates | Checked out to one person; others see it read-only | Carlo holds the drainage package; you can read it, not edit it, until he hands it back |
| Records that only ever get added | Never conflict; both sides simply keep both | A quote received, an RFI, a timesheet, a site diary entry |
| Ordinary fields | The latest edit wins, with the earlier value kept in history | A contact's phone number, a note |
| A clash on money that slipped through | Stops at a side-by-side screen; a person chooses | Two different labour rates for the same crew |
| Issued revisions | Frozen forever; can only be superseded, never edited | Tender Revision B as sent to the client |

The checkout rule matters most. A lock can only be taken while online, so checkout has to happen before going out to site or onto a flight. Nobody else can change a locked package until it is checked back in, so there is nothing to collide when the laptop reconnects.

Locks are held by package, not by whole job, so one estimator on a flight does not block the team.

**Breaking a lock.** A lost laptop or a forgotten checkout must not freeze a package. A manager can break a lock, which returns the package to the last checked-in version. If the original holder later reconnects with unsynced edits, the check-in is refused because the base version has moved. Their change set is kept and shown side by side with the current package, and a person chooses what to bring across. This is the only place a compare-and-choose screen is needed.

### The maths runs on the laptop

The calculation engine, meaning build-ups, extensions, on-costs, margins and roll-ups, is one piece of code that runs both on the laptop and on the server. Offline totals are therefore real totals, not estimates of the estimate. When a package is checked in, the server recalculates and confirms that its total matches the laptop's, which catches errors before they become a priced tender.

### Drawings and documents

Drawing sets are too big to copy everywhere. They live in cloud storage, and each tender has a "make available offline" switch that downloads its current document set to the laptop. Superseded revisions stay in the cloud unless someone asks for them.

### Always visible, always safe

The status bar at the bottom of every screen always shows the connection state, for example "Online, 0 packages checked out", or a black badge reading "Offline, 2 packages checked out, 14 changes waiting". The local database is encrypted. A lost laptop can be locked out remotely and its copy wiped at the next connection.

Your Conhur Ops build spec already set offline-first as a requirement, so this is the same principle carried across to a much larger record.

## What it looks like

It should look like the software in your examples: the warehouse system, the marine HSEQ system and the practice-management system. These are dense, calm, built to be used eight hours a day, and trusted because they look like they hold a lot of data properly. Five screens are mocked up in [Blackline Platform — Screen Concepts](https://claude.ai/artifact/LY3sufCvKT2b1exhBVi1cz): the Tender Register, the Estimate workbench working offline, the Scope Register with an addendum's impact, quote levelling, and Cost Control with the rate feedback loop. The module names in the left navigator link the screens together.

The conventions that create that feel are these:

- **The frame is fixed and familiar.** A slim white title bar shows where you are as a breadcrumb (job, then module), with the menus beside it, then a toolbar of labelled icon buttons. The module navigator runs down the left, and a status bar along the bottom always shows the sync state.
- **Grids are the main surface.** They have grouped column headers (Item, Quantity, Direct cost, Sell, Control), monospaced right-aligned figures, a grey selected row, and totals rows in the header grey. Calculated cells are shaded and input cells stay white, so the estimator can see at a glance what can be typed into.
- **Master and detail stay on one screen.** Select a row and its detail (build-up, activity, impact) appears beneath it, so the estimator never loses their place.
- **There is no colour at all.** Status is carried by fill and outline: solid black means "needs you" (flagged, offline, checked out, the active module), grey means in progress or waiting, an outline means done or included, and a dashed outline means excluded. Borders are hairlines, corners are square, the workspace, toolbar and sidebar sit on grey with white tables on top, and there are no gradients, shadows or illustrations.
- **Text is plain and specific.** "Tender issue blocked until 2 flagged items are cleared" rather than friendly marketing copy.
- **It is keyboard-first.** Tab through cells, type, press Enter, and the line extends and recalculates, as it does in Excel. Estimators will not give up Excel for anything slower.

The typeface in the mockups is Geist, with Geist Mono for figures. It is modern and free, and its figures are all the same width, so columns of money line up.

## Where AI sits, and where it is kept out

AI works in Blackline as a reviewer and a drafter, never as the pricer of record. It never changes a number on its own. Everything it produces lands as a proposal row that a person accepts or rejects, with a reference back to the page or clause it came from, and both the proposal and the decision are logged.

That makes it look like part of a professional tool rather than an AI product. There is no chat window as the main screen and no sparkle icons. Mason appears as a review pane and a toolbar button, the same way a spell-check or a clash-detection tool would.

These are the jobs it earns its place on:

- **Reading tender documents.** It proposes scope items, missing information and likely choke points into ScopeForge for you to confirm.
- **Reading addenda.** It lists what changed against the previous revision and which scope items are affected.
- **Levelling quotes.** It compares a subcontractor's inclusions and exclusions against your scope and flags the gaps.
- **Reviewing the estimate.** It flags rates, productivities and quantities that sit outside your own history for similar work.
- **Drafting the submission.** It writes the qualifications and exclusions section from the scope records, for you to edit.

AI needs a connection, so all of this is online only. Offline, the platform loses nothing it depends on. The QSi tier for smaller contractors can ship with AI switched off entirely, which fits your thinking that the smaller tier is mainly a proper QS system to replace Excel.

## Technology and build order

Checkout, versioning and the shared calculation engine have to be in the foundations from day one, because every record needs a package, a version and a lock state. The container is a separate choice: build a browser app first (React, with a local database for checked-out packages), and wrap it in Tauri later if browser storage limits, encryption or remote wipe become a problem. Nothing in the data layer depends on that choice.

### Recommended stack

| Layer | Recommendation | Why |
| --- | --- | --- |
| Application | Browser app first; optionally wrapped in [Tauri 2](https://dev.to/focuscookie/tauri-20-sqlite-db-react-2aem) later | Cheapest start; the wrapper adds a real local database, encryption and remote wipe if needed |
| Interface | React and TypeScript, with a professional data grid such as AG Grid | Grouped columns, frozen panes, in-cell editing and keyboard entry are what estimators expect |
| Local store | SQLite (WASM in the browser, native under Tauri), holding only checked-out packages and cached reads | Proven, fast, and it holds a full job comfortably |
| Checkout and check-in | Lock records and a version number per package, with a check-in endpoint on our own server | No sync engine needed; business rules apply at check-in |
| Cloud database | PostgreSQL, hosted in an Australian region | Estimates are relational: hierarchies, cost codes, links, money |
| Calculation engine | One shared TypeScript module using decimal arithmetic, never floating point | The same totals offline and online, to the cent |
| Documents | Cloud object storage, with a PDF viewer built in | Drawings stay out of the database |
| Integrations | Xero first for invoices and purchase orders, then timesheet and plant-hour apps | Actuals arrive without retyping |

### Owning the build

The platform will not be built on a hosted app builder such as Emergent. Those charge a monthly fee for as long as the product exists, and both the code and the hosting sit on their platform. Instead, it will be built with Claude Code, with the code in your own repository so you own it outright. Claude Code works best with a written spec in the repository: this document, the data model, the conflict rules, and the calculation tests against real jobs.

One honest caveat: a cloud platform still needs a server somewhere to hold the master copy and run checkout and check-in. The difference is that this is an ordinary hosting bill in your own account, and it can be moved to another provider at any time. If the server is down, anyone with packages checked out can keep working and check them in later.

### Build order

1. **Data model and calculation engine.** Test them against real priced jobs such as 329 Hobsonville Road and 48 Eastglen Road until the totals match to the cent.
2. **Local store, checkout and check-in.** Include lock breaking and the conflict rules, proven with two clients and the network unplugged.
3. **Rate Library and Estimate.** This is the workbench where most hours are spent.
4. **Scope and Tender Documents.** ScopeForge rebuilt as structured records linked to estimate lines.
5. **Tender Procurement and Submission.** Quote levelling, the tender letter, and frozen revisions.
6. **Contacts and Enquiries.** The pipeline front end.
7. **Contract Setup and Cost Control.** The Job Cost Tracker rebuilt on the live budget, with the Xero link.
8. **The feedback loop and the AI review layer.** These come last, because they depend on everything above being trustworthy.

## Decisions to make before build starts

Each of these changes the foundations, so each is cheap to decide now and expensive to change later.

- [ ] **Builder.** Decided: Claude Code, in your own repository. The first sessions build the foundations (data model, calculation engine, local database and sync) before any screens.
- [ ] **Customers from day one, or your own tool first?** Selling it means multi-company separation, billing and onboarding have to be in the data model from the first table.
- [ ] **Checkout size.** Is it checked out by package, by section, or the whole estimate? Smaller pieces suit teams; the whole estimate is simpler for a sole estimator.
- [ ] **Cost code structure.** One Blackline standard across every job, or each contractor's own codes mapped onto it? The rate-library feedback loop only works if actuals and estimates share codes.
- [ ] **Tiers.** Which modules sit in QSi and which in TQSi? Offline, Cost Control and AI are the obvious dividing lines.
- [ ] **First accounting link.** Xero, MYOB, or both? This sets where actuals and commitments come from.
- [ ] **Data residency.** Is an Australian-hosted cloud acceptable to New Zealand clients, or does it need a New Zealand option?
- [ ] **Browser access.** Is the browser version full editing, or read-only plus approvals for managers and clients? Read-only is far simpler to keep consistent.

## Sources

- [PowerSync overview](https://docs.powersync.com/overview/readme-1): local SQLite writes, upload queue through your own back end
- [Tauri 2 with SQLite and React](https://dev.to/focuscookie/tauri-20-sqlite-db-react-2aem)
