import type { Wire } from './wire';

export type UpstreamEnv = { BOOKING_API_URL: string; BOOKING_API_KEY: string };

export type UpstreamRequest = {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	/** Path under the base URL, e.g. `/org/bookings`. */
	path: string;
	body?: unknown;
};

/**
 * What the booking API said, sorted by what the worker does about it:
 * - `retry`: not the request's fault (429, 5xx, network, bad key); try again later.
 * - `not_found`: the booking or member isn't there (yet).
 * - `rejected`: the booking system refuses this request and always will. Drop it.
 */
export type Outcome =
	| { ok: true; data: unknown }
	| { ok: false; kind: 'retry'; message: string; retryAfterSec?: number }
	| { ok: false; kind: 'not_found'; message: string }
	| { ok: false; kind: 'rejected'; message: string };

/** The booking API's own words for a failure: its message plus any field errors. */
function describe(status: number, body: Wire | null): string {
	const message = typeof body?.message === 'string' ? body.message : `HTTP ${status}`;
	const errors = body?.errors;
	if (errors && typeof errors === 'object') {
		const fields = Object.entries(errors as Record<string, unknown>)
			.map(([field, list]) => `${field}: ${Array.isArray(list) ? list.join('; ') : String(list)}`)
			.join(' | ');
		if (fields) return `${message} (${fields})`;
	}
	return message;
}

/** Seconds to wait, from `RateLimit-Reset` or `Retry-After`. */
function retryAfter(headers: Headers): number | undefined {
	for (const name of ['RateLimit-Reset', 'Retry-After']) {
		const seconds = Number(headers.get(name));
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
	}
	return undefined;
}

export function classify(status: number, body: Wire | null, headers: Headers): Outcome {
	const message = describe(status, body);
	if (status === 429)
		return { ok: false, kind: 'retry', message, retryAfterSec: retryAfter(headers) };
	// 401 and 403 mean our key is wrong or revoked: not the request's fault, and a retry after the
	// key is fixed will work, so keep it (it lands in the dead-letter queue if it never does).
	if (status >= 500 || status === 401 || status === 403 || status === 408) {
		return { ok: false, kind: 'retry', message };
	}
	if (status === 404) return { ok: false, kind: 'not_found', message };
	return { ok: false, kind: 'rejected', message };
}

/**
 * GET a public JSON endpoint that needs no key and has no `{ success, data }` envelope (the CMS
 * positions feed). Never throws; sorted into an {@link Outcome} like `call`.
 */
export async function getJson(url: string, fetchImpl: typeof fetch = fetch): Promise<Outcome> {
	let response: Response;
	try {
		response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
	} catch (error) {
		return { ok: false, kind: 'retry', message: `Network error: ${(error as Error).message}` };
	}
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// Not JSON, e.g. an error page from a proxy.
	}
	if (!response.ok) {
		const wire = body && typeof body === 'object' ? (body as Wire) : null;
		return classify(response.status, wire, response.headers);
	}
	if (body === null) return { ok: false, kind: 'retry', message: 'Unreadable response' };
	return { ok: true, data: body };
}

/** Call the booking API. Never throws; network trouble comes back as `retry`. */
export async function call(
	env: UpstreamEnv,
	req: UpstreamRequest,
	fetchImpl: typeof fetch = fetch
): Promise<Outcome> {
	const url = `${env.BOOKING_API_URL.replace(/\/+$/, '')}${req.path}`;
	const headers: Record<string, string> = {
		Accept: 'application/json',
		Authorization: `Bearer ${env.BOOKING_API_KEY}`
	};
	if (req.body !== undefined) headers['Content-Type'] = 'application/json';

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: req.method,
			headers,
			body: req.body === undefined ? undefined : JSON.stringify(req.body)
		});
	} catch (error) {
		return { ok: false, kind: 'retry', message: `Network error: ${(error as Error).message}` };
	}

	if (response.status === 204) return { ok: true, data: null };

	let body: Wire | null = null;
	try {
		body = (await response.json()) as Wire;
	} catch {
		// Not JSON, e.g. an error page from a proxy. Fall through to status handling.
	}

	if (!response.ok) return classify(response.status, body, response.headers);
	if (!body || body.success === false) {
		return { ok: false, kind: 'retry', message: 'Booking API sent an unreadable response' };
	}
	return { ok: true, data: body.data };
}
