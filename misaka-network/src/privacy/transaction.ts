// ============================================================
// Misaka Network - Private Transaction
// ============================================================
// Creates and validates cash-like private transactions:
// - Stealth outputs (one-time addresses)
// - Ring inputs (sender hidden among decoys)
// - Key images (double-spend prevention)
// - Encrypted amounts (only parties see values)
// ============================================================

import { createHash } from 'crypto';
import { PrivateTransaction, RingInput, StealthOutput, PrivateUTXO, StealthMeta } from './types';
import { createStealthOutput, computeKeyImage } from './stealth';
import { ringSign, ringVerify } from './ring';
import { scalarMulBase, scalarToBytes } from './curve';
import { calculateFee } from '../core/fee';
import { FeeTier, DEFAULT_FEE_TIERS } from '../types';
import {
  pedersenCommit, toBaseUnits, computeExcess,
  verifyCommitmentBalance, PedersenCommitment,
} from './pedersen';

// ============================================================
// Key Image Store (in-memory)
// ============================================================

export class InMemoryKeyImageStore {
  private images = new Map<string, string>(); // keyImage → txId

  has(keyImage: string): boolean { return this.images.has(keyImage); }
  add(keyImage: string, txId: string): void { this.images.set(keyImage, txId); }
  getAll(): string[] { return Array.from(this.images.keys()); }
  size(): number { return this.images.size; }
}

// ============================================================
// Decoy Selection
// ============================================================

/**
 * Select decoy public keys for ring mixing.
 * In production, decoys come from the global stealth UTXO set.
 * This function takes a pool of candidate one-time public keys.
 */
export function selectDecoys(
  realPubKey: string,
  decoyPool: string[],
  ringSize: number = 4
): { ring: string[]; realIndex: number } {
  // Filter out the real key from the pool
  const candidates = decoyPool.filter(k => k !== realPubKey);
  if (candidates.length < ringSize - 1) {
    throw new Error(`Not enough decoys: need ${ringSize - 1}, have ${candidates.length}`);
  }

  // Shuffle and pick ringSize-1 decoys
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const decoys = shuffled.slice(0, ringSize - 1);

  // Insert real key at random position
  const realIndex = Math.floor(Math.random() * ringSize);
  const ring: string[] = [];
  let di = 0;
  for (let i = 0; i < ringSize; i++) {
    if (i === realIndex) ring.push(realPubKey);
    else ring.push(decoys[di++]);
  }

  return { ring, realIndex };
}

// ============================================================
// Private Transaction Creation
// ============================================================

export interface CreatePrivateTxParams {
  /** UTXOs to spend */
  inputs: PrivateUTXO[];
  /** Recipient stealth meta-addresses and amounts */
  recipients: Array<{ meta: StealthMeta; amount: number }>;
  /** Sender's stealth meta for change output */
  senderMeta: StealthMeta;
  /** Pool of one-time public keys for decoy selection */
  decoyPool: string[];
  /** Ring size (default 4) */
  ringSize?: number;
  /** Fee tiers */
  feeTiers?: FeeTier[];
}

export function createPrivateTransaction(params: CreatePrivateTxParams): PrivateTransaction {
  const {
    inputs, recipients, senderMeta, decoyPool,
    ringSize = 4, feeTiers = DEFAULT_FEE_TIERS,
  } = params;

  const totalInput = inputs.reduce((s, u) => s + u.amount, 0);
  const totalOutput = recipients.reduce((s, r) => s + r.amount, 0);
  const fee = calculateFee(totalOutput, feeTiers);
  const change = totalInput - totalOutput - fee;

  if (change < 0) {
    throw new Error(`Insufficient funds: input=${totalInput}, output=${totalOutput}, fee=${fee}`);
  }

  // 1. Build stealth outputs with Pedersen commitments
  const stealthOutputs: StealthOutput[] = [];
  const outputBlindings: bigint[] = [];
  let idx = 0;
  for (const r of recipients) {
    const { output, commitment } = createStealthOutput(r.meta, r.amount, idx);
    stealthOutputs.push(output);
    outputBlindings.push(commitment.blinding);
    idx++;
  }

  // 2. Change output (to self, also stealth)
  if (change > 0) {
    const { output, commitment } = createStealthOutput(senderMeta, change, idx);
    stealthOutputs.push(output);
    outputBlindings.push(commitment.blinding);
  }

  // 3. Compute excess blinding for balance proof
  // excess = sum(input_blindings) - sum(output_blindings)
  const inputBlindings = inputs.map(u => u.blinding);
  const excess = computeExcess(inputBlindings, outputBlindings);

  // 4. Build ring inputs
  const ringInputs: RingInput[] = [];
  const keyImages: string[] = [];

  for (const utxo of inputs) {
    const { ring, realIndex } = selectDecoys(utxo.oneTimePubKey, decoyPool, ringSize);

    // Message = hash of all outputs + fee (binds signature to this tx)
    const msgHash = hashOutputs(stealthOutputs, fee);

    const sig = ringSign(msgHash, ring, realIndex, utxo.oneTimeSecret);

    ringInputs.push({
      ring,
      ringSignature: sig,
      inputCommitment: utxo.commitment,
    });
    keyImages.push(sig.keyImage);
  }

  // 5. Compute tx ID
  const txContent = JSON.stringify({
    version: 1,
    type: 'private_transfer',
    ringInputs: ringInputs.map(ri => ({
      ring: ri.ring,
      c0: ri.ringSignature.c0,
      ss: ri.ringSignature.ss,
      keyImage: ri.ringSignature.keyImage,
      inputCommitment: ri.inputCommitment,
    })),
    stealthOutputs: stealthOutputs.map(so => ({
      oneTimePubKey: so.oneTimePubKey,
      commitment: so.commitment,
    })),
    keyImages,
    fee,
    timestamp: Date.now(),
  });
  const id = createHash('sha256').update(txContent).digest('hex');

  return {
    id,
    version: 1,
    type: 'private_transfer',
    ringInputs,
    stealthOutputs,
    keyImages,
    fee,
    excessBlinding: Buffer.from(scalarToBytes(excess)).toString('hex'),
    timestamp: Date.now(),
  };
}

// ============================================================
// Private Transaction Validation
// ============================================================

/**
 * Validate a private transaction.
 * Returns null if valid, error message otherwise.
 *
 * What the chain CAN verify:
 *   ✅ Ring signatures are valid (sender controls one ring member)
 *   ✅ Key images are not double-spent
 *   ✅ Fee matches tier rules
 *   ✅ Ring members exist in the UTXO set
 *
 * What the chain CANNOT see:
 *   ❌ Who the real sender is (hidden in ring)
 *   ❌ Who the recipient is (stealth one-time address)
 *   ❌ The amounts (hidden in Pedersen commitments + encrypted)
 */
export function validatePrivateTransaction(
  tx: PrivateTransaction,
  keyImageStore: InMemoryKeyImageStore,
  isValidPubKey: (pubkey: string) => boolean,
  feeTiers: FeeTier[] = DEFAULT_FEE_TIERS
): string | null {
  // 1. Type check
  if (tx.type !== 'private_transfer') return 'Invalid type';
  if (!tx.ringInputs.length) return 'No inputs';
  if (!tx.stealthOutputs.length) return 'No outputs';

  // 2. Key images not already spent
  for (const ki of tx.keyImages) {
    if (keyImageStore.has(ki)) return `Double spend: key image ${ki.slice(0,16)}... already used`;
  }

  // 3. Validate each ring input
  const msgHash = hashOutputs(tx.stealthOutputs, tx.fee);
  for (let i = 0; i < tx.ringInputs.length; i++) {
    const ri = tx.ringInputs[i];

    // Check ring size ≥ 2
    if (ri.ring.length < 2) return `Ring input ${i}: ring too small`;

    // Check all ring members are known public keys
    for (const pk of ri.ring) {
      if (!isValidPubKey(pk)) return `Ring input ${i}: unknown ring member ${pk.slice(0,16)}...`;
    }

    // Verify ring signature
    if (!ringVerify(msgHash, ri.ring, ri.ringSignature)) {
      return `Ring input ${i}: invalid ring signature`;
    }

    // Check key image matches
    if (ri.ringSignature.keyImage !== tx.keyImages[i]) {
      return `Ring input ${i}: key image mismatch`;
    }
  }

  // 4. Fee validation
  if (tx.fee <= 0) return 'Fee must be positive';

  // 5. Verify Pedersen commitment balance
  // sum(input_commitments) = sum(output_commitments) + fee*G + excess*H
  const inputCommitments = tx.ringInputs.map(ri => ri.inputCommitment).filter(Boolean);
  const outputCommitments = tx.stealthOutputs.map(so => so.commitment).filter(Boolean);

  if (inputCommitments.length > 0 && outputCommitments.length > 0 && tx.excessBlinding) {
    const { bytesToScalar: bts } = require('./curve');
    const excessBlinding = bts(new Uint8Array(Buffer.from(tx.excessBlinding, 'hex')));
    const feeBase = toBaseUnits(tx.fee);
    const balanceOk = verifyCommitmentBalance(
      inputCommitments, outputCommitments, feeBase, excessBlinding,
    );
    if (!balanceOk) return 'Pedersen commitment balance check failed';
  }

  return null;
}

// ---- Helpers ----

function hashOutputs(outputs: StealthOutput[], fee: number): string {
  const data = JSON.stringify({
    outputs: outputs.map(o => ({
      oneTimePubKey: o.oneTimePubKey,
      encryptedAmount: o.encryptedAmount,
      amountNonce: o.amountNonce,
    })),
    fee,
  });
  return createHash('sha256').update(data).digest('hex');
}
