import { call, type UpstreamEnv } from './upstream';

export type CacheLike = Pick<Cache, 'match' | 'put'>;

const FRESH_SECONDS = 30;
const STALE_SECONDS = 3600;

// Cache keys have to be URLs; this host is never contacted.
const keyFor = (kind: 'fresh' | 'stale', path: string) =>
	new Request(`https://cache.bookings.invalid/${kind}/${encodeURIComponent(path)}`);

function entry(data: unknown, seconds: number) {
	return new Response(JSON.stringify(data), { headers: { 'Cache-Control': `max-age=${seconds}` } });
}

/**
 * GET from the booking API, returning its `data` as-is. Served from cache for 30 seconds. When the
 * booking system is down, serves the last copy we saw, up to an hour old, instead of failing.
 */
export async function cachedRead(
	env: UpstreamEnv,
	path: string,
	cache: CacheLike = caches.default,
	fetchImpl: typeof fetch = fetch
): Promise<unknown> {
	const fresh = await cache.match(keyFor('fresh', path));
	if (fresh) return fresh.json();

	const outcome = await call(env, { method: 'GET', path }, fetchImpl);
	if (outcome.ok) {
		await Promise.all([
			cache.put(keyFor('fresh', path), entry(outcome.data, FRESH_SECONDS)),
			cache.put(keyFor('stale', path), entry(outcome.data, STALE_SECONDS))
		]);
		return outcome.data;
	}

	if (outcome.kind === 'rejected') {
		throw new Error(`The booking system refused the request: ${outcome.message}`);
	}
	const stale = await cache.match(keyFor('stale', path));
	if (stale) {
		console.warn(`Serving a saved copy of ${path}: ${outcome.message}`);
		return stale.json();
	}
	throw new Error(
		`The booking system is unavailable and there is no saved copy: ${outcome.message}`
	);
}
