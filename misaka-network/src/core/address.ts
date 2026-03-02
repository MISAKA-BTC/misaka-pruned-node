// ============================================================
// Misaka Network - Address (bech32m)
// ============================================================
import { bech32m } from 'bech32';
import { NetworkType, HRP, ADDRESS_VERSION } from '../types';

const PAYLOAD_LENGTH = 33; // 1 byte version + 32 bytes pubkey
const PUBKEY_LENGTH = 32;

/**
 * Encode a public key into a Misaka bech32m address.
 */
export function encodeMisakaAddress(pubKey: Uint8Array, network: NetworkType = 'testnet'): string {
  if (pubKey.length !== PUBKEY_LENGTH) {
    throw new Error(`Invalid public key length: expected ${PUBKEY_LENGTH}, got ${pubKey.length}`);
  }

  const hrp = HRP[network];
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  payload[0] = ADDRESS_VERSION;
  payload.set(pubKey, 1);

  // Convert to 5-bit words for bech32m
  const words = bech32m.toWords(Buffer.from(payload));
  return bech32m.encode(hrp, words, 120); // limit=120 chars
}

/**
 * Decode a Misaka bech32m address to its public key and network.
 */
export function decodeMisakaAddress(address: string): { pubKey: Uint8Array; network: NetworkType } {
  let decoded;
  try {
    decoded = bech32m.decode(address, 120);
  } catch (e) {
    throw new Error(`Invalid Misaka address: bech32m decode failed - ${(e as Error).message}`);
  }

  // Check HRP
  let network: NetworkType;
  if (decoded.prefix === HRP.mainnet) {
    network = 'mainnet';
  } else if (decoded.prefix === HRP.testnet) {
    network = 'testnet';
  } else {
    throw new Error(`Invalid Misaka address: unknown HRP "${decoded.prefix}"`);
  }

  // Convert from 5-bit words back to bytes
  const payload = Buffer.from(bech32m.fromWords(decoded.words));

  if (payload.length !== PAYLOAD_LENGTH) {
    throw new Error(`Invalid Misaka address: payload length ${payload.length}, expected ${PAYLOAD_LENGTH}`);
  }

  // Check version
  const version = payload[0];
  if (version !== ADDRESS_VERSION) {
    throw new Error(`Invalid Misaka address: unsupported version ${version}`);
  }

  // Extract pubkey
  const pubKey = new Uint8Array(payload.slice(1));
  if (pubKey.length !== PUBKEY_LENGTH) {
    throw new Error(`Invalid Misaka address: pubkey length ${pubKey.length}, expected ${PUBKEY_LENGTH}`);
  }

  return { pubKey, network };
}

/**
 * Validate a Misaka address string.
 */
export function isValidMisakaAddress(address: string): boolean {
  try {
    decodeMisakaAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a string looks like a Solana address (Base58, ~32-44 chars).
 * Solana addresses are Base58Check encoded, typically 32-44 chars.
 */
export function isSolanaAddress(address: string): boolean {
  // Solana addresses: Base58 characters, typically 32-44 chars
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!base58Regex.test(address)) return false;

  // Additional check: NOT a Misaka address
  if (address.startsWith('misaka1') || address.startsWith('tmisaka1')) return false;

  return true;
}

/**
 * Detect address type and validate for safety.
 */
export function detectAddressType(address: string): 'misaka' | 'solana' | 'unknown' {
  if (isValidMisakaAddress(address)) return 'misaka';
  if (isSolanaAddress(address)) return 'solana';
  return 'unknown';
}

/**
 * Validate a destination address for Misaka sends.
 * Throws if it looks like a Solana address or is invalid.
 */
export function validateMisakaDestination(address: string): void {
  if (isSolanaAddress(address)) {
    throw new Error(
      'ERROR: This looks like a Solana address. ' +
      'Misaka addresses start with "misaka1" or "tmisaka1". ' +
      'Please use the correct address format.'
    );
  }
  if (!isValidMisakaAddress(address)) {
    throw new Error(
      'Invalid Misaka address. ' +
      'Addresses must start with "misaka1" (mainnet) or "tmisaka1" (testnet).'
    );
  }
}
