// ============================================================
// Misaka Network - Full Node
// ============================================================
import { EventEmitter } from 'events';
import * as http from 'http';
import {
  NodeConfig, Block, Transaction, ConfidentialTransaction, BlockSignature,
  DEFAULT_FEE_TIERS, NetworkType
} from '../types';
import { Blockchain } from '../core/blockchain';
import { UTXOStore } from '../core/utxo-store';
import { Mempool } from '../core/mempool';
import { ConsensusEngine, ConsensusEvent } from '../consensus/engine';
import { P2PNetwork } from '../p2p/network';
import { generateKeyPair, toHex, fromHex, hashPubKey } from '../utils/crypto';
import { generateArchiveKeyPair, decryptAuditEnvelope } from '../privacy/audit';
import { isConfidentialTx, AnyTransaction } from '../types';

export class MisakaNode extends EventEmitter {
  private config: NodeConfig;
  private blockchain: Blockchain;
  private utxoStore: UTXOStore;
  private mempool: Mempool;
  private consensus: ConsensusEngine | null = null;
  private p2p: P2PNetwork;
  private rpcServer: http.Server | null = null;
  private validatorKey?: { publicKey: Uint8Array; secretKey: Uint8Array };
  private running: boolean = false;

  constructor(config: NodeConfig) {
    super();
    this.config = config;
    this.utxoStore = new UTXOStore();
    this.blockchain = new Blockchain(
      this.utxoStore,
      config.feeTiers || DEFAULT_FEE_TIERS,
      config.validators
    );
    this.mempool = new Mempool(config.feeTiers || DEFAULT_FEE_TIERS);
    this.p2p = new P2PNetwork({
      chainId: config.chainId,
      listenHost: config.listenHost,
      listenPort: config.listenPort,
    });
  }

  /** Set validator key */
  setValidatorKey(secretKey: Uint8Array, publicKey: Uint8Array): void {
    this.validatorKey = { secretKey, publicKey };
  }

  /** Start the node */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start P2P
    await this.p2p.start();
    this.setupP2PHandlers();

    // Initialize genesis if no blocks
    if (this.blockchain.currentHeight < 0) {
      this.initializeGenesis();
    }

    // Start consensus if we're a validator and have genesis
    if (this.validatorKey && this.blockchain.currentHeight >= 0) {
      this.startConsensus();
    }

    // Start JSON-RPC server
    await this.startRPC();

    // Connect to initial peers
    for (const peerAddr of this.config.peers) {
      const [host, portStr] = peerAddr.split(':');
      const port = parseInt(portStr);
      if (host && port) {
        try {
          await this.p2p.connectToPeer(host, port);
        } catch (err: any) {
          // Peer might not be available yet
        }
      }
    }

    this.emit('started', {
      chainId: this.config.chainId,
      listenPort: this.config.listenPort,
      rpcPort: this.config.rpcPort,
    });
  }

  /** Stop the node */
  async stop(): Promise<void> {
    this.running = false;
    this.consensus?.stop();
    await this.p2p.stop();
    if (this.rpcServer) {
      await new Promise<void>((resolve) => this.rpcServer!.close(() => resolve()));
    }
    this.emit('stopped');
  }

  /** Initialize genesis block */
  private initializeGenesis(): void {
    if (!this.validatorKey) {
      // Non-validator nodes wait for genesis from peers
      return;
    }

    // Only the first validator in the sorted list creates genesis.
    // Others will receive it via P2P sync after connecting.
    const sortedValidators = [...this.config.validators].sort();
    const myPubHex = toHex(this.validatorKey.publicKey);
    if (sortedValidators.length > 0 && sortedValidators[0] !== myPubHex) {
      // Not the designated genesis creator — wait for sync
      return;
    }

    // Auto-generate archive key pair if not configured
    if (!this.config.archivePubKey) {
      const archiveKP = generateArchiveKeyPair();
      this.config.archivePubKey = archiveKP.publicKey;
      this.config.archiveSecretKey = archiveKP.secretKey;

      // Save to file for distribution
      const fs = require('fs');
      const path = require('path');
      const archiveKeyPath = path.join(this.config.dataDir, 'archive-key.json');
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      fs.writeFileSync(archiveKeyPath, JSON.stringify({
        publicKey: archiveKP.publicKey,
        secretKey: archiveKP.secretKey,
        notice: 'publicKey → all nodes (config.archivePubKey). secretKey → archive nodes only (config.archiveSecretKey).',
      }, null, 2));
      console.log(`[Genesis] Archive key pair generated → ${archiveKeyPath}`);
      console.log(`[Genesis] archivePubKey: ${archiveKP.publicKey}`);
    }

    // Create genesis with initial distribution
    const genesisDistributions = this.config.validators.map(v => ({
      pubKeyHash: hashPubKey(fromHex(v)),
      amount: 100_000_000, // 100M tokens per validator
    }));

    const genesis = this.blockchain.createGenesisBlock(
      genesisDistributions,
      this.validatorKey.secretKey,
      this.validatorKey.publicKey
    );

    const error = this.blockchain.addBlock(genesis);
    if (error) {
      this.emit('error', new Error(`Genesis block failed: ${error}`));
    } else {
      this.emit('block', genesis);
      // Broadcast genesis to peers
      this.p2p.broadcastBlock(genesis);

      // Seed confidential UTXO pool for decoy ring members
      // These are not spendable — they just populate the decoy pool
      // so the first real confidential TXs have ring members available
      this.seedConfidentialPool();
    }
  }

  /** Start consensus engine */
  private startConsensus(): void {
    if (!this.validatorKey) return;

    const validators = this.config.validators.map(v => ({
      pubKey: fromHex(v),
      pubKeyHex: v,
    }));

    this.consensus = new ConsensusEngine(this.blockchain, this.mempool, {
      validators,
      mySecretKey: this.validatorKey.secretKey,
      myPubKey: this.validatorKey.publicKey,
      blockInterval: this.config.blockInterval || 5000,
    });

    this.consensus.on('consensus', (event: ConsensusEvent) => {
      switch (event.type) {
        case 'propose':
          this.p2p.broadcastProposal(event.block);
          break;
        case 'vote':
          this.p2p.broadcastVote(event.blockHash, event.signature);
          break;
        case 'committed':
          this.p2p.broadcastBlock(event.block);
          this.emit('block', event.block);
          break;
        case 'error':
          this.emit('consensus:error', event.message);
          break;
      }
    });

    this.consensus.start();
  }

  /** Setup P2P event handlers */
  private setupP2PHandlers(): void {
    this.p2p.on('tx', (tx: Transaction) => {
      const error = this.mempool.addTransaction(
        tx,
        (txId, idx) => this.utxoStore.get(txId, idx)
      );
      if (!error) {
        // Re-broadcast to other peers
        this.p2p.broadcastTransaction(tx);
        this.emit('tx', tx);
      }
    });

    // Confidential TX gossip: pruned nodes validate ring sigs + Pedersen,
    // never see sender/recipient/amount
    this.p2p.on('confidential_tx', (tx: ConfidentialTransaction) => {
      const confidentialUTXOs = this.blockchain.getConfidentialUTXOStore();
      const error = this.mempool.addConfidentialTransaction(tx, confidentialUTXOs);
      if (!error) {
        this.p2p.broadcastConfidentialTransaction(tx);
        this.emit('confidential_tx', tx);
      }
    });

    this.p2p.on('block', (block: Block) => {
      const error = this.blockchain.addBlock(block);
      if (!error) {
        this.mempool.removeTransactions(block.transactions.map(tx => tx.id));
        this.emit('block', block);
        // If we just received genesis, seed confidential pool + start consensus
        if (block.header.height === 0) {
          this.seedConfidentialPool();
          if (this.validatorKey && !this.consensus) {
            this.startConsensus();
          }
        }
      }
    });

    this.p2p.on('propose', (block: Block) => {
      this.consensus?.handleProposedBlock(block);
    });

    this.p2p.on('vote', (data: { blockHash: string; signature: BlockSignature }) => {
      this.consensus?.handleVote(data.blockHash, data.signature);
    });

    this.p2p.on('request:blocks', (req: {
      fromHeight: number;
      toHeight: number;
      respond: (blocks: Block[]) => void;
    }) => {
      const blocks = this.blockchain.getBlocks(req.fromHeight, req.toHeight);
      req.respond(blocks);
    });

    this.p2p.on('peer:connected', (info: any) => {
      this.emit('peer:connected', info);
      // Sync: request blocks we're missing
      if (this.blockchain.currentHeight < 0) {
        // No genesis yet — request from peers
        this.p2p.requestBlocks(0, 100);
      }
    });

    this.p2p.on('response:blocks', (blocks: Block[]) => {
      // Apply received blocks in order
      const sorted = [...blocks].sort(
        (a, b) => a.header.height - b.header.height
      );
      for (const block of sorted) {
        if (block.header.height <= this.blockchain.currentHeight) continue;
        const error = this.blockchain.addBlock(block);
        if (!error) {
          this.mempool.removeTransactions(block.transactions.map(tx => tx.id));
          this.emit('block', block);
          if (block.header.height === 0) {
            this.seedConfidentialPool();
          }
        }
      }
      // After sync, start consensus if not yet running
      if (this.blockchain.currentHeight >= 0 && this.validatorKey && !this.consensus) {
        this.startConsensus();
      }
    });

    this.p2p.on('peer:disconnected', (info: any) => {
      this.emit('peer:disconnected', info);
    });
  }

  /** Start JSON-RPC server */
  private async startRPC(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.rpcServer = http.createServer((req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const request = JSON.parse(body);

            // Archive-only methods require auth token
            const archiveMethods = ['decryptAuditEnvelope', 'decryptBlockAudits'];
            if (archiveMethods.includes(request.method)) {
              const authHeader = req.headers['x-archive-token'] || req.headers['authorization'];
              const expectedToken = this.config.archiveSecretKey
                ? require('../utils/crypto').sha256(this.config.archiveSecretKey).slice(0, 32)
                : null;
              if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  jsonrpc: '2.0', id: request.id,
                  error: { code: -32600, message: 'Archive API requires valid auth token' },
                }));
                return;
              }
            }

            const result = await this.handleRPCRequest(request);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
          } catch (err: any) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: err.message },
            }));
          }
        });
      });

      // Bind to 127.0.0.1 by default (not 0.0.0.0)
      const rpcBind = this.config.rpcBind || '127.0.0.1';
      this.rpcServer.listen(this.config.rpcPort, rpcBind, () => {
        resolve();
      });
    });
  }

  /** Handle JSON-RPC request */
  private async handleRPCRequest(request: any): Promise<any> {
    switch (request.method) {
      case 'getInfo':
        return this.blockchain.getInfo();

      case 'getBalance': {
        const { pubKeyHash } = request.params;
        return { balance: this.utxoStore.getBalance(pubKeyHash) };
      }

      case 'getUTXOs': {
        const { pubKeyHash } = request.params;
        return { utxos: this.utxoStore.getByPubKeyHash(pubKeyHash) };
      }

      case 'sendTransaction': {
        const tx = request.params.transaction as Transaction;
        const error = this.mempool.addTransaction(
          tx,
          (txId, idx) => this.utxoStore.get(txId, idx)
        );
        if (error) throw new Error(error);
        this.p2p.broadcastTransaction(tx);
        return { txId: tx.id };
      }

      case 'sendConfidentialTransaction': {
        const tx = request.params.transaction as ConfidentialTransaction;
        const confidentialUTXOs = this.blockchain.getConfidentialUTXOStore();
        const error = this.mempool.addConfidentialTransaction(tx, confidentialUTXOs);
        if (error) throw new Error(error);
        this.p2p.broadcastConfidentialTransaction(tx);
        return { txId: tx.id, type: 'confidential' };
      }

      case 'getBlock': {
        const { height } = request.params;
        const block = this.blockchain.getBlockByHeight(height);
        return block || null;
      }

      case 'getMempoolSize':
        return {
          size: this.mempool.size,
          confidential: this.mempool.confidentialSize,
          total: this.mempool.totalSize,
        };

      case 'getPeers':
        return { peers: this.p2p.getPeers() };

      case 'getConsensusStatus':
        return this.consensus?.getStatus() || { running: false };

      // ── Confidential TX queries (any node) ──

      case 'getConfidentialUTXOs': {
        const store = this.blockchain.getConfidentialUTXOStore();
        return {
          utxos: store.getAll(),
          count: store.size,
          keyImageCount: store.keyImageCount,
        };
      }

      case 'getConfidentialInfo': {
        const cStore = this.blockchain.getConfidentialUTXOStore();
        return {
          confidentialUtxoCount: cStore.size,
          keyImageCount: cStore.keyImageCount,
          knownPubKeyCount: cStore.pubKeyCount,
          archivePubKey: this.config.archivePubKey || null,
          isArchiveNode: !!this.config.archiveSecretKey,
        };
      }

      // ── Archive-only: decrypt audit envelope ──

      case 'decryptAuditEnvelope': {
        if (!this.config.archiveSecretKey) {
          throw new Error('This node is not an archive node (no archiveSecretKey)');
        }
        const { txId, height } = request.params;
        // Find the TX in a block
        let targetTx: ConfidentialTransaction | null = null;
        if (height !== undefined) {
          const block = this.blockchain.getBlockByHeight(height);
          if (block) {
            for (const tx of block.transactions) {
              if (isConfidentialTx(tx) && tx.id === txId) {
                targetTx = tx;
                break;
              }
            }
          }
        }
        // Fallback: scan recent blocks
        if (!targetTx) {
          for (let h = this.blockchain.currentHeight; h >= 0 && h > this.blockchain.currentHeight - 100; h--) {
            const block = this.blockchain.getBlockByHeight(h);
            if (!block) continue;
            for (const tx of block.transactions) {
              if (isConfidentialTx(tx) && tx.id === txId) {
                targetTx = tx;
                break;
              }
            }
            if (targetTx) break;
          }
        }
        if (!targetTx) throw new Error(`Confidential TX ${txId} not found`);

        const auditData = decryptAuditEnvelope(targetTx.auditEnvelope, this.config.archiveSecretKey);
        if (!auditData) throw new Error('Failed to decrypt audit envelope');
        return {
          txId,
          sender: auditData.senderPubKeyHash,
          senderPubKey: auditData.senderPubKey,
          outputs: auditData.outputs,
          inputRefs: auditData.inputRefs,
          fee: auditData.fee,
          timestamp: auditData.timestamp,
        };
      }

      case 'decryptBlockAudits': {
        if (!this.config.archiveSecretKey) {
          throw new Error('This node is not an archive node (no archiveSecretKey)');
        }
        const blockHeight = request.params.height;
        const block = this.blockchain.getBlockByHeight(blockHeight);
        if (!block) throw new Error(`Block ${blockHeight} not found`);

        const audits: any[] = [];
        for (const tx of block.transactions) {
          if (isConfidentialTx(tx)) {
            const auditData = decryptAuditEnvelope(tx.auditEnvelope, this.config.archiveSecretKey!);
            audits.push({
              txId: tx.id,
              decrypted: !!auditData,
              sender: auditData?.senderPubKeyHash || null,
              outputs: auditData?.outputs || [],
              fee: tx.fee,
            });
          }
        }
        return { height: blockHeight, confidentialTxCount: audits.length, audits };
      }

      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }

  /** Submit a transaction directly (for local use) */
  submitTransaction(tx: Transaction): string | null {
    const error = this.mempool.addTransaction(
      tx,
      (txId, idx) => this.utxoStore.get(txId, idx)
    );
    if (!error) {
      this.p2p.broadcastTransaction(tx);
    }
    return error;
  }

  /** Get blockchain info */
  getChainInfo() {
    return this.blockchain.getInfo();
  }

  /** Get UTXO store */
  getUTXOStore(): UTXOStore {
    return this.utxoStore;
  }

  /** Get blockchain */
  getBlockchain(): Blockchain {
    return this.blockchain;
  }

  /** Get mempool */
  getMempool(): Mempool {
    return this.mempool;
  }

  /**
   * Seed the confidential UTXO pool with initial decoy entries.
   * Deterministic: all nodes generate the same 16 entries from chainId.
   * These are non-spendable dummy outputs used only as ring members
   * so the first confidential transactions have decoys available.
   */
  private seedConfidentialPool(): void {
    const { sha256: sha256Fn } = require('../utils/crypto');
    const { bytesToScalar, scalarMulBase, scalarToBytes, P } = require('../privacy/curve');
    const { pedersenCommit, toBaseUnits } = require('../privacy/pedersen');
    const confStore = this.blockchain.getConfidentialUTXOStore();

    // Skip if already seeded (e.g. node restart)
    if (confStore.size > 0) return;

    const SEED_COUNT = 16;

    for (let i = 0; i < SEED_COUNT; i++) {
      // Deterministic scalar from chainId + index
      const seedHash = sha256Fn(`${this.config.chainId}:confidential-seed:${i}`);
      const seedBytes = new Uint8Array(Buffer.from(seedHash, 'hex'));
      const secret = bytesToScalar(seedBytes);
      const oneTimePubKey = scalarMulBase(secret).toHex();

      // Deterministic commitment — amounts in base units (same scale as createStealthOutput)
      const amountSeed = sha256Fn(`${this.config.chainId}:amount-seed:${i}`);
      const blindSeed = sha256Fn(`${this.config.chainId}:blind-seed:${i}`);
      const displayAmount = Number(BigInt('0x' + amountSeed.slice(0, 8)) % 100000n + 1000n);
      const blinding = bytesToScalar(new Uint8Array(Buffer.from(blindSeed, 'hex')));
      const amountBase = toBaseUnits(displayAmount);
      const commitment = pedersenCommit(amountBase, blinding);

      confStore.add({
        txId: `genesis-seed-${i.toString().padStart(4, '0')}`,
        outputIndex: 0,
        commitment: commitment.point,
        oneTimePubKey,
        blockHeight: 0,
      });
    }

    console.log(`[Genesis] Seeded confidential pool with ${SEED_COUNT} decoy UTXOs`);
  }
}
