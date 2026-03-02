// ============================================================
// Misaka Network - Privacy Types
// ============================================================

/** Stealth address keypair — recipient publishes (scanPub, spendPub) */
export interface StealthKeyPair {
  scanSecret: string;   // hex 32B seed
  scanPub: string;      // hex 32B ed25519 pubkey = H(scanSecret)·G
  spendSecret: string;  // hex 32B seed
  spendPub: string;     // hex 32B ed25519 pubkey = H(spendSecret)·G
}

/** Published stealth meta-address (safe to share) */
export interface StealthMeta {
  scanPub: string;
  spendPub: string;
}

/** One-time stealth output (stored on chain) */
export interface StealthOutput {
  oneTimePubKey: string;    // P = Hs(rA)·G + B
  ephemeralPubKey: string;  // R = r·G
  encryptedAmount: string;  // hex (XOR encrypted)
  amountNonce: string;      // hex
  /** Pedersen commitment to the amount: C = v*G + r*H (hex point) */
  commitment: string;
  /** Encrypted blinding factor + value for recipient (hex) */
  encryptedCommitmentData?: string;
  commitmentDataNonce?: string;
  outputIndex: number;
}

/** Ring signature (SAG) */
export interface RingSignature {
  c0: string;         // initial challenge (hex scalar)
  ss: string[];       // response scalars (hex[])
  keyImage: string;   // I = x · Hp(P) (hex point)
}

/** Ring input in a private transaction */
export interface RingInput {
  ring: string[];                  // public keys hex[]
  ringSignature: RingSignature;
  /** Pedersen commitment of the input being spent (hex point) */
  inputCommitment: string;
}

/** Private transaction */
export interface PrivateTransaction {
  id: string;
  version: number;
  type: 'private_transfer';
  ringInputs: RingInput[];
  stealthOutputs: StealthOutput[];
  keyImages: string[];
  fee: number;
  /** Excess blinding factor for Pedersen balance proof */
  excessBlinding: string;
  memo?: { ciphertext: string; nonce: string; ephemeralPubKey: string };
  /** Encrypted audit envelope — only archive nodes can decrypt */
  auditEnvelope?: {
    ciphertext: string;
    nonce: string;
    ephemeralPubKey: string;
  };
  timestamp: number;
}

/** Scanned output (detected by recipient) */
export interface ScannedOutput {
  txId: string;
  outputIndex: number;
  oneTimePubKey: string;
  amount: number;
  oneTimeSecret: bigint;
  keyImage: string;
  /** Pedersen commitment (hex point) */
  commitment: string;
  /** Blinding factor for the commitment */
  blinding: bigint;
}

/** Private UTXO (spendable) */
export interface PrivateUTXO {
  txId: string;
  outputIndex: number;
  oneTimePubKey: string;
  amount: number;
  oneTimeSecret: bigint;
  keyImage: string;
  /** Pedersen commitment (hex point) */
  commitment: string;
  /** Blinding factor for the commitment */
  blinding: bigint;
}
