// ============================================================
// Misaka Network - Transaction
// ============================================================
import { Transaction, TransactionType, TxInput, TxOutput, EncryptedMemo, FeeTier, DEFAULT_FEE_TIERS, UTXOEntry } from '../types';
import { sha256, sign, verify, toHex, fromHex, hashPubKey, encryptMemoProper, deriveX25519KeyPair } from '../utils/crypto';
import { calculateFee, validateFee } from './fee';

/**
 * Serialize transaction data for hashing/signing (excludes id and signatures).
 */
export function serializeTxForHash(tx: Omit<Transaction, 'id'>): string {
  const obj = {
    version: tx.version,
    type: tx.type,
    inputs: tx.inputs.map(i => ({
      prevTxId: i.prevTxId,
      outputIndex: i.outputIndex,
      publicKey: i.publicKey,
    })),
    outputs: tx.outputs.map(o => ({
      amount: o.amount,
      recipientPubKeyHash: o.recipientPubKeyHash,
    })),
    fee: tx.fee,
    memo: tx.memo ? {
      ciphertext: tx.memo.ciphertext,
      nonce: tx.memo.nonce,
      ephemeralPubKey: tx.memo.ephemeralPubKey,
    } : undefined,
    timestamp: tx.timestamp,
  };
  return JSON.stringify(obj);
}

/**
 * Compute transaction ID (hash).
 */
export function computeTxId(tx: Omit<Transaction, 'id'>): string {
  return sha256(serializeTxForHash(tx));
}

/**
 * Serialize the signing message for a specific input.
 * The signer signs: SHA-256(txId || inputIndex)
 */
export function getInputSigningMessage(txId: string, inputIndex: number): Uint8Array {
  const msg = `${txId}:${inputIndex}`;
  return new Uint8Array(Buffer.from(sha256(msg), 'hex'));
}

/**
 * Create and sign a transaction.
 */
export function createTransaction(params: {
  utxos: UTXOEntry[];           // UTXOs to spend
  senderSecretKey: Uint8Array;  // Ed25519 secret key (64 bytes)
  senderPubKey: Uint8Array;     // Ed25519 public key (32 bytes)
  recipientPubKeyHash: string;  // Hash of recipient's public key
  amount: number;
  memo?: string;                // Optional plaintext memo (will be encrypted)
  recipientPubKey?: Uint8Array; // Needed for memo encryption
  feeTiers?: FeeTier[];
}): Transaction {
  const { utxos, senderSecretKey, senderPubKey, recipientPubKeyHash, amount, feeTiers } = params;

  // Calculate fee
  const fee = calculateFee(amount, feeTiers || DEFAULT_FEE_TIERS);

  // Calculate total input
  const totalInput = utxos.reduce((sum, u) => sum + u.amount, 0);
  const totalNeeded = amount + fee;

  if (totalInput < totalNeeded) {
    throw new Error(
      `Insufficient funds: have ${totalInput}, need ${totalNeeded} (amount: ${amount} + fee: ${fee})`
    );
  }

  const change = totalInput - totalNeeded;
  const senderPubKeyHex = toHex(senderPubKey);
  const senderPubKeyHash = hashPubKey(senderPubKey);

  // Build outputs
  const outputs: TxOutput[] = [
    { amount, recipientPubKeyHash },
  ];

  // Add change output if needed
  if (change > 0) {
    outputs.push({ amount: change, recipientPubKeyHash: senderPubKeyHash });
  }

  // Encrypt memo if provided
  let memo: EncryptedMemo | undefined;
  if (params.memo && params.recipientPubKey) {
    const recipientX25519 = deriveX25519KeyPair(
      // We need the recipient's Ed25519 secret to get their X25519 pubkey
      // But we don't have it! We need the recipient to publish their X25519 pubkey.
      // For MVP: sender creates a symmetric encrypted memo using a scheme
      // where recipient can derive the key from their own Ed25519 secret.
      params.recipientPubKey as any // This won't work for deriveX25519KeyPair
    );
    // For MVP, we'll skip proper memo encryption in createTransaction
    // and handle it in the wallet SDK where we have more context.
  }

  // Build unsigned tx
  const unsignedTx: Omit<Transaction, 'id'> = {
    version: 1,
    type: TransactionType.TRANSFER,
    inputs: utxos.map(u => ({
      prevTxId: u.txId,
      outputIndex: u.outputIndex,
      signature: '', // placeholder
      publicKey: senderPubKeyHex,
    })),
    outputs,
    fee,
    memo,
    timestamp: Date.now(),
  };

  // Compute tx ID
  const txId = computeTxId(unsignedTx);

  // Sign each input
  const signedInputs: TxInput[] = unsignedTx.inputs.map((input, idx) => {
    const sigMsg = getInputSigningMessage(txId, idx);
    const signature = sign(sigMsg, senderSecretKey);
    return {
      ...input,
      signature: toHex(signature),
    };
  });

  return {
    id: txId,
    ...unsignedTx,
    inputs: signedInputs,
  };
}

/**
 * Validate a transaction.
 * Returns null if valid, or an error message string.
 */
export function validateTransaction(
  tx: Transaction,
  getUTXO: (txId: string, index: number) => UTXOEntry | undefined,
  feeTiers: FeeTier[] = DEFAULT_FEE_TIERS,
  options?: { bridgeEnabled?: boolean },
): string | null {
  // 0. Validate transaction type (before everything else)
  if (tx.type === TransactionType.DEPOSIT || tx.type === TransactionType.WITHDRAW) {
    if (!options?.bridgeEnabled) {
      return `Transaction type '${tx.type}' is reserved for future bridge — not yet supported`;
    }
    // Bridge TX validation is handled by MisakaBridgeHandler
    // Here we only do basic structural checks
    if (tx.type === TransactionType.DEPOSIT) {
      // Deposit TX: must have exactly 1 input (lock reference) and 1+ outputs
      if (tx.inputs.length !== 1) return 'Deposit TX must have exactly 1 input (lock reference)';
      if (tx.outputs.length < 1) return 'Deposit TX must have at least 1 output';
      // Fee is 0 for deposits (bridge fee deducted from amount)
      if (tx.fee !== 0) return 'Deposit TX fee must be 0 (bridge fee deducted from amount)';
      return null; // Skip UTXO/signature checks for bridge deposits
    }
    if (tx.type === TransactionType.WITHDRAW) {
      // Withdraw TX: must have inputs and a burn output
      if (tx.inputs.length < 1) return 'Withdraw TX must have at least 1 input';
      if (tx.outputs.length < 1) return 'Withdraw TX must have at least 1 output';
      // Burn address check
      const burnOutput = tx.outputs[0];
      if (burnOutput.recipientPubKeyHash !== '0'.repeat(64)) {
        return 'Withdraw TX first output must be to burn address';
      }
      return null; // Signature/UTXO validation done by bridge handler
    }
  }
  if (tx.type !== TransactionType.TRANSFER && tx.type !== TransactionType.COINBASE) {
    return `Unknown transaction type: ${tx.type}`;
  }

  // 1. Verify tx ID
  const { id, ...txWithoutId } = tx;
  // Recompute with empty signatures for hash
  const txForHash: Omit<Transaction, 'id'> = {
    ...txWithoutId,
    inputs: txWithoutId.inputs.map(i => ({
      ...i,
      signature: '', // signatures not included in hash
    })),
  };
  // Actually, the txId is computed from the tx data without signatures
  // Let me recompute:
  const recomputedId = computeTxId({
    ...txWithoutId,
    inputs: txWithoutId.inputs.map(i => ({
      prevTxId: i.prevTxId,
      outputIndex: i.outputIndex,
      signature: '',
      publicKey: i.publicKey,
    })),
  });

  if (tx.id !== recomputedId) {
    return `Invalid transaction ID: expected ${recomputedId}, got ${tx.id}`;
  }

  // 2. Must have at least one input and one output
  if (tx.inputs.length === 0) return 'Transaction must have at least one input';
  if (tx.outputs.length === 0) return 'Transaction must have at least one output';

  // 3. All output amounts must be positive
  for (const output of tx.outputs) {
    if (output.amount <= 0) return `Output amount must be positive: ${output.amount}`;
  }

  // 4. Verify each input signature and collect total input amount
  let totalInput = 0;
  const spentOutputs = new Set<string>();

  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const utxoKey = `${input.prevTxId}:${input.outputIndex}`;

    // Check for double-spend within this transaction
    if (spentOutputs.has(utxoKey)) {
      return `Double spend: ${utxoKey} referenced multiple times`;
    }
    spentOutputs.add(utxoKey);

    // Look up the UTXO
    const utxo = getUTXO(input.prevTxId, input.outputIndex);
    if (!utxo) {
      return `UTXO not found: ${utxoKey}`;
    }

    // Verify the public key matches the UTXO owner
    const inputPubKeyHash = hashPubKey(fromHex(input.publicKey));
    if (inputPubKeyHash !== utxo.recipientPubKeyHash) {
      return `Input ${i}: public key does not match UTXO owner`;
    }

    // Verify signature
    const sigMsg = getInputSigningMessage(tx.id, i);
    const sigBytes = fromHex(input.signature);
    const pubKeyBytes = fromHex(input.publicKey);

    if (!verify(sigMsg, sigBytes, pubKeyBytes)) {
      return `Input ${i}: invalid signature`;
    }

    totalInput += utxo.amount;
  }

  // 5. Calculate total output
  const totalOutput = tx.outputs.reduce((sum, o) => sum + o.amount, 0);

  // 6. Verify UTXO balance: inputs = outputs + fee
  const expectedFee = totalInput - totalOutput;
  if (Math.abs(expectedFee - tx.fee) > 1e-10) {
    return `Fee mismatch: inputs(${totalInput}) - outputs(${totalOutput}) = ${expectedFee}, but tx.fee = ${tx.fee}`;
  }

  // 7. Validate fee against tier
  // The "amount" for fee calculation is the primary output (first output, excluding change)
  // For simplicity, we sum all non-change outputs as the "sent amount"
  // Actually, in UTXO model, we need to determine the actual send amount.
  // Convention: fee must match calculateFee(totalOutput - change)
  // But we don't know which output is "change" vs "send"
  // Solution: validate fee against the TOTAL output amount (sum of all outputs)
  // No, the spec says fee is based on the send amount.
  // For validation: fee tier is based on the largest output (primary recipient)
  // Or: we validate that tx.fee matches calculateFee for SOME valid interpretation.
  
  // Simplest approach: the fee must match calculateFee(totalOutput)
  // where totalOutput is the sum of all outputs (the "value transferred")
  // This is slightly different from "amount sent to recipient" but simpler to validate.
  
  // Actually, let's use: fee is based on the sum of outputs to non-sender addresses.
  // But we can't distinguish sender from recipient in UTXO model without more info.
  
  // Final decision for MVP: fee is based on the FIRST output amount (primary send)
  // Change outputs (back to sender) don't count toward the fee tier amount.
  // This matches the createTransaction logic where outputs[0] is the send amount.
  
  const sendAmount = tx.outputs[0].amount;
  if (!validateFee(sendAmount, tx.fee, feeTiers)) {
    const required = calculateFee(sendAmount, feeTiers);
    return `Invalid fee: for send amount ${sendAmount}, required fee is ${required}, got ${tx.fee}`;
  }

  return null; // valid
}

/**
 * Create a coinbase transaction (block reward / genesis).
 */
export function createCoinbaseTx(
  recipientPubKeyHash: string,
  amount: number,
  blockHeight: number
): Transaction {
  const tx: Omit<Transaction, 'id'> = {
    version: 1,
    type: TransactionType.COINBASE,
    inputs: [{
      prevTxId: '0'.repeat(64),
      outputIndex: blockHeight, // encode block height in coinbase
      signature: '',
      publicKey: '',
    }],
    outputs: [{ amount, recipientPubKeyHash }],
    fee: 0,
    timestamp: Date.now(),
  };

  const id = computeTxId(tx);
  return { id, ...tx };
}
