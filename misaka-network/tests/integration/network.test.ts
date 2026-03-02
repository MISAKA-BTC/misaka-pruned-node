// ============================================================
// Misaka Network - Integration Tests
// ============================================================
import { Blockchain, createBlock, signBlock } from '../../src/core/blockchain';
import { UTXOStore } from '../../src/core/utxo-store';
import { ConfidentialUTXOStore } from '../../src/core/confidential-utxo';
import { Mempool } from '../../src/core/mempool';
import { ConsensusEngine, ConsensusEvent } from '../../src/consensus/engine';
import { createTransaction, createCoinbaseTx } from '../../src/core/transaction';
import { generateKeyPair, toHex, fromHex, hashPubKey, sha256 } from '../../src/utils/crypto';
import { calculateFee } from '../../src/core/fee';
import { DEFAULT_FEE_TIERS, Transaction } from '../../src/types';

/** Compute combined state root (transparent + confidential) */
function combinedStateRoot(utxoStore: UTXOStore, confStore: ConfidentialUTXOStore): string {
  return sha256(utxoStore.computeStateRoot() + '|' + confStore.computeStateRoot());
}

// =============================================
// 4-Node Consensus Test
// =============================================
describe('4-Node Consensus', () => {
  // Generate 4 validator keypairs
  const validators = Array.from({ length: 4 }, () => {
    const kp = generateKeyPair();
    return {
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      pubKeyHex: toHex(kp.publicKey),
      pubKeyHash: hashPubKey(kp.publicKey),
    };
  });

  const validatorPubKeys = validators.map(v => v.pubKeyHex);

  function createNodeChain(validatorIndex: number) {
    const utxoStore = new UTXOStore();
    const blockchain = new Blockchain(utxoStore, DEFAULT_FEE_TIERS, validatorPubKeys);
    const confStore = blockchain.getConfidentialUTXOStore();
    const mempool = new Mempool(DEFAULT_FEE_TIERS);

    return { utxoStore, confStore, blockchain, mempool, validator: validators[validatorIndex] };
  }

  test('genesis block creation and validation', () => {
    const { blockchain, validator } = createNodeChain(0);

    const genesis = blockchain.createGenesisBlock(
      validators.map(v => ({ pubKeyHash: v.pubKeyHash, amount: 100_000_000 })),
      validator.secretKey,
      validator.publicKey
    );

    // Add signatures from other validators
    for (let i = 1; i < validators.length; i++) {
      const sig = signBlock(genesis.hash, validators[i].secretKey, validators[i].publicKey);
      genesis.signatures.push(sig);
    }

    const error = blockchain.addBlock(genesis);
    expect(error).toBeNull();
    expect(blockchain.currentHeight).toBe(0);

    // Check balances
    for (const v of validators) {
      expect(blockchain.getUTXOStore().getBalance(v.pubKeyHash)).toBe(100_000_000);
    }
  });

  test('10 consecutive blocks with 4 validators', () => {
    // Setup 4 chains (simulating 4 nodes)
    const nodes = validators.map((_, i) => createNodeChain(i));

    // Create genesis on first node
    const genesisBlock = nodes[0].blockchain.createGenesisBlock(
      validators.map(v => ({ pubKeyHash: v.pubKeyHash, amount: 100_000_000 })),
      validators[0].secretKey,
      validators[0].publicKey
    );

    // Collect all signatures
    for (let i = 1; i < validators.length; i++) {
      const sig = signBlock(genesisBlock.hash, validators[i].secretKey, validators[i].publicKey);
      genesisBlock.signatures.push(sig);
    }

    // Apply genesis to all nodes
    for (const node of nodes) {
      const error = node.blockchain.addBlock(genesisBlock);
      expect(error).toBeNull();
    }

    // Generate 10 blocks with round-robin proposer
    for (let height = 1; height <= 10; height++) {
      const proposerIndex = height % 4;
      const proposer = validators[proposerIndex];
      const node = nodes[proposerIndex];

      // Create coinbase
      const coinbase = createCoinbaseTx(proposer.pubKeyHash, 1000, height);

      // Temporarily apply to compute state root
      node.utxoStore.applyTransaction(coinbase, height);
      const stateRoot = combinedStateRoot(node.utxoStore, node.confStore);
      node.utxoStore.revertTransaction(coinbase);

      // Create block
      const block = createBlock({
        height,
        previousHash: node.blockchain.latestHash,
        transactions: [coinbase],
        proposerPubKey: proposer.publicKey,
        proposerSecretKey: proposer.secretKey,
        stateRoot,
      });

      // Collect votes from all validators
      for (let i = 0; i < validators.length; i++) {
        if (i === proposerIndex) continue;
        const sig = signBlock(block.hash, validators[i].secretKey, validators[i].publicKey);
        block.signatures.push(sig);
      }

      // Apply to all nodes
      for (const n of nodes) {
        const error = n.blockchain.addBlock(block);
        expect(error).toBeNull();
      }
    }

    // Verify all nodes have the same state
    const heights = nodes.map(n => n.blockchain.currentHeight);
    expect(heights).toEqual([10, 10, 10, 10]);

    const stateRoots = nodes.map(n => combinedStateRoot(n.utxoStore, n.confStore));
    expect(new Set(stateRoots).size).toBe(1); // all same

    const latestHashes = nodes.map(n => n.blockchain.latestHash);
    expect(new Set(latestHashes).size).toBe(1); // all same
  });

  test('transfer between validators (UTXO flow)', () => {
    const nodes = validators.map((_, i) => createNodeChain(i));

    // Genesis
    const genesis = nodes[0].blockchain.createGenesisBlock(
      validators.map(v => ({ pubKeyHash: v.pubKeyHash, amount: 100_000_000 })),
      validators[0].secretKey,
      validators[0].publicKey
    );
    for (let i = 1; i < validators.length; i++) {
      genesis.signatures.push(signBlock(genesis.hash, validators[i].secretKey, validators[i].publicKey));
    }
    for (const node of nodes) {
      expect(node.blockchain.addBlock(genesis)).toBeNull();
    }

    // Validator 0 sends 50,000 to Validator 1
    const sender = validators[0];
    const recipient = validators[1];
    const sendAmount = 50_000;
    const fee = calculateFee(sendAmount);

    const senderUTXOs = nodes[0].utxoStore.getByPubKeyHash(sender.pubKeyHash);
    expect(senderUTXOs.length).toBeGreaterThan(0);

    const tx = createTransaction({
      utxos: [senderUTXOs[0]],
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash: recipient.pubKeyHash,
      amount: sendAmount,
    });

    expect(tx.fee).toBe(fee);

    // Validate the transaction
    const txError = nodes[0].mempool.addTransaction(
      tx,
      (txId, idx) => nodes[0].utxoStore.get(txId, idx)
    );
    expect(txError).toBeNull();

    // Create block with the transaction
    const height = 1;
    const proposer = validators[1]; // round robin: height 1 => validator 1
    const coinbase = createCoinbaseTx(proposer.pubKeyHash, 1000 + tx.fee, height);

    // Apply to compute state root
    const n = nodes[1];
    n.utxoStore.applyTransaction(coinbase, height);
    n.utxoStore.applyTransaction(tx, height);
    const stateRoot = combinedStateRoot(n.utxoStore, n.confStore);
    // Revert
    n.utxoStore.revertTransaction(tx, (txId, idx) => {
      // We need the original UTXO to revert
      if (txId === senderUTXOs[0].txId && idx === senderUTXOs[0].outputIndex) {
        return senderUTXOs[0];
      }
      return undefined;
    });
    n.utxoStore.revertTransaction(coinbase);

    const block = createBlock({
      height,
      previousHash: n.blockchain.latestHash,
      transactions: [coinbase, tx],
      proposerPubKey: proposer.publicKey,
      proposerSecretKey: proposer.secretKey,
      stateRoot,
    });

    for (let i = 0; i < validators.length; i++) {
      if (i === 1) continue;
      block.signatures.push(signBlock(block.hash, validators[i].secretKey, validators[i].publicKey));
    }

    // Apply to all nodes
    for (const node of nodes) {
      const error = node.blockchain.addBlock(block);
      expect(error).toBeNull();
    }

    // Check balances
    const senderBalance = nodes[0].utxoStore.getBalance(sender.pubKeyHash);
    const recipientBalance = nodes[0].utxoStore.getBalance(recipient.pubKeyHash);

    expect(senderBalance).toBe(100_000_000 - sendAmount - fee);
    expect(recipientBalance).toBe(100_000_000 + sendAmount + 1000 + fee); // +coinbase+fee reward (proposer=recipient)
  });

  test('genesis block accepts single signature (pre-consensus)', () => {
    const { blockchain, validator } = createNodeChain(0);

    const genesis = blockchain.createGenesisBlock(
      [{ pubKeyHash: validator.pubKeyHash, amount: 100_000_000 }],
      validator.secretKey,
      validator.publicKey
    );

    // Genesis (height=0) only needs 1 signature
    const error = blockchain.addBlock(genesis);
    expect(error).toBeNull();
  });

  test('reject non-genesis block with insufficient signatures', () => {
    // First create and add genesis
    const { blockchain, validator } = createNodeChain(0);
    const genesis = blockchain.createGenesisBlock(
      [{ pubKeyHash: validator.pubKeyHash, amount: 100_000_000 }],
      validator.secretKey,
      validator.publicKey
    );
    blockchain.addBlock(genesis);

    // Now try block at height 1 with only 1 signature (need 3 for 4 validators)
    const block = createBlock({
      height: 1,
      previousHash: genesis.hash,
      transactions: [createCoinbaseTx(validator.pubKeyHash, 1000, 1)],
      proposerPubKey: validator.publicKey,
      proposerSecretKey: validator.secretKey,
      stateRoot: sha256(blockchain.getUTXOStore().computeStateRoot() + '|' + blockchain.getConfidentialUTXOStore().computeStateRoot()),
    });
    // Apply txs temporarily to get correct stateRoot
    for (const tx of block.transactions) {
      blockchain.getUTXOStore().applyTransaction(tx as Transaction, 1);
    }
    const stateRoot = sha256(blockchain.getUTXOStore().computeStateRoot() + '|' + blockchain.getConfidentialUTXOStore().computeStateRoot());
    for (const tx of [...block.transactions].reverse()) {
      blockchain.getUTXOStore().revertTransaction(tx as Transaction);
    }
    const block2 = createBlock({
      height: 1,
      previousHash: genesis.hash,
      transactions: block.transactions,
      proposerPubKey: validator.publicKey,
      proposerSecretKey: validator.secretKey,
      stateRoot,
    });
    const error = blockchain.addBlock(block2);
    expect(error).toBeTruthy();
    expect(error).toContain('Insufficient signatures');
  });

  test('reject invalid fee transaction in block', () => {
    const nodes = validators.map((_, i) => createNodeChain(i));

    // Genesis
    const genesis = nodes[0].blockchain.createGenesisBlock(
      validators.map(v => ({ pubKeyHash: v.pubKeyHash, amount: 100_000_000 })),
      validators[0].secretKey,
      validators[0].publicKey
    );
    for (let i = 1; i < 4; i++) {
      genesis.signatures.push(signBlock(genesis.hash, validators[i].secretKey, validators[i].publicKey));
    }
    for (const node of nodes) {
      expect(node.blockchain.addBlock(genesis)).toBeNull();
    }

    // Create tx with wrong fee
    const sender = validators[0];
    const recipient = validators[1];
    const senderUTXOs = nodes[0].utxoStore.getByPubKeyHash(sender.pubKeyHash);

    const tx = createTransaction({
      utxos: [senderUTXOs[0]],
      senderSecretKey: sender.secretKey,
      senderPubKey: sender.publicKey,
      recipientPubKeyHash: recipient.pubKeyHash,
      amount: 50_000,
    });

    // Tamper: change fee (this will make the UTXO balance not match)
    tx.fee = 999;
    // Recalculate outputs to make UTXO sum work but fee tier wrong
    tx.outputs[1].amount = tx.outputs[1].amount + 0.5 - 999; // adjust change

    // Add to mempool should fail
    const mempoolError = nodes[0].mempool.addTransaction(
      tx,
      (txId, idx) => nodes[0].utxoStore.get(txId, idx)
    );
    expect(mempoolError).toBeTruthy();
  });
});

// =============================================
// Wallet Integration
// =============================================
describe('Wallet Integration', () => {
  test('wallet creates multiple accounts with unique addresses', () => {
    const { MisakaWallet } = require('../../src/wallet/sdk');
    const wallet = new MisakaWallet({ network: 'testnet' });

    const acc1 = wallet.createAccount('primary');
    const acc2 = wallet.createAccount('payments');
    const acc3 = wallet.createAccount('savings');

    expect(acc1.address).not.toBe(acc2.address);
    expect(acc2.address).not.toBe(acc3.address);
    expect(acc1.address.startsWith('tmisaka1')).toBe(true);
  });

  test('wallet export and import roundtrip', () => {
    const { MisakaWallet } = require('../../src/wallet/sdk');
    const wallet = new MisakaWallet({ network: 'testnet' });
    wallet.createAccount('primary');
    wallet.createAccount('payments');

    const exported = wallet.exportWallet();
    const restored = MisakaWallet.fromBackup(exported);

    const originalAccounts = wallet.getAccounts();
    const restoredAccounts = restored.getAccounts();

    expect(restoredAccounts.length).toBe(originalAccounts.length);
    for (let i = 0; i < originalAccounts.length; i++) {
      expect(restoredAccounts[i].address).toBe(originalAccounts[i].address);
    }
  });

  test('address reuse warning', () => {
    const { MisakaWallet } = require('../../src/wallet/sdk');
    const wallet = new MisakaWallet({ network: 'testnet' });
    const account = wallet.createAccount('test');

    // Simulate usage
    account.usageCount = 4;
    const warning = wallet.checkAddressReuse(account);
    expect(warning).toBeTruthy();
    expect(warning).toContain('WARNING');

    account.usageCount = 1;
    expect(wallet.checkAddressReuse(account)).toBeNull();
  });
});
