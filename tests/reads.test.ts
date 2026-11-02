import { describe, expect, it } from 'vitest';
import { cachedRead } from '../src/reads';
import { env, fakeCache, fakeFetch, json } from './helpers';

describe('cachedRead', () => {
	it('serves a repeat read from cache without calling the API again', async () => {
		const cache = fakeCache();
		const f = fakeFetch(json(200, { success: true, data: [{ id: 1 }] }));
		expect(await cachedRead(env, '/org/bookings', cache, f.impl)).toEqual([{ id: 1 }]);
		expect(await cachedRead(env, '/org/bookings', cache, f.impl)).toEqual([{ id: 1 }]);
		expect(f.calls).toHaveLength(1);
	});

	it('serves the last saved copy when the booking system is down', async () => {
		const cache = fakeCache();
		await cachedRead(
			env,
			'/org/bookings',
			cache,
			fakeFetch(json(200, { success: true, data: ['old'] })).impl
		);
		// Drop the fresh copy, as if its 30 seconds had passed.
		const stale = await cache.match(
			new Request(`https://cache.bookings.invalid/stale/${encodeURIComponent('/org/bookings')}`)
		);
		const down = {
			match: async (req: Request) => (req.url.includes('/stale/') ? stale?.clone() : undefined),
			put: cache.put
		};
		const f = fakeFetch(json(503, { success: false, message: 'down' }));
		expect(await cachedRead(env, '/org/bookings', down, f.impl)).toEqual(['old']);
	});

	it('throws when the booking system is down and nothing was saved', async () => {
		const f = fakeFetch(new Error('offline'));
		await expect(cachedRead(env, '/org/bookings', fakeCache(), f.impl)).rejects.toThrow(
			/unavailable/
		);
	});

	it('throws, rather than serving old data, when the request itself is refused', async () => {
		const f = fakeFetch(json(400, { success: false, message: 'bad filter' }));
		await expect(cachedRead(env, '/bookings?type=x', fakeCache(), f.impl)).rejects.toThrow(
			/bad filter/
		);
	});
});
