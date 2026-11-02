import { describe, expect, it } from 'vitest';
import {
	fromWireBooking,
	fromWireMember,
	fromWirePositions,
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
		expect(
			fromWirePositions({
				restricted: true,
				positions: [
					{ callsign: 'IND_TWR', requires: [{ id: 1, name: 'Tower', tier: 'T1' }] },
					{ callsign: 'IND_GND' }
				]
			})
		).toEqual({
			restricted: true,
			positions: [
				{ callsign: 'IND_TWR', requires: [{ name: 'Tower', tier: 'T1' }] },
				{ callsign: 'IND_GND', requires: [] }
			]
		});
	});
});
