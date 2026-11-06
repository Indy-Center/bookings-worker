import { call, getJson, type Outcome, type UpstreamEnv } from './upstream';

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
 * Load through `load`, returning its data as-is. Served from cache for 30 seconds. When the source
 * is down, serves the last copy we saw, up to an hour old, instead of failing. `source` names the
 * system in error messages.
 */
async function cached(
	key: string,
	source: string,
	load: () => Promise<Outcome>,
	cache: CacheLike
): Promise<unknown> {
	const fresh = await cache.match(keyFor('fresh', key));
	if (fresh) return fresh.json();

	const outcome = await load();
	if (outcome.ok) {
		await Promise.all([
			cache.put(keyFor('fresh', key), entry(outcome.data, FRESH_SECONDS)),
			cache.put(keyFor('stale', key), entry(outcome.data, STALE_SECONDS))
		]);
		return outcome.data;
	}

	if (outcome.kind === 'rejected') {
		throw new Error(`${source} refused the request: ${outcome.message}`);
	}
	const stale = await cache.match(keyFor('stale', key));
	if (stale) {
		console.warn(`Serving a saved copy of ${key}: ${outcome.message}`);
		return stale.json();
	}
	throw new Error(`${source} is unavailable and there is no saved copy: ${outcome.message}`);
}

/** GET from the booking API, returning its `data` as-is. */
export function cachedRead(
	env: UpstreamEnv,
	path: string,
	cache: CacheLike = caches.default,
	fetchImpl: typeof fetch = fetch
): Promise<unknown> {
	return cached(
		path,
		'The booking system',
		() => call(env, { method: 'GET', path }, fetchImpl),
		cache
	);
}

/** GET the CMS positions feed (a public URL, no key), returning the JSON as-is. */
export function cachedPositionsFeed(
	url: string,
	cache: CacheLike = caches.default,
	fetchImpl: typeof fetch = fetch
): Promise<unknown> {
	return cached(url, 'The CMS', () => getJson(url, fetchImpl), cache);
}
