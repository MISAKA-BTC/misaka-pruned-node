// ============================================================
// Misaka Network - ZK Bridge Types
// ============================================================
// Defines all data structures for the Solana ↔ Misaka bridge.
//
// Architecture:
//   Solana → Misaka (DEPOSIT):
//     1. User locks SOL/SPL on Solana bridge program
//     2. Relayer observes lock event
//     3. Relayer generates zk-proof of lock
//     4. Misaka verifier checks proof → mints on Misaka
//
//   Misaka → Solana (WITHDRAW):
//     1. User burns tokens on Misaka (amount revealed for bridge)
//     2. Relayer observes burn event
//     3. Relayer generates zk-proof of burn
//     4. Solana program verifies proof → unlocks on Solana
//
// Priority: Bridge correctness > Privacy
//   - Deposit amounts are verifiable (needed for mint)
//   - Withdraw amounts are public (needed for unlock)
//   - Recipient on Misaka side uses stealth address when possible
// ============================================================

/** Supported bridge tokens */
export enum BridgeToken {
  SOL = 'SOL',
  USDC = 'USDC',
  MISAKA = 'MISAKA',
}

/** Bridge direction */
export enum BridgeDirection {
  SOLANA_TO_MISAKA = 'solana_to_misaka',
  MISAKA_TO_SOLANA = 'misaka_to_solana',
}

/** Bridge operation status */
export enum BridgeStatus {
  PENDING = 'pending',
  LOCKED = 'locked',
  PROOF_GENERATED = 'proof_generated',
  PROOF_VERIFIED = 'proof_verified',
  MINTED = 'minted',
  BURNED = 'burned',
  UNLOCKED = 'unlocked',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

// ============================================================
// Solana Side
// ============================================================

/** Solana lock event (emitted by bridge program) */
export interface SolanaLockEvent {
  /** Solana transaction signature (base58) */
  txSignature: string;
  /** Solana slot number */
  slot: number;
  /** Bridge program ID (base58) */
  programId: string;
  /** Locker's Solana address (base58) */
  lockerAddress: string;
  /** Amount locked (in lamports / base units) */
  amount: bigint;
  /** Token type */
  token: BridgeToken;
  /** Misaka recipient (stealth meta or pubkey hash) */
  misakaRecipient: string;
  /** Unique nonce to prevent replay */
  nonce: string;
  /** Block timestamp */
  timestamp: number;
}

/** Solana unlock instruction */
export interface SolanaUnlockInstruction {
  /** Misaka burn TX ID */
  burnTxId: string;
  /** Solana recipient address (base58) */
  recipientAddress: string;
  /** Amount to unlock */
  amount: bigint;
  /** Token type */
  token: BridgeToken;
  /** ZK proof of Misaka burn */
  proof: ZKProof;
  /** Nonce */
  nonce: string;
}

// ============================================================
// ZK Proof System
// ============================================================

/**
 * ZK Proof structure (Groth16-style).
 *
 * Proves: "I know a Solana lock TX with amount A to program P,
 *          and the commitment C corresponds to A"
 *
 * Public inputs:
 *   - commitment (Pedersen commitment to amount)
 *   - programId hash
 *   - nonce
 *
 * Private witness:
 *   - actual amount
 *   - blinding factor
 *   - TX signature
 *   - locker address
 */
export interface ZKProof {
  /** Proof type identifier */
  protocol: 'groth16_sim' | 'plonk_sim' | 'schnorr_bridge';
  /** Proof elements (curve points as hex) */
  proofA: string;   // π_A (G1 point): k1*G + k2*H
  proofB: string;   // π_B (G1 point): binding element
  proofC: string;   // π_C (G1 point): combined response
  /** Schnorr response scalars (hex-encoded) — required for verification */
  responseS1?: string;  // s1 = k1 - e*amount
  responseS2?: string;  // s2 = k2 - e*blinding
  /** Public inputs */
  publicInputs: ZKPublicInputs;
  /** Proof metadata */
  createdAt: number;
  /** Prover version */
  proverVersion: string;
}

/** Public inputs to the ZK circuit */
export interface ZKPublicInputs {
  /** Pedersen commitment to the bridged amount: C = v*G + r*H */
  amountCommitment: string;
  /** Hash of the Solana bridge program ID */
  programIdHash: string;
  /** Unique nonce (prevents replay) */
  nonce: string;
  /** Hash of the Misaka recipient */
  recipientHash: string;
  /** Bridge direction */
  direction: BridgeDirection;
  /** Token type */
  token: BridgeToken;
  /**
   * Amount in cleartext — BRIDGE PRIORITY OVER PRIVACY.
   * Required for verifiable minting. The amount is public
   * because the bridge needs to verify the exact tokens
   * to mint/unlock. Stealth addressing still protects
   * the recipient's identity on Misaka.
   */
  amount: bigint;
}

/** ZK circuit witness (private, never shared) */
export interface ZKWitness {
  /** Actual amount (lamports / base units) */
  amount: bigint;
  /** Pedersen blinding factor */
  blinding: bigint;
  /** Solana TX signature */
  txSignature: string;
  /** Locker's Solana address */
  lockerAddress: string;
  /** Solana slot */
  slot: number;
  /** Bridge nonce */
  nonce: string;
}

/** Verification key (used by Misaka to verify proofs) */
export interface VerificationKey {
  /** Generator point for alpha (hex) */
  alpha: string;
  /** Generator point for beta (hex) */
  beta: string;
  /** Generator points for public inputs (hex[]) */
  gamma: string[];
  /** Delta point (hex) */
  delta: string;
  /** Protocol version */
  version: string;
}

// ============================================================
// Misaka Side
// ============================================================

/** Deposit transaction data (Solana → Misaka) */
export interface DepositTxData {
  /** ZK proof of Solana lock */
  proof: ZKProof;
  /** Solana lock event hash (for reference) */
  lockEventHash: string;
  /** Amount to mint on Misaka (public — bridge > privacy) */
  amount: number;
  /** Recipient on Misaka (pubkey hash or stealth) */
  recipientPubKeyHash: string;
  /** Token being bridged */
  token: BridgeToken;
  /** Bridge nonce */
  nonce: string;
}

/** Withdraw transaction data (Misaka → Solana) */
export interface WithdrawTxData {
  /** Amount to burn on Misaka (public — bridge > privacy) */
  amount: number;
  /** Solana recipient address */
  solanaRecipient: string;
  /** Token being bridged */
  token: BridgeToken;
  /** Burn proof (key image of spent UTXO) */
  burnKeyImages: string[];
  /** Bridge nonce */
  nonce: string;
}

/** Bridge state (tracked by Misaka validators) */
export interface BridgeState {
  /** All processed nonces (replay prevention) */
  processedNonces: Set<string>;
  /** Total minted per token */
  totalMinted: Map<BridgeToken, bigint>;
  /** Total burned per token */
  totalBurned: Map<BridgeToken, bigint>;
  /** Pending deposits */
  pendingDeposits: Map<string, DepositTxData>;
  /** Pending withdrawals */
  pendingWithdrawals: Map<string, WithdrawTxData>;
  /** Active verification key */
  verificationKey: VerificationKey;
}

// ============================================================
// Relayer
// ============================================================

/** Relayer configuration */
export interface RelayerConfig {
  /** Solana RPC endpoint */
  solanaRpcUrl: string;
  /** Misaka node RPC endpoint */
  misakaRpcUrl: string;
  /** Bridge program ID on Solana */
  bridgeProgramId: string;
  /** Relayer's signing key */
  relayerSecret: string;
  /** Polling interval (ms) */
  pollInterval: number;
  /** Maximum retries for failed operations */
  maxRetries: number;
  /** Confirmation depth on Solana before processing */
  solanaConfirmations: number;
}

/** Relayer operation record */
export interface RelayerOperation {
  id: string;
  direction: BridgeDirection;
  status: BridgeStatus;
  proof?: ZKProof;
  lockEvent?: SolanaLockEvent;
  withdrawData?: WithdrawTxData;
  misakaTxId?: string;
  solanaTxSig?: string;
  retries: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

// ============================================================
// Bridge Configuration
// ============================================================

/** Bridge module configuration */
export interface BridgeConfig {
  /** Is the bridge enabled? */
  enabled: boolean;
  /** Supported tokens */
  supportedTokens: BridgeToken[];
  /** Minimum bridge amount per token */
  minimumAmount: Map<BridgeToken, bigint>;
  /** Maximum bridge amount per token per operation */
  maximumAmount: Map<BridgeToken, bigint>;
  /** Bridge fee (flat, in Misaka tokens) */
  bridgeFee: number;
  /** Required validator confirmations for bridge operations */
  requiredConfirmations: number;
  /** Solana bridge program ID */
  solanaProgramId: string;
  /** Verification key for ZK proofs */
  verificationKey: VerificationKey;
}

/** Default bridge configuration */
export function defaultBridgeConfig(vk: VerificationKey): BridgeConfig {
  return {
    enabled: true,
    supportedTokens: [BridgeToken.SOL, BridgeToken.USDC],
    minimumAmount: new Map([
      [BridgeToken.SOL, 1_000_000n],      // 0.001 SOL
      [BridgeToken.USDC, 1_000_000n],     // 1 USDC
    ]),
    maximumAmount: new Map([
      [BridgeToken.SOL, 100_000_000_000n], // 100 SOL
      [BridgeToken.USDC, 100_000_000_000n],// 100k USDC
    ]),
    bridgeFee: 5,
    requiredConfirmations: 3,
    solanaProgramId: 'BridgeMisakaProgram1111111111111111111111111',
    verificationKey: vk,
  };
}
