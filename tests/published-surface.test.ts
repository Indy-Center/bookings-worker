// Smoke test that the emitted dist surface is what we expect. Imports from `../dist` (built by
// `npm run build:lib`, which runs before `npm test`) so it exercises what consumers receive.
//
// If this file fails to compile, the package contract is broken.

import { describe, expect, it } from 'vitest';
import type {
	Booking,
	BookingsBinding,
	BookingsRpc,
	Member,
	NewBooking,
	PositionList,
	PositionsBinding,
	RosterBinding
} from '../dist';

describe('published surface', () => {
	it('exposes the expected types', () => {
		const booking: NewBooking = {
			externalId: 'abc',
			cid: 1234567,
			callsign: 'IND_TWR',
			start: new Date(),
			end: new Date()
		};
		const member: Member = { cid: 1234567, rating: 5, isMentor: true };
		const positions: PositionList = { restricted: false, positions: [] };
		const rpc = { async createBooking() {} } as unknown as BookingsRpc;
		// The bindings can't be constructed but should be nameable.
		type _types = [Booking, BookingsBinding, PositionsBinding, RosterBinding];
		expect([booking, member, positions, rpc]).toHaveLength(4);
	});
});
