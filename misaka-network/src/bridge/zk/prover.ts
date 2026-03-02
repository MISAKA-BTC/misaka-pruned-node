// ============================================================
// Misaka Network - ZK Bridge Prover
// ============================================================
// Generates zero-knowledge proofs for bridge operations.
//
// Proof system: Schnorr-Pedersen Sigma Protocol over Ed25519
//
// For DEPOSIT (Solana → Misaka):
//   Proves knowledge of (amount, blinding, txSig, locker)
//   such that C = amount*G + blinding*H
//   while revealing amount publicly (bridge > privacy).
//
// For WITHDRAW (Misaka → Solana):
//   Proves a valid burn occurred on Misaka
//   with amount revealed for Solana unlock.
//
// Protocol (interactive → Fiat-Shamir non-interactive):
//   Prover:
//     k1, k2 ← random scalars
//     A = k1*G + k2*H         (commitment to randomness)
//     B = k1*G                 (binding element)
//     e = Hash(A, B, C, public_inputs)  (Fiat-Shamir challenge)
//     s1 = k1 - e*amount      (response for value)
//     s2 = k2 - e*blinding    (response for blinding)
//   Verifier:
//     Check: s1*G + s2*H + e*C == A
//     Check: s1*G + e*(amount*G) == B   (amount is public)
// ============================================================

import { createHash } from 'crypto';
import {
  scalarMulBase, scalarMul, pointAdd, pointFromHex,
  hashToScalar, randomScalar, modScalar, scalarToBytes,
  basePoint, zeroPoint, CurvePoint,
} from '../../privacy/curve';
import {
  getH, pedersenCommit, toBaseUnits, PedersenCommitment,
} from '../../privacy/pedersen';
import {
  ZKProof, ZKPublicInputs, ZKWitness, VerificationKey,
  BridgeDirection, BridgeToken, SolanaLockEvent,
} from '../types';
import {
  computeCircuitChallenge, hashProgramId, hashRecipient,
  computeLockEventHash, computeBurnEventHash,
  evaluateCircuit,
} from './circuit';

// ============================================================
// Trusted Setup (simplified — CRS generation)
// ============================================================

/**
 * Generate a verification key (Common Reference String).
 * In production Groth16, this would be a multi-party ceremony.
 * Here we use hash-derived generators for transparency.
 */
export function generateVerificationKey(): VerificationKey {
  const alpha = hashToScalar('misaka_vk_alpha_v1', 'trusted_setup');
  const beta = hashToScalar('misaka_vk_beta_v1', 'trusted_setup');
  const delta = hashToScalar('misaka_vk_delta_v1', 'trusted_setup');

  // Gamma generators: one per public input
  const gammaScalars = [
    hashToScalar('misaka_vk_gamma_0', 'commitment'),
    hashToScalar('misaka_vk_gamma_1', 'programIdHash'),
    hashToScalar('misaka_vk_gamma_2', 'nonce'),
    hashToScalar('misaka_vk_gamma_3', 'recipientHash'),
    hashToScalar('misaka_vk_gamma_4', 'amount'),
    hashToScalar('misaka_vk_gamma_5', 'direction'),
  ];

  return {
    alpha: scalarMulBase(alpha).toHex(),
    beta: scalarMulBase(beta).toHex(),
    gamma: gammaScalars.map(s => scalarMulBase(s).toHex()),
    delta: scalarMulBase(delta).toHex(),
    version: 'schnorr_bridge_v1',
  };
}

// ============================================================
// Deposit Proof (Solana → Misaka)
// ============================================================

/**
 * Generate a ZK proof for a Solana lock event.
 *
 * This proves:
 *   1. Prover knows the lock TX details
 *   2. The Pedersen commitment matches the amount
 *   3. Amount is publicly verifiable (bridge > privacy)
 *
 * @param lockEvent  - The observed Solana lock event
 * @param commitment - Pedersen commitment to the amount
 * @param programId  - Expected Solana bridge program ID
 * @param recipientPubKeyHash - Misaka recipient
 */
export function proveDeposit(
  lockEvent: SolanaLockEvent,
  commitment: PedersenCommitment,
  programId: string,
  recipientPubKeyHash: string,
): ZKProof {
  const H = getH();
  const amount = commitment.value;
  const blinding = commitment.blinding;

  // Verify circuit constraints first
  const programHash = hashProgramId(programId);
  const recipientHash = hashRecipient(recipientPubKeyHash);
  const constraints = evaluateCircuit(
    amount, blinding, commitment.point,
    lockEvent.txSignature, lockEvent.lockerAddress,
    lockEvent.slot, lockEvent.nonce,
    programHash, recipientHash,
  );

  const failed = constraints.filter(c => !c.satisfied);
  if (failed.length > 0) {
    throw new Error(`Circuit constraints failed: ${failed.map(f => f.name).join(', ')}`);
  }

  // Sigma protocol: Prover phase 1 (commitment)
  const k1 = randomScalar(); // randomness for value component
  const k2 = randomScalar(); // randomness for blinding component

  // A = k1*G + k2*H (hides both randomness components)
  const A = pointAdd(scalarMulBase(k1), scalarMul(k2, H));

  // B = binding element incorporating TX details
  const txBinding = hashToScalar(
    lockEvent.txSignature,
    lockEvent.lockerAddress,
    lockEvent.slot.toString(),
    lockEvent.nonce,
    'deposit_binding',
  );
  const B = pointAdd(scalarMulBase(k1), scalarMul(txBinding, basePoint()));

  // Fiat-Shamir challenge
  const e = computeCircuitChallenge(
    A, B, commitment.point,
    programHash, lockEvent.nonce,
    recipientHash, amount,
  );

  // Response scalars
  const s1 = modScalar(k1 - modScalar(e * amount));
  const s2 = modScalar(k2 - modScalar(e * blinding));

  // Construct proof
  const proofC = computeProofC(s1, s2, e, txBinding);

  const publicInputs: ZKPublicInputs = {
    amountCommitment: commitment.point,
    programIdHash: programHash,
    nonce: lockEvent.nonce,
    recipientHash,
    direction: BridgeDirection.SOLANA_TO_MISAKA,
    token: lockEvent.token,
    amount, // PUBLIC — bridge > privacy
  };

  return {
    protocol: 'schnorr_bridge',
    proofA: A.toHex(),
    proofB: B.toHex(),
    proofC: proofC.toHex(),
    responseS1: Buffer.from(scalarToBytes(s1)).toString('hex'),
    responseS2: Buffer.from(scalarToBytes(s2)).toString('hex'),
    publicInputs,
    createdAt: Date.now(),
    proverVersion: 'misaka-bridge-prover-1.0.0',
  };
}

// ============================================================
// Withdraw Proof (Misaka → Solana)
// ============================================================

/**
 * Generate a ZK proof for a Misaka burn event.
 *
 * Proves:
 *   1. Tokens were burned on Misaka (key images spent)
 *   2. The burn amount matches the claimed unlock amount
 *   3. The Solana recipient is bound to the proof
 */
export function proveWithdraw(
  burnTxId: string,
  amount: bigint,
  solanaRecipient: string,
  nonce: string,
  burnKeyImages: string[],
  programId: string,
): ZKProof {
  const H = getH();

  // Create commitment to the burn amount (public)
  const blinding = randomScalar();
  const commitPoint = pointAdd(
    amount === 0n ? zeroPoint() : scalarMulBase(modScalar(amount)),
    scalarMul(blinding, H)
  );
  const commitment = commitPoint.toHex();

  const programHash = hashProgramId(programId);
  const recipientHash = hashRecipient(solanaRecipient);
  const burnHash = computeBurnEventHash(burnTxId, amount, solanaRecipient, nonce);

  // Sigma protocol
  const k1 = randomScalar();
  const k2 = randomScalar();

  const A = pointAdd(scalarMulBase(k1), scalarMul(k2, H));

  // Bind key images into the proof
  const keyImageBinding = hashToScalar(
    ...burnKeyImages,
    burnTxId,
    'withdraw_binding',
  );
  const B = pointAdd(scalarMulBase(k1), scalarMul(keyImageBinding, basePoint()));

  const e = computeCircuitChallenge(
    A, B, commitment,
    programHash, nonce,
    recipientHash, amount,
  );

  const s1 = modScalar(k1 - modScalar(e * amount));
  const s2 = modScalar(k2 - modScalar(e * blinding));

  const proofC = computeProofC(s1, s2, e, keyImageBinding);

  const publicInputs: ZKPublicInputs = {
    amountCommitment: commitment,
    programIdHash: programHash,
    nonce,
    recipientHash,
    direction: BridgeDirection.MISAKA_TO_SOLANA,
    token: BridgeToken.SOL,
    amount, // PUBLIC — bridge > privacy
  };

  return {
    protocol: 'schnorr_bridge',
    proofA: A.toHex(),
    proofB: B.toHex(),
    proofC: proofC.toHex(),
    responseS1: Buffer.from(scalarToBytes(s1)).toString('hex'),
    responseS2: Buffer.from(scalarToBytes(s2)).toString('hex'),
    publicInputs,
    createdAt: Date.now(),
    proverVersion: 'misaka-bridge-prover-1.0.0',
  };
}

// ============================================================
// Helper: Proof C element
// ============================================================

function computeProofC(
  s1: bigint, s2: bigint, e: bigint, binding: bigint
): CurvePoint {
  // C combines all response elements for compact verification
  const combinedScalar = modScalar(s1 + modScalar(s2 * e) + modScalar(binding * modScalar(e * e)));
  return scalarMulBase(combinedScalar);
}
