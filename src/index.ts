// The bookings Worker. Other Workers bind to it as a service; see the README. Three entrypoints, one
// per consumer, so each app can only call what it needs:
//   Bookings (default)  Community website
//   Positions           CMS
//   Roster              Training Tools
// There is no fetch handler, so nothing here is reachable from the internet. Every write is put on a
// queue and carried out by queue(), which owns retries and failure handling.
import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
	Booking,
	BookingChange,
	BookingFilter,
	BookingRef,
	BookingsRpc,
	EndorsementGrant,
	Member,
	NewBooking,
	PositionList,
	PositionsRpc,
	RosterRpc
} from './client/api';
import { consume, type ConsumeEnv } from './consume';
import type { Job } from './jobs';
import { cachedRead } from './reads';
import {
	checkChange,
	checkMember,
	checkMembers,
	checkNewBooking,
	checkPositions,
	checkRef
} from './validate';
import {
	fromWireBooking,
	fromWireMember,
	fromWirePositions,
	toQuery,
	toWireMember,
	toWireNew,
	toWirePatch,
	type Wire
} from './wire';

// Larger lists are split into several jobs: a queue message is limited to 128 KB.
const UPSERT_CHUNK = 1000;
// replaceRoster can't be split, because pruning removes everyone not in that one request.
const MAX_REPLACE = 1200;

const queueOf = (env: Env) => env.BOOKINGS_QUEUE as unknown as Queue<Job>;
const send = async (env: Env, job: Job): Promise<void> => {
	await queueOf(env).send(job);
};

async function listBookings(env: Env, path: string): Promise<Booking[]> {
	return ((await cachedRead(env, path)) as Wire[]).map(fromWireBooking);
}

async function getPositions(env: Env): Promise<PositionList> {
	return fromWirePositions((await cachedRead(env, '/org/positions')) as Wire);
}

/** For the Community website. */
export default class Bookings extends WorkerEntrypoint<Env> implements BookingsRpc {
	listBookings(filter?: BookingFilter) {
		const query = toQuery(filter);
		return listBookings(this.env, query ? `/bookings?${query}` : '/bookings');
	}

	listOrgBookings() {
		return listBookings(this.env, '/org/bookings');
	}

	getPositions() {
		return getPositions(this.env);
	}

	createBooking(booking: NewBooking) {
		return send(this.env, { op: 'booking.create', body: toWireNew(checkNewBooking(booking)) });
	}

	updateBooking(change: BookingChange) {
		const checked = checkChange(change);
		return send(this.env, {
			op: 'booking.update',
			externalId: checked.externalId,
			patch: toWirePatch(checked)
		});
	}

	cancelBooking(ref: BookingRef) {
		return send(this.env, { op: 'booking.cancel', externalId: checkRef(ref).externalId });
	}

	queue(batch: MessageBatch<Job>) {
		return consume(batch, this.env as unknown as ConsumeEnv);
	}
}

/** For the CMS. Bind with `"entrypoint": "Positions"`. */
export class Positions extends WorkerEntrypoint<Env> implements PositionsRpc {
	getPositions() {
		return getPositions(this.env);
	}

	setPositions(callsigns: string[] | null) {
		return send(this.env, { op: 'positions.set', positions: checkPositions(callsigns) });
	}
}

/** For Training Tools. Bind with `"entrypoint": "Roster"`. */
export class Roster extends WorkerEntrypoint<Env> implements RosterRpc {
	async listMembers(): Promise<Member[]> {
		return ((await cachedRead(this.env, '/org/members')) as Wire[]).map(fromWireMember);
	}

	upsertMember(member: Member) {
		return send(this.env, {
			op: 'roster.upsert',
			members: [toWireMember(checkMember(member))],
			prune: false
		});
	}

	async upsertMembers(members: Member[]) {
		const wire = checkMembers(members, { allowEmpty: true }).map(toWireMember);
		const jobs: { body: Job }[] = [];
		for (let i = 0; i < wire.length; i += UPSERT_CHUNK) {
			jobs.push({
				body: { op: 'roster.upsert', members: wire.slice(i, i + UPSERT_CHUNK), prune: false }
			});
		}
		if (jobs.length) await queueOf(this.env).sendBatch(jobs);
	}

	replaceRoster(members: Member[]) {
		const checked = checkMembers(members, { allowEmpty: false });
		if (checked.length > MAX_REPLACE) {
			throw new Error(
				`replaceRoster takes at most ${MAX_REPLACE} members; use upsertMembers for more`
			);
		}
		return send(this.env, {
			op: 'roster.upsert',
			members: checked.map(toWireMember),
			prune: true
		});
	}

	removeMember(cid: number) {
		if (!Number.isInteger(cid) || cid <= 0) throw new Error('cid must be a positive whole number');
		return send(this.env, { op: 'roster.remove', cid: String(cid) });
	}

	async grantEndorsement(_grant: EndorsementGrant): Promise<void> {
		throw new Error(ENDORSEMENTS_UNAVAILABLE);
	}

	async revokeEndorsement(_grant: Pick<EndorsementGrant, 'cid' | 'tier'>): Promise<void> {
		throw new Error(ENDORSEMENTS_UNAVAILABLE);
	}
}

const ENDORSEMENTS_UNAVAILABLE =
	'Endorsements are not available yet: the booking system has no API-key endpoint for them';
