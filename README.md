# bookings

Cloudflare Worker that wraps the [ATC booking API](https://bookings.zlcartcc.org/api-docs) for other Indy Center Workers. It holds the API key, passes on only the fields Indy Center uses, and owns all error handling: callers fire and forget.

Following the [RPC vs Queue pattern](https://tech.flyindycenter.com/patterns/rpc-vs-queue/), callers reach it over a service binding. It has no HTTP route and isn't on the internet.

> **Status: in development, not deployed.** CI (`ci.yml`) runs on pull requests and on every push to `main`. **Build and Deploy (`build-and-deploy.yml`) does not run automatically**: it is manual-only, started from the Actions tab, until we change it. Nothing is deployed to Cloudflare or published to npm until someone runs it. To turn automatic deploys back on, add `push: { branches: [main] }` under `on:` in `build-and-deploy.yml`, after the queues, secrets and npm trusted publishing in [Setup](#setup) exist.

## How it behaves

- **Writes are queued.** Create, update and cancel a booking, set the bookable positions, and roster changes all return once queued. Nobody waits for, or needs to handle, the booking system's answer.
- **Retries.** Rate limits (waiting until `RateLimit-Reset`), 5xx, network errors and a rejected API key are retried with backoff, up to 8 times, then moved to `bookings-jobs-dlq` with an alert. Fixing a bad key and replaying the dead-letter queue recovers them.
- **Permanent refusals** (overlap, ineligible position or controller, wrong organization, validation) are dropped, logged, and sent to staff as an alert.
- **Alerts** go through [Larry](https://github.com/Indy-Center/indy-larry) to the channel named by `FAILURE_ALERT_CHANNEL` (a name from Larry's `SEND_CHANNELS`). Empty means log only. Alerts never ping anyone.
- **Not found on a cancel or update** gets three tries 30 seconds apart before it is believed, because a queue only keeps order as far as it can and the create may still be queued. A cancel that still finds nothing counts as done.
- **Reads** return data. They are cached for 30 seconds, and when the booking system is down they serve the last copy, up to an hour old. With nothing saved they throw.
- **Malformed input** (bad callsign, end before start, over 13 hours, start over 180 days out, duplicate CIDs, an empty roster for `replaceRoster`) throws before anything is queued.

## RPC surface

Published as `@indy-center/bookings-worker` (built from `src/client/`). Each app binds to its own entrypoint, so it can only call what it needs:

| Entrypoint           | Used by           | Methods                                                                                                                                                                                                                                     |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bookings` (default) | Community website | `listBookings`, `listOrgBookings`, `getPositions`, `createBooking`, `updateBooking`, `cancelBooking`                                                                                                                                        |
| `Positions`          | CMS               | `setPositions`                                                                                                                                                                                                                              |
| `Roster`             | Training Tools    | `listMembers`, `upsertMember`, `upsertMembers`, `replaceRoster`, `removeMember`, `grantEndorsement`\*, `revokeEndorsement`\* (\*throw for now: the booking system has no API-key endpoint for endorsements, so T2 is granted in its portal) |

```jsonc
// caller's wrangler.jsonc
"services": [
  { "binding": "BOOKINGS", "service": "bookings" },                              // Community
  { "binding": "POSITIONS", "service": "bookings", "entrypoint": "Positions" },  // CMS
  { "binding": "ROSTER", "service": "bookings", "entrypoint": "Roster" }         // Training Tools
]
```

```ts
import type { BookingsBinding } from '@indy-center/bookings-worker'; // npm install @indy-center/bookings-worker

// Fire and forget. externalId is your own ID (e.g. the booking's row ID): it makes a retry safe and is
// how you update and cancel it.
await env.BOOKINGS.createBooking({
	externalId: String(row.id),
	cid: 1234567,
	callsign: 'IND_TWR',
	start: new Date('2026-12-01T18:00:00Z'),
	end: new Date('2026-12-01T20:00:00Z')
});
await env.BOOKINGS.updateBooking({
	externalId: String(row.id),
	end: new Date('2026-12-01T21:00:00Z')
});
await env.BOOKINGS.cancelBooking({ externalId: String(row.id) });

// Reads return data. A booking that was refused never appears here, so a UI can show "pending"
// until its externalId shows up.
const bookings = await env.BOOKINGS.listOrgBookings();
// From the CMS positions feed; retired positions are left out.
const positions = await env.BOOKINGS.getPositions();
```

`setPositions` replaces the **whole** list, so send every position every time. `replaceRoster` removes everyone not listed (portal admins are never removed) and refuses an empty list; use `upsertMembers` to add or update without removing anyone.

## Setup

1. Create the queues: `npx wrangler queues create bookings-jobs` and `npx wrangler queues create bookings-jobs-dlq`.
2. Repo secrets: `ENV_BOOKING_API_URL` (the base URL **including `/api`**) and `ENV_BOOKING_API_KEY`. `CLOUDFLARE_WORKERS_API_KEY` (Workers Scripts:Edit, Queues:Edit) is an org secret, already set. Optional repo variable: `ENV_FAILURE_ALERT_CHANNEL`, a channel name from Larry's `SEND_CHANNELS` (we use `bookings-alerts`; add `bookings-alerts:<channelId>` to Larry's `ENV_SEND_CHANNELS` and redeploy Larry first).
3. On npmjs.com, set the package's trusted publisher to this repository and `build-and-deploy.yml`.
4. For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`.

Bump `version` in `package.json` when `src/client/` changes; merging without a bump publishes nothing.

## Development

```bash
npm install
npm run cf-typegen   # generates worker-configuration.d.ts
npm run typecheck
npm test             # builds the published types first
```

## Open questions

- **Endorsements from Training Tools.** How T2 endorsements get from our training system into the booking system is not settled: its endorsement endpoints are portal-only. We are checking whether the VATUSA sync already covers T2, and will otherwise ask the booking system's maintainers for an API-key endpoint or a supported feed. Until then admins grant T2 in the portal.
- **Ordering.** A queue doesn't guarantee order. `max_concurrency: 1` and the not-found retries cover the common case, but a cancel sent immediately after a create that keeps failing could be processed first.
- **Shared limits.** The booking API limits requests per client address (100 per 15 minutes). Every app's calls come from this worker, so they share it.
