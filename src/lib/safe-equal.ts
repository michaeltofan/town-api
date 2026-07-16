import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare secrets without short-circuiting on string length differences.
 * Hashes both sides so timingSafeEqual always receives equal-length buffers.
 */
export function safeEqualString(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}
