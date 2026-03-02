// ============================================================
// Misaka Network - P2P Network Layer
// ============================================================
import { EventEmitter } from 'events';
import * as net from 'net';
import { MessageType, NetworkMessage, PeerInfo, Block, Transaction, ConfidentialTransaction, BlockSignature } from '../types';
import { v4 as uuidv4 } from 'uuid';

const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB
const HANDSHAKE_TIMEOUT = 5000;
const PING_INTERVAL = 30000;
const MAX_PEERS = 50;

interface PeerConnection {
  socket: net.Socket;
  info: PeerInfo;
  buffer: string;
  handshakeComplete: boolean;
}

export class P2PNetwork extends EventEmitter {
  private nodeId: string;
  private chainId: string;
  private version: string;
  private server: net.Server | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private listenPort: number;
  private listenHost: string;
  private rateLimits: Map<string, { count: number; resetTime: number }> = new Map();
  private peerScores: Map<string, number> = new Map();

  constructor(params: {
    chainId: string;
    listenHost: string;
    listenPort: number;
    version?: string;
  }) {
    super();
    this.nodeId = uuidv4();
    this.chainId = params.chainId;
    this.listenHost = params.listenHost;
    this.listenPort = params.listenPort;
    this.version = params.version || '0.1.0';
  }

  /** Start listening for connections */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleIncomingConnection(socket));

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.listenPort, this.listenHost, () => {
        this.emit('listening', { host: this.listenHost, port: this.listenPort });
        resolve();
      });
    });
  }

  /** Stop the P2P server */
  async stop(): Promise<void> {
    // Close all peer connections
    for (const [id, peer] of this.peers) {
      peer.socket.destroy();
    }
    this.peers.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Connect to a peer */
  async connectToPeer(host: string, port: number): Promise<void> {
    if (this.peers.size >= MAX_PEERS) return;

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, HANDSHAKE_TIMEOUT);

      socket.connect(port, host, () => {
        clearTimeout(timeout);
        const peer = this.setupPeer(socket, host, port);
        this.sendHandshake(peer);
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Handle incoming connection */
  private handleIncomingConnection(socket: net.Socket): void {
    const remoteHost = socket.remoteAddress || 'unknown';
    const remotePort = socket.remotePort || 0;
    this.setupPeer(socket, remoteHost, remotePort);
  }

  /** Setup a peer connection */
  private setupPeer(socket: net.Socket, host: string, port: number): PeerConnection {
    const peer: PeerConnection = {
      socket,
      info: {
        nodeId: '',
        host,
        port,
        chainId: '',
        version: '',
        lastSeen: Date.now(),
        score: 100,
      },
      buffer: '',
      handshakeComplete: false,
    };

    const tempId = `${host}:${port}`;
    this.peers.set(tempId, peer);

    socket.setEncoding('utf-8');

    socket.on('data', (data: string) => {
      peer.buffer += data;
      // Prevent unbounded buffer growth from malicious peers
      if (peer.buffer.length > MAX_MESSAGE_SIZE * 2) {
        this.adjustPeerScore(tempId, -100);
        peer.buffer = '';
        socket.destroy();
        return;
      }
      this.processBuffer(tempId, peer);
    });

    socket.on('close', () => {
      this.peers.delete(tempId);
      if (peer.info.nodeId) {
        this.peers.delete(peer.info.nodeId);
      }
      this.emit('peer:disconnected', peer.info);
    });

    socket.on('error', (err) => {
      this.adjustPeerScore(tempId, -10);
    });

    return peer;
  }

  /** Process message buffer */
  private processBuffer(peerId: string, peer: PeerConnection): void {
    // Messages are JSON objects separated by newlines
    const lines = peer.buffer.split('\n');
    peer.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.length === 0) continue;
      if (line.length > MAX_MESSAGE_SIZE) {
        this.adjustPeerScore(peerId, -50);
        continue;
      }

      // Rate limiting
      if (!this.checkRateLimit(peerId)) {
        this.adjustPeerScore(peerId, -5);
        continue;
      }

      try {
        const message: NetworkMessage = JSON.parse(line);
        this.handleMessage(peerId, peer, message);
      } catch (err) {
        this.adjustPeerScore(peerId, -10);
      }
    }
  }

  /** Handle a received message */
  private handleMessage(peerId: string, peer: PeerConnection, message: NetworkMessage): void {
    peer.info.lastSeen = Date.now();

    switch (message.type) {
      case MessageType.HANDSHAKE:
        this.handleHandshake(peerId, peer, message);
        break;
      case MessageType.HANDSHAKE_ACK:
        this.handleHandshakeAck(peerId, peer, message);
        break;
      case MessageType.GOSSIP_TX:
        this.emit('tx', message.payload as Transaction);
        break;
      case MessageType.GOSSIP_CONFIDENTIAL_TX:
        this.emit('confidential_tx', message.payload as ConfidentialTransaction);
        break;
      case MessageType.GOSSIP_BLOCK:
        this.emit('block', message.payload as Block);
        break;
      case MessageType.PROPOSE_BLOCK:
        this.emit('propose', message.payload as Block);
        break;
      case MessageType.VOTE_BLOCK:
        this.emit('vote', message.payload as { blockHash: string; signature: BlockSignature });
        break;
      case MessageType.REQUEST_BLOCKS:
        this.emit('request:blocks', {
          fromHeight: message.payload.fromHeight,
          toHeight: message.payload.toHeight,
          respond: (blocks: Block[]) => this.sendMessage(peer, {
            type: MessageType.RESPONSE_BLOCKS,
            sender: this.nodeId,
            payload: blocks,
            timestamp: Date.now(),
          }),
        });
        break;
      case MessageType.RESPONSE_BLOCKS:
        this.emit('response:blocks', message.payload as Block[]);
        break;
      case MessageType.PING:
        this.sendMessage(peer, {
          type: MessageType.PONG,
          sender: this.nodeId,
          payload: {},
          timestamp: Date.now(),
        });
        break;
      case MessageType.PONG:
        // Update last seen
        break;
    }
  }

  /** Send handshake */
  private sendHandshake(peer: PeerConnection): void {
    this.sendMessage(peer, {
      type: MessageType.HANDSHAKE,
      sender: this.nodeId,
      payload: {
        chainId: this.chainId,
        nodeId: this.nodeId,
        version: this.version,
        listenPort: this.listenPort,
      },
      timestamp: Date.now(),
    });
  }

  /** Handle handshake */
  private handleHandshake(peerId: string, peer: PeerConnection, message: NetworkMessage): void {
    const { chainId, nodeId, version, listenPort } = message.payload;

    if (chainId !== this.chainId) {
      peer.socket.destroy();
      this.peers.delete(peerId);
      return;
    }

    // Update peer info
    peer.info.nodeId = nodeId;
    peer.info.chainId = chainId;
    peer.info.version = version;
    peer.info.port = listenPort || peer.info.port;
    peer.handshakeComplete = true;

    // Re-key the peer by nodeId
    this.peers.delete(peerId);
    this.peers.set(nodeId, peer);

    // Send ack
    this.sendMessage(peer, {
      type: MessageType.HANDSHAKE_ACK,
      sender: this.nodeId,
      payload: {
        chainId: this.chainId,
        nodeId: this.nodeId,
        version: this.version,
      },
      timestamp: Date.now(),
    });

    this.emit('peer:connected', peer.info);
  }

  /** Handle handshake ack */
  private handleHandshakeAck(peerId: string, peer: PeerConnection, message: NetworkMessage): void {
    const { nodeId, chainId, version } = message.payload;
    peer.info.nodeId = nodeId;
    peer.info.chainId = chainId;
    peer.info.version = version;
    peer.handshakeComplete = true;

    // Re-key
    this.peers.delete(peerId);
    this.peers.set(nodeId, peer);

    this.emit('peer:connected', peer.info);
  }

  /** Send a message to a peer */
  private sendMessage(peer: PeerConnection, message: NetworkMessage): void {
    try {
      const data = JSON.stringify(message) + '\n';
      peer.socket.write(data);
    } catch (err) {
      // Connection may be closed
    }
  }

  /** Broadcast a message to all connected peers */
  broadcast(message: NetworkMessage): void {
    for (const peer of this.peers.values()) {
      if (peer.handshakeComplete) {
        this.sendMessage(peer, message);
      }
    }
  }

  /** Broadcast a transaction */
  broadcastTransaction(tx: Transaction): void {
    this.broadcast({
      type: MessageType.GOSSIP_TX,
      sender: this.nodeId,
      payload: tx,
      timestamp: Date.now(),
    });
  }

  /** Broadcast a confidential transaction */
  broadcastConfidentialTransaction(tx: ConfidentialTransaction): void {
    this.broadcast({
      type: MessageType.GOSSIP_CONFIDENTIAL_TX,
      sender: this.nodeId,
      payload: tx,
      timestamp: Date.now(),
    });
  }

  /** Broadcast a block proposal */
  broadcastProposal(block: Block): void {
    this.broadcast({
      type: MessageType.PROPOSE_BLOCK,
      sender: this.nodeId,
      payload: block,
      timestamp: Date.now(),
    });
  }

  /** Broadcast a vote */
  broadcastVote(blockHash: string, signature: BlockSignature): void {
    this.broadcast({
      type: MessageType.VOTE_BLOCK,
      sender: this.nodeId,
      payload: { blockHash, signature },
      timestamp: Date.now(),
    });
  }

  /** Broadcast a committed block */
  broadcastBlock(block: Block): void {
    this.broadcast({
      type: MessageType.GOSSIP_BLOCK,
      sender: this.nodeId,
      payload: block,
      timestamp: Date.now(),
    });
  }

  /** Request blocks from all peers */
  requestBlocks(fromHeight: number, toHeight: number): void {
    this.broadcast({
      type: MessageType.REQUEST_BLOCKS,
      sender: this.nodeId,
      payload: { fromHeight, toHeight },
      timestamp: Date.now(),
    });
  }

  /** Rate limiting */
  private checkRateLimit(peerId: string): boolean {
    const now = Date.now();
    let limit = this.rateLimits.get(peerId);

    if (!limit || now > limit.resetTime) {
      limit = { count: 0, resetTime: now + 1000 };
      this.rateLimits.set(peerId, limit);
    }

    limit.count++;
    return limit.count <= 100; // 100 messages per second max
  }

  /** Adjust peer score */
  private adjustPeerScore(peerId: string, delta: number): void {
    const current = this.peerScores.get(peerId) || 100;
    const newScore = Math.max(0, Math.min(200, current + delta));
    this.peerScores.set(peerId, newScore);

    if (newScore <= 0) {
      // Disconnect bad peer
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.socket.destroy();
        this.peers.delete(peerId);
      }
    }
  }

  /** Get connected peer count */
  get peerCount(): number {
    return this.peers.size;
  }

  /** Get node ID */
  getNodeId(): string {
    return this.nodeId;
  }

  /** Get peer list */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values())
      .filter(p => p.handshakeComplete)
      .map(p => p.info);
  }
}
