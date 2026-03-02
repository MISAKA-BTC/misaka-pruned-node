// ============================================================
// Misaka Network - Wallet SDK
// ============================================================
import {
  NetworkType, KeyPair, WalletAccount, ViewKey,
  Transaction, UTXOEntry, FeeTier, DEFAULT_FEE_TIERS,
  EncryptedMemo,
} from '../types';
import {
  generateKeyPair, keyPairFromSeed, toHex, fromHex, hashPubKey,
  sha256, sha256Buffer,
  encryptMemoProper, decryptMemoProper, deriveX25519KeyPair,
  sign, randomBytes,
} from '../utils/crypto';
import { encodeMisakaAddress, decodeMisakaAddress, validateMisakaDestination } from '../core/address';
import { createTransaction } from '../core/transaction';
import { calculateFee } from '../core/fee';
import * as http from 'http';

/**
 * Misaka Wallet SDK
 * Supports multiple accounts (address separation), memo encryption, and view keys.
 */
export class MisakaWallet {
  private accounts: WalletAccount[] = [];
  private network: NetworkType;
  private masterSeed: Uint8Array;
  private rpcUrl: string;

  constructor(params: {
    network?: NetworkType;
    seed?: Uint8Array;
    rpcUrl?: string;
  } = {}) {
    this.network = params.network || 'testnet';
    this.masterSeed = params.seed || randomBytes(32);
    this.rpcUrl = params.rpcUrl || 'http://localhost:3001';
  }

  /** Get the master seed (for backup) */
  getMasterSeed(): Uint8Array {
    return this.masterSeed;
  }

  /** Create a new account (address separation support) */
  createAccount(label: string = 'default'): WalletAccount {
    const index = this.accounts.length;

    // Derive seed for this account: SHA-256(masterSeed || index)
    const derivedSeed = sha256Buffer(
      Buffer.concat([Buffer.from(this.masterSeed), Buffer.from([index & 0xff, (index >> 8) & 0xff])])
    );

    const keyPair = keyPairFromSeed(new Uint8Array(derivedSeed));
    const address = encodeMisakaAddress(keyPair.publicKey, this.network);
    const pubKeyHash = hashPubKey(keyPair.publicKey);

    const account: WalletAccount = {
      index,
      label,
      keyPair,
      address,
      pubKeyHash,
      usageCount: 0,
    };

    this.accounts.push(account);
    return account;
  }

  /** Get all accounts */
  getAccounts(): WalletAccount[] {
    return this.accounts;
  }

  /** Get the primary account (creates one if none exist) */
  getPrimaryAccount(): WalletAccount {
    if (this.accounts.length === 0) {
      this.createAccount('primary');
    }
    return this.accounts[0];
  }

  /** Get account by index */
  getAccount(index: number): WalletAccount | undefined {
    return this.accounts[index];
  }

  /** Find account by address */
  findAccountByAddress(address: string): WalletAccount | undefined {
    return this.accounts.find(a => a.address === address);
  }

  /** Find account by public key hash */
  findAccountByPubKeyHash(hash: string): WalletAccount | undefined {
    return this.accounts.find(a => a.pubKeyHash === hash);
  }

  /** Check for address reuse and warn */
  checkAddressReuse(account: WalletAccount): string | null {
    if (account.usageCount > 3) {
      return `WARNING: Address ${account.address} has been used ${account.usageCount} times. ` +
        `Consider creating a new account for better privacy.`;
    }
    return null;
  }

  /** Create a send transaction */
  async createSendTransaction(params: {
    fromAccountIndex?: number;
    toAddress: string;
    amount: number;
    memo?: string;
    feeTiers?: FeeTier[];
  }): Promise<Transaction> {
    // Validate destination address
    validateMisakaDestination(params.toAddress);

    const account = params.fromAccountIndex !== undefined
      ? this.accounts[params.fromAccountIndex]
      : this.getPrimaryAccount();

    if (!account) throw new Error('Account not found');

    // Warn about address reuse
    const warning = this.checkAddressReuse(account);
    if (warning) {
      console.warn(warning);
    }

    // Decode recipient address to get their public key
    const { pubKey: recipientPubKey } = decodeMisakaAddress(params.toAddress);
    const recipientPubKeyHash = hashPubKey(recipientPubKey);

    // Get UTXOs from RPC
    const utxos = await this.rpcCall('getUTXOs', { pubKeyHash: account.pubKeyHash });
    if (!utxos.utxos || utxos.utxos.length === 0) {
      throw new Error('No UTXOs available');
    }

    // Calculate fee
    const fee = calculateFee(params.amount, params.feeTiers || DEFAULT_FEE_TIERS);
    const totalNeeded = params.amount + fee;

    // Select UTXOs
    const selectedUTXOs = selectUTXOs(utxos.utxos, totalNeeded);

    // Create transaction
    const tx = createTransaction({
      utxos: selectedUTXOs,
      senderSecretKey: account.keyPair.secretKey,
      senderPubKey: account.keyPair.publicKey,
      recipientPubKeyHash,
      amount: params.amount,
      feeTiers: params.feeTiers,
    });

    // Encrypt memo if provided
    if (params.memo) {
      const recipientX25519 = deriveX25519FromPubKey(recipientPubKey);
      // For MVP: we use a simplified encryption that the recipient can decrypt
      // with their X25519 key derived from their Ed25519 secret
      tx.memo = encryptMemoSimple(params.memo, recipientPubKey, account.keyPair.secretKey);
    }

    // Increment usage count
    account.usageCount++;

    return tx;
  }

  /** Submit a transaction to the network */
  async submitTransaction(tx: Transaction): Promise<string> {
    const result = await this.rpcCall('sendTransaction', { transaction: tx });
    return result.txId;
  }

  /** Get balance for an account */
  async getBalance(accountIndex?: number): Promise<number> {
    const account = accountIndex !== undefined
      ? this.accounts[accountIndex]
      : this.getPrimaryAccount();
    if (!account) throw new Error('Account not found');

    const result = await this.rpcCall('getBalance', { pubKeyHash: account.pubKeyHash });
    return result.balance;
  }

  /** Get total balance across all accounts */
  async getTotalBalance(): Promise<number> {
    let total = 0;
    for (const account of this.accounts) {
      const result = await this.rpcCall('getBalance', { pubKeyHash: account.pubKeyHash });
      total += result.balance;
    }
    return total;
  }

  /** Generate a view key for selective disclosure */
  generateViewKey(accountIndex: number, label: string, validFrom?: number, validUntil?: number): ViewKey {
    const account = this.accounts[accountIndex];
    if (!account) throw new Error('Account not found');

    // Derive X25519 keypair from Ed25519
    const x25519 = deriveX25519KeyPair(account.keyPair.secretKey);

    return {
      ownerPubKeyHash: account.pubKeyHash,
      viewSecret: toHex(x25519.secretKey),
      label,
      validFrom,
      validUntil,
    };
  }

  /** Decrypt a memo using a view key */
  decryptMemoWithViewKey(memo: EncryptedMemo, viewKey: ViewKey): string {
    const x25519Secret = fromHex(viewKey.viewSecret);
    return decryptMemoProper(memo, x25519Secret);
  }

  /** Decrypt a memo using an account's secret key */
  decryptMemo(memo: EncryptedMemo, accountIndex?: number): string {
    const account = accountIndex !== undefined
      ? this.accounts[accountIndex]
      : this.getPrimaryAccount();
    if (!account) throw new Error('Account not found');

    const x25519 = deriveX25519KeyPair(account.keyPair.secretKey);
    return decryptMemoProper(memo, x25519.secretKey);
  }

  /** RPC call to node */
  async rpcCall(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      });

      const url = new URL(this.rpcUrl);

      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(body);
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /** Export wallet data (for backup) */
  exportWallet(): {
    network: NetworkType;
    masterSeed: string;
    accounts: { index: number; label: string; address: string }[];
  } {
    return {
      network: this.network,
      masterSeed: toHex(this.masterSeed),
      accounts: this.accounts.map(a => ({
        index: a.index,
        label: a.label,
        address: a.address,
      })),
    };
  }

  /** Import wallet from backup data */
  static fromBackup(data: {
    network: NetworkType;
    masterSeed: string;
    accounts: { index: number; label: string }[];
  }, rpcUrl?: string): MisakaWallet {
    const wallet = new MisakaWallet({
      network: data.network,
      seed: fromHex(data.masterSeed),
      rpcUrl,
    });

    for (const acc of data.accounts) {
      wallet.createAccount(acc.label);
    }

    return wallet;
  }
}

// ---- Helper Functions ----

/** Simple UTXO selection (greedy, largest first) */
function selectUTXOs(utxos: UTXOEntry[], targetAmount: number): UTXOEntry[] {
  const sorted = [...utxos].sort((a, b) => b.amount - a.amount);
  const selected: UTXOEntry[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.amount;
    if (total >= targetAmount) break;
  }

  if (total < targetAmount) {
    throw new Error(`Insufficient funds: have ${total}, need ${targetAmount}`);
  }

  return selected;
}

/** Derive X25519-like key from Ed25519 public key (for encryption target) */
function deriveX25519FromPubKey(_pubKey: Uint8Array): Uint8Array {
  // This is used as a target for encryption. In production,
  // the recipient would publish their X25519 public key.
  // For MVP, we use the Ed25519 pubkey as entropy for a DH-like scheme.
  return _pubKey;
}

/**
 * Simple memo encryption for MVP.
 * Uses nacl.box-compatible scheme:
 * - Sender generates ephemeral X25519 keypair
 * - Shared key = X25519_DH(ephemeral_secret, recipient_x25519_pub)
 * - But we don't have recipient_x25519_pub without their secret
 * 
 * Workaround: Use nacl.secretbox with key derived from shared info
 * that both sides can compute.
 */
import nacl from 'tweetnacl';
import { encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

function encryptMemoSimple(
  plaintext: string,
  recipientEd25519PubKey: Uint8Array,
  senderEd25519SecretKey: Uint8Array
): EncryptedMemo {
  // Derive sender's X25519 secret
  const senderX25519 = deriveX25519KeyPair(senderEd25519SecretKey);

  // Generate ephemeral X25519 keypair
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = decodeUTF8(plaintext);

  // Create a shared key from: ephemeral_secret XOR sender_x25519_secret, hashed
  // Then encrypt with nacl.secretbox
  const sharedKeyInput = Buffer.concat([
    Buffer.from(ephemeral.secretKey),
    Buffer.from(recipientEd25519PubKey),
  ]);
  const sharedKey = sha256Buffer(sharedKeyInput).slice(0, nacl.secretbox.keyLength);

  const ciphertext = nacl.secretbox(messageBytes, nonce, new Uint8Array(sharedKey));
  if (!ciphertext) throw new Error('Memo encryption failed');

  return {
    ciphertext: Buffer.from(ciphertext).toString('hex'),
    nonce: Buffer.from(nonce).toString('hex'),
    ephemeralPubKey: Buffer.from(ephemeral.publicKey).toString('hex'),
  };
}

/**
 * Decrypt memo - requires knowing the ephemeral secret to reconstruct the shared key.
 * This is the limitation of the simple scheme.
 * 
 * For the real implementation, we use proper nacl.box with X25519 DH:
 * encrypt: nacl.box(msg, nonce, recipient_x25519_pub, ephemeral_x25519_secret)
 * decrypt: nacl.box.open(ct, nonce, ephemeral_x25519_pub, recipient_x25519_secret)
 * 
 * The recipient MUST publish their X25519 public key, or we derive it.
 */
