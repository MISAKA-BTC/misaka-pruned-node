// ============================================================
// Misaka Network - Flat Fee System (3% network fee)
// ============================================================
import { FeeTier, DEFAULT_FEE_TIERS, NETWORK_FEE_RATE } from '../types';

/**
 * Calculate the required fee for a given amount.
 * Flat 3% of the total output amount.
 */
export function calculateFee(amount: number, _tiers?: FeeTier[]): number {
  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }
  // Flat percentage fee, rounded to 8 decimal places
  return Math.round(amount * NETWORK_FEE_RATE * 1e8) / 1e8;
}

/**
 * Validate that a given fee meets the required minimum (>= 3% of amount).
 * Overpaying is allowed (extra goes to validator reward).
 */
export function validateFee(amount: number, fee: number, _tiers?: FeeTier[]): boolean {
  const requiredFee = calculateFee(amount);
  // Fee must be at least the required amount (overpay OK)
  return fee >= requiredFee - 1e-8;
}

/**
 * Get fee rate info.
 */
export function getFeeTier(amount: number, _tiers?: FeeTier[]): FeeTier {
  return DEFAULT_FEE_TIERS[0];
}

/**
 * Display fee info.
 */
export function formatFeeTiers(_tiers?: FeeTier[]): string {
  return [
    'Network Fee:',
    '─'.repeat(50),
    `  Flat rate: ${(NETWORK_FEE_RATE * 100).toFixed(1)}% of transfer amount`,
    '─'.repeat(50),
  ].join('\n');
}

/**
 * Validate fee configuration (backward compat).
 */
export function validateFeeTiers(tiers: FeeTier[]): boolean {
  return tiers.length > 0;
}
