// ============================================================
// Misaka Network - Stealth Address Protocol (DKSAP)
// ============================================================
// Recipient publishes: (A=a·G, B=b·G)  scan/spend keys
// Sender: r random, R=r·G, s=Hs(r·A,idx), P=s·G+B
// Recipient: s=Hs(a·R,idx), check P==s·G+B, spend key = s+b
// View-only: knows a → can detect, but NOT spend (needs b)
// ============================================================

import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import {
  initCurve, pointFromHex, scalarMulBase, scalarMul,
  pointAdd, hashToScalar, hashToPoint, randomScalar,
  scalarToBytes, modScalar, CurvePoint,
} from './curve';
import { StealthKeyPair, StealthMeta, StealthOutput, ScannedOutput } from './types';
import { pedersenCommit, toBaseUnits, serializeCommitmentSecrets, deserializeCommitmentSecrets, PedersenCommitment } from './pedersen';

// ---- Key Generation ----

export function generateStealthKeyPair(): StealthKeyPair {
  const scanSeed = Buffer.from(nacl.randomBytes(32));
  const spendSeed = Buffer.from(nacl.randomBytes(32));
  const scanScalar = hashToScalar(scanSeed, 'scan_scalar_derive');
  const spendScalar = hashToScalar(spendSeed, 'spend_scalar_derive');
  const scanPub = scalarMulBase(scanScalar).toHex();
  const spendPub = scalarMulBase(spendScalar).toHex();
  return {
    scanSecret: scanSeed.toString('hex'),
    scanPub,
    spendSecret: spendSeed.toString('hex'),
    spendPub,
  };
}

export function getStealthMeta(kp: StealthKeyPair): StealthMeta {
  return { scanPub: kp.scanPub, spendPub: kp.spendPub };
}

// ---- Sending: Create stealth output ----

export function createStealthOutput(
  recipientMeta: StealthMeta,
  amount: number,
  outputIndex: number
): { output: StealthOutput; ephemeralSecret: bigint; commitment: PedersenCommitment } {
  const r = randomScalar();
  const R = scalarMulBase(r);
  const A = pointFromHex(recipientMeta.scanPub);
  const rA = scalarMul(r, A);
  const s = hashToScalar(rA.toRawBytes(), `stealth_output:${outputIndex}`);
  const B = pointFromHex(recipientMeta.spendPub);
  const P = pointAdd(scalarMulBase(s), B);

  // Create Pedersen commitment for the amount
  const amountBase = toBaseUnits(amount);
  const commitment = pedersenCommit(amountBase);

  // Encrypt amount (legacy XOR method for backward compat)
  const { encrypted, nonce } = encryptAmount(amount, s);

  // Encrypt commitment data (blinding + value) for recipient
  const commitData = serializeCommitmentSecrets(amountBase, commitment.blinding);
  const { encrypted: encCommit, nonce: commitNonce } = encryptCommitmentData(commitData, s);

  return {
    output: {
      oneTimePubKey: P.toHex(),
      ephemeralPubKey: R.toHex(),
      encryptedAmount: encrypted,
      amountNonce: nonce,
      commitment: commitment.point,
      encryptedCommitmentData: encCommit,
      commitmentDataNonce: commitNonce,
      outputIndex,
    },
    ephemeralSecret: r,
    commitment,
  };
}

// ---- Receiving: Scan & detect ----

export function scanStealthOutput(
  output: StealthOutput,
  txId: string,
  scanSecret: string,
  spendSecret: string,
  spendPub: string
): ScannedOutput | null {
  try {
    const a = hashToScalar(Buffer.from(scanSecret, 'hex'), 'scan_scalar_derive');
    const R = pointFromHex(output.ephemeralPubKey);
    const aR = scalarMul(a, R);
    const s = hashToScalar(aR.toRawBytes(), `stealth_output:${output.outputIndex}`);
    const B = pointFromHex(spendPub);
    const expectedP = pointAdd(scalarMulBase(s), B);
    const actualP = pointFromHex(output.oneTimePubKey);
    if (!expectedP.equals(actualP)) return null;

    // One-time secret: p = s + b
    const b = hashToScalar(Buffer.from(spendSecret, 'hex'), 'spend_scalar_derive');
    const oneTimeSecret = modScalar(s + b);

    const amount = decryptAmount(output.encryptedAmount, output.amountNonce, s);
    const Hp = hashToPoint(output.oneTimePubKey, 'key_image');
    const keyImage = scalarMul(oneTimeSecret, Hp).toHex();

    // Recover commitment data
    let blinding = 0n;
    if (output.encryptedCommitmentData && output.commitmentDataNonce) {
      const commitData = decryptCommitmentData(output.encryptedCommitmentData, output.commitmentDataNonce, s);
      const { blinding: b } = deserializeCommitmentSecrets(commitData);
      blinding = b;
    }

    return {
      txId, outputIndex: output.outputIndex, oneTimePubKey: output.oneTimePubKey,
      amount, oneTimeSecret, keyImage,
      commitment: output.commitment || '',
      blinding,
    };
  } catch { return null; }
}

/** View-only scan: detects output & amount, but cannot spend */
export function scanWithViewKey(
  output: StealthOutput, txId: string, scanSecret: string, spendPub: string
): { txId: string; outputIndex: number; amount: number } | null {
  try {
    const a = hashToScalar(Buffer.from(scanSecret, 'hex'), 'scan_scalar_derive');
    const R = pointFromHex(output.ephemeralPubKey);
    const aR = scalarMul(a, R);
    const s = hashToScalar(aR.toRawBytes(), `stealth_output:${output.outputIndex}`);
    const B = pointFromHex(spendPub);
    const expectedP = pointAdd(scalarMulBase(s), B);
    if (!expectedP.equals(pointFromHex(output.oneTimePubKey))) return null;
    const amount = decryptAmount(output.encryptedAmount, output.amountNonce, s);
    return { txId, outputIndex: output.outputIndex, amount };
  } catch { return null; }
}

// ---- Key Image ----

export function computeKeyImage(oneTimeSecret: bigint, oneTimePubKey: string): string {
  const Hp = hashToPoint(oneTimePubKey, 'key_image');
  return scalarMul(oneTimeSecret, Hp).toHex();
}

// ---- Amount Encryption (XOR with key stream) ----

function deriveAmountKey(sharedScalar: bigint): Buffer {
  return createHash('sha256').update(Buffer.from(scalarToBytes(sharedScalar))).update('amount_key').digest();
}

function encryptAmount(amount: number, sharedScalar: bigint): { encrypted: string; nonce: string } {
  const key = deriveAmountKey(sharedScalar);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeDoubleBE(amount, 0);
  const nonce = Buffer.from(nacl.randomBytes(8));
  const stream = createHash('sha256').update(key).update(nonce).digest();
  const enc = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) enc[i] = amountBuf[i] ^ stream[i];
  return { encrypted: enc.toString('hex'), nonce: nonce.toString('hex') };
}

function decryptAmount(encHex: string, nonceHex: string, sharedScalar: bigint): number {
  const key = deriveAmountKey(sharedScalar);
  const enc = Buffer.from(encHex, 'hex');
  const nonce = Buffer.from(nonceHex, 'hex');
  const stream = createHash('sha256').update(key).update(nonce).digest();
  const dec = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) dec[i] = enc[i] ^ stream[i];
  return dec.readDoubleBE(0);
}

function encryptCommitmentData(data: Buffer, sharedScalar: bigint): { encrypted: string; nonce: string } {
  const key = createHash('sha256')
    .update(Buffer.from(scalarToBytes(sharedScalar)))
    .update('commitment_data_key')
    .digest();
  const nonce = Buffer.from(nacl.randomBytes(8));
  // Use SHA256 stream cipher for longer data (64 bytes)
  const stream = Buffer.alloc(64);
  for (let chunk = 0; chunk < 2; chunk++) {
    const s = createHash('sha256').update(key).update(nonce).update(Buffer.from([chunk])).digest();
    s.copy(stream, chunk * 32);
  }
  const enc = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) enc[i] = data[i] ^ stream[i];
  return { encrypted: enc.toString('hex'), nonce: nonce.toString('hex') };
}

function decryptCommitmentData(encHex: string, nonceHex: string, sharedScalar: bigint): Buffer {
  const key = createHash('sha256')
    .update(Buffer.from(scalarToBytes(sharedScalar)))
    .update('commitment_data_key')
    .digest();
  const enc = Buffer.from(encHex, 'hex');
  const nonce = Buffer.from(nonceHex, 'hex');
  const stream = Buffer.alloc(64);
  for (let chunk = 0; chunk < 2; chunk++) {
    const s = createHash('sha256').update(key).update(nonce).update(Buffer.from([chunk])).digest();
    s.copy(stream, chunk * 32);
  }
  const dec = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) dec[i] = enc[i] ^ stream[i];
  return dec;
}
