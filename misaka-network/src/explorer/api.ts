// ============================================================
// Misaka Network - Explorer REST API (32GB VPS)
// ============================================================
// Serves JSON endpoints for a block explorer web UI.
// Only runs on explorer/indexer nodes.
//
// Endpoints:
//   GET /api/status              — chain status + supply
//   GET /api/block/:height       — block detail + stats
//   GET /api/blocks/recent       — recent blocks
//   GET /api/tx/:txId            — transaction detail
//   GET /api/address/:hash       — address info + recent activity
//   GET /api/address/:hash/txs   — paginated TX history
//   GET /api/richlist            — top balances
//   GET /api/validators          — validator stats
//   GET /api/search?q=           — search TX/address
//   GET /api/fees                — fee statistics
// ============================================================

import * as http from 'http';
import { URL } from 'url';
import { ExplorerIndexer } from './indexer';
import { UTXOStore } from '../core/utxo-store';
import { IBlockStore } from '../storage/types';

export interface ExplorerAPIConfig {
  port: number;
  host: string;
  corsOrigin?: string;
}

export class ExplorerAPI {
  private server: http.Server | null = null;
  private indexer: ExplorerIndexer;
  private utxoStore: UTXOStore;
  private blockStore: IBlockStore;
  private config: ExplorerAPIConfig;

  constructor(
    indexer: ExplorerIndexer,
    utxoStore: UTXOStore,
    blockStore: IBlockStore,
    config: ExplorerAPIConfig,
  ) {
    this.indexer = indexer;
    this.utxoStore = utxoStore;
    this.blockStore = blockStore;
    this.config = config;
  }

  /** Start the API server */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      this.server.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  /** Stop the API server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS
    const origin = this.config.corsOrigin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      this.json(res, 405, { error: 'Method not allowed' });
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const path = url.pathname;
      const params = url.searchParams;

      this.route(path, params, res);
    } catch (err: any) {
      this.json(res, 500, { error: err.message });
    }
  }

  private route(path: string, params: URLSearchParams, res: http.ServerResponse): void {
    // ── /api/status ─────────────────────────────────────
    if (path === '/api/status') {
      const supply = this.indexer.getSupplyStats(this.utxoStore);
      const fees = this.indexer.getFeeStats();
      const mem = this.indexer.getMemoryStats();
      this.json(res, 200, {
        chain: {
          height: this.blockStore.getLatestHeight(),
          txCount: this.indexer.txCount,
          addressCount: this.indexer.addressCount,
        },
        supply,
        fees: { avgPerBlock: fees.avgFeePerBlock, total: fees.totalFees },
        indexer: mem,
      });
      return;
    }

    // ── /api/block/:height ──────────────────────────────
    const blockMatch = path.match(/^\/api\/block\/(\d+)$/);
    if (blockMatch) {
      const height = parseInt(blockMatch[1]);
      const block = this.blockStore.getByHeight(height);
      const stats = this.indexer.getBlockStats(height);
      if (!block) {
        this.json(res, 404, { error: `Block ${height} not found` });
        return;
      }
      this.json(res, 200, {
        block: {
          hash: block.hash,
          height: block.header.height,
          previousHash: block.header.previousHash,
          proposer: block.header.proposer,
          timestamp: block.header.timestamp,
          stateRoot: block.header.stateRoot,
          txCount: block.transactions.length,
          signatures: block.signatures.length,
          transactions: block.transactions.map(tx => tx.id),
        },
        stats,
      });
      return;
    }

    // ── /api/blocks/recent ──────────────────────────────
    if (path === '/api/blocks/recent') {
      const count = Math.min(parseInt(params.get('count') || '10'), 50);
      const recentStats = this.indexer.getRecentBlockStats(count);
      this.json(res, 200, { blocks: recentStats });
      return;
    }

    // ── /api/tx/:txId ───────────────────────────────────
    const txMatch = path.match(/^\/api\/tx\/([a-f0-9]+)$/);
    if (txMatch) {
      const txId = txMatch[1];
      const indexed = this.indexer.getTx(txId);
      if (!indexed) {
        this.json(res, 404, { error: `TX ${txId} not found` });
        return;
      }
      // Get the full TX from the block
      const block = this.blockStore.getByHeight(indexed.blockHeight);
      const fullTx = block?.transactions.find(tx => tx.id === txId);
      this.json(res, 200, { indexed, tx: fullTx || null });
      return;
    }

    // ── /api/address/:hash ──────────────────────────────
    const addrMatch = path.match(/^\/api\/address\/([a-f0-9]+)$/);
    if (addrMatch) {
      const hash = addrMatch[1];
      const balance = this.utxoStore.getBalance(hash);
      const utxos = this.utxoStore.getByPubKeyHash(hash);
      const txCount = this.indexer.getAddressTxCount(hash);
      const recentActivity = this.indexer.getAddressActivity(hash, 0, 10);

      this.json(res, 200, {
        pubKeyHash: hash,
        balance,
        utxoCount: utxos.length,
        txCount,
        recentActivity,
      });
      return;
    }

    // ── /api/address/:hash/txs ──────────────────────────
    const addrTxMatch = path.match(/^\/api\/address\/([a-f0-9]+)\/txs$/);
    if (addrTxMatch) {
      const hash = addrTxMatch[1];
      const offset = parseInt(params.get('offset') || '0');
      const limit = Math.min(parseInt(params.get('limit') || '20'), 100);
      const txs = this.indexer.getAddressTxs(hash, offset, limit);
      const total = this.indexer.getAddressTxCount(hash);
      this.json(res, 200, { txs, total, offset, limit });
      return;
    }

    // ── /api/richlist ───────────────────────────────────
    if (path === '/api/richlist') {
      const limit = Math.min(parseInt(params.get('limit') || '100'), 500);
      const richList = this.indexer.buildRichList(this.utxoStore, limit);
      this.json(res, 200, { richList });
      return;
    }

    // ── /api/validators ─────────────────────────────────
    if (path === '/api/validators') {
      const stats = this.indexer.getAllValidatorStats();
      this.json(res, 200, { validators: stats });
      return;
    }

    // ── /api/search ─────────────────────────────────────
    if (path === '/api/search') {
      const q = params.get('q') || '';
      if (q.length < 4) {
        this.json(res, 400, { error: 'Query must be at least 4 characters' });
        return;
      }
      const txResults = this.indexer.searchTx(q, 5);
      const addrResults = this.indexer.searchAddress(q, 5);
      this.json(res, 200, { transactions: txResults, addresses: addrResults });
      return;
    }

    // ── /api/fees ───────────────────────────────────────
    if (path === '/api/fees') {
      const stats = this.indexer.getFeeStats();
      this.json(res, 200, stats);
      return;
    }

    // ── 404 ─────────────────────────────────────────────
    this.json(res, 404, { error: 'Not found' });
  }

  private json(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
