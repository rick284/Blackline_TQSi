# Hosting Blackline

Blackline runs as **one program** (the server, which also serves the web app) plus **one Postgres database**. Any host that can run a container (or a Node program) and gives you a Postgres database will do. Nothing here has been deployed yet. The plan is **Render** (server and database, Singapore region) with **Netlify** optionally in front; the steps are under "Deploying to Render (and Netlify)".

## What you need

1. **A Postgres database**, version 14 or newer, ideally in an Australian region (see "Where the data lives"). The host gives you an address that looks like `postgres://user:password@host:5432/dbname`.
2. **Somewhere to run the program**: it is packaged as a container (`Dockerfile` in the repository root). It listens on the port in `PORT` (3000 by default) and needs about 512 MB of memory.
3. **A web address with HTTPS**, which most hosts provide automatically (`something.onrender.com`, or your own domain such as `blackline.yourcompany.co.nz`).

## Settings

Set these as environment variables in the host's settings page (`.env.example` lists them):

| Name | What it does |
|---|---|
| `NODE_ENV=production` | Turns on hosted mode: needs `DATABASE_URL`, limits sign-in attempts, sends security headers, signs up only the first company. |
| `DATABASE_URL` | The Postgres address. Add `?sslmode=require` if the host wants an encrypted connection. |
| `REGISTRATION` | `first` (default when hosted): the very first person to open the site creates the company and becomes its owner, then sign-up closes. `closed`: nobody; use the admin tool. `open`: anyone (not recommended on the internet). |
| `TRUST_PROXY` | How many proxies sit between the visitor and the program: `1` for the host's own front door (Render alone), `2` when Netlify is in front of Render. The program takes the visitor's address that many entries from the right of `X-Forwarded-For`, so a visitor can't make up an address. A wrong count only weakens the per-address sign-in limit (too low: everyone looks like one visitor; too high: an address can be faked); the per-email limit still works. Not yet checked against Render's real headers. |
| `PORT` | Usually set by the host. |

The database tables are created and updated by the program itself the first time it starts and whenever a new version adds one. Several copies starting at once is safe.

## First start

1. Start the program with the settings above. In the logs you should see `Applied migrations: 001_init.sql, ...` then `Blackline server listening ...`.
2. Open the web address. The sign-in page shows **New company** (because no company exists yet). Create yours: you become the owner.
3. Reload: the **New company** tab is gone. Add your team from inside the app (owners add managers; managers add estimators and viewers).

If you'd rather not leave sign-up open even for those minutes, set `REGISTRATION=closed` and create the first company with the admin tool instead.

## The administrator's tool

There is no "forgot my password" email yet. The administrator does it from a terminal on the server (most hosts have a "Shell" tab on the service) with the same `DATABASE_URL` set:

```bash
npm run admin -w @blackline/server -- list
npm run admin -w @blackline/server -- create-company --org "Acme Civil" --name "Sam Smith" --email sam@acme.co.nz
npm run admin -w @blackline/server -- reset-password --email sam@acme.co.nz
```

Give the password in the `ADMIN_PASSWORD` environment variable (it stays out of the command history) or with `--password "..."`. At least 10 characters. A password reset signs that person out everywhere.

## Backups (do this before real work goes in)

The database *is* Blackline: every estimate, revision and ledger entry. Use a host that takes **automatic daily backups with point-in-time restore**, and check that the plan you pay for includes it (cheap or free database plans often don't, or delete the data after a period). Also take your own occasional copy:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=blackline-backup.dump
```

and prove once that a copy restores into an empty database (`pg_restore --dbname=... blackline-backup.dump`) before you depend on it.

## Where the data lives

Estimates and contract figures are commercially sensitive. Put the database in the **Sydney** region, or a New Zealand region if the host offers one and your clients' contracts ask for it (a few cloud providers have opened NZ regions recently; check what the specific host offers today). Check any client confidentiality or data-location clause before you choose. The program and database should be in the same region, or every screen gets slower.

## What is and isn't protected

Done: passwords are hashed (scrypt); sign-in is rate-limited (8 wrong tries per email and 40 per address in 15 minutes); sessions last 14 days and can be ended; every company's data is separated in the database itself; security headers and a strict content policy are sent; the server shuts down cleanly on a deploy.

Not done yet (matters once real people depend on it):

- **Password reset by email, email verification, listing and ending your other sessions.** These need an email service. Until then the administrator tool is the reset path.
- **Rate limits are kept in the server's memory.** Fine for one copy of the program, which is the intended setup. If you ever run several copies, each counts separately.
- **Someone can lock a person out for 15 minutes** by typing wrong passwords for their email (the cost of limiting guesses by email).
- **A background job for expired sessions**: they are cleared each time the server starts, and an expired one never works in the meantime.
- **Monitoring and alerts**: use the host's own (is it up, is the disk filling).
- **No staging copy.** Test a new version on a scratch database before pointing it at the real one.

## Updating

Push to the branch the host watches, or trigger a deploy. The host starts the new copy, waits for `/health` to answer (it checks the database too), then stops the old one. The program applies any new database changes itself on start, each in one step that is undone if it fails, and never replays one it has already applied. Every change so far only adds (tables, columns, rules); read any future one before deploying it to real data, and take a backup first.

## Deploying to Render (and Netlify)

Decided: **Render, Singapore region** (Render has no Sydney or NZ region; Singapore is the nearest it offers). Fine for a first, internal trial. **Before real client estimates go in, decide whether your contracts allow data outside Australia/NZ**; moving later means copying the database (`pg_dump` then `pg_restore`) to a new host and changing `DATABASE_URL`. The older Render services (`blackline-api`, `tender-platform-api`, both Oregon) are left running and untouched: everything below creates new things with new names.

### A. The server and database on Render

`render.yaml` in the repository describes both (a "blueprint"): service `blackline-tqsi` (Docker, Singapore, `starter` plan so it stays awake) and database `blackline-tqsi-db` (Singapore, `basic-256mb`, a paid plan, which includes point-in-time restore).

1. In Render: **Blueprints → New Blueprint Instance**, pick the `Blackline_TQSi` GitHub repository and the `feat/foundations` branch (or `main` once merged). Render reads `render.yaml` and shows what it will create and the monthly cost. Check it names only the two new things, then approve.
2. Wait for the first build (several minutes). Open the service's **Logs**: you want `Applied migrations: ...` then `Blackline server listening ...`.
3. Open the service's address (`https://blackline-tqsi.onrender.com`, or whatever Render shows if that name was taken). It already serves the whole app. Create your company on the sign-in page (**New company**), then reload: the tab is gone.
4. Updates: `autoDeploy` is off, so a push to GitHub changes nothing live. Press **Manual Deploy** on the service when you want a new version.

Check the plan names and prices on Render's screen in step 1 before approving: they change, and if Render rejects a plan name in `render.yaml`, pick the nearest plan in the screen or edit the file. The 256 MB database is the smallest paid size: fine to start, watch its storage and memory on the database's **Metrics** tab and move up a size when needed. The `starter` server has 512 MB of memory; if big workbook imports make it restart, move up a size.

### B. Netlify in front (optional)

Not needed to use Blackline: the Render address above works on its own. Use Netlify if you want its address, a custom domain handled there, or the web files served from its network.

1. Edit `netlify.toml`: replace `RENDER_ADDRESS` with the server's address without `https://` (for example `blackline-tqsi.onrender.com`). Commit and push.
2. In Netlify: **Add new site → Import from Git**, pick the repository. The build command and folder come from `netlify.toml`.
3. On Render, change the service's `TRUST_PROXY` to `2` (two proxies now: Netlify and Render).
4. Open the Netlify address and sign in. The browser talks only to Netlify; it passes `/api/...` on to Render.

Two limits to know: Netlify gives up on a proxied request that takes longer than about half a minute, so a very large workbook import could fail through Netlify (use the Render address directly for imports if it does); and the offline service worker has not been exercised on a hosted build at all (the browser pane used for testing here can't run service workers), so test going offline once on the real address.

### C. Costs and what to compare if you move

Check Render's and Netlify's current price pages: the server and database are the paid parts (an always-on server plus a paid database is typically tens of dollars a month), and Netlify's free plan is usually enough for the web files. If you move host later, compare in this order: an Australian or NZ region for both program and database; automatic daily backups with restore; a plan that doesn't sleep when idle; and database access from your own computer for backups.

## Testing without a host

- `npm test` runs everything against an in-process Postgres (PGlite).
- `npm run test:pg` runs the server's tests through the real `pg` adapter over Postgres's own network protocol, which is what a hosted database uses. Two tests that need the database to report an SQL error skip themselves in that mode only.
- Not tested: the container build itself, and a real hosted Postgres. Do both once on a scratch host before real work goes in.
