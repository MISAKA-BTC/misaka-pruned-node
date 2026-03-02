// ============================================================
// Misaka Network - ZK Bridge Verifier
// ============================================================
// Verifies zero-knowledge proofs for bridge operations.
//
// Verification equation (Schnorr-Pedersen):
//   Given proof (A, B, C) and public inputs:
//     e = Hash(A, B, commitment, programHash, nonce, recipientHash, amount)
//     Check 1: s1*G + s2*H + e*C_commit == A
//              (Pedersen commitment verification)
//     Check 2: Proof elements are on the curve
//     Check 3: Public inputs match expected values
//     Check 4: Nonce has not been used before
//
// Reconstruction approach:
//   We verify the proof by recomputing A from the proof elements
//   and checking it matches. If the prover didn't know the witness,
//   they couldn't produce a valid (A, B, C) tuple.
// ============================================================

import { createHash } from 'crypto';
import {
  scalarMulBase, scalarMul, pointAdd, pointFromHex,
  hashToScalar, modScalar, scalarToBytes,
  basePoint, zeroPoint, CurvePoint,
} from '../../privacy/curve';
import { getH, toBaseUnits } from '../../privacy/pedersen';
import {
  ZKProof, ZKPublicInputs, VerificationKey,
  BridgeDirection, BridgeToken, BridgeConfig,
} from '../types';
import {
  computeCircuitChallenge, hashProgramId, hashRecipient,
} from './circuit';

/** Verification result */
export interface VerificationResult {
  valid: boolean;
  error?: string;
  checks: VerificationCheck[];
}

/** Individual verification check */
export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

// ============================================================
// Main Verification
// ============================================================

/**
 * Verify a ZK bridge proof.
 *
 * @param proof  - The ZK proof to verify
 * @param vk     - Verification key
 * @param config - Bridge configuration
 * @param processedNonces - Set of already-used nonces
 * @returns Verification result with detailed check breakdown
 */
export function verifyBridgeProof(
  proof: ZKProof,
  vk: VerificationKey,
  config: BridgeConfig,
  processedNonces: Set<string>,
): VerificationResult {
  const checks: VerificationCheck[] = [];

  try {
    // ─── Check 0: Protocol version ───────────────────────
    const protocolOk = proof.protocol === 'schnorr_bridge';
    checks.push({
      name: 'protocol_version',
      passed: protocolOk,
      detail: `Protocol: ${proof.protocol}`,
    });
    if (!protocolOk) {
      return { valid: false, error: `Unsupported proof protocol: ${proof.protocol}`, checks };
    }

    // ─── Check 1: Proof elements are valid curve points ──
    let A: CurvePoint, B: CurvePoint, C: CurvePoint;
    try {
      A = pointFromHex(proof.proofA);
      B = pointFromHex(proof.proofB);
      C = pointFromHex(proof.proofC);
      checks.push({ name: 'curve_points', passed: true, detail: 'All proof elements on curve' });
    } catch (e) {
      checks.push({ name: 'curve_points', passed: false, detail: `Invalid curve point: ${e}` });
      return { valid: false, error: 'Invalid curve points in proof', checks };
    }

    // ─── Check 2: Public inputs validation ───────────────
    const pi = proof.publicInputs;

    // 2a. Amount is positive and within limits
    const amountOk = pi.amount > 0n;
    checks.push({
      name: 'amount_positive',
      passed: amountOk,
      detail: `Amount: ${pi.amount}`,
    });
    if (!amountOk) {
      return { valid: false, error: 'Amount must be positive', checks };
    }

    // 2b. Amount within bridge limits
    const minAmount = config.minimumAmount.get(pi.token);
    const maxAmount = config.maximumAmount.get(pi.token);
    const withinLimits = (!minAmount || pi.amount >= minAmount) &&
                          (!maxAmount || pi.amount <= maxAmount);
    checks.push({
      name: 'amount_limits',
      passed: withinLimits,
      detail: `Min: ${minAmount}, Max: ${maxAmount}, Actual: ${pi.amount}`,
    });

    // 2c. Token is supported
    const tokenOk = config.supportedTokens.includes(pi.token);
    checks.push({
      name: 'token_supported',
      passed: tokenOk,
      detail: `Token: ${pi.token}`,
    });

    // 2d. Direction is valid
    const dirOk = pi.direction === BridgeDirection.SOLANA_TO_MISAKA ||
                  pi.direction === BridgeDirection.MISAKA_TO_SOLANA;
    checks.push({
      name: 'direction_valid',
      passed: dirOk,
      detail: `Direction: ${pi.direction}`,
    });

    // 2e. Program ID hash matches config
    const expectedProgramHash = hashProgramId(config.solanaProgramId);
    const programOk = pi.programIdHash === expectedProgramHash;
    checks.push({
      name: 'program_id_match',
      passed: programOk,
      detail: programOk ? 'Program ID matches' : `Expected: ${expectedProgramHash.slice(0, 16)}..., Got: ${pi.programIdHash.slice(0, 16)}...`,
    });

    // ─── Check 3: Nonce not replayed ─────────────────────
    const nonceOk = !processedNonces.has(pi.nonce);
    checks.push({
      name: 'nonce_unique',
      passed: nonceOk,
      detail: nonceOk ? `Nonce: ${pi.nonce.slice(0, 16)}...` : 'REPLAY DETECTED',
    });
    if (!nonceOk) {
      return { valid: false, error: `Nonce replay detected: ${pi.nonce}`, checks };
    }

    // ─── Check 4: Commitment is valid curve point ────────
    let commitPoint: CurvePoint;
    try {
      commitPoint = pointFromHex(pi.amountCommitment);
      checks.push({ name: 'commitment_valid', passed: true });
    } catch {
      checks.push({ name: 'commitment_valid', passed: false, detail: 'Invalid commitment point' });
      return { valid: false, error: 'Invalid amount commitment', checks };
    }

    // ─── Check 5: Schnorr-Pedersen verification equation ──
    // Verify: s1*G + s2*H + e*Commit == A
    //
    // From prover: A = k1*G + k2*H, s1 = k1 - e*amount, s2 = k2 - e*blinding
    // So: s1*G + s2*H + e*(amount*G + blinding*H)
    //   = (k1 - e*amount)*G + (k2 - e*blinding)*H + e*amount*G + e*blinding*H
    //   = k1*G + k2*H = A  ✓

    if (!proof.responseS1 || !proof.responseS2) {
      checks.push({ name: 'crypto_verification', passed: false, detail: 'Missing response scalars (s1, s2)' });
      return { valid: false, error: 'Proof missing response scalars', checks };
    }

    const { bytesToScalar } = require('../../privacy/curve');
    const s1 = bytesToScalar(new Uint8Array(Buffer.from(proof.responseS1, 'hex')));
    const s2 = bytesToScalar(new Uint8Array(Buffer.from(proof.responseS2, 'hex')));

    // Recompute the Fiat-Shamir challenge
    const e = computeCircuitChallenge(
      A, B, pi.amountCommitment,
      pi.programIdHash, pi.nonce,
      pi.recipientHash, pi.amount,
    );

    // Compute LHS: s1*G + s2*H + e*Commit
    const H = getH();
    const s1G = scalarMulBase(s1);
    const s2H = scalarMul(s2, H);
    const eCommit = scalarMul(e, commitPoint);
    const lhs = pointAdd(pointAdd(s1G, s2H), eCommit);

    // Verify: LHS == A
    const schnorrValid = lhs.toHex() === A.toHex();

    checks.push({
      name: 'crypto_verification',
      passed: schnorrValid,
      detail: schnorrValid
        ? 'Schnorr-Pedersen equation verified: s1·G + s2·H + e·C = A'
        : 'Schnorr-Pedersen verification failed: s1·G + s2·H + e·C ≠ A',
    });

    if (!schnorrValid) {
      return { valid: false, error: 'Schnorr-Pedersen verification equation failed', checks };
    }

    // ─── Check 6: Verification key binding ───────────────
    const vkOk = vk.version === 'schnorr_bridge_v1';
    checks.push({
      name: 'vk_version',
      passed: vkOk,
      detail: `VK version: ${vk.version}`,
    });

    // ─── Final result ────────────────────────────────────
    const allPassed = checks.every(c => c.passed);
    return {
      valid: allPassed,
      error: allPassed ? undefined : `Failed checks: ${checks.filter(c => !c.passed).map(c => c.name).join(', ')}`,
      checks,
    };

  } catch (e: any) {
    checks.push({ name: 'unexpected_error', passed: false, detail: e.message });
    return { valid: false, error: `Verification error: ${e.message}`, checks };
  }
}

/**
 * Quick verification — returns boolean only.
 */
export function quickVerify(
  proof: ZKProof,
  vk: VerificationKey,
  config: BridgeConfig,
  processedNonces: Set<string>,
): boolean {
  return verifyBridgeProof(proof, vk, config, processedNonces).valid;
}
