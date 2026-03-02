// ============================================================
// Misaka Network - SAG Ring Signatures
// ============================================================
// Spontaneous Anonymous Group (SAG) Signature with Key Images
//
// Sign(m, ring=[P_0..P_{n-1}], j, x_j):
//   I = x_j · Hp(P_j)                    [key image]
//   k = random
//   c_{j+1} = Hs(m, kG, k·Hp(P_j))
//   for i = j+1 .. j-1 (mod n):
//     s_i = random
//     c_{i+1} = Hs(m, s_i·G + c_i·P_i, s_i·Hp(P_i) + c_i·I)
//   s_j = k - c_j · x_j (mod L)
//
// Verify(m, ring, c_0, [s_0..], I):
//   for i = 0..n-1:
//     c_{i+1} = Hs(m, s_i·G + c_i·P_i, s_i·Hp(P_i) + c_i·I)
//   check c_n == c_0, and I not in spent set
// ============================================================

import {
  pointFromHex, scalarMulBase, scalarMul, pointAdd,
  hashToScalar, hashToPoint, randomScalar, modScalar,
  scalarToBytes, CurvePoint, CURVE_ORDER,
} from './curve';
import { RingSignature } from './types';

/**
 * Generate a linkable ring signature (SAG with key images).
 *
 * @param message  - Message hash to sign (hex)
 * @param ring     - Public keys (hex[]), one per ring member
 * @param realIdx  - Index of the real signer in the ring
 * @param secretKey - Scalar secret key of the real signer
 * @returns Ring signature with key image
 */
export function ringSign(
  message: string,
  ring: string[],
  realIdx: number,
  secretKey: bigint
): RingSignature {
  const n = ring.length;
  if (n < 2) throw new Error('Ring must have at least 2 members');
  if (realIdx < 0 || realIdx >= n) throw new Error('Invalid real index');

  // Parse ring points
  const points: CurvePoint[] = ring.map(h => pointFromHex(h));

  // Key image: I = x · Hp(P)
  const HpReal = hashToPoint(ring[realIdx], 'ring_hp');
  const I = scalarMul(secretKey, HpReal);
  const keyImage = I.toHex();

  // Step 1: Random k
  const k = randomScalar();
  const kG = scalarMulBase(k);
  const kHp = scalarMul(k, HpReal);

  // c_{j+1}
  const cs: bigint[] = new Array(n).fill(0n);
  const ss: bigint[] = new Array(n).fill(0n);
  const next = (i: number) => (i + 1) % n;

  cs[next(realIdx)] = computeChallenge(message, kG, kHp);

  // Step 2: Fill ring
  let i = next(realIdx);
  while (i !== realIdx) {
    ss[i] = randomScalar();
    const HpI = hashToPoint(ring[i], 'ring_hp');
    // L = s_i·G + c_i·P_i
    const L = pointAdd(scalarMulBase(ss[i]), scalarMul(cs[i], points[i]));
    // R = s_i·Hp(P_i) + c_i·I
    const R = pointAdd(scalarMul(ss[i], HpI), scalarMul(cs[i], I));
    cs[next(i)] = computeChallenge(message, L, R);
    i = next(i);
  }

  // Step 3: Close the ring
  // s_j = k - c_j · x_j (mod L)
  ss[realIdx] = modScalar(k - modScalar(cs[realIdx] * secretKey));

  return {
    c0: scalarToHex(cs[0]),
    ss: ss.map(scalarToHex),
    keyImage,
  };
}

/**
 * Verify a linkable ring signature.
 */
export function ringVerify(
  message: string,
  ring: string[],
  sig: RingSignature
): boolean {
  try {
    const n = ring.length;
    if (n < 2 || sig.ss.length !== n) return false;

    const points: CurvePoint[] = ring.map(h => pointFromHex(h));
    const I = pointFromHex(sig.keyImage);
    const ss = sig.ss.map(hexToScalar);
    let c = hexToScalar(sig.c0);

    for (let i = 0; i < n; i++) {
      const HpI = hashToPoint(ring[i], 'ring_hp');
      const L = pointAdd(scalarMulBase(ss[i]), scalarMul(c, points[i]));
      const R = pointAdd(scalarMul(ss[i], HpI), scalarMul(c, I));
      c = computeChallenge(message, L, R);
    }

    // Should loop back to c_0
    return c === hexToScalar(sig.c0);
  } catch {
    return false;
  }
}

// ---- Helpers ----

function computeChallenge(message: string, L: CurvePoint, R: CurvePoint): bigint {
  return hashToScalar(message, L.toHex(), R.toHex(), 'ring_challenge');
}

function scalarToHex(s: bigint): string {
  return Buffer.from(scalarToBytes(s)).toString('hex');
}

function hexToScalar(hex: string): bigint {
  const bytes = Buffer.from(hex, 'hex');
  let num = 0n;
  for (let i = 0; i < bytes.length; i++) num += BigInt(bytes[i]) << BigInt(8 * i);
  return modScalar(num);
}
