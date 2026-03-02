// ============================================================
// Misaka Network - Confidential Transaction
// ============================================================
// Creates and validates privacy-protected transactions:
//
//   Pruned node sees:  ring signatures, commitments, key images, fee
//   Pruned node proves: balance correct, no double-spend, valid sigs
//   Pruned node CANNOT: identify sender, recipient, or amounts
//
//   Archive node sees:  everything pruned node sees + decrypted audit
//   Archive node knows: sender, recipient, amounts (via audit envelope)
// ============================================================

import { createHash } from 'crypto';
import {
  ConfidentialTransaction, ConfidentialRingInput, ConfidentialStealthOutput,
  AuditEnvelope, TransactionType, FeeTier, DEFAULT_FEE_TIERS,
} from '../types';
import { PrivateUTXO, StealthMeta } from '../privacy/types';
import { createStealthOutput } from '../privacy/stealth';
import { ringSign, ringVerify } from '../privacy/ring';
import { scalarToBytes } from '../privacy/curve';
import {
  toBaseUnits, computeExcess, verifyCommitmentBalance,
} from '../privacy/pedersen';
import { calculateFee } from './fee';
import { encryptAuditEnvelope, isValidAuditEnvelope, AuditData } from '../privacy/audit';
import { ConfidentialUTXOStore } from './confidential-utxo';

// ============================================================
// Creation
// ============================================================

export interface CreateConfidentialTxParams {
  /** Private UTXOs to spend */
  inputs: PrivateUTXO[];
  /** Recipients: stealth meta-address + amount */
  recipients: Array<{ meta: StealthMeta; amount: number; pubKeyHash: string }>;
  /** Sender info for change + audit */
  sender: {
    meta: StealthMeta;
    pubKey: string;
    pubKeyHash: string;
  };
  /** Decoy pool (one-time public keys for ring mixing) */
  decoyPool: string[];
  /** Archive public key (for audit envelope encryption) */
  archivePubKey: string;
  /** Ring size (default 4) */
  ringSize?: number;
  /** Fee tiers */
  feeTiers?: FeeTier[];
}

/**
 * Create a confidential transaction.
 *
 * The sender creates:
 *   1. Stealth outputs (recipient hidden)
 *   2. Ring inputs (sender hidden among decoys)
 *   3. Pedersen commitments (amounts hidden)
 *   4. Audit envelope (encrypted plaintext for archive nodes)
 */
export function createConfidentialTransaction(
  params: CreateConfidentialTxParams
): ConfidentialTransaction {
  const {
    inputs, recipients, sender, decoyPool, archivePubKey,
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
  const stealthOutputs: ConfidentialStealthOutput[] = [];
  const outputBlindings: bigint[] = [];
  let idx = 0;

  const auditOutputs: AuditData['outputs'] = [];

  for (const r of recipients) {
    const { output, commitment } = createStealthOutput(r.meta, r.amount, idx);
    stealthOutputs.push(output);
    outputBlindings.push(commitment.blinding);
    auditOutputs.push({ recipientPubKeyHash: r.pubKeyHash, amount: r.amount });
    idx++;
  }

  // Change output (to self, also stealth)
  if (change > 0) {
    const { output, commitment } = createStealthOutput(sender.meta, change, idx);
    stealthOutputs.push(output);
    outputBlindings.push(commitment.blinding);
    auditOutputs.push({ recipientPubKeyHash: sender.pubKeyHash, amount: change });
  }

  // 2. Compute excess blinding for Pedersen balance proof
  const inputBlindings = inputs.map(u => u.blinding);
  const excess = computeExcess(inputBlindings, outputBlindings);

  // 3. Build ring inputs
  const ringInputs: ConfidentialRingInput[] = [];
  const keyImages: string[] = [];

  const msgHash = hashOutputs(stealthOutputs, fee);

  for (const utxo of inputs) {
    const { ring, realIndex } = selectDecoys(utxo.oneTimePubKey, decoyPool, ringSize);
    const sig = ringSign(msgHash, ring, realIndex, utxo.oneTimeSecret);

    ringInputs.push({
      ring,
      ringSignature: sig,
      inputCommitment: utxo.commitment,
    });
    keyImages.push(sig.keyImage);
  }

  // 4. Create audit envelope (encrypted for archive node)
  const auditData: AuditData = {
    senderPubKey: sender.pubKey,
    senderPubKeyHash: sender.pubKeyHash,
    outputs: auditOutputs,
    inputRefs: inputs.map(u => ({
      txId: u.txId,
      outputIndex: u.outputIndex,
      amount: u.amount,
    })),
    fee,
    timestamp: Date.now(),
  };

  const auditEnvelope = encryptAuditEnvelope(auditData, archivePubKey);

  // 5. Compute TX ID
  const txContent = JSON.stringify({
    version: 1,
    type: TransactionType.CONFIDENTIAL,
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
  });
  const id = createHash('sha256').update(txContent).digest('hex');

  return {
    id,
    version: 1,
    type: TransactionType.CONFIDENTIAL,
    ringInputs,
    stealthOutputs,
    keyImages,
    fee,
    excessBlinding: Buffer.from(scalarToBytes(excess)).toString('hex'),
    auditEnvelope,
    timestamp: Date.now(),
  };
}

// ============================================================
// Validation (what pruned nodes do)
// ============================================================

/**
 * Validate a confidential transaction.
 * This is what EVERY node (including pruned) must verify.
 * No secret keys needed — purely cryptographic proof checking.
 *
 * Returns null if valid, error message string otherwise.
 */
export function validateConfidentialTransaction(
  tx: ConfidentialTransaction,
  confidentialUTXOs: ConfidentialUTXOStore,
  feeTiers: FeeTier[] = DEFAULT_FEE_TIERS
): string | null {
  // 1. Type check
  if (tx.type !== TransactionType.CONFIDENTIAL) return 'Not a confidential transaction';
  if (!tx.ringInputs.length) return 'No ring inputs';
  if (!tx.stealthOutputs.length) return 'No stealth outputs';
  if (tx.ringInputs.length !== tx.keyImages.length) return 'Ring inputs / key images count mismatch';

  // 2. Key images not already spent
  for (const ki of tx.keyImages) {
    if (confidentialUTXOs.hasKeyImage(ki)) {
      return `Double spend: key image ${ki.slice(0, 16)}... already used`;
    }
  }

  // 3. Validate each ring input
  const msgHash = hashOutputs(tx.stealthOutputs, tx.fee);

  for (let i = 0; i < tx.ringInputs.length; i++) {
    const ri = tx.ringInputs[i];

    // Ring size ≥ 2
    if (ri.ring.length < 2) return `Ring input ${i}: ring too small (${ri.ring.length})`;

    // All ring members must be known one-time public keys
    for (const pk of ri.ring) {
      if (!confidentialUTXOs.isKnownPubKey(pk)) {
        return `Ring input ${i}: unknown ring member ${pk.slice(0, 16)}...`;
      }
    }

    // Verify ring signature
    if (!ringVerify(msgHash, ri.ring, ri.ringSignature)) {
      return `Ring input ${i}: invalid ring signature`;
    }

    // Key image consistency
    if (ri.ringSignature.keyImage !== tx.keyImages[i]) {
      return `Ring input ${i}: key image mismatch`;
    }
  }

  // 4. Fee must be positive
  if (tx.fee <= 0) return 'Fee must be positive';

  // 5. Verify Pedersen commitment balance
  //    sum(input_commitments) = sum(output_commitments) + fee·G + excess·H
  const inputCommitments = tx.ringInputs.map(ri => ri.inputCommitment).filter(Boolean);
  const outputCommitments = tx.stealthOutputs.map(so => so.commitment).filter(Boolean);

  if (inputCommitments.length > 0 && outputCommitments.length > 0 && tx.excessBlinding) {
    const { bytesToScalar } = require('../privacy/curve');
    const excessBlinding = bytesToScalar(new Uint8Array(Buffer.from(tx.excessBlinding, 'hex')));
    const feeBase = toBaseUnits(tx.fee);

    if (!verifyCommitmentBalance(inputCommitments, outputCommitments, feeBase, excessBlinding)) {
      return 'Pedersen commitment balance check failed';
    }
  }

  // 6. Audit envelope must be structurally valid
  if (!tx.auditEnvelope) return 'Missing audit envelope';
  if (!isValidAuditEnvelope(tx.auditEnvelope)) return 'Invalid audit envelope structure';

  return null; // valid
}

// ============================================================
// Helpers
// ============================================================

function hashOutputs(outputs: ConfidentialStealthOutput[], fee: number): string {
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

function selectDecoys(
  realPubKey: string,
  decoyPool: string[],
  ringSize: number
): { ring: string[]; realIndex: number } {
  const candidates = decoyPool.filter(k => k !== realPubKey);
  if (candidates.length < ringSize - 1) {
    throw new Error(`Not enough decoys: need ${ringSize - 1}, have ${candidates.length}`);
  }

  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const decoys = shuffled.slice(0, ringSize - 1);
  const realIndex = Math.floor(Math.random() * ringSize);
  const ring: string[] = [];
  let di = 0;
  for (let i = 0; i < ringSize; i++) {
    if (i === realIndex) ring.push(realPubKey);
    else ring.push(decoys[di++]);
  }

  return { ring, realIndex };
}
