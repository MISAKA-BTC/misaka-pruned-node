#!/usr/bin/env node
// ============================================================
// Misaka Network - CLI
// ============================================================
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import {
  NetworkType, DEFAULT_FEE_TIERS, NodeConfig,
} from '../types';
import {
  generateKeyPair, toHex, fromHex, hashPubKey,
} from '../utils/crypto';
import { encodeMisakaAddress, decodeMisakaAddress, detectAddressType, isValidMisakaAddress } from '../core/address';
import { calculateFee, formatFeeTiers, getFeeTier } from '../core/fee';
import { MisakaNode } from '../core/node';
import { MisakaWallet } from '../wallet/sdk';

const program = new Command();

program
  .name('misaka')
  .description('Misaka Network CLI - Transfer-only privacy-enhanced L1')
  .version('0.1.0');

// ---- Key Generation ----
program
  .command('keygen')
  .description('Generate a new Ed25519 keypair')
  .option('-o, --output <path>', 'Output file path', './misaka-key.json')
  .action((options) => {
    const kp = generateKeyPair();
    const data = {
      publicKey: toHex(kp.publicKey),
      secretKey: toHex(kp.secretKey),
    };
    fs.writeFileSync(options.output, JSON.stringify(data, null, 2));
    console.log(`✅ Key pair generated and saved to ${options.output}`);
    console.log(`   Public key: ${data.publicKey}`);
    console.log(`   ⚠️  Keep your secret key safe and never share it!`);
  });

// ---- Address ----
program
  .command('address')
  .description('Derive Misaka address from a key file')
  .option('-k, --key <path>', 'Key file path', './misaka-key.json')
  .option('-n, --network <network>', 'Network: main or test', 'test')
  .action((options) => {
    const keyData = JSON.parse(fs.readFileSync(options.key, 'utf-8'));
    const pubKey = fromHex(keyData.publicKey);
    const network: NetworkType = options.network === 'main' ? 'mainnet' : 'testnet';
    const address = encodeMisakaAddress(pubKey, network);
    const pubKeyHash = hashPubKey(pubKey);

    console.log(`Network:       ${network}`);
    console.log(`Address:       ${address}`);
    console.log(`Public Key:    ${keyData.publicKey}`);
    console.log(`PubKey Hash:   ${pubKeyHash}`);
  });

// ---- Address Validate ----
program
  .command('validate')
  .description('Validate and identify an address type')
  .argument('<address>', 'Address to validate')
  .action((address) => {
    const type = detectAddressType(address);
    console.log(`Address: ${address}`);
    console.log(`Type:    ${type}`);

    if (type === 'misaka') {
      const decoded = decodeMisakaAddress(address);
      console.log(`Network: ${decoded.network}`);
      console.log(`PubKey:  ${toHex(decoded.pubKey)}`);
    } else if (type === 'solana') {
      console.log(`⚠️  This is a Solana address. Cannot use with Misaka!`);
    } else {
      console.log(`❌ Unknown address format.`);
    }
  });

// ---- Fee ----
program
  .command('fee')
  .description('Show fee tiers or calculate fee for a specific amount')
  .option('-a, --amount <number>', 'Calculate fee for this amount')
  .action((options) => {
    if (options.amount) {
      const amount = parseFloat(options.amount);
      const fee = calculateFee(amount);
      const tier = getFeeTier(amount);
      console.log(`Amount: ${amount.toLocaleString()}`);
      console.log(`Tier:   ${tier.label}`);
      console.log(`Fee:    ${fee}`);
    } else {
      console.log(formatFeeTiers());
    }
  });

// ---- Balance ----
program
  .command('balance')
  .description('Check balance for an address')
  .option('-k, --key <path>', 'Key file path', './misaka-key.json')
  .option('-r, --rpc <url>', 'RPC URL', 'http://localhost:3001')
  .action(async (options) => {
    const keyData = JSON.parse(fs.readFileSync(options.key, 'utf-8'));
    const pubKey = fromHex(keyData.publicKey);
    const pubKeyHash = hashPubKey(pubKey);
    const address = encodeMisakaAddress(pubKey, 'testnet');

    try {
      const result = await rpcCall(options.rpc, 'getBalance', { pubKeyHash });
      console.log(`Address: ${address}`);
      console.log(`Balance: ${result.balance.toLocaleString()}`);
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
    }
  });

// ---- Send ----
program
  .command('send')
  .description('Send tokens')
  .requiredOption('-t, --to <address>', 'Recipient Misaka address')
  .requiredOption('-a, --amount <number>', 'Amount to send')
  .option('-m, --memo <text>', 'Optional memo (will be encrypted)')
  .option('-k, --key <path>', 'Key file path', './misaka-key.json')
  .option('-r, --rpc <url>', 'RPC URL', 'http://localhost:3001')
  .action(async (options) => {
    try {
      // Validate destination
      const addrType = detectAddressType(options.to);
      if (addrType === 'solana') {
        console.error('❌ ERROR: This looks like a Solana address!');
        console.error('   Misaka addresses start with "misaka1" or "tmisaka1".');
        process.exit(1);
      }
      if (!isValidMisakaAddress(options.to)) {
        console.error('❌ Invalid Misaka address.');
        process.exit(1);
      }

      const amount = parseFloat(options.amount);
      const fee = calculateFee(amount);

      console.log(`Sending ${amount.toLocaleString()} tokens`);
      console.log(`To:  ${options.to}`);
      console.log(`Fee: ${fee} (auto-calculated)`);
      console.log('');

      // Load key
      const keyData = JSON.parse(fs.readFileSync(options.key, 'utf-8'));
      const secretKey = fromHex(keyData.secretKey);
      const pubKey = fromHex(keyData.publicKey);
      const senderPubKeyHash = hashPubKey(pubKey);

      // Get UTXOs
      const utxoResult = await rpcCall(options.rpc, 'getUTXOs', { pubKeyHash: senderPubKeyHash });
      if (!utxoResult.utxos || utxoResult.utxos.length === 0) {
        console.error('❌ No UTXOs available. Balance may be 0.');
        process.exit(1);
      }

      // Decode recipient
      const { pubKey: recipientPubKey } = decodeMisakaAddress(options.to);
      const recipientPubKeyHash = hashPubKey(recipientPubKey);

      // Import transaction module dynamically
      const { createTransaction } = await import('../core/transaction');

      // Select UTXOs
      const totalNeeded = amount + fee;
      const sorted = [...utxoResult.utxos].sort((a: any, b: any) => b.amount - a.amount);
      const selected: any[] = [];
      let total = 0;
      for (const u of sorted) {
        selected.push(u);
        total += u.amount;
        if (total >= totalNeeded) break;
      }

      if (total < totalNeeded) {
        console.error(`❌ Insufficient funds: have ${total}, need ${totalNeeded}`);
        process.exit(1);
      }

      const tx = createTransaction({
        utxos: selected,
        senderSecretKey: secretKey,
        senderPubKey: pubKey,
        recipientPubKeyHash,
        amount,
      });

      // Submit
      const result = await rpcCall(options.rpc, 'sendTransaction', { transaction: tx });
      console.log(`✅ Transaction submitted!`);
      console.log(`   TX ID: ${result.txId}`);
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// ---- Node Start ----
program
  .command('node')
  .description('Node operations')
  .command('start')
  .description('Start a Misaka node')
  .option('-c, --config <path>', 'Config file path')
  .option('-p, --port <number>', 'P2P listen port', '4001')
  .option('--rpc-port <number>', 'RPC port', '3001')
  .option('--chain-id <id>', 'Chain ID', 'misaka-testnet-1')
  .option('-k, --key <path>', 'Validator key file path')
  .option('--peers <peers>', 'Comma-separated peer addresses')
  .option('--validators <validators>', 'Comma-separated validator public keys')
  .option('--data-dir <path>', 'Data directory', './data')
  .option('--block-interval <ms>', 'Block interval in ms', '5000')
  .action(async (options) => {
    let config: NodeConfig;

    if (options.config && fs.existsSync(options.config)) {
      config = JSON.parse(fs.readFileSync(options.config, 'utf-8'));
    } else {
      config = {
        chainId: options.chainId,
        network: 'testnet' as NetworkType,
        listenHost: '0.0.0.0',
        listenPort: parseInt(options.port),
        rpcPort: parseInt(options.rpcPort),
        peers: options.peers ? options.peers.split(',') : [],
        validatorKeyPath: options.key,
        dataDir: options.dataDir,
        pruningWindow: 1000,
        feeTiers: DEFAULT_FEE_TIERS,
        validators: options.validators ? options.validators.split(',') : [],
        blockInterval: parseInt(options.blockInterval),
        checkpointInterval: 100,
      };
    }

    console.log(`🚀 Starting Misaka Node...`);
    console.log(`   Chain ID:  ${config.chainId}`);
    console.log(`   P2P:       ${config.listenHost}:${config.listenPort}`);
    console.log(`   RPC:       http://0.0.0.0:${config.rpcPort}`);

    const node = new MisakaNode(config);

    // Load validator key if provided
    if (config.validatorKeyPath && fs.existsSync(config.validatorKeyPath)) {
      const keyData = JSON.parse(fs.readFileSync(config.validatorKeyPath, 'utf-8'));
      node.setValidatorKey(fromHex(keyData.secretKey), fromHex(keyData.publicKey));
      console.log(`   Validator: ${keyData.publicKey.substring(0, 16)}...`);
    }

    node.on('started', (info) => {
      console.log(`✅ Node started successfully!`);
    });

    node.on('block', (block) => {
      console.log(`📦 Block #${block.header.height} committed (${block.transactions.length} txs) hash=${block.hash.substring(0, 16)}...`);
    });

    node.on('tx', (tx) => {
      console.log(`📨 TX ${tx.id.substring(0, 16)}... added to mempool`);
    });

    node.on('peer:connected', (info) => {
      console.log(`🔗 Peer connected: ${info.nodeId?.substring(0, 8)}...`);
    });

    node.on('consensus:error', (msg) => {
      console.error(`⚠️  Consensus: ${msg}`);
    });

    await node.start();

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down...');
      await node.stop();
      process.exit(0);
    });
  });

// ---- Info ----
program
  .command('info')
  .description('Get chain info from a node')
  .option('-r, --rpc <url>', 'RPC URL', 'http://localhost:3001')
  .action(async (options) => {
    try {
      const result = await rpcCall(options.rpc, 'getInfo', {});
      console.log('Chain Info:');
      console.log(`  Height:     ${result.height}`);
      console.log(`  Latest:     ${result.latestHash.substring(0, 16)}...`);
      console.log(`  UTXO Count: ${result.utxoCount}`);
      console.log(`  State Root: ${result.stateRoot.substring(0, 16)}...`);
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
    }
  });

// ---- RPC Helper ----
function rpcCall(url: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });

    const parsedUrl = new URL(url);
    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch (err) {
          reject(new Error(`Invalid response: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(data);
    req.end();
  });
}

program.parse();
