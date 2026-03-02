// ============================================================
// Misaka Network - Archive Audit System
// ============================================================
// Archive nodes hold a special decryption key that lets them
// read the plaintext details of confidential transactions.
//
// On-chain: transactions carry an "audit envelope" encrypted
// with the archive public key. Only archive operators can open it.
//
// Pruned nodes: verify ring sigs + Pedersen balance, never see plaintext.
// Archive nodes: decrypt envelope → sender, recipient, amounts.
// ============================================================

import { createHash, randomBytes } from 'crypto';
import nacl from 'tweetnacl';

// ---- Archive Key Pair ----

export interface ArchiveKeyPair {
  /** X25519 public key (hex, 32 bytes) — published in chain params */
  publicKey: string;
  /** X25519 secret key (hex, 32 bytes) — held only by archive operators */
  secretKey: string;
}

/**
 * Generate a new archive key pair.
 * The public key goes into chain params (genesis).
 * The secret key is distributed only to archive node operators.
 */
export function generateArchiveKeyPair(): ArchiveKeyPair {
  const kp = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString('hex'),
    secretKey: Buffer.from(kp.secretKey).toString('hex'),
  };
}

// ---- Audit Envelope ----

/** Plaintext audit data inside the envelope */
export interface AuditData {
  /** Sender's public key (hex) */
  senderPubKey: string;
  /** Sender's public key hash */
  senderPubKeyHash: string;
  /** Per-output: recipient pubkey hash + amount */
  outputs: Array<{
    recipientPubKeyHash: string;
    amount: number;
  }>;
  /** UTXO references consumed */
  inputRefs: Array<{
    txId: string;
    outputIndex: number;
    amount: number;
  }>;
  /** Total fee */
  fee: number;
  /** Timestamp */
  timestamp: number;
}

/** Encrypted audit envelope (stored on-chain) */
export interface AuditEnvelope {
  /** NaCl box ciphertext (hex) */
  ciphertext: string;
  /** Nonce (hex, 24 bytes) */
  nonce: string;
  /** Ephemeral X25519 public key used for encryption (hex, 32 bytes) */
  ephemeralPubKey: string;
}

/**
 * Encrypt audit data with the archive public key.
 * Uses NaCl box (X25519 + XSalsa20-Poly1305).
 *
 * Called by the transaction sender. Anyone can encrypt to the archive key,
 * but only the archive operator (with the secret key) can decrypt.
 */
export function encryptAuditEnvelope(
  data: AuditData,
  archivePubKeyHex: string
): AuditEnvelope {
  const archivePub = new Uint8Array(Buffer.from(archivePubKeyHex, 'hex'));
  const ephemeralKP = nacl.box.keyPair();
  const nonce = randomBytes(24);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');

  const ciphertext = nacl.box(
    new Uint8Array(plaintext),
    new Uint8Array(nonce),
    archivePub,
    ephemeralKP.secretKey
  );

  if (!ciphertext) {
    throw new Error('Audit envelope encryption failed');
  }

  return {
    ciphertext: Buffer.from(ciphertext).toString('hex'),
    nonce: Buffer.from(nonce).toString('hex'),
    ephemeralPubKey: Buffer.from(ephemeralKP.publicKey).toString('hex'),
  };
}

/**
 * Decrypt an audit envelope with the archive secret key.
 * Returns the plaintext audit data, or null if decryption fails.
 *
 * Only archive node operators have the secret key.
 */
export function decryptAuditEnvelope(
  envelope: AuditEnvelope,
  archiveSecretKeyHex: string
): AuditData | null {
  try {
    const ciphertext = new Uint8Array(Buffer.from(envelope.ciphertext, 'hex'));
    const nonce = new Uint8Array(Buffer.from(envelope.nonce, 'hex'));
    const ephPub = new Uint8Array(Buffer.from(envelope.ephemeralPubKey, 'hex'));
    const secretKey = new Uint8Array(Buffer.from(archiveSecretKeyHex, 'hex'));

    const plaintext = nacl.box.open(ciphertext, nonce, ephPub, secretKey);
    if (!plaintext) return null;

    return JSON.parse(Buffer.from(plaintext).toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Verify that an audit envelope is structurally valid (non-empty, correct sizes).
 * Does NOT require the secret key — any node can check structure.
 */
export function isValidAuditEnvelope(envelope: AuditEnvelope): boolean {
  if (!envelope.ciphertext || !envelope.nonce || !envelope.ephemeralPubKey) return false;
  if (Buffer.from(envelope.nonce, 'hex').length !== 24) return false;
  if (Buffer.from(envelope.ephemeralPubKey, 'hex').length !== 32) return false;
  if (Buffer.from(envelope.ciphertext, 'hex').length === 0) return false;
  return true;
}
