import { describe, expect, it } from 'vitest';
import {
	checkChange,
	checkMembers,
	checkNewBooking,
	checkPositions,
	checkRef
} from '../src/validate';

const now = new Date('2026-12-01T00:00:00Z');
const good = {
	externalId: 'abc',
	cid: 1234567,
	callsign: 'IND_TWR',
	start: new Date('2026-12-02T18:00:00Z'),
	end: new Date('2026-12-02T20:00:00Z')
};

describe('checkNewBooking', () => {
	it('accepts a good booking', () => {
		expect(checkNewBooking(good, now).callsign).toBe('IND_TWR');
	});

	it.each([
		['lowercase callsign', { callsign: 'ind_twr' }],
		['callsign without a position suffix', { callsign: 'IND_XYZ' }],
		['bare suffix', { callsign: 'TWR' }],
		['empty external ID', { externalId: '' }],
		['external ID over 64 characters', { externalId: 'x'.repeat(65) }],
		['string CID', { cid: '123' }],
		['zero CID', { cid: 0 }],
		['unknown type', { type: 'mentoring' }],
		['end before start', { end: new Date('2026-12-02T17:00:00Z') }],
		['over 13 hours', { end: new Date('2026-12-03T08:00:00Z') }],
		[
			'start more than 180 days out',
			{ start: new Date('2027-07-01T00:00:00Z'), end: new Date('2027-07-01T01:00:00Z') }
		],
		['invalid date', { start: new Date('nope') }]
	])('rejects %s', (_name, patch) => {
		expect(() => checkNewBooking({ ...good, ...patch }, now)).toThrow();
	});

	it('accepts multi-part callsigns', () => {
		expect(checkNewBooking({ ...good, callsign: 'LLBG_D_APP' }, now).callsign).toBe('LLBG_D_APP');
	});
});

describe('checkChange and checkRef', () => {
	it('needs something to change', () => {
		expect(() => checkChange({ externalId: 'abc' }, now)).toThrow(/at least one field/);
		expect(checkChange({ externalId: 'abc', end: new Date() }, now).end).toBeInstanceOf(Date);
	});

	it('checks the window only when both times are given', () => {
		expect(() =>
			checkChange(
				{
					externalId: 'a',
					start: new Date('2026-12-02T20:00:00Z'),
					end: new Date('2026-12-02T18:00:00Z')
				},
				now
			)
		).toThrow();
	});

	it('requires an external ID', () => {
		expect(() => checkRef({})).toThrow();
		expect(checkRef({ externalId: 'a' })).toEqual({ externalId: 'a' });
	});
});

describe('checkMembers', () => {
	it('refuses an empty list when asked to, so a bug cannot wipe the roster', () => {
		expect(() => checkMembers([], { allowEmpty: false })).toThrow(/empty/);
		expect(checkMembers([], { allowEmpty: true })).toEqual([]);
	});

	it('refuses duplicates, bad ratings and bad roles', () => {
		expect(() =>
			checkMembers(
				[
					{ cid: 1, rating: 5 },
					{ cid: 1, rating: 5 }
				],
				{ allowEmpty: true }
			)
		).toThrow(/Duplicate/);
		expect(() => checkMembers([{ cid: 1, rating: 0 }], { allowEmpty: true })).toThrow();
		expect(() =>
			checkMembers([{ cid: 1, rating: 5, role: 'admin' }], { allowEmpty: true })
		).toThrow();
	});
});

describe('checkPositions', () => {
	it('allows null to remove the list, and rejects bad or repeated callsigns', () => {
		expect(checkPositions(null)).toBeNull();
		expect(checkPositions(['IND_TWR', 'IND_APP'])).toHaveLength(2);
		expect(() => checkPositions(['IND_TWR', 'IND_TWR'])).toThrow();
		expect(() => checkPositions(['nope'])).toThrow();
	});
});
