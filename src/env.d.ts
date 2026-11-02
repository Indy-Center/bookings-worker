declare global {
	interface Env {
		/** Base URL of the booking API, including `/api`. A secret. */
		BOOKING_API_URL: string;
		/** Our organization's bearer token. A secret. */
		BOOKING_API_KEY: string;
		/** A Larry `SEND_CHANNELS` name that failure alerts go to. Empty means log only. */
		FAILURE_ALERT_CHANNEL: string;
	}
}

export {};
