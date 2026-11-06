# CLAUDE.md

Notes for Claude Code (and anyone else) working in this repo. The README says what the worker does and how to call it; this file says why it is built this way and how to work on it.

## Rules for this repo

- **Never `git push` without explicit permission** from the user in that moment. Committing locally is fine when asked. A push covers only the one the user asked for; do not infer permission from "make it run" or "fix it".
- **Do not turn on automatic deploys.** `build-and-deploy.yml` is manual-only (`workflow_dispatch`) while the worker is being built. Do not add a `push` trigger to it, and do not run it, without being told to.
- A push to `main` runs CI (`ci.yml`), which only checks. Warn the user before a push if anything else would trigger.
- Do not commit secrets. `BOOKING_API_URL` and `BOOKING_API_KEY` are Worker secrets given to the team later; `.dev.vars` is gitignored.

## What this is

A Cloudflare Worker (`bookings`) that wraps the ATC booking API (a VATSIM ATC booking system) for other Indy Center Workers. Jira: DEV-230 (this worker), DEV-231 (CMS keeps the bookable positions list), DEV-232 (Training Tools manages the roster and T2 endorsements), DEV-233 (Community website uses this worker for all booking needs). The Community website is Thomas Henkel's; CMS and Training Tools are ATM's.

Published as `@indy-center/bookings-worker` (types only, from `src/client/`). Repo: https://github.com/Indy-Center/bookings-worker.

## Design decisions (agreed with the user)

- **Per-consumer entrypoints** in `src/index.ts`: `Bookings` (default, Community), `Positions` (CMS), `Roster` (Training Tools). Each app binds to its own with `"entrypoint": "..."`, so it can only call what it needs. Positions replace and roster prune are destructive, which is why they are not on one shared class.
- **The bookable positions list is data we work with.** `https://cms.flyindycenter.com/api/public/v1/positions` (public, no auth, cached 5 minutes) is the source of truth for the ARTCC's bookable positions. It returns a bare array; each item has `id`, `callsign`, `name`, `shortName`, `radioName`, `frequency` (Hz), `facility`, `starred`, `requiredCredentials` and `retired`. Anything that disagrees with it (such as the booking system's own list) is wrong. It lists positions, not which are free; open slots come from `listOrgBookings`. `Bookings.getPositions()` reads it (URL in the `POSITIONS_URL` var in `wrangler.jsonc`; `fromCmsPositions` in `src/wire.ts` drops `retired` ones and keeps `callsign`, `name`, `radioName`, `frequency`, `facility` and `requiredCredentials`), cached like the other reads (30s, stale copy for an hour). It no longer reads the booking system's own list. The CMS sends the list in through the `Positions` entrypoint (`setPositions`, DEV-231), which no longer has a `getPositions`. This was a breaking change to the published types, hence version 2.0.0.
- **Positions in the Community UI** (DEV-233): show each position's `radioName`, grouped under its parent `facility`. Credentials rank from the top down: E-RC, T-RC, A-LC, S-LC, A-GC, S-GC, and a higher credential covers every lower one (T2-CTR is also used, but it is already in each position's `requiredCredentials`). S-LC, A-GC and S-GC can be held by VATSIM S1-rated controllers. The booking API decides who can actually book; the UI only hides positions the controller lacks the credential for, to make booking easier. It is a convenience, not a check.
- **Callers are fire and forget; all error handling lives here.** Every write returns once queued. `src/consume.ts` retries rate limits (using `RateLimit-Reset`), 5xx, network errors and 401/403 with backoff (up to `MAX_RETRIES`, then the dead-letter queue and an alert). Permanent refusals (400 overlap/wrong org, 409, 422) are dropped, logged and alerted. A 404 on cancel/update gets 3 tries 30s apart before it is believed, because a queue only keeps order as far as it can and the create may still be queued.
- **Reads return data**, via `src/reads.ts`: cached 30s in the Workers Cache API, with a stale copy kept an hour and served if the booking system is down.
- **Malformed input throws before queueing** (`src/validate.ts`), matching indy-larry. Expected failures are not returned as a result union or thrown as custom error classes, because callers never see upstream outcomes.
- **Alerts** go to a staff channel through Larry (`indy-larry` Worker, `LARRY.enqueue`), named by `FAILURE_ALERT_CHANNEL`. Empty means log only. Alerts never ping (`allowedMentions: { parse: [] }`).
- **Writes use the `/bookings/external/*` endpoints** with a caller-supplied `externalId`, so retries are idempotent and update/cancel address the booking by that ID.
- **Only fields Indy Center needs** are passed through: `division`/`subdivision` and timestamps are dropped, `cid` is a number, times are `Date`, and the feed's `mentoring` type is normalized to `training`.
- **Endorsements**: `grantEndorsement`/`revokeEndorsement` exist as a contract for Training Tools but throw "not available yet". The booking docs list endorsements and GCAP restrictions only under `/org/session/*`, which needs a portal session, not the API key. GCAP applies to every booking, including ours: a controller without the matching endorsement (e.g. T2) is refused with a 422 whose key is `restriction`, which this worker drops and alerts. Endorsements reach the booking system by portal grant, a VATUSA or VATEUD sync (every 15 minutes, read-only), or an organization's own training system (how that connects is undocumented). Portal sign-in is VATSIM Connect OAuth for listed admin CIDs, so the worker cannot log in on its own.
- **Roster**: `upsertMembers` never removes anyone; `replaceRoster` sets `prune: true`, refuses an empty list and is capped at 1200 members (one queue message is 128 KB, and a prune cannot be split). `upsertMembers` chunks at 1000.

## Layout

- `src/index.ts`: the three entrypoints and the `queue()` handler (on the default export, like Larry).
- `src/client/`: the published types and RPC interfaces. Bump `version` in `package.json` when this changes; merging without a bump publishes nothing.
- `src/validate.ts`, `src/wire.ts`: input checks and mapping to and from the booking API's JSON.
- `src/upstream.ts`: the one place that calls the booking API; classifies results as `retry`, `not_found` or `rejected`.
- `src/jobs.ts`: queue job types and the request each becomes. `positionsBody` is the one place to change the positions payload shape.
- `src/consume.ts`, `src/reads.ts`: queue consumer and cached reads.
- `tests/`: Vitest, with an injected `fetch` and fake cache (see `tests/helpers.ts`).
- `.github/workflows/ci.yml`: runs on pull requests, pushes to `main`, manually, and via `workflow_call`.
- `.github/workflows/build-and-deploy.yml`: manual-only deploy plus npm publish (trusted publishing).

## Commands

```bash
npm install
npm run cf-typegen   # generates worker-configuration.d.ts (gitignored); run after changing wrangler.jsonc
npm run typecheck
npm test             # runs build:lib first, then Vitest
npm run lint         # prettier --check; npm run format to fix
npx wrangler deploy --dry-run --outdir dist-check   # what CI's "Worker bundles" step runs
```

Style: tabs, single quotes, no trailing commas, 100 columns (Prettier). Matches the org's other Workers (`discord-bot`). The definition of done in the team's docs: you ran it, tests cover the change, CI is green, the README still describes reality.

## Org conventions this follows

From https://tech.flyindycenter.com and the `indy-larry` worker (`Code_Work/indy-larry/worker`):

- No HTTP between Workers, no shared secrets, no CORS: service bindings only.
- If a person is waiting, use RPC and keep it fast; if nobody is, use a queue.
- An RPC worker is a `WorkerEntrypoint` with its consumer types published from `src/client/`.
- CI order: format, types, build, tests. Branching and Jira rules are under `/agreements/` in the docs.
- Deploy secrets are re-set on every deploy from `ENV_*` repo secrets.

## Not deployed yet

Nothing is live.

### TODO before the first build and deploy

- [x] `CLOUDFLARE_WORKERS_API_KEY`: org secret, already set and shared with this repo (indy-larry deploys with it).
- [x] Repo variable `ENV_FAILURE_ALERT_CHANNEL` = `bookings-alerts`.
- [x] `bookings-alerts:<channelId>` added to Larry's `ENV_SEND_CHANNELS` and Larry redeployed.
- [ ] Repo secret `ENV_BOOKING_API_URL`: Indy Center's booking system base URL **including `/api`** (GitHub: Settings, Secrets and variables, Actions, Secrets tab). The deploy sets it on the Worker as `BOOKING_API_URL`.
- [ ] Repo secret `ENV_BOOKING_API_KEY`: the organization's API key, from whoever holds it (same place). The deploy sets it as `BOOKING_API_KEY`.
- [ ] Create the queues `bookings-jobs` and `bookings-jobs-dlq` (needs Cloudflare access).
- [ ] Set npm trusted publishing to this repo and `build-and-deploy.yml`. The first deploy publishes `2.0.0` of the types and a publish can't be undone.
- [ ] CI green on `main`.
- [ ] Try it against the real booking API with `wrangler dev` and a `.dev.vars` (copy `.dev.vars.example`): one booking, one update, one cancel, one `setPositions`, one roster upsert.
- [ ] Send a test alert: queue a booking the booking system will refuse and check it lands in `bookings-alerts`.
- [ ] Run Build and Deploy by hand (`workflow_dispatch`), only when told to.

### After the first deploy

- [ ] The CMS pushes its positions through the `Positions` entrypoint (DEV-231).
- [ ] The Community website switches to `Bookings`, reading `getPositions` and showing `radioName` under each facility (DEV-233).
- [ ] Training Tools uses `Roster` (DEV-232).
- [ ] Settle how T2 endorsements reach the booking system (see Open questions).

## Open questions

- **Endorsements from Training Tools**: how do T2 endorsements get from our training system into the booking system? Its endpoints are portal-only. In the ZID Bookings Integration chat the booking system's maintainer (VATSIM) said issuing endorsements and solos "can all be done with the API" and offered custom tweaks, so ask him to confirm an API-key path (ATM owns this). Also check whether the VATUSA sync already covers T2. Until then admins grant T2 in the portal.
- **Ordering**: a cancel sent right after a create that keeps failing could be processed first. The not-found retries cover the common case only.
- **Rejected bookings are invisible** to callers: a refused booking never appears in `listOrgBookings`, so the Community UI should show "pending" until its `externalId` shows up.
- **Shared rate limit**: the booking API limits 100 requests per 15 minutes per client address, shared by every app through this worker.
- **Booking API quirks to remember**: REST uses ISO times and string CIDs; the change feed uses `YYYY-MM-DD HH:MM:SS` UTC, numeric CIDs and calls training `mentoring`. Bearer bookings need the target CID on the roster with rating S1 or higher; solo and GCAP overrides are portal-only. The change feed (`/booking-events`) is not wrapped yet; a follow-up if Community wants live updates.
