import type { BookingChange, BookingRef, BookingType, Member, NewBooking } from './client/api';

const SUFFIXES = ['DEL', 'GND', 'TWR', 'APP', 'DEP', 'CTR', 'FSS', 'RMP', 'TMU', 'FMP', 'RDO'];
const CALLSIGN = new RegExp(`^[A-Z0-9]+(_[A-Z0-9]+)*_(${SUFFIXES.join('|')})$`);
const TYPES: BookingType[] = ['booking', 'event', 'exam', 'training'];
const MAX_HOURS = 13;
const MAX_DAYS_AHEAD = 180;
const MAX_ROSTER = 5000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fail(message: string): never {
	throw new Error(message);
}

function object(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== 'object') fail(`Expected ${what} to be an object`);
	return value as Record<string, unknown>;
}

function checkCid(cid: unknown): number {
	if (typeof cid !== 'number' || !Number.isInteger(cid) || cid <= 0) {
		fail('cid must be a positive whole number');
	}
	return cid;
}

export function checkCallsign(callsign: unknown): string {
	if (typeof callsign !== 'string' || !CALLSIGN.test(callsign)) {
		fail(
			`callsign must be capital letters, digits and underscores ending in one of _${SUFFIXES.join(', _')}`
		);
	}
	return callsign;
}

function checkType(type: unknown): BookingType {
	if (!TYPES.includes(type as BookingType)) fail(`type must be one of ${TYPES.join(', ')}`);
	return type as BookingType;
}

function checkDate(value: unknown, field: string): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime()))
		fail(`${field} must be a valid Date`);
	return value;
}

export function checkExternalId(id: unknown): string {
	if (typeof id !== 'string' || id.length < 1 || id.length > 64) {
		fail('externalId must be 1 to 64 characters');
	}
	return id;
}

function checkWindow(start: Date, end: Date, now: Date) {
	const length = end.getTime() - start.getTime();
	if (length <= 0) fail('end must be after start');
	if (length > MAX_HOURS * HOUR) fail(`A booking can be at most ${MAX_HOURS} hours`);
	if (start.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY) {
		fail(`start must be within the next ${MAX_DAYS_AHEAD} days`);
	}
}

export function checkNewBooking(input: unknown, now = new Date()): NewBooking {
	const b = object(input, 'the booking');
	const start = checkDate(b.start, 'start');
	const end = checkDate(b.end, 'end');
	checkWindow(start, end, now);
	return {
		externalId: checkExternalId(b.externalId),
		cid: checkCid(b.cid),
		callsign: checkCallsign(b.callsign),
		type: b.type === undefined ? undefined : checkType(b.type),
		start,
		end
	};
}

export function checkChange(input: unknown, now = new Date()): BookingChange {
	const c = object(input, 'the change');
	const change: BookingChange = { externalId: checkExternalId(c.externalId) };
	if (c.callsign !== undefined) change.callsign = checkCallsign(c.callsign);
	if (c.type !== undefined) change.type = checkType(c.type);
	if (c.start !== undefined) change.start = checkDate(c.start, 'start');
	if (c.end !== undefined) change.end = checkDate(c.end, 'end');
	if (change.start && change.end) checkWindow(change.start, change.end, now);
	if (Object.keys(change).length === 1)
		fail('A change needs at least one field besides externalId');
	return change;
}

export function checkRef(input: unknown): BookingRef {
	return { externalId: checkExternalId(object(input, 'the booking reference').externalId) };
}

export function checkMember(input: unknown): Member {
	const m = object(input, 'the member');
	if (typeof m.rating !== 'number' || !Number.isInteger(m.rating) || m.rating < 1) {
		fail('rating must be a whole number, 1 (OBS) or higher');
	}
	if (m.role !== undefined && m.role !== 'member' && m.role !== 'manager') {
		fail("role must be 'member' or 'manager'");
	}
	return {
		cid: checkCid(m.cid),
		rating: m.rating,
		role: m.role,
		isHome: typeof m.isHome === 'boolean' ? m.isHome : undefined,
		isMentor: typeof m.isMentor === 'boolean' ? m.isMentor : undefined
	};
}

export function checkMembers(input: unknown, { allowEmpty }: { allowEmpty: boolean }): Member[] {
	if (!Array.isArray(input)) fail('members must be an array');
	if (input.length === 0 && !allowEmpty) fail('Refusing an empty roster');
	if (input.length > MAX_ROSTER) fail(`At most ${MAX_ROSTER} members at a time`);
	const members = input.map(checkMember);
	if (new Set(members.map((m) => m.cid)).size !== members.length) fail('Duplicate cid in members');
	return members;
}

export function checkPositions(input: unknown): string[] | null {
	if (input === null) return null;
	if (!Array.isArray(input)) fail('callsigns must be an array, or null to remove the list');
	const callsigns = input.map(checkCallsign);
	if (new Set(callsigns).size !== callsigns.length) fail('Duplicate callsign in the list');
	return callsigns;
}
