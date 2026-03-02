// ============================================================
// Misaka Network - Ed25519 Curve Operations
// ============================================================

import { createHash, randomBytes } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

const Point = ed25519.ExtendedPoint;

export const CURVE_ORDER = BigInt(
  '7237005577332262213973186563042994240857116359379907606001950938285454250989'
);

export type CurvePoint = InstanceType<typeof Point>;

const _G = Point.BASE;
const _ZERO = Point.ZERO;

// No async init needed — static imports
export async function initCurve(): Promise<void> { /* no-op for compat */ }

export function basePoint(): CurvePoint { return _G; }
export function zeroPoint(): CurvePoint { return _ZERO; }

export function pointFromHex(hex: string): CurvePoint {
  return Point.fromHex(hex);
}

export function modScalar(n: bigint): bigint {
  return ((n % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
}

export function invertScalar(a: bigint): bigint {
  // Extended Euclidean algorithm for modular inverse
  let [old_r, r] = [a % CURVE_ORDER, CURVE_ORDER];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
}

export function scalarMulBase(scalar: bigint): CurvePoint {
  const s = modScalar(scalar);
  if (s === 0n) return _ZERO;
  return _G.multiply(s);
}

export function scalarMul(scalar: bigint, point: CurvePoint): CurvePoint {
  const s = modScalar(scalar);
  if (s === 0n) return _ZERO;
  return point.multiply(s);
}

export function pointAdd(p: CurvePoint, q: CurvePoint): CurvePoint {
  return p.add(q);
}

export function hashToScalar(...inputs: (Uint8Array | string)[]): bigint {
  const h = createHash('sha512');
  for (const inp of inputs) {
    if (typeof inp === 'string') h.update(Buffer.from(inp, 'utf-8'));
    else h.update(Buffer.from(inp));
  }
  const hash = h.digest();
  let num = 0n;
  for (let i = 0; i < 64; i++) num += BigInt(hash[i]) << BigInt(8 * i);
  const result = ((num % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
  return result === 0n ? 1n : result;
}

export function hashToPoint(...inputs: (Uint8Array | string)[]): CurvePoint {
  return _G.multiply(hashToScalar(...inputs));
}

export function randomScalar(): bigint {
  const bytes = randomBytes(64);
  let num = 0n;
  for (let i = 0; i < 64; i++) num += BigInt(bytes[i]) << BigInt(8 * i);
  const result = ((num % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
  return result === 0n ? 1n : result;
}

export function scalarToBytes(s: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = modScalar(s);
  for (let i = 0; i < 32; i++) { bytes[i] = Number(val & 0xffn); val >>= 8n; }
  return bytes;
}

export function bytesToScalar(bytes: Uint8Array): bigint {
  let num = 0n;
  for (let i = 0; i < bytes.length; i++) num += BigInt(bytes[i]) << BigInt(8 * i);
  return modScalar(num);
}
