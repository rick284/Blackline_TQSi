# Hosting Blackline

Blackline runs as **one program** (the server, which also serves the web app) plus **one Postgres database**. Any host that can run a container (or a Node program) and gives you a Postgres database will do. Nothing here has been deployed yet: the choice of host is still to be made (see "Choosing a host" at the end).

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
| `TRUST_PROXY=1` | The host puts its own front door in front of the program, so believe the visitor address it passes on. Leave it on with a host's own web address. |
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

## Choosing a host

Not chosen yet. What to compare, in order of importance: an Australian region for both the program and the database; automatic daily backups with restore on the database plan; the monthly price for a small always-on instance (avoid plans that "sleep" when idle, the first request after a sleep takes a minute); whether the database can be reached from your own computer for backups; and whether you can use your own web address. A small setup of this kind typically costs in the order of tens of dollars a month; get the exact figure from the host's current price page.

## Testing without a host

- `npm test` runs everything against an in-process Postgres (PGlite).
- `npm run test:pg` runs the server's tests through the real `pg` adapter over Postgres's own network protocol, which is what a hosted database uses. Two tests that need the database to report an SQL error skip themselves in that mode only.
- Not tested: the container build itself, and a real hosted Postgres. Do both once on a scratch host before real work goes in.
