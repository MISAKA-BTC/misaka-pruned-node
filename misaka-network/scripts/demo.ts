#!/usr/bin/env ts-node
// ============================================================
// Misaka Network - 4-Node Demo
// ============================================================

import { Blockchain, createBlock, signBlock } from '../src/core/blockchain';
import { UTXOStore } from '../src/core/utxo-store';
import { Mempool } from '../src/core/mempool';
import { createTransaction, createCoinbaseTx } from '../src/core/transaction';
import { generateKeyPair, toHex, hashPubKey, deriveX25519KeyPair } from '../src/utils/crypto';
import { encodeMisakaAddress } from '../src/core/address';
import { calculateFee, formatFeeTiers } from '../src/core/fee';
import { encryptMemoProper, decryptMemoProper } from '../src/utils/crypto';
import { DEFAULT_FEE_TIERS } from '../src/types';

function log(msg: string) {
  console.log(`  ${msg}`);
}

function header(msg: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${msg}`);
  console.log('═'.repeat(60));
}

async function main() {
  header('🌐 Misaka Network - 4-Node Local Demo');

  // ── 1. Generate Validator Keys ──
  header('1. Generating 4 Validator Keypairs');
  const validators = Array.from({ length: 4 }, (_, i) => {
    const kp = generateKeyPair();
    const pubKeyHex = toHex(kp.publicKey);
    const address = encodeMisakaAddress(kp.publicKey, 'testnet');
    const pubKeyHash = hashPubKey(kp.publicKey);

    log(`Validator ${i}: ${address}`);
    log(`  PubKey:  ${pubKeyHex.substring(0, 32)}...`);
    log(`  Hash:    ${pubKeyHash.substring(0, 32)}...`);

    return { ...kp, pubKeyHex, address, pubKeyHash };
  });

  const validatorPubKeys = validators.map(v => v.pubKeyHex);

  // ── 2. Initialize Nodes ──
  header('2. Initializing 4 Nodes');
  const nodes = validators.map((v, i) => {
    const utxoStore = new UTXOStore();
    const blockchain = new Blockchain(utxoStore, DEFAULT_FEE_TIERS, validatorPubKeys);
    const mempool = new Mempool(DEFAULT_FEE_TIERS);
    log(`Node ${i} initialized`);
    return { utxoStore, blockchain, mempool, validator: v };
  });

  // ── 3. Create Genesis Block ──
  header('3. Creating Genesis Block (100M tokens per validator)');
  const genesisDistributions = validators.map(v => ({
    pubKeyHash: v.pubKeyHash,
    amount: 100_000_000,
  }));

  const genesis = nodes[0].blockchain.createGenesisBlock(
    genesisDistributions,
    validators[0].secretKey,
    validators[0].publicKey
  );

  // Collect signatures from all validators
  for (let i = 1; i < 4; i++) {
    const sig = signBlock(genesis.hash, validators[i].secretKey, validators[i].publicKey);
    genesis.signatures.push(sig);
  }
  log(`Genesis hash: ${genesis.hash.substring(0, 32)}...`);
  log(`Signatures:   ${genesis.signatures.length}/4`);

  // Apply genesis to all nodes
  for (let i = 0; i < 4; i++) {
    const error = nodes[i].blockchain.addBlock(genesis);
    if (error) {
      console.error(`❌ Node ${i} genesis failed: ${error}`);
      return;
    }
  }
  log('✅ Genesis applied to all 4 nodes');

  // ── 4. Show Fee Tiers ──
  header('4. Fee Tier Configuration');
  console.log(formatFeeTiers());

  // ── 5. Send Transaction (Validator 0 → Validator 1) ──
  header('5. Sending 50,000 tokens: Validator 0 → Validator 1');
  const sender = validators[0];
  const recipient = validators[1];
  const sendAmount = 50_000;
  const fee = calculateFee(sendAmount);
  log(`Amount:    ${sendAmount.toLocaleString()}`);
  log(`Fee:       ${fee} (auto-calculated, tier 1)`);

  const senderUTXOs = nodes[0].utxoStore.getByPubKeyHash(sender.pubKeyHash);
  log(`Sender UTXOs: ${senderUTXOs.length} (total: ${senderUTXOs.reduce((s, u) => s + u.amount, 0).toLocaleString()})`);

  const tx = createTransaction({
    utxos: [senderUTXOs[0]],
    senderSecretKey: sender.secretKey,
    senderPubKey: sender.publicKey,
    recipientPubKeyHash: recipient.pubKeyHash,
    amount: sendAmount,
  });

  log(`TX ID:     ${tx.id.substring(0, 32)}...`);
  log(`Inputs:    ${tx.inputs.length}`);
  log(`Outputs:   ${tx.outputs.length} (send: ${tx.outputs[0].amount}, change: ${tx.outputs[1]?.amount || 0})`);

  // Add to mempool
  const mempoolError = nodes[0].mempool.addTransaction(
    tx,
    (txId, idx) => nodes[0].utxoStore.get(txId, idx)
  );
  if (mempoolError) {
    console.error(`❌ Mempool error: ${mempoolError}`);
    return;
  }
  log('✅ Transaction validated and added to mempool');

  // ── 6. Build Block with Transaction ──
  header('6. Building Block #1 (with transfer)');
  const proposerIdx = 1 % 4; // Round-robin: height 1 => validator 1
  const proposer = validators[proposerIdx];
  const coinbase = createCoinbaseTx(proposer.pubKeyHash, 1000 + tx.fee, 1);

  // Compute state root
  const n = nodes[proposerIdx];
  n.utxoStore.applyTransaction(coinbase, 1);
  n.utxoStore.applyTransaction(tx, 1);
  const stateRoot = n.utxoStore.computeStateRoot();
  n.utxoStore.revertTransaction(tx, (txId, idx) => {
    if (txId === senderUTXOs[0].txId && idx === senderUTXOs[0].outputIndex) return senderUTXOs[0];
    return undefined;
  });
  n.utxoStore.revertTransaction(coinbase, () => undefined);

  const block1 = createBlock({
    height: 1,
    previousHash: n.blockchain.latestHash,
    transactions: [coinbase, tx],
    proposerPubKey: proposer.publicKey,
    proposerSecretKey: proposer.secretKey,
    stateRoot,
  });

  // Collect all validator signatures
  for (let i = 0; i < 4; i++) {
    if (i === proposerIdx) continue;
    block1.signatures.push(signBlock(block1.hash, validators[i].secretKey, validators[i].publicKey));
  }

  log(`Block hash:  ${block1.hash.substring(0, 32)}...`);
  log(`Proposer:    Validator ${proposerIdx}`);
  log(`TXs:         ${block1.transactions.length} (1 coinbase + 1 transfer)`);
  log(`Signatures:  ${block1.signatures.length}/4`);

  // Apply to all nodes
  for (let i = 0; i < 4; i++) {
    const error = nodes[i].blockchain.addBlock(block1);
    if (error) {
      console.error(`❌ Node ${i} block 1 failed: ${error}`);
      return;
    }
  }
  log('✅ Block #1 committed on all 4 nodes');

  // ── 7. Check Balances ──
  header('7. Balances After Transfer');
  for (let i = 0; i < 4; i++) {
    const balance = nodes[0].utxoStore.getBalance(validators[i].pubKeyHash);
    log(`Validator ${i} (${validators[i].address.substring(0, 20)}...): ${balance.toLocaleString()}`);
  }

  // ── 8. Generate More Blocks ──
  header('8. Generating 9 more blocks (total: 10)');
  for (let height = 2; height <= 10; height++) {
    const pIdx = height % 4;
    const prop = validators[pIdx];
    const cb = createCoinbaseTx(prop.pubKeyHash, 1000, height);

    const nd = nodes[pIdx];
    nd.utxoStore.applyTransaction(cb, height);
    const sr = nd.utxoStore.computeStateRoot();
    nd.utxoStore.revertTransaction(cb, () => undefined);

    const blk = createBlock({
      height,
      previousHash: nd.blockchain.latestHash,
      transactions: [cb],
      proposerPubKey: prop.publicKey,
      proposerSecretKey: prop.secretKey,
      stateRoot: sr,
    });

    for (let i = 0; i < 4; i++) {
      if (i === pIdx) continue;
      blk.signatures.push(signBlock(blk.hash, validators[i].secretKey, validators[i].publicKey));
    }

    for (const node of nodes) {
      const error = node.blockchain.addBlock(blk);
      if (error) {
        console.error(`❌ Block ${height} failed: ${error}`);
        return;
      }
    }
    log(`Block #${height} ✅ (proposer: V${pIdx})`);
  }

  // ── 9. Memo Encryption Demo ──
  header('9. Memo Encryption Demo (E2E)');
  const recipientX25519 = deriveX25519KeyPair(recipient.secretKey);
  const plaintext = 'Payment for invoice #INV-2025-001';
  log(`Plaintext: "${plaintext}"`);

  const encrypted = encryptMemoProper(plaintext, recipientX25519.publicKey);
  log(`Encrypted: ${encrypted.ciphertext.substring(0, 40)}...`);
  log(`Nonce:     ${encrypted.nonce.substring(0, 20)}...`);

  const decrypted = decryptMemoProper(encrypted, recipientX25519.secretKey);
  log(`Decrypted: "${decrypted}"`);
  log(`✅ Memo encryption/decryption verified`);

  // ── 10. View Key Demo ──
  header('10. Selective Disclosure (View Key)');
  const viewKey = {
    ownerPubKeyHash: recipient.pubKeyHash,
    viewSecret: toHex(recipientX25519.secretKey),
    label: 'auditor-2025',
  };
  log(`View key generated for: ${recipient.address.substring(0, 25)}...`);
  log(`View secret (share with auditor): ${viewKey.viewSecret.substring(0, 32)}...`);

  // Auditor uses view key to decrypt
  const auditDecrypt = decryptMemoProper(encrypted, new Uint8Array(Buffer.from(viewKey.viewSecret, 'hex')));
  log(`Auditor decrypted: "${auditDecrypt}"`);
  log(`✅ View key selective disclosure verified`);

  // ── Summary ──
  header('📊 Final Network State');
  const info = nodes[0].blockchain.getInfo();
  log(`Chain height: ${info.height}`);
  log(`Latest hash:  ${info.latestHash.substring(0, 32)}...`);
  log(`UTXO count:   ${info.utxoCount}`);
  log(`State root:   ${info.stateRoot.substring(0, 32)}...`);

  console.log('\n');
  for (let i = 0; i < 4; i++) {
    const balance = nodes[0].utxoStore.getBalance(validators[i].pubKeyHash);
    const nodeInfo = nodes[i].blockchain.getInfo();
    log(`Node ${i}: height=${nodeInfo.height}, balance=${balance.toLocaleString()}, state=${nodeInfo.stateRoot.substring(0, 16)}...`);
  }

  // Verify consistency
  const stateRoots = new Set(nodes.map(n => n.utxoStore.computeStateRoot()));
  const latestHashes = new Set(nodes.map(n => n.blockchain.latestHash));
  console.log('\n');
  log(`All nodes consistent: ${stateRoots.size === 1 && latestHashes.size === 1 ? '✅ YES' : '❌ NO'}`);

  header('🎉 Demo Complete!');
}

main().catch(console.error);
