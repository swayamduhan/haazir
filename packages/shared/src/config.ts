/** Nonce rotation window, in seconds. Spec section 5.2. */
export const NONCE_WINDOW_SEC = 10;

/** Default grace period for revealing a session seed after nominal end. Spec section 5.4. */
export const DEFAULT_GRACE_PERIOD_SEC = 900;

/** Upper bound on a single session's duration, as a sanity check. Spec section 7.2. */
export const MAX_SESSION_DURATION_SEC = 14_400;
