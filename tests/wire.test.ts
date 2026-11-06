import { describe, expect, it } from 'vitest';
import {
	fromWireBooking,
	fromWireMember,
	fromCmsPositions,
	parseUtc,
	toQuery,
	toWireNew
} from '../src/wire';

describe('wire mapping', () => {
	it('reads both of the booking API time formats as UTC', () => {
		expect(parseUtc('2026-09-20T18:00:00.000Z').toISOString()).toBe('2026-09-20T18:00:00.000Z');
		expect(parseUtc('2026-09-20 18:00:00').toISOString()).toBe('2026-09-20T18:00:00.000Z');
		expect(() => parseUtc('soon')).toThrow();
	});

	it('normalizes a booking: numeric CID, Date times, mentoring becomes training', () => {
		const b = fromWireBooking({
			id: 7,
			cid: '1234567',
			callsign: 'IND_TWR',
			type: 'mentoring',
			start: '2026-12-01T18:00:00.000Z',
			end: '2026-12-01T20:00:00.000Z',
			division: 'USA',
			createdAt: 'x'
		});
		expect(b).toEqual({
			id: 7,
			externalId: null,
			cid: 1234567,
			callsign: 'IND_TWR',
			type: 'training',
			start: new Date('2026-12-01T18:00:00.000Z'),
			end: new Date('2026-12-01T20:00:00.000Z')
		});
	});

	it('sends the CID as a string, defaults the type and omits division and subdivision', () => {
		const wire = toWireNew({
			externalId: 'a',
			cid: 1234567,
			callsign: 'IND_TWR',
			start: new Date('2026-12-01T18:00:00Z'),
			end: new Date('2026-12-01T20:00:00Z')
		});
		expect(wire).toMatchObject({ cid: '1234567', type: 'booking' });
		expect(wire).not.toHaveProperty('division');
	});

	it('builds a stable query', () => {
		expect(toQuery({ when: 'future', callsign: 'IND' })).toBe('callsign=IND&order=future');
		expect(toQuery()).toBe('');
	});

	it('fills roster and position defaults', () => {
		expect(fromWireMember({ cid: '1', rating: 5 })).toEqual({
			cid: 1,
			rating: 5,
			role: 'member',
			isHome: true,
			isMentor: false
		});
	});

	it('reads the CMS positions feed, leaving out retired positions', () => {
		const feed = [
			{
				id: '01X',
				callsign: 'AID_GND',
				name: 'Ground Control',
				shortName: 'AID GC',
				radioName: 'Anderson Ground',
				frequency: 121600000,
				facility: {
					id: 'AID',
					name: 'Anderson Muni ATCT',
					parent: { id: 'IND', name: 'Indianapolis ATCT/TRACON' }
				},
				starred: true,
				requiredCredentials: [{ anyOf: ['A-GC'] }],
				retired: false
			},
			{
				callsign: 'CMH_EM_APP',
				name: 'CMH GUARD',
				radioName: 'Columbus Approach',
				frequency: 121500000,
				facility: { id: 'CMH', name: 'Columbus ATCT/TRACON', parent: null },
				requiredCredentials: [],
				retired: false
			},
			{ callsign: 'OLD_TWR', retired: true }
		];
		expect(fromCmsPositions(feed)).toEqual([
			{
				callsign: 'AID_GND',
				name: 'Ground Control',
				radioName: 'Anderson Ground',
				frequency: 121600000,
				facility: {
					id: 'AID',
					name: 'Anderson Muni ATCT',
					parent: { id: 'IND', name: 'Indianapolis ATCT/TRACON' }
				},
				starred: true,
				requiredCredentials: [{ anyOf: ['A-GC'] }]
			},
			{
				callsign: 'CMH_EM_APP',
				name: 'CMH GUARD',
				radioName: 'Columbus Approach',
				frequency: 121500000,
				facility: { id: 'CMH', name: 'Columbus ATCT/TRACON', parent: null },
				starred: false,
				requiredCredentials: []
			}
		]);
		expect(() => fromCmsPositions({ positions: [] })).toThrow(/not a list/);
	});
});
