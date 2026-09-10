/** Nonce rotation window, in seconds. Spec section 5.2. */
export const NONCE_WINDOW_SEC = 10;

/** Default grace period for revealing a session seed after nominal end. Spec section 5.4. */
export const DEFAULT_GRACE_PERIOD_SEC = 900;

/** Upper bound on a single session's duration, as a sanity check. Spec section 7.2. */
export const MAX_SESSION_DURATION_SEC = 14_400;

/**
 * The attendance a student must reach, in basis points: 7500 = 75.00%.
 *
 * Basis points rather than a percentage float because canonical encoding
 * rejects non-integers by design — a float's string form is not portable
 * across platforms, and a percentage is exactly the kind of value that would
 * otherwise arrive as 74.99999999999999. Spec section 6.3.
 */
export const ATTENDANCE_THRESHOLD_BP = 7500;
