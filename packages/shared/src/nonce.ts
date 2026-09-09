import { createHmac } from 'crypto';
import { NONCE_WINDOW_SEC } from './config';

/**
 * The nonce window containing `nowMs`, counted from the session start.
 *
 * The epoch is the session start, NOT the unix epoch. Left unstated this is
 * the kind of ambiguity that produces intermittent mismatches between the
 * faculty device and any verifier. Spec section 5.2.
 */
export function windowFor(
  nowMs: number,
  startTimeMs: number,
  windowSec: number = NONCE_WINDOW_SEC,
): number {
  if (nowMs < startTimeMs) {
    throw new Error('windowFor: time is before session start');
  }
  return Math.floor((nowMs - startTimeMs) / (windowSec * 1000));
}

/**
 * nonce(w) = HMAC-SHA256(key = seed, message = decimal string of w)
 *
 * Computed locally by the faculty device every window, with no ledger
 * interaction — this is what keeps rotation off-chain. Once the seed is
 * revealed at session close, anyone can recompute every window and verify
 * any record without trusting a server. Spec section 5.2.
 */
export function deriveNonce(seedHex: string, window: number): string {
  if (!Number.isInteger(window) || window < 0) {
    throw new Error(`deriveNonce: window must be a non-negative integer (got ${window})`);
  }
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new Error('deriveNonce: seed must be 32-byte hex');
  }
  return createHmac('sha256', Buffer.from(seedHex, 'hex'))
    .update(String(window))
    .digest('hex');
}
