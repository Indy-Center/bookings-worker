import type { Job } from '../src/jobs';

export const env = {
	BOOKING_API_URL: 'https://booking.test/api',
	BOOKING_API_KEY: 'test-key'
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});
}

/** A fetch that answers with each response in turn and records the requests. */
export function fakeFetch(...responses: (Response | Error)[]) {
	const calls: { url: string; init: RequestInit }[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const next = responses.shift();
		if (!next) throw new Error('Unexpected request');
		if (next instanceof Error) throw next;
		return next;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

export function fakeMessage(body: Job, attempts = 1) {
	const state = { acked: false, retried: undefined as undefined | { delaySeconds?: number } };
	return {
		state,
		message: {
			body,
			attempts,
			ack: () => {
				state.acked = true;
			},
			retry: (options?: { delaySeconds?: number }) => {
				state.retried = options ?? {};
			}
		}
	};
}

export function batchOf(...messages: ReturnType<typeof fakeMessage>[]) {
	return { messages: messages.map((m) => m.message) } as unknown as MessageBatch<Job>;
}

export function fakeCache() {
	const store = new Map<string, Response>();
	return {
		match: async (req: Request) => store.get(req.url)?.clone(),
		put: async (req: Request, res: Response) => {
			store.set(req.url, res);
		}
	};
}

export const createJob: Job = {
	op: 'booking.create',
	body: {
		externalId: 'abc',
		cid: '1234567',
		callsign: 'IND_TWR',
		type: 'booking',
		start: '2026-12-01T18:00:00.000Z',
		end: '2026-12-01T20:00:00.000Z'
	}
};
