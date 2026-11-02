import type { UpstreamRequest } from './upstream';
import type { Wire } from './wire';

/** One write, as it sits on the `bookings-jobs` queue. Already checked, and already in the booking API's shape. */
export type Job =
	| { op: 'booking.create'; body: Wire }
	| { op: 'booking.update'; externalId: string; patch: Wire }
	| { op: 'booking.cancel'; externalId: string }
	| { op: 'positions.set'; positions: string[] | null }
	| { op: 'roster.upsert'; members: Wire[]; prune: boolean }
	| { op: 'roster.remove'; cid: string };

const external = (id: string) => `/bookings/external/${encodeURIComponent(id)}`;

/**
 * The positions body. Kept in one place because the booking docs show the list's shape only in what
 * it returns; if the booking system wants objects (`{ callsign }`) instead of strings, change it here.
 */
function positionsBody(positions: string[] | null) {
	return { positions };
}

export function toRequest(job: Job): UpstreamRequest {
	switch (job.op) {
		case 'booking.create':
			return { method: 'POST', path: '/bookings/external', body: job.body };
		case 'booking.update':
			return { method: 'PUT', path: external(job.externalId), body: job.patch };
		case 'booking.cancel':
			return { method: 'DELETE', path: external(job.externalId) };
		case 'positions.set':
			return { method: 'PUT', path: '/org/positions', body: positionsBody(job.positions) };
		case 'roster.upsert':
			return {
				method: 'PUT',
				path: '/org/members',
				body: { members: job.members, prune: job.prune }
			};
		case 'roster.remove':
			return { method: 'DELETE', path: `/org/members/${encodeURIComponent(job.cid)}` };
	}
}

/** A short line saying what a job was, for logs and alerts. No secrets in it. */
export function describeJob(job: Job): string {
	switch (job.op) {
		case 'booking.create':
			return `create booking ${job.body.callsign} for CID ${job.body.cid} (${job.body.start} to ${job.body.end}, externalId ${job.body.externalId})`;
		case 'booking.update':
			return `update booking (externalId ${job.externalId})`;
		case 'booking.cancel':
			return `cancel booking (externalId ${job.externalId})`;
		case 'positions.set':
			return job.positions === null
				? 'remove the bookable positions list'
				: `set ${job.positions.length} bookable positions`;
		case 'roster.upsert':
			return `${job.prune ? 'replace the roster with' : 'update'} ${job.members.length} roster members`;
		case 'roster.remove':
			return `remove CID ${job.cid} from the roster`;
	}
}
