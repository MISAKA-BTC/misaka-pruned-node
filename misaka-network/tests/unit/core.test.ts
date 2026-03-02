// ============================================================
// Misaka Network - Unit Tests
// ============================================================
import {
  encodeMisakaAddress,
  decodeMisakaAddress,
  isValidMisakaAddress,
  isSolanaAddress,
  detectAddressType,
  validateMisakaDestination,
} from '../../src/core/address';
import {
  calculateFee,
  validateFee,
  getFeeTier,
  validateFeeTiers,
  formatFeeTiers,
} from '../../src/core/fee';
import {
  createTransaction,
  validateTransaction,
  computeTxId,
  createCoinbaseTx,
  getInputSigningMessage,
} from '../../src/core/transaction';
import { UTXOStore } from '../../src/core/utxo-store';
import {
  generateKeyPair,
  sha256,
  toHex,
  fromHex,
  hashPubKey,
  sign,
  verify,
  encryptMemoProper,
  decryptMemoProper,
  deriveX25519KeyPair,
} from '../../src/utils/crypto';
import { DEFAULT_FEE_TIERS, TransactionType } from '../../src/types';

// =============================================
// Address Tests
// =============================================
describe('Misaka Address (bech32m)', () => {
  let keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeAll(() => {
    keyPair = generateKeyPair();
  });

  test('encode and decode testnet address', () => {
    const address = encodeMisakaAddress(keyPair.publicKey, 'testnet');
    expect(address.startsWith('tmisaka1')).toBe(true);

    const decoded = decodeMisakaAddress(address);
    expect(decoded.network).toBe('testnet');
    expect(toHex(decoded.pubKey)).toBe(toHex(keyPair.publicKey));
  });

  test('encode and decode mainnet address', () => {
    const address = encodeMisakaAddress(keyPair.publicKey, 'mainnet');
    expect(address.startsWith('misaka1')).toBe(true);

    const decoded = decodeMisakaAddress(address);
    expect(decoded.network).toBe('mainnet');
    expect(toHex(decoded.pubKey)).toBe(toHex(keyPair.publicKey));
  });

  test('reject invalid pubkey length', () => {
    expect(() => encodeMisakaAddress(new Uint8Array(16), 'testnet')).toThrow('Invalid public key length');
  });

  test('reject corrupted address', () => {
    const address = encodeMisakaAddress(keyPair.publicKey, 'testnet');
    // Corrupt a character
    const corrupted = address.slice(0, 10) + 'x' + address.slice(11);
    expect(isValidMisakaAddress(corrupted)).toBe(false);
  });

  test('reject address with wrong HRP', () => {
    expect(isValidMisakaAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
  });

  test('isValidMisakaAddress returns true for valid', () => {
    const address = encodeMisakaAddress(keyPair.publicKey, 'testnet');
    expect(isValidMisakaAddress(address)).toBe(true);
  });

  test('multiple keypairs produce different addresses', () => {
    const kp2 = generateKeyPair();
    const addr1 = encodeMisakaAddress(keyPair.publicKey, 'testnet');
    const addr2 = encodeMisakaAddress(kp2.publicKey, 'testnet');
    expect(addr1).not.toBe(addr2);
  });

  test('same key produces same address', () => {
    const addr1 = encodeMisakaAddress(keyPair.publicKey, 'testnet');
    const addr2 = encodeMisakaAddress(keyPair.publicKey, 'testnet');
    expect(addr1).toBe(addr2);
  });
});

describe('Solana Address Detection', () => {
  test('detect Solana-like address', () => {
    // Typical Solana address format
    expect(isSolanaAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe(true);
    expect(isSolanaAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe(true);
  });

  test('Misaka address is not a Solana address', () => {
    const kp = generateKeyPair();
    const misakaAddr = encodeMisakaAddress(kp.publicKey, 'testnet');
    expect(isSolanaAddress(misakaAddr)).toBe(false);
  });

  test('detectAddressType correctly identifies types', () => {
    const kp = generateKeyPair();
    const misakaAddr = encodeMisakaAddress(kp.publicKey, 'testnet');

    expect(detectAddressType(misakaAddr)).toBe('misaka');
    expect(detectAddressType('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe('solana');
    expect(detectAddressType('not-an-address')).toBe('unknown');
  });

  test('validateMisakaDestination throws for Solana address', () => {
    expect(() => {
      validateMisakaDestination('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    }).toThrow('Solana address');
  });

  test('validateMisakaDestination throws for invalid address', () => {
    expect(() => {
      validateMisakaDestination('not-an-address');
    }).toThrow('Invalid Misaka address');
  });

  test('validateMisakaDestination passes for valid Misaka address', () => {
    const kp = generateKeyPair();
    const addr = encodeMisakaAddress(kp.publicKey, 'testnet');
    expect(() => validateMisakaDestination(addr)).not.toThrow();
  });
});

// =============================================
// Fee Tests
// =============================================
describe('Flat 3% Fee System', () => {
  test('fee is 3% of amount', () => {
    expect(calculateFee(1000)).toBe(30);         // 1000 * 0.03
    expect(calculateFee(10_000)).toBe(300);      // 10000 * 0.03
    expect(calculateFee(100_000)).toBe(3000);    // 100000 * 0.03
    expect(calculateFee(1_000_000)).toBe(30000); // 1M * 0.03
  });

  test('small amounts get proportional fee', () => {
    expect(calculateFee(1)).toBe(0.03);
    expect(calculateFee(100)).toBe(3);
  });

  test('reject zero amount', () => {
    expect(() => calculateFee(0)).toThrow('Amount must be positive');
  });

  test('reject negative amount', () => {
    expect(() => calculateFee(-100)).toThrow('Amount must be positive');
  });

  test('validateFee accepts exact and overpayment', () => {
    expect(validateFee(1000, 30)).toBe(true);    // exact 3%
    expect(validateFee(1000, 50)).toBe(true);    // overpay OK
    expect(validateFee(1000, 29)).toBe(false);   // underpay rejected
  });

  test('getFeeTier returns single tier', () => {
    const tier = getFeeTier(200_000);
    expect(tier.maxAmount).toBe(Infinity);
  });

  test('validateFeeTiers checks configuration', () => {
    expect(validateFeeTiers(DEFAULT_FEE_TIERS)).toBe(true);
    expect(validateFeeTiers([])).toBe(false);
  });

  test('formatFeeTiers returns string', () => {
    const formatted = formatFeeTiers();
    expect(formatted).toContain('3.0%');
  });
});

// =============================================
// Crypto Tests
// =============================================
describe('Cryptographic Utilities', () => {
  test('key generation produces valid keypair', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(64);
  });

  test('sign and verify', () => {
    const kp = generateKeyPair();
    const msg = new Uint8Array([1, 2, 3, 4]);
    const sig = sign(msg, kp.secretKey);
    expect(verify(msg, sig, kp.publicKey)).toBe(true);
  });

  test('verify fails with wrong key', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const msg = new Uint8Array([1, 2, 3, 4]);
    const sig = sign(msg, kp1.secretKey);
    expect(verify(msg, sig, kp2.publicKey)).toBe(false);
  });

  test('verify fails with wrong message', () => {
    const kp = generateKeyPair();
    const msg1 = new Uint8Array([1, 2, 3, 4]);
    const msg2 = new Uint8Array([5, 6, 7, 8]);
    const sig = sign(msg1, kp.secretKey);
    expect(verify(msg2, sig, kp.publicKey)).toBe(false);
  });

  test('sha256 produces consistent hash', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  test('hex conversion roundtrip', () => {
    const data = new Uint8Array([0, 1, 2, 255]);
    expect(fromHex(toHex(data))).toEqual(data);
  });

  test('hashPubKey produces consistent hash', () => {
    const kp = generateKeyPair();
    expect(hashPubKey(kp.publicKey)).toBe(hashPubKey(kp.publicKey));
    expect(hashPubKey(kp.publicKey)).toBe(hashPubKey(toHex(kp.publicKey)));
  });
});

// =============================================
// Memo Encryption Tests
// =============================================
describe('Memo Encryption (E2E)', () => {
  test('encrypt and decrypt memo', () => {
    const recipient = generateKeyPair();
    const recipientX25519 = deriveX25519KeyPair(recipient.secretKey);

    const plaintext = 'Payment for invoice #12345';
    const encrypted = encryptMemoProper(plaintext, recipientX25519.publicKey);

    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.nonce).toBeTruthy();
    expect(encrypted.ephemeralPubKey).toBeTruthy();

    const decrypted = decryptMemoProper(encrypted, recipientX25519.secretKey);
    expect(decrypted).toBe(plaintext);
  });

  test('wrong key cannot decrypt', () => {
    const recipient = generateKeyPair();
    const wrong = generateKeyPair();
    const recipientX25519 = deriveX25519KeyPair(recipient.secretKey);
    const wrongX25519 = deriveX25519KeyPair(wrong.secretKey);

    const encrypted = encryptMemoProper('secret', recipientX25519.publicKey);

    expect(() => {
      decryptMemoProper(encrypted, wrongX25519.secretKey);
    }).toThrow('Decryption failed');
  });

  test('different encryptions of same plaintext produce different ciphertext', () => {
    const recipient = generateKeyPair();
    const recipientX25519 = deriveX25519KeyPair(recipient.secretKey);

    const enc1 = encryptMemoProper('same text', recipientX25519.publicKey);
    const enc2 = encryptMemoProper('same text', recipientX25519.publicKey);

    // Different ephemeral keys and nonces
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.ephemeralPubKey).not.toBe(enc2.ephemeralPubKey);
  });
});

// =============================================
// UTXO Store Tests
// =============================================
describe('UTXO Store', () => {
  let store: UTXOStore;

  beforeEach(() => {
    store = new UTXOStore();
  });

  test('add and get UTXO', () => {
    store.add({
      txId: 'tx1',
      outputIndex: 0,
      amount: 1000,
      recipientPubKeyHash: 'hash1',
      blockHeight: 0,
    });

    const utxo = store.get('tx1', 0);
    expect(utxo).toBeDefined();
    expect(utxo!.amount).toBe(1000);
  });

  test('remove UTXO', () => {
    store.add({
      txId: 'tx1',
      outputIndex: 0,
      amount: 1000,
      recipientPubKeyHash: 'hash1',
      blockHeight: 0,
    });

    expect(store.remove('tx1', 0)).toBe(true);
    expect(store.get('tx1', 0)).toBeUndefined();
  });

  test('getBalance returns correct sum', () => {
    store.add({ txId: 'tx1', outputIndex: 0, amount: 1000, recipientPubKeyHash: 'hash1', blockHeight: 0 });
    store.add({ txId: 'tx2', outputIndex: 0, amount: 2000, recipientPubKeyHash: 'hash1', blockHeight: 1 });
    store.add({ txId: 'tx3', outputIndex: 0, amount: 500, recipientPubKeyHash: 'hash2', blockHeight: 1 });

    expect(store.getBalance('hash1')).toBe(3000);
    expect(store.getBalance('hash2')).toBe(500);
    expect(store.getBalance('hash3')).toBe(0);
  });

  test('selectUTXOs greedy selection', () => {
    store.add({ txId: 'tx1', outputIndex: 0, amount: 100, recipientPubKeyHash: 'h1', blockHeight: 0 });
    store.add({ txId: 'tx2', outputIndex: 0, amount: 500, recipientPubKeyHash: 'h1', blockHeight: 0 });
    store.add({ txId: 'tx3', outputIndex: 0, amount: 200, recipientPubKeyHash: 'h1', blockHeight: 0 });

    const selected = store.selectUTXOs('h1', 600);
    expect(selected.length).toBeGreaterThanOrEqual(2);
    const total = selected.reduce((s, u) => s + u.amount, 0);
    expect(total).toBeGreaterThanOrEqual(600);
  });

  test('selectUTXOs throws on insufficient funds', () => {
    store.add({ txId: 'tx1', outputIndex: 0, amount: 100, recipientPubKeyHash: 'h1', blockHeight: 0 });
    expect(() => store.selectUTXOs('h1', 1000)).toThrow('Insufficient UTXOs');
  });

  test('computeStateRoot is deterministic', () => {
    store.add({ txId: 'tx1', outputIndex: 0, amount: 100, recipientPubKeyHash: 'h1', blockHeight: 0 });
    const root1 = store.computeStateRoot();
    const root2 = store.computeStateRoot();
    expect(root1).toBe(root2);
  });

  test('applyTransaction modifies UTXO set', () => {
    // Setup: add initial UTXO
    store.add({
      txId: 'genesis',
      outputIndex: 0,
      amount: 10000,
      recipientPubKeyHash: 'sender_hash',
      blockHeight: 0,
    });

    const tx = {
      id: 'tx_spend',
      version: 1,
      type: TransactionType.TRANSFER,
      inputs: [{ prevTxId: 'genesis', outputIndex: 0, signature: '', publicKey: '' }],
      outputs: [
        { amount: 5000, recipientPubKeyHash: 'recipient_hash' },
        { amount: 4850, recipientPubKeyHash: 'sender_hash' },
      ],
      fee: 150, // 3% of 5000
      timestamp: Date.now(),
    };

    store.applyTransaction(tx, 1);

    // Genesis UTXO should be spent
    expect(store.get('genesis', 0)).toBeUndefined();
    // New UTXOs should exist
    expect(store.get('tx_spend', 0)?.amount).toBe(5000);
    expect(store.get('tx_spend', 1)?.amount).toBe(4850);
  });
});

// =============================================
// Transaction Tests
// =============================================
describe('Transaction', () => {
  let sender: { publicKey: Uint8Array; secretKey: Uint8Array };
  let recipient: { publicKey: Uint8Array; secretKey: Uint8Array };
  let store: UTXOStore;

  beforeEach(() => {
    sender = generateKeyPair();
    recipient = generateKeyPair();
    store = new UTXOStore();
  });

  test('create a valid transaction', () => {
    const senderPubKeyHash = hashPubKey(sender.publicKey);
    const recipientPubKeyHash = hashPubKey(recipient.publicKey);

    // Add a UTXO for the sender
    store.add({
      txId: 'genesis_tx',
      outputIndex: 0,
      amount: 10000,
      recipientPubKeyHash: senderPubKeyHash,
      blockHeight: 0,
    });

    const utxos = store.getByPubKeyHash(senderPubKeyHash);

    const tx = createTransaction({
      utxos,
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash,
      amount: 5000,
    });

    expect(tx.id).toBeTruthy();
    expect(tx.inputs.length).toBe(1);
    expect(tx.outputs.length).toBe(2); // send + change
    expect(tx.outputs[0].amount).toBe(5000);
    expect(tx.fee).toBe(150); // 3% of 5000
  });

  test('validate a valid transaction', () => {
    const senderPubKeyHash = hashPubKey(sender.publicKey);
    const recipientPubKeyHash = hashPubKey(recipient.publicKey);

    store.add({
      txId: 'genesis_tx',
      outputIndex: 0,
      amount: 10000,
      recipientPubKeyHash: senderPubKeyHash,
      blockHeight: 0,
    });

    const utxos = store.getByPubKeyHash(senderPubKeyHash);
    const tx = createTransaction({
      utxos,
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash,
      amount: 5000,
    });

    const error = validateTransaction(
      tx,
      (txId, idx) => store.get(txId, idx)
    );
    expect(error).toBeNull();
  });

  test('reject transaction with wrong fee', () => {
    const senderPubKeyHash = hashPubKey(sender.publicKey);
    const recipientPubKeyHash = hashPubKey(recipient.publicKey);

    store.add({
      txId: 'genesis_tx',
      outputIndex: 0,
      amount: 10000,
      recipientPubKeyHash: senderPubKeyHash,
      blockHeight: 0,
    });

    const utxos = store.getByPubKeyHash(senderPubKeyHash);
    const tx = createTransaction({
      utxos,
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash,
      amount: 5000,
    });

    // Tamper with the fee and recompute ID so we hit fee validation
    tx.fee = 1; // Way below 3% of 5000 (=150)
    tx.id = computeTxId({
      ...tx,
      inputs: tx.inputs.map(i => ({ ...i, signature: '' })),
    });
    // Re-sign inputs with new tx ID
    for (let i = 0; i < tx.inputs.length; i++) {
      const sigMsg = getInputSigningMessage(tx.id, i);
      tx.inputs[i].signature = toHex(sign(sigMsg, sender.secretKey));
    }

    const error = validateTransaction(
      tx,
      (txId, idx) => store.get(txId, idx)
    );
    expect(error).toBeTruthy();
    expect(error).toContain('Fee mismatch');
  });

  test('reject deposit tx type (reserved for future bridge)', () => {
    const senderPubKeyHash = hashPubKey(sender.publicKey);
    const recipientPubKeyHash = hashPubKey(recipient.publicKey);

    store.add({
      txId: 'genesis_deposit',
      outputIndex: 0,
      amount: 10000,
      recipientPubKeyHash: senderPubKeyHash,
      blockHeight: 0,
    });

    const utxos = store.getByPubKeyHash(senderPubKeyHash);
    const tx = createTransaction({
      utxos,
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash,
      amount: 5000,
    });

    // Override type to deposit
    (tx as any).type = TransactionType.DEPOSIT;

    const error = validateTransaction(
      tx,
      (txId, idx) => store.get(txId, idx)
    );
    expect(error).toBeTruthy();
    expect(error).toContain('reserved for future bridge');
  });

  test('reject withdraw tx type (reserved for future bridge)', () => {
    const senderPubKeyHash = hashPubKey(sender.publicKey);
    const recipientPubKeyHash = hashPubKey(recipient.publicKey);

    store.add({
      txId: 'genesis_withdraw',
      outputIndex: 0,
      amount: 10000,
      recipientPubKeyHash: senderPubKeyHash,
      blockHeight: 0,
    });

    const utxos = store.getByPubKeyHash(senderPubKeyHash);
    const tx = createTransaction({
      utxos,
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash,
      amount: 5000,
    });

    (tx as any).type = TransactionType.WITHDRAW;

    const error = validateTransaction(
      tx,
      (txId, idx) => store.get(txId, idx)
    );
    expect(error).toBeTruthy();
    expect(error).toContain('reserved for future bridge');
  });

  test('reject transaction spending non-existent UTXO', () => {
    const senderPubKeyHash = hashPubKey(sender.publicKey);
    const recipientPubKeyHash = hashPubKey(recipient.publicKey);

    store.add({
      txId: 'genesis_tx',
      outputIndex: 0,
      amount: 10000,
      recipientPubKeyHash: senderPubKeyHash,
      blockHeight: 0,
    });

    const utxos = store.getByPubKeyHash(senderPubKeyHash);
    const tx = createTransaction({
      utxos,
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash,
      amount: 5000,
    });

    // Remove the UTXO before validation
    store.remove('genesis_tx', 0);

    const error = validateTransaction(
      tx,
      (txId, idx) => store.get(txId, idx)
    );
    expect(error).toBeTruthy();
    expect(error).toContain('UTXO not found');
  });

  test('insufficient funds throws', () => {
    const senderPubKeyHash = hashPubKey(sender.publicKey);
    const recipientPubKeyHash = hashPubKey(recipient.publicKey);

    store.add({
      txId: 'genesis_tx',
      outputIndex: 0,
      amount: 100,
      recipientPubKeyHash: senderPubKeyHash,
      blockHeight: 0,
    });

    const utxos = store.getByPubKeyHash(senderPubKeyHash);
    expect(() => {
      createTransaction({
        utxos,
        senderSecretKey: sender.secretKey,
        senderPubKey: sender.publicKey,
        recipientPubKeyHash,
        amount: 200,
      });
    }).toThrow('Insufficient funds');
  });

  test('coinbase transaction has special input', () => {
    const tx = createCoinbaseTx('recipient_hash', 1000, 5);
    expect(tx.inputs[0].prevTxId).toBe('0'.repeat(64));
    expect(tx.outputs[0].amount).toBe(1000);
    expect(tx.fee).toBe(0);
  });
});

// =============================================
// View Key Tests
// =============================================
describe('View Key / Selective Disclosure', () => {
  test('view key can decrypt memo', () => {
    const owner = generateKeyPair();
    const ownerX25519 = deriveX25519KeyPair(owner.secretKey);

    // Encrypt a memo to the owner
    const memo = encryptMemoProper('Invoice #999: payment received', ownerX25519.publicKey);

    // Generate view key (X25519 secret)
    const viewKey = {
      ownerPubKeyHash: hashPubKey(owner.publicKey),
      viewSecret: toHex(ownerX25519.secretKey),
      label: 'auditor-view-key',
    };

    // Third party uses view key to decrypt
    const decrypted = decryptMemoProper(memo, fromHex(viewKey.viewSecret));
    expect(decrypted).toBe('Invoice #999: payment received');
  });

  test('view key from different account cannot decrypt', () => {
    const owner = generateKeyPair();
    const other = generateKeyPair();
    const ownerX25519 = deriveX25519KeyPair(owner.secretKey);
    const otherX25519 = deriveX25519KeyPair(other.secretKey);

    const memo = encryptMemoProper('secret', ownerX25519.publicKey);

    expect(() => {
      decryptMemoProper(memo, otherX25519.secretKey);
    }).toThrow('Decryption failed');
  });
});
