import { describeJob, toRequest, type Job } from './jobs';
import { call, type UpstreamEnv } from './upstream';

/** Larry's `enqueue`, the one method we use. Declared here so we don't depend on Larry's package. */
export type LarryLike = {
	enqueue(request: {
		channel: string;
		content: string;
		allowedMentions: { parse: [] };
	}): Promise<void>;
};

export type ConsumeEnv = UpstreamEnv & {
	FAILURE_ALERT_CHANNEL?: string;
	LARRY?: LarryLike;
};

/** Keep in step with `max_retries` in wrangler.jsonc: after this many retries a message goes to the dead-letter queue. */
export const MAX_RETRIES = 8;
// A cancel or update can reach the booking system before the create it follows, since a queue only
// keeps order as far as it can. A "not found" gets a few more tries before we believe it.
const NOT_FOUND_RETRIES = 3;
const NOT_FOUND_DELAY_SEC = 30;
const BACKOFF_BASE_SEC = 15;
const BACKOFF_MAX_SEC = 900;

export function backoff(attempts: number): number {
	return Math.min(BACKOFF_MAX_SEC, BACKOFF_BASE_SEC * 2 ** Math.max(0, attempts - 1));
}

/** Tell staff, if a channel is configured. Never throws: an alert failing must not fail the job. */
export async function alertFailure(env: ConsumeEnv, text: string): Promise<void> {
	if (!env.FAILURE_ALERT_CHANNEL || !env.LARRY) return;
	try {
		await env.LARRY.enqueue({
			channel: env.FAILURE_ALERT_CHANNEL,
			content: `⚠️ Bookings: ${text}`.slice(0, 1900),
			allowedMentions: { parse: [] }
		});
	} catch (error) {
		console.error('Could not send failure alert', (error as Error).message);
	}
}

/**
 * Work through a batch of writes. Each message ends one of four ways:
 * - done: acked.
 * - retried later (rate limit, outage, network, bad key), with backoff, until `MAX_RETRIES`, when it
 *   goes to the dead-letter queue and staff are told.
 * - refused for good (overlap, ineligible, wrong organization): acked, logged and staff are told.
 * - a "not found" on a cancel or removal: counts as done once it has had a few tries.
 */
export async function consume(
	batch: MessageBatch<Job>,
	env: ConsumeEnv,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	for (const message of batch.messages) {
		const job = message.body;
		const what = describeJob(job);
		const outcome = await call(env, toRequest(job), fetchImpl);

		if (outcome.ok) {
			message.ack();
			continue;
		}

		const gone = job.op === 'booking.cancel' || job.op === 'roster.remove';
		const needsExisting = gone || job.op === 'booking.update';

		if (outcome.kind === 'rejected') {
			console.error(`Refused: ${what}: ${outcome.message}`);
			await alertFailure(env, `could not ${what}. The booking system said: ${outcome.message}`);
			message.ack();
			continue;
		}

		if (outcome.kind === 'not_found' && needsExisting) {
			if (message.attempts < NOT_FOUND_RETRIES) {
				message.retry({ delaySeconds: NOT_FOUND_DELAY_SEC });
				continue;
			}
			if (gone) {
				// Already gone is what the caller wanted.
				message.ack();
				continue;
			}
			console.error(`Not found: ${what}`);
			await alertFailure(env, `could not ${what}: the booking was not found.`);
			message.ack();
			continue;
		}

		// A retryable failure, or a "not found" on something that should exist (a wrong base URL).
		if (message.attempts > MAX_RETRIES) {
			console.error(`Giving up: ${what}: ${outcome.message}`);
			await alertFailure(
				env,
				`gave up on ${what} after ${message.attempts} tries and moved it to the dead-letter queue. Last error: ${outcome.message}`
			);
			message.retry();
			continue;
		}
		const delaySeconds =
			outcome.kind === 'retry' && outcome.retryAfterSec
				? Math.max(outcome.retryAfterSec, 1)
				: backoff(message.attempts);
		console.warn(
			`Retrying in ${delaySeconds}s (attempt ${message.attempts}): ${what}: ${outcome.message}`
		);
		message.retry({ delaySeconds });
	}
}
