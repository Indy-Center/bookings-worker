import { describe, expect, it, vi } from 'vitest';
import { MAX_RETRIES, backoff, consume } from '../src/consume';
import { batchOf, createJob, env, fakeFetch, fakeMessage, json } from './helpers';

const alerts = () => {
	const enqueue = vi.fn(async () => {});
	return {
		enqueue,
		env: { ...env, FAILURE_ALERT_CHANNEL: 'tech-team-alerts', LARRY: { enqueue } }
	};
};

describe('consume', () => {
	it('acks a booking that was made, using the external endpoint', async () => {
		const m = fakeMessage(createJob);
		const f = fakeFetch(json(201, { success: true, data: { id: 1 } }));
		await consume(batchOf(m), env, f.impl);
		expect(m.state.acked).toBe(true);
		expect(f.calls[0]?.url).toBe('https://booking.test/api/bookings/external');
		expect(f.calls[0]?.init.method).toBe('POST');
		expect((f.calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
			'Bearer test-key'
		);
	});

	it('drops and alerts on an overlap, without retrying', async () => {
		const a = alerts();
		const m = fakeMessage(createJob);
		const f = fakeFetch(
			json(400, {
				success: false,
				message: 'Booking overlaps with existing booking for this callsign'
			})
		);
		await consume(batchOf(m), a.env, f.impl);
		expect(m.state.acked).toBe(true);
		expect(m.state.retried).toBeUndefined();
		expect(a.enqueue).toHaveBeenCalledOnce();
		const sent = (
			a.enqueue.mock.calls[0] as unknown as [{ content: string; allowedMentions: unknown }]
		)[0];
		expect(sent.content).toContain('overlaps');
		expect(sent.allowedMentions).toEqual({ parse: [] });
	});

	it('includes field errors from a 422 in the alert', async () => {
		const a = alerts();
		const f = fakeFetch(
			json(422, {
				success: false,
				message: 'Validation failed',
				errors: { rating: ['Rating too low'] }
			})
		);
		await consume(batchOf(fakeMessage(createJob)), a.env, f.impl);
		const sent = (a.enqueue.mock.calls[0] as unknown as [{ content: string }])[0];
		expect(sent.content).toContain('rating: Rating too low');
	});

	it('does not alert when no channel is configured', async () => {
		const enqueue = vi.fn(async () => {});
		const f = fakeFetch(json(422, { success: false, message: 'nope' }));
		await consume(batchOf(fakeMessage(createJob)), { ...env, LARRY: { enqueue } }, f.impl);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('retries a rate limit after the time the API names', async () => {
		const m = fakeMessage(createJob);
		const f = fakeFetch(
			json(429, { success: false, message: 'slow down' }, { 'RateLimit-Reset': '42' })
		);
		await consume(batchOf(m), env, f.impl);
		expect(m.state.acked).toBe(false);
		expect(m.state.retried).toEqual({ delaySeconds: 42 });
	});

	it('retries a 500 and a network error with backoff', async () => {
		const m1 = fakeMessage(createJob, 1);
		const m2 = fakeMessage(createJob, 3);
		const f = fakeFetch(
			json(500, { success: false, message: 'boom' }),
			new Error('connection reset')
		);
		await consume(batchOf(m1, m2), env, f.impl);
		expect(m1.state.retried).toEqual({ delaySeconds: 15 });
		expect(m2.state.retried).toEqual({ delaySeconds: 60 });
	});

	it('treats a bad API key as retryable, so fixing the key recovers the jobs', async () => {
		const m = fakeMessage(createJob);
		await consume(
			batchOf(m),
			env,
			fakeFetch(json(401, { success: false, message: 'Invalid or missing API key' })).impl
		);
		expect(m.state.retried).toBeDefined();
		expect(m.state.acked).toBe(false);
	});

	it('alerts and hands over to the dead-letter queue after the last retry', async () => {
		const a = alerts();
		const m = fakeMessage(createJob, MAX_RETRIES + 1);
		await consume(
			batchOf(m),
			a.env,
			fakeFetch(json(503, { success: false, message: 'down' })).impl
		);
		expect(a.enqueue).toHaveBeenCalledOnce();
		expect(m.state.retried).toEqual({});
	});

	it('waits for a create that may still be queued before believing a 404 on cancel', async () => {
		const cancel = { op: 'booking.cancel', externalId: 'abc' } as const;
		const early = fakeMessage(cancel, 1);
		const late = fakeMessage(cancel, 3);
		const f = fakeFetch(
			json(404, { success: false, message: 'not found' }),
			json(404, { success: false, message: 'not found' })
		);
		await consume(batchOf(early, late), env, f.impl);
		expect(early.state.retried).toEqual({ delaySeconds: 30 });
		expect(late.state.acked).toBe(true);
	});

	it('alerts when an update never finds its booking', async () => {
		const a = alerts();
		const m = fakeMessage({ op: 'booking.update', externalId: 'abc', patch: { end: 'x' } }, 3);
		await consume(
			batchOf(m),
			a.env,
			fakeFetch(json(404, { success: false, message: 'not found' })).impl
		);
		expect(m.state.acked).toBe(true);
		expect(a.enqueue).toHaveBeenCalledOnce();
	});

	it('survives a failing alert', async () => {
		const enqueue = vi.fn(async () => {
			throw new Error('larry down');
		});
		const m = fakeMessage(createJob);
		await consume(
			batchOf(m),
			{ ...env, FAILURE_ALERT_CHANNEL: 'x', LARRY: { enqueue } },
			fakeFetch(json(422, { success: false, message: 'nope' })).impl
		);
		expect(m.state.acked).toBe(true);
	});

	it('percent-encodes the external ID in the path', async () => {
		const f = fakeFetch(json(200, { success: true, data: {} }));
		await consume(batchOf(fakeMessage({ op: 'booking.cancel', externalId: 'a/b c' })), env, f.impl);
		expect(f.calls[0]?.url).toBe('https://booking.test/api/bookings/external/a%2Fb%20c');
	});

	it('sends prune only when asked, and caps backoff', async () => {
		const f = fakeFetch(json(200, { success: true, data: {} }));
		await consume(
			batchOf(
				fakeMessage({ op: 'roster.upsert', members: [{ cid: '1', rating: 5 }], prune: true })
			),
			env,
			f.impl
		);
		expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
			members: [{ cid: '1', rating: 5 }],
			prune: true
		});
		expect(backoff(20)).toBe(900);
	});
});
