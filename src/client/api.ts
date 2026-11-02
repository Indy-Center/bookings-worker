// src/client/api.ts

/** What a booking is for. */
export type BookingType = 'booking' | 'event' | 'exam' | 'training';

/** A booking, as callers see it. Only the fields Indy Center uses. */
export type Booking = {
	/** The booking system's own number. */
	id: number;
	/** The caller's ID for it, if it was made with one. Every booking Indy Center makes has one. */
	externalId: string | null;
	/** The controller's VATSIM CID. */
	cid: number;
	/** e.g. `IND_TWR`. */
	callsign: string;
	type: BookingType;
	/** UTC. */
	start: Date;
	end: Date;
};

export type BookingFilter = {
	/** Partial match. */
	callsign?: string;
	type?: BookingType;
	/** Bookings starting after this. */
	from?: Date;
	/** Bookings ending before this. */
	to?: Date;
	when?: 'current' | 'future' | 'past';
};

/**
 * A booking to make. The worker checks the shape (callsign format, end after start, at most 13 hours,
 * start within 180 days) before queueing; the booking system then decides eligibility (bookable
 * position, rating, overlap).
 */
export type NewBooking = {
	/**
	 * Your own ID for this booking, 1 to 64 characters, unique across Indy Center bookings, e.g. the
	 * booking's row ID. It is how you update and cancel the booking, and it makes a retry safe: the
	 * same ID never makes two bookings.
	 */
	externalId: string;
	cid: number;
	callsign: string;
	/** Defaults to `'booking'`. */
	type?: BookingType;
	start: Date;
	end: Date;
};

/** Changes to a booking made with an `externalId`. Leave out what stays the same. */
export type BookingChange = {
	externalId: string;
	callsign?: string;
	type?: BookingType;
	start?: Date;
	end?: Date;
};

export type BookingRef = { externalId: string };

/** A position controllers may book. */
export type Position = {
	callsign: string;
	/** Endorsements (restrictions) that cover it; empty means only the rating applies. */
	requires: { name: string; tier: string }[];
};

export type PositionList = {
	/** False when no list is set, which means any valid callsign may be booked. */
	restricted: boolean;
	positions: Position[];
};

export type RosterRole = 'member' | 'manager';

/** One controller on the roster. The roster decides who can sign in to the booking portal and who can book. */
export type Member = {
	cid: number;
	/** VATSIM rating number, 1 (OBS) or higher. */
	rating: number;
	/** Defaults to `'member'`. */
	role?: RosterRole;
	/** Defaults to true. */
	isHome?: boolean;
	/** Mentors and instructors may book training and exams for others. Defaults to false. */
	isMentor?: boolean;
};

/** Endorsement tiers the booking system knows. */
export type EndorsementTier = 'T1' | 'T2' | 'SUPERCENTER';

/**
 * The booking system has no API-key endpoint for endorsements yet (see the README), so
 * grantEndorsement() and revokeEndorsement() throw. This is the contract the Training Tools side can
 * code against until it does.
 */
export type EndorsementGrant = {
	cid: number;
	tier: EndorsementTier;
	/** Leave out for permanent. */
	expiresAt?: Date;
};

/**
 * How the worker handles failure, for every method below.
 *
 * Writes return once **queued**. Nobody should wait for or handle the booking system's answer: the
 * worker retries rate limits, outages and network errors with backoff, and drops what the booking
 * system permanently refuses (overlap, ineligible controller or position, wrong organization),
 * logging it and, when configured, alerting a staff channel through Larry. A request the worker can
 * tell is malformed throws before anything is queued.
 *
 * Reads return data. They are cached for 30 seconds, and when the booking system is down they serve
 * the last copy they had, up to an hour old. With nothing to serve they throw.
 */

/** For the Community website: everything about bookings themselves. The default entrypoint. */
export interface BookingsRpc extends Rpc.WorkerEntrypointBranded {
	listBookings(filter?: BookingFilter): Promise<Booking[]>;
	/** All of Indy Center's bookings, including ones made outside this worker. */
	listOrgBookings(): Promise<Booking[]>;
	/** The bookable positions, for building a booking form. */
	getPositions(): Promise<PositionList>;
	/** Queue a booking. Idempotent on `externalId`. Throws only if the request is malformed. */
	createBooking(booking: NewBooking): Promise<void>;
	/** Queue a change to a booking made with `externalId`. */
	updateBooking(change: BookingChange): Promise<void>;
	/** Queue a cancellation. A booking that is already gone counts as cancelled. */
	cancelBooking(ref: BookingRef): Promise<void>;
}

/** For the CMS: the list of bookable positions. Bind with `"entrypoint": "Positions"`. */
export interface PositionsRpc extends Rpc.WorkerEntrypointBranded {
	getPositions(): Promise<PositionList>;
	/**
	 * Queue a replacement of the **whole** list. Send every position every time, because anything left
	 * out stops being bookable. `null` removes the list, so any valid callsign may be booked. If any
	 * callsign is invalid the booking system saves nothing, and the worker logs and alerts.
	 */
	setPositions(callsigns: string[] | null): Promise<void>;
}

/** For Training Tools: the roster and endorsements. Bind with `"entrypoint": "Roster"`. */
export interface RosterRpc extends Rpc.WorkerEntrypointBranded {
	listMembers(): Promise<Member[]>;
	/** Queue adding or updating one controller. */
	upsertMember(member: Member): Promise<void>;
	/** Queue adding or updating many (up to 5000). Controllers not listed are left alone. */
	upsertMembers(members: Member[]): Promise<void>;
	/**
	 * Queue making the roster **exactly** this list: everyone not listed is removed (portal admins are
	 * never removed). Refuses an empty list, so a bug can't wipe the roster.
	 */
	replaceRoster(members: Member[]): Promise<void>;
	/** Queue removing one controller. */
	removeMember(cid: number): Promise<void>;
	/** Not available yet; throws. See {@link EndorsementGrant}. */
	grantEndorsement(grant: EndorsementGrant): Promise<void>;
	/** Not available yet; throws. */
	revokeEndorsement(grant: Pick<EndorsementGrant, 'cid' | 'tier'>): Promise<void>;
}

/** Binding types for a caller's `Env`: `BOOKINGS: BookingsBinding`. Note `Service<>` comes from `@cloudflare/workers-types`. */
export type BookingsBinding = Service<BookingsRpc>;
export type PositionsBinding = Service<PositionsRpc>;
export type RosterBinding = Service<RosterRpc>;
