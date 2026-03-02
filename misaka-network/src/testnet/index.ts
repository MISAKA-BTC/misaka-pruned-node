// ============================================================
// Misaka Network - Testnet Utilities
// ============================================================
// - Permissionless validator creation (no staking/anchoring)
// - Token faucet for testing
// - Auto-bootstrap with validators + faucet
// ============================================================

import nacl from 'tweetnacl';
import { encodeMisakaAddress } from '../core/address';
import { generateStealthKeyPair } from '../privacy/stealth';
import { createCoinbaseTx } from '../core/transaction';
import { Transaction, KeyPair } from '../types';
import { hashPubKey, toHex } from '../utils/crypto';
import { StealthKeyPair } from '../privacy/types';

// ============================================================
// Testnet Validator (permissionless — no anchoring required)
// ============================================================

export interface TestnetValidator {
  name: string;
  keyPair: KeyPair;
  pubKeyHex: string;
  address: string;           // tmisaka1...
  pubKeyHash: string;
  stealthKeys: StealthKeyPair;
  createdAt: number;
}

/**
 * Create a new testnet validator — no staking, no anchoring.
 * Just generate keys and you're a validator.
 */
export function createTestnetValidator(name?: string): TestnetValidator {
  const kp = nacl.sign.keyPair();
  const pubKeyHex = toHex(kp.publicKey);
  const address = encodeMisakaAddress(kp.publicKey, 'testnet');
  const pubKeyHash = hashPubKey(kp.publicKey);

  return {
    name: name || `validator-${pubKeyHex.slice(0, 8)}`,
    keyPair: { publicKey: kp.publicKey, secretKey: kp.secretKey },
    pubKeyHex,
    address,
    pubKeyHash,
    stealthKeys: generateStealthKeyPair(),
    createdAt: Date.now(),
  };
}

/** Create a simple test account (not a validator). */
export function createTestAccount(label?: string) {
  const kp = nacl.sign.keyPair();
  const pubKeyHex = toHex(kp.publicKey);
  return {
    keyPair: { publicKey: kp.publicKey, secretKey: kp.secretKey } as KeyPair,
    pubKeyHex,
    address: encodeMisakaAddress(kp.publicKey, 'testnet'),
    pubKeyHash: hashPubKey(kp.publicKey),
    label: label || `account-${pubKeyHex.slice(0, 8)}`,
  };
}

// ============================================================
// Testnet Faucet
// ============================================================

export interface FaucetConfig {
  dripAmount: number;          // tokens per drip (default 10M)
  cooldownMs: number;          // rate limit per address (ms)
  maxDripsPerAddress: number;  // max drips per address
  totalSupply: number;         // total faucet supply
}

export const DEFAULT_FAUCET_CONFIG: FaucetConfig = {
  dripAmount: 10_000_000,
  cooldownMs: 60_000,
  maxDripsPerAddress: 10,
  totalSupply: 1_000_000_000,
};

export class TestnetFaucet {
  private config: FaucetConfig;
  private faucetKeyPair: KeyPair;
  private faucetPubKeyHash: string;
  private faucetAddress: string;
  private distributed = 0;
  private dripHistory = new Map<string, { count: number; lastDrip: number }>();
  private blockHeight = 0;

  constructor(config?: Partial<FaucetConfig>) {
    this.config = { ...DEFAULT_FAUCET_CONFIG, ...config };
    const kp = nacl.sign.keyPair();
    this.faucetKeyPair = { publicKey: kp.publicKey, secretKey: kp.secretKey };
    this.faucetPubKeyHash = hashPubKey(kp.publicKey);
    this.faucetAddress = encodeMisakaAddress(kp.publicKey, 'testnet');
  }

  getAddress(): string { return this.faucetAddress; }
  getPubKeyHex(): string { return toHex(this.faucetKeyPair.publicKey); }
  getPubKeyHash(): string { return this.faucetPubKeyHash; }
  getRemaining(): number { return this.config.totalSupply - this.distributed; }

  /** Create genesis TX that funds the faucet */
  createFaucetGenesisTx(): Transaction {
    return createCoinbaseTx(this.faucetPubKeyHash, this.config.totalSupply, 0);
  }

  /**
   * Request tokens from the faucet.
   * Returns coinbase TX or error.
   */
  drip(recipientPubKeyHash: string, amount?: number):
    { tx: Transaction; amount: number } | { error: string } {
    const dripAmount = amount || this.config.dripAmount;

    if (this.distributed + dripAmount > this.config.totalSupply) {
      return { error: 'Faucet depleted' };
    }

    const history = this.dripHistory.get(recipientPubKeyHash);
    if (history) {
      if (history.count >= this.config.maxDripsPerAddress) {
        return { error: `Max drips (${this.config.maxDripsPerAddress}) reached` };
      }
      const elapsed = Date.now() - history.lastDrip;
      if (elapsed < this.config.cooldownMs) {
        return { error: `Cooldown active. Wait ${Math.ceil((this.config.cooldownMs - elapsed) / 1000)}s.` };
      }
    }

    this.blockHeight++;
    const tx = createCoinbaseTx(recipientPubKeyHash, dripAmount, this.blockHeight);
    this.distributed += dripAmount;
    this.dripHistory.set(recipientPubKeyHash, {
      count: (history?.count || 0) + 1,
      lastDrip: Date.now(),
    });

    return { tx, amount: dripAmount };
  }

  getStats() {
    let totalDrips = 0;
    for (const [, h] of this.dripHistory) totalDrips += h.count;
    return {
      totalSupply: this.config.totalSupply,
      distributed: this.distributed,
      remaining: this.getRemaining(),
      uniqueRecipients: this.dripHistory.size,
      totalDrips,
    };
  }
}

// ============================================================
// Testnet Bootstrap
// ============================================================

/**
 * Bootstrap a complete testnet with validators + faucet.
 * Every validator gets initial tokens — no staking needed.
 */
export function bootstrapTestnet(params?: {
  numValidators?: number;
  faucetConfig?: Partial<FaucetConfig>;
  tokensPerValidator?: number;
}) {
  const numValidators = params?.numValidators || 4;
  const tokensPerValidator = params?.tokensPerValidator || 100_000_000;

  const faucet = new TestnetFaucet(params?.faucetConfig);
  const validators: TestnetValidator[] = [];
  const genesisTxs: Transaction[] = [];

  // Faucet genesis
  genesisTxs.push(faucet.createFaucetGenesisTx());

  // Validators
  for (let i = 0; i < numValidators; i++) {
    const v = createTestnetValidator(`testnet-validator-${i}`);
    validators.push(v);
    genesisTxs.push(createCoinbaseTx(v.pubKeyHash, tokensPerValidator, 0));
  }

  return { validators, faucet, genesisTxs };
}
