import type {
	Booking,
	BookingChange,
	BookingFilter,
	BookingType,
	Member,
	NewBooking,
	PositionList
} from './client/api';

/** The booking API's JSON, loosely typed: we only read what we pass on, and tolerate the rest. */
export type Wire = Record<string, unknown>;

/**
 * Parse a time from the booking API: ISO 8601, or `YYYY-MM-DD HH:MM:SS` in UTC (what its change feed
 * uses).
 */
export function parseUtc(value: unknown): Date {
	const text = String(value);
	const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
		? new Date(`${text.replace(' ', 'T')}Z`)
		: new Date(text);
	if (Number.isNaN(date.getTime())) throw new Error(`Booking API sent an unreadable time: ${text}`);
	return date;
}

function bookingType(value: unknown): BookingType {
	// The change feed calls training sessions "mentoring".
	if (value === 'mentoring') return 'training';
	if (value === 'event' || value === 'exam' || value === 'training') return value;
	return 'booking';
}

export function fromWireBooking(w: Wire): Booking {
	return {
		id: Number(w.id),
		externalId: typeof w.externalId === 'string' ? w.externalId : null,
		cid: Number(w.cid),
		callsign: String(w.callsign),
		type: bookingType(w.type),
		start: parseUtc(w.start),
		end: parseUtc(w.end)
	};
}

export function toWireNew(b: NewBooking): Wire {
	return {
		externalId: b.externalId,
		cid: String(b.cid),
		callsign: b.callsign,
		type: b.type ?? 'booking',
		start: b.start.toISOString(),
		end: b.end.toISOString()
	};
}

export function toWirePatch(c: BookingChange): Wire {
	const patch: Wire = {};
	if (c.callsign !== undefined) patch.callsign = c.callsign;
	if (c.type !== undefined) patch.type = c.type;
	if (c.start !== undefined) patch.start = c.start.toISOString();
	if (c.end !== undefined) patch.end = c.end.toISOString();
	return patch;
}

export function toQuery(filter: BookingFilter = {}): string {
	const q = new URLSearchParams();
	if (filter.callsign) q.set('callsign', filter.callsign);
	if (filter.type) q.set('type', filter.type);
	if (filter.from) q.set('startDate', filter.from.toISOString());
	if (filter.to) q.set('endDate', filter.to.toISOString());
	if (filter.when) q.set('order', filter.when);
	q.sort();
	return q.toString();
}

export function toWireMember(m: Member): Wire {
	const wire: Wire = { cid: String(m.cid), rating: m.rating };
	if (m.role !== undefined) wire.role = m.role;
	if (m.isHome !== undefined) wire.isHome = m.isHome;
	if (m.isMentor !== undefined) wire.isMentor = m.isMentor;
	return wire;
}

export function fromWireMember(w: Wire): Member {
	return {
		cid: Number(w.cid),
		rating: Number(w.rating),
		role: w.role === 'manager' ? 'manager' : 'member',
		isHome: w.isHome !== false,
		isMentor: w.isMentor === true
	};
}

export function fromWirePositions(w: Wire): PositionList {
	const positions = Array.isArray(w.positions) ? (w.positions as Wire[]) : [];
	return {
		restricted: w.restricted === true,
		positions: positions.map((p) => ({
			callsign: String(p.callsign),
			requires: (Array.isArray(p.requires) ? (p.requires as Wire[]) : []).map((r) => ({
				name: String(r.name),
				tier: String(r.tier)
			}))
		}))
	};
}
