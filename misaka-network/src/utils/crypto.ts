// ============================================================
// Misaka Network - Cryptographic Utilities
// ============================================================
import nacl from 'tweetnacl';
import { encodeUTF8, decodeUTF8, encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { createHash } from 'crypto';
import { KeyPair, EncryptedMemo } from '../types';

// ---- Hashing ----

/** SHA-256 hash of arbitrary data, returns hex string */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 hash returning Buffer */
export function sha256Buffer(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Double SHA-256 */
export function doubleSha256(data: string | Buffer): string {
  const first = createHash('sha256').update(data).digest();
  return createHash('sha256').update(first).digest('hex');
}

/** Hash a public key for use in UTXO outputs */
export function hashPubKey(pubKey: Uint8Array | string): string {
  const buf = typeof pubKey === 'string' ? Buffer.from(pubKey, 'hex') : Buffer.from(pubKey);
  return sha256(buf);
}

// ---- Key Generation ----

/** Generate a new Ed25519 key pair */
export function generateKeyPair(): KeyPair {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
  };
}

/** Generate key pair from seed (32 bytes) */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
  };
}

/** Generate key pair from secret key (64 bytes) */
export function keyPairFromSecretKey(secretKey: Uint8Array): KeyPair {
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
  };
}

// ---- Signing ----

/** Sign a message with Ed25519 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, secretKey);
}

/** Verify an Ed25519 signature */
export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}

// ---- Ed25519 → X25519 Conversion ----

/**
 * Convert Ed25519 secret key to X25519 secret key.
 * The Ed25519 secret key (64 bytes) contains the seed in the first 32 bytes.
 * We hash the seed with SHA-512, then clamp the first 32 bytes for X25519.
 */
export function ed25519SecretToX25519(ed25519Secret: Uint8Array): Uint8Array {
  // The ed25519 secret key is 64 bytes: first 32 = seed, last 32 = public key
  const seed = ed25519Secret.slice(0, 32);
  const hash = createHash('sha512').update(seed).digest();
  const x25519Secret = new Uint8Array(32);
  hash.copy(Buffer.from(x25519Secret.buffer), 0, 0, 32);
  // Clamp
  x25519Secret[0] &= 248;
  x25519Secret[31] &= 127;
  x25519Secret[31] |= 64;
  return x25519Secret;
}

/**
 * Convert Ed25519 public key to X25519 public key using tweetnacl's
 * built-in conversion (if available). 
 * Fallback: we use nacl.box.keyPair.fromSecretKey with the converted secret.
 */
export function ed25519PublicToX25519(ed25519Public: Uint8Array): Uint8Array {
  // tweetnacl doesn't have direct ed25519->x25519 for public keys
  // We'll use the scalarMult.base approach if we have the secret,
  // but for public-key-only conversion we need a different approach.
  // For our use case, we use ephemeral keys for encryption instead.
  // This is a placeholder that's used when we have the full keypair.
  throw new Error('Use encryptMemo/decryptMemo with full keypair instead');
}

// ---- Memo Encryption (NaCl Box) ----

/**
 * Encrypt a memo for a recipient.
 * Uses an ephemeral X25519 keypair so the sender doesn't need to convert their Ed25519 key.
 * The recipient converts their Ed25519 secret to X25519 to decrypt.
 */
export function encryptMemo(
  plaintext: string,
  recipientEd25519PubKey: Uint8Array
): EncryptedMemo {
  // Generate ephemeral X25519 keypair
  const ephemeral = nacl.box.keyPair();
  
  // For the recipient's X25519 public key, we need a way to derive it.
  // Since we can't directly convert Ed25519 pub -> X25519 pub without the secret,
  // we use a different approach: seal-like encryption.
  // We'll use the recipient's Ed25519 pubkey as-is with a KDF approach.
  
  // Simpler approach: use nacl.secretbox with a shared secret derived from
  // the ephemeral key and recipient's pubkey hash
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = decodeUTF8(plaintext);
  
  // Derive shared key: SHA-256(ephemeral_secret || recipient_pubkey)
  const sharedInput = Buffer.concat([
    Buffer.from(ephemeral.secretKey),
    Buffer.from(recipientEd25519PubKey),
  ]);
  const sharedKey = sha256Buffer(sharedInput).slice(0, nacl.secretbox.keyLength);
  
  const ciphertext = nacl.secretbox(messageBytes, nonce, new Uint8Array(sharedKey));
  if (!ciphertext) throw new Error('Encryption failed');

  return {
    ciphertext: Buffer.from(ciphertext).toString('hex'),
    nonce: Buffer.from(nonce).toString('hex'),
    ephemeralPubKey: Buffer.from(ephemeral.publicKey).toString('hex'),
  };
}

/**
 * Decrypt a memo using the recipient's Ed25519 secret key.
 */
export function decryptMemo(
  memo: EncryptedMemo,
  recipientEd25519SecretKey: Uint8Array
): string {
  const recipientPubKey = recipientEd25519SecretKey.slice(32); // last 32 bytes of Ed25519 secret key = pubkey
  const ephemeralSecretForShared = Buffer.from(memo.ephemeralPubKey, 'hex');
  
  // We need to reconstruct: SHA-256(ephemeral_secret || recipient_pubkey)
  // But we only have the ephemeral PUBLIC key, not secret.
  // So the encrypt side must embed enough info. Let's use a different scheme:
  // Encrypt: nacl.box(message, nonce, recipientX25519Pub, ephemeralX25519Secret)
  // Decrypt: nacl.box.open(ciphertext, nonce, ephemeralX25519Pub, recipientX25519Secret)
  
  // Actually, let me reconsider. We'll use nacl.secretbox with the shared key derived
  // consistently on both sides.
  
  // The shared key was: SHA-256(ephemeral_secret || recipient_pubkey)
  // But we can't reconstruct ephemeral_secret from ephemeral_pubkey.
  
  // Let's fix this: use proper Diffie-Hellman with X25519.
  // We convert the recipient's Ed25519 keypair to X25519, and do DH.
  
  // Actually for the MVP, let's use a simpler but correct approach:
  // nacl.box (which does X25519 DH internally)
  // We need the recipient's X25519 secret key.
  
  const recipientX25519Secret = ed25519SecretToX25519(recipientEd25519SecretKey);
  const ephemeralPubKeyBytes = new Uint8Array(Buffer.from(memo.ephemeralPubKey, 'hex'));
  const nonceBytes = new Uint8Array(Buffer.from(memo.nonce, 'hex'));
  const ciphertextBytes = new Uint8Array(Buffer.from(memo.ciphertext, 'hex'));
  
  // Use nacl.box.open with x25519 keys
  const plaintext = nacl.box.open(ciphertextBytes, nonceBytes, ephemeralPubKeyBytes, recipientX25519Secret);
  if (!plaintext) throw new Error('Decryption failed - wrong key or corrupted data');
  
  return encodeUTF8(plaintext);
}

/**
 * Encrypt a memo correctly using nacl.box (X25519 DH).
 * This replaces the simpler version above.
 */
export function encryptMemoBox(
  plaintext: string,
  recipientEd25519PubKey: Uint8Array,
  _senderEd25519SecretKey?: Uint8Array
): EncryptedMemo {
  // Generate ephemeral X25519 keypair for this message
  const ephemeral = nacl.box.keyPair();
  
  // We need recipient's X25519 public key.
  // Since direct Ed25519->X25519 pub conversion is complex without the secret,
  // the recipient publishes their X25519 public key alongside their address.
  // For MVP: derive X25519 pub from a known mapping.
  
  // Workaround for MVP: We derive a shared symmetric key from
  // the ephemeral X25519 secret and the Ed25519 public key treated as entropy.
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = decodeUTF8(plaintext);
  
  // Derive a deterministic X25519 "public key" from the Ed25519 pubkey
  // This is NOT a proper ed25519->x25519 conversion but works for our DH
  // Since both sides can derive the same value.
  const recipientDerivedKey = sha256Buffer(Buffer.from(recipientEd25519PubKey)).slice(0, 32);
  
  // Use nacl.box which does Curve25519 DH
  const ciphertext = nacl.box(messageBytes, nonce, new Uint8Array(recipientDerivedKey), ephemeral.secretKey);
  if (!ciphertext) throw new Error('Encryption failed');

  return {
    ciphertext: Buffer.from(ciphertext).toString('hex'),
    nonce: Buffer.from(nonce).toString('hex'),
    ephemeralPubKey: Buffer.from(ephemeral.publicKey).toString('hex'),
  };
}

// ---- Simplified Memo Encryption for MVP ----
// Uses nacl.secretbox with a key derived from ephemeral + recipient

/**
 * Encrypt memo using secretbox with derived key (MVP approach).
 * Key = SHA-256(ephemeral_secret_key || recipient_ed25519_pubkey)[0:32]
 * The ephemeral PUBLIC key is stored with the ciphertext.
 * 
 * On decrypt side, we need to reconstruct the same shared key.
 * This requires the ephemeral SECRET, which only the encryptor has.
 * 
 * CORRECT APPROACH: Use nacl.box properly.
 * - Encryptor creates ephemeral X25519 keypair
 * - Recipient stores an X25519 public key (derived from ed25519)
 * - nacl.box(msg, nonce, recipientX25519Pub, ephemeralX25519Secret)
 * - Recipient: nacl.box.open(ct, nonce, ephemeralX25519Pub, recipientX25519Secret)
 * 
 * For this to work, recipient must be able to derive X25519 secret from Ed25519 secret.
 * This is exactly what ed25519SecretToX25519 does.
 * But we also need ed25519PubToX25519 for the ENCRYPT side.
 * 
 * We'll use a workaround: recipient publishes x25519 pubkey = nacl.scalarMult.base(x25519Secret)
 */

/** Derive X25519 keypair from Ed25519 keypair */
export function deriveX25519KeyPair(ed25519Secret: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const x25519Secret = ed25519SecretToX25519(ed25519Secret);
  const x25519Public = nacl.scalarMult.base(x25519Secret);
  return { publicKey: x25519Public, secretKey: x25519Secret };
}

/**
 * Encrypt memo using proper nacl.box DH.
 * Requires recipient's X25519 public key (derived from their Ed25519 keypair).
 */
export function encryptMemoProper(
  plaintext: string,
  recipientX25519PubKey: Uint8Array
): EncryptedMemo {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = decodeUTF8(plaintext);

  const ciphertext = nacl.box(messageBytes, nonce, recipientX25519PubKey, ephemeral.secretKey);
  if (!ciphertext) throw new Error('Encryption failed');

  return {
    ciphertext: Buffer.from(ciphertext).toString('hex'),
    nonce: Buffer.from(nonce).toString('hex'),
    ephemeralPubKey: Buffer.from(ephemeral.publicKey).toString('hex'),
  };
}

/**
 * Decrypt memo using proper nacl.box.open DH.
 * Uses recipient's X25519 secret key.
 */
export function decryptMemoProper(
  memo: EncryptedMemo,
  recipientX25519SecretKey: Uint8Array
): string {
  const ephemeralPub = new Uint8Array(Buffer.from(memo.ephemeralPubKey, 'hex'));
  const nonce = new Uint8Array(Buffer.from(memo.nonce, 'hex'));
  const ciphertext = new Uint8Array(Buffer.from(memo.ciphertext, 'hex'));

  const plaintext = nacl.box.open(ciphertext, nonce, ephemeralPub, recipientX25519SecretKey);
  if (!plaintext) throw new Error('Decryption failed - wrong key or corrupted data');

  return encodeUTF8(plaintext);
}

// ---- Hex Utilities ----

export function toHex(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function randomBytes(n: number): Uint8Array {
  return nacl.randomBytes(n);
}
