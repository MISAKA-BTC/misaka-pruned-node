// ============================================================
// Misaka Network - Core Types
// ============================================================

/** Network type */
export type NetworkType = 'mainnet' | 'testnet';

/** HRP for bech32m addresses */
export const HRP: Record<NetworkType, string> = {
  mainnet: 'misaka',
  testnet: 'tmisaka',
};

/** Current address version */
export const ADDRESS_VERSION = 0x00;

/** Network fee rate: 3% of transfer amount */
export const NETWORK_FEE_RATE = 0.03;

/** Fee tier definition (kept for interface compat) */
export interface FeeTier {
  maxAmount: number;     // upper bound (inclusive), Infinity for last tier
  fee: number;           // fixed fee in tokens (legacy — now calculated as 3%)
  label: string;         // human-readable label
}

/** Default fee tiers — single tier, flat 3% */
export const DEFAULT_FEE_TIERS: FeeTier[] = [
  { maxAmount: Infinity, fee: 0, label: 'Flat 3% network fee' },
];

/** Transaction type */
export enum TransactionType {
  /** Standard value transfer */
  TRANSFER = 'transfer',
  /** Block reward (coinbase) */
  COINBASE = 'coinbase',
  /** Privacy-protected confidential transfer */
  CONFIDENTIAL = 'confidential',
  /**
   * Reserved for future Solana bridge deposits.
   * NOT implemented in MVP — included only so the enum value is stable.
   * A deposit tx would carry a zk-proof of the lock event on Solana
   * and mint equivalent tokens on Misaka.
   */
  DEPOSIT = 'deposit',
  /**
   * Reserved for future bridge withdrawals (burn on Misaka → unlock on Solana).
   */
  WITHDRAW = 'withdraw',
}

/** Fee distribution strategy */
export enum FeeDistribution {
  /** 100% to block proposer (MVP default) */
  VALIDATOR_100 = 'validator_100',
  /** 50% burn, 50% to validator */
  BURN_50_VALIDATOR_50 = 'burn_50_validator_50',
  /** 100% burn (deflationary) */
  BURN_100 = 'burn_100',
}

/** Chain parameters (genesis-level configuration) */
export interface ChainParams {
  chainId: string;
  network: NetworkType;
  feeTiers: FeeTier[];
  feeDistribution: FeeDistribution;
  blockReward: number;
  blockInterval: number;         // ms
  maxBlockSize: number;          // max transactions per block
  checkpointInterval: number;    // blocks between checkpoints
  /** Reserved: zk-bridge verifier config (future) */
  bridge?: {
    enabled: boolean;
    solanaRpcUrl?: string;
    verifierContractId?: string;
  };
  /** Archive node public key for audit envelope encryption */
  archivePubKey?: string;
}

/** Default chain parameters */
export const DEFAULT_CHAIN_PARAMS: ChainParams = {
  chainId: 'misaka-mainnet-1',
  network: 'mainnet',
  feeTiers: DEFAULT_FEE_TIERS,
  feeDistribution: FeeDistribution.VALIDATOR_100,
  blockReward: 1000,
  blockInterval: 5000,
  maxBlockSize: 500,
  checkpointInterval: 100,
  bridge: { enabled: false },
};

/** Transaction input (spending a UTXO) */
export interface TxInput {
  prevTxId: string;      // hash of the previous transaction
  outputIndex: number;   // index of the output being spent
  signature: string;     // hex-encoded Ed25519 signature
  publicKey: string;     // hex-encoded Ed25519 public key of the signer
}

/** Transaction output */
export interface TxOutput {
  amount: number;        // amount in base units
  recipientPubKeyHash: string;  // hex-encoded hash of recipient's public key
}

/** Encrypted memo */
export interface EncryptedMemo {
  ciphertext: string;    // hex-encoded encrypted data
  nonce: string;         // hex-encoded nonce
  ephemeralPubKey: string; // hex-encoded ephemeral public key for decryption
}

/** Transaction */
export interface Transaction {
  id: string;            // SHA-256 hash of tx content (computed)
  version: number;       // tx format version
  type: TransactionType; // transaction type
  inputs: TxInput[];
  outputs: TxOutput[];
  fee: number;           // must match tier for the total output amount
  memo?: EncryptedMemo;  // optional encrypted memo
  timestamp: number;     // unix ms
}

/** Unsigned transaction (before ID computed) */
export type UnsignedTransaction = Omit<Transaction, 'id'>;

// ---- Confidential Transaction (privacy-protected) ----

/** Stealth output in a confidential transaction */
export interface ConfidentialStealthOutput {
  /** One-time public key P = Hs(rA)·G + B */
  oneTimePubKey: string;
  /** Ephemeral public key R = r·G */
  ephemeralPubKey: string;
  /** Encrypted amount (only recipient can decrypt) */
  encryptedAmount: string;
  amountNonce: string;
  /** Pedersen commitment C = v·G + r·H */
  commitment: string;
  /** Encrypted commitment secrets (blinding + value) for recipient */
  encryptedCommitmentData?: string;
  commitmentDataNonce?: string;
  outputIndex: number;
}

/** Ring input in a confidential transaction */
export interface ConfidentialRingInput {
  /** Ring member public keys (one is the real sender) */
  ring: string[];
  /** Ring signature proving control without revealing which member */
  ringSignature: {
    c0: string;       // initial challenge
    ss: string[];     // response scalars
    keyImage: string;  // I = x · Hp(P) — unique per secret key
  };
  /** Pedersen commitment of the input being spent */
  inputCommitment: string;
}

/** Audit envelope — encrypted with archive node's public key */
export interface AuditEnvelope {
  /** NaCl box ciphertext (hex) */
  ciphertext: string;
  /** Nonce (hex, 24 bytes) */
  nonce: string;
  /** Ephemeral X25519 public key (hex, 32 bytes) */
  ephemeralPubKey: string;
}

/**
 * Confidential Transaction
 *
 * On-chain data structure for privacy-protected transfers.
 *
 * What PRUNED nodes can verify:
 *   ✅ Ring signatures valid (sender controls one ring member)
 *   ✅ Key images not double-spent
 *   ✅ Pedersen commitment balance (inputs = outputs + fee)
 *   ✅ Audit envelope exists and is structurally valid
 *
 * What PRUNED nodes CANNOT see:
 *   ❌ Who sent it (hidden in ring)
 *   ❌ Who received it (stealth one-time address)
 *   ❌ How much was sent (Pedersen commitment + encrypted)
 *
 * What ARCHIVE nodes can additionally see:
 *   ✅ Decrypted audit envelope → sender, recipients, amounts
 */
export interface ConfidentialTransaction {
  id: string;
  version: number;
  type: TransactionType.CONFIDENTIAL;
  /** Ring inputs (hide sender among decoys) */
  ringInputs: ConfidentialRingInput[];
  /** Stealth outputs (hide recipient with one-time addresses) */
  stealthOutputs: ConfidentialStealthOutput[];
  /** Key images for double-spend prevention */
  keyImages: string[];
  /** Fee (visible — required for validation) */
  fee: number;
  /** Excess blinding factor for Pedersen balance proof */
  excessBlinding: string;
  /** Encrypted audit data (only archive nodes can decrypt) */
  auditEnvelope: AuditEnvelope;
  /** Optional encrypted memo */
  memo?: EncryptedMemo;
  timestamp: number;
}

/** Any transaction that can appear in a block */
export type AnyTransaction = Transaction | ConfidentialTransaction;

/** Type guard: is this a confidential transaction? */
export function isConfidentialTx(tx: AnyTransaction): tx is ConfidentialTransaction {
  return tx.type === TransactionType.CONFIDENTIAL;
}

/** Block header */
export interface BlockHeader {
  version: number;
  height: number;
  previousHash: string;
  merkleRoot: string;
  timestamp: number;
  proposer: string;        // hex-encoded public key of the block proposer
  stateRoot: string;       // hash of UTXO set
}

/** Block with transactions and consensus signatures */
export interface Block {
  header: BlockHeader;
  hash: string;            // SHA-256 of header
  transactions: AnyTransaction[];
  signatures: BlockSignature[];   // 2/3+ validator signatures
}

/** Validator signature on a block */
export interface BlockSignature {
  validatorPubKey: string;  // hex public key
  signature: string;        // hex Ed25519 signature of block hash
}

/** UTXO entry in the database */
export interface UTXOEntry {
  txId: string;
  outputIndex: number;
  amount: number;
  recipientPubKeyHash: string;
  blockHeight: number;
}

/** Confidential UTXO entry (no plaintext amount or recipient) */
export interface ConfidentialUTXOEntry {
  txId: string;
  outputIndex: number;
  /** Pedersen commitment (amount hidden) */
  commitment: string;
  /** One-time public key (recipient hidden) */
  oneTimePubKey: string;
  blockHeight: number;
}

/** Peer information */
export interface PeerInfo {
  nodeId: string;
  host: string;
  port: number;
  chainId: string;
  version: string;
  lastSeen: number;
  score: number;
}

/** Node configuration */
export interface NodeConfig {
  chainId: string;
  network: NetworkType;
  listenHost: string;
  listenPort: number;
  rpcPort: number;
  peers: string[];            // initial peer addresses "host:port"
  validatorKeyPath?: string;  // path to validator key file
  dataDir: string;
  pruningWindow: number;      // number of blocks to keep
  feeTiers: FeeTier[];
  validators: string[];       // hex public keys of allowed validators
  blockInterval: number;      // ms between blocks
  checkpointInterval: number; // blocks between checkpoints
  /** Archive public key (for encrypting audit envelopes) — all nodes need this */
  archivePubKey?: string;
  /** Archive secret key — only archive node operators have this */
  archiveSecretKey?: string;
  /** RPC bind address — default 127.0.0.1, set to 0.0.0.0 only for trusted networks */
  rpcBind?: string;
}

/** Checkpoint (signed state snapshot) */
export interface Checkpoint {
  height: number;
  stateRoot: string;
  blockHash: string;
  signatures: BlockSignature[];
}

/** View key for selective disclosure */
export interface ViewKey {
  /** The public key (address) this view key belongs to */
  ownerPubKeyHash: string;
  /** The x25519 secret key for decrypting memos (hex) */
  viewSecret: string;
  /** Label for this view key */
  label: string;
  /** Optional: restrict to transactions after this timestamp */
  validFrom?: number;
  /** Optional: restrict to transactions before this timestamp */
  validUntil?: number;
}

/** Wallet key pair */
export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Wallet account (for address separation) */
export interface WalletAccount {
  index: number;
  label: string;
  keyPair: KeyPair;
  address: string;
  pubKeyHash: string;
  usageCount: number;
}

/** P2P message types */
export enum MessageType {
  HANDSHAKE = 'handshake',
  HANDSHAKE_ACK = 'handshake_ack',
  GOSSIP_TX = 'gossip_tx',
  GOSSIP_CONFIDENTIAL_TX = 'gossip_confidential_tx',
  GOSSIP_BLOCK = 'gossip_block',
  REQUEST_BLOCKS = 'request_blocks',
  RESPONSE_BLOCKS = 'response_blocks',
  REQUEST_SNAPSHOT = 'request_snapshot',
  RESPONSE_SNAPSHOT = 'response_snapshot',
  PROPOSE_BLOCK = 'propose_block',
  VOTE_BLOCK = 'vote_block',
  PING = 'ping',
  PONG = 'pong',
}

/** P2P network message */
export interface NetworkMessage {
  type: MessageType;
  sender: string;       // node ID
  payload: any;
  timestamp: number;
}
