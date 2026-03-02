// ============================================================
// Misaka Network - Pedersen Commitment Scheme
// ============================================================
// C = v*G + r*H  (homomorphic, hiding, binding)
//
// Used for confidential amounts:
//   - Chain stores commitments, not plaintext amounts
//   - Validators verify sum(inputs) = sum(outputs) + fee
//   - Nobody learns the actual amounts
// ============================================================

import {
  basePoint, zeroPoint, scalarMulBase, scalarMul, pointAdd,
  hashToPoint, randomScalar, modScalar,
  scalarToBytes, bytesToScalar, CurvePoint, pointFromHex,
} from './curve';

/**
 * Nothing-up-my-sleeve generator H.
 * H = HashToPoint("Misaka-Pedersen-H-v1")
 * Nobody knows discrete log of H w.r.t. G.
 */
let _H: CurvePoint | null = null;

export function getH(): CurvePoint {
  if (!_H) {
    _H = hashToPoint('Misaka-Pedersen-Generator-H-v1', 'pedersen_H');
  }
  return _H;
}

/** Pedersen commitment data */
export interface PedersenCommitment {
  /** Committed point C = v*G + r*H (hex) */
  point: string;
  /** Blinding factor (only known to creator) */
  blinding: bigint;
  /** Actual value (only known to creator) */
  value: bigint;
}

/**
 * Create a Pedersen commitment: C = v*G + r*H
 */
export function pedersenCommit(value: bigint, blinding?: bigint): PedersenCommitment {
  if (value < 0n) throw new Error('Value must be non-negative');
  const r = blinding ?? randomScalar();
  const H = getH();
  const vG = value === 0n ? zeroPoint() : scalarMulBase(modScalar(value));
  const rH = scalarMul(r, H);
  const C = pointAdd(vG, rH);
  return { point: C.toHex(), blinding: r, value };
}

/**
 * Create a transparent commitment (blinding = 0, value is public).
 * Used for fees since they must be publicly verifiable for tier validation.
 */
export function pedersenCommitTransparent(value: bigint): PedersenCommitment {
  return pedersenCommit(value, 0n);
}

/** Precision: 1 token = 10^8 base units */
export const PRECISION = 100_000_000n;

export function toBaseUnits(amount: number): bigint {
  return BigInt(Math.round(amount * Number(PRECISION)));
}

export function fromBaseUnits(base: bigint): number {
  return Number(base) / Number(PRECISION);
}

/**
 * Verify balance: sum(input commitments) == sum(output commitments) + fee*G + excess*H
 *
 * Returns true if the commitments balance.
 *   excess = sum(input_blindings) - sum(output_blindings)
 */
export function verifyCommitmentBalance(
  inputCommitmentHexes: string[],
  outputCommitmentHexes: string[],
  feeBaseUnits: bigint,
  excessBlinding: bigint,
): boolean {
  try {
    const H = getH();

    // Sum inputs
    let sumIn = zeroPoint();
    for (const hex of inputCommitmentHexes) {
      sumIn = pointAdd(sumIn, pointFromHex(hex));
    }

    // Sum outputs + fee
    let sumOutFee = zeroPoint();
    for (const hex of outputCommitmentHexes) {
      sumOutFee = pointAdd(sumOutFee, pointFromHex(hex));
    }
    if (feeBaseUnits > 0n) {
      sumOutFee = pointAdd(sumOutFee, scalarMulBase(modScalar(feeBaseUnits)));
    }

    // excess*H
    const excessPoint = scalarMul(modScalar(excessBlinding), H);

    // sumIn == sumOutFee + excess*H
    const expected = pointAdd(sumOutFee, excessPoint);
    return sumIn.equals(expected);
  } catch {
    return false;
  }
}

/**
 * Compute the excess blinding factor.
 * excess = sum(input blindings) - sum(output blindings)
 */
export function computeExcess(inputBlindings: bigint[], outputBlindings: bigint[]): bigint {
  let sumIn = 0n;
  for (const b of inputBlindings) sumIn = modScalar(sumIn + b);
  let sumOut = 0n;
  for (const b of outputBlindings) sumOut = modScalar(sumOut + b);
  return modScalar(sumIn - sumOut);
}

/**
 * Serialize commitment secrets for encrypted transmission.
 */
export function serializeCommitmentSecrets(value: bigint, blinding: bigint): Buffer {
  const buf = Buffer.alloc(64);
  buf.set(scalarToBytes(value), 0);
  buf.set(scalarToBytes(blinding), 32);
  return buf;
}

/**
 * Deserialize commitment secrets.
 */
export function deserializeCommitmentSecrets(buf: Buffer): {
  value: bigint;
  blinding: bigint;
} {
  const value = bytesToScalar(new Uint8Array(buf.subarray(0, 32)));
  const blinding = bytesToScalar(new Uint8Array(buf.subarray(32, 64)));
  return { value, blinding };
}
