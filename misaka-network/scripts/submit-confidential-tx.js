// ============================================================
// Misaka Network - Confidential TX Submission Helper
// ============================================================
// Creates a full confidential transaction and submits via RPC.
// Usage: node scripts/submit-confidential-tx.js <RPC_PORT> <ARCHIVE_PUB_KEY>
// ============================================================

const http = require('http');
const { generateStealthKeyPair, createStealthOutput, scanOutputs } = require('../dist/privacy/stealth');
const { ringSign, ringVerify } = require('../dist/privacy/ring');
const { randomScalar, scalarMulBase, scalarToBytes, bytesToScalar } = require('../dist/privacy/curve');
const { pedersenCommit, computeExcess, toBaseUnits } = require('../dist/privacy/pedersen');
const { encryptAuditEnvelope } = require('../dist/privacy/audit');
const { sha256 } = require('../dist/utils/crypto');
const { createHash } = require('crypto');

// ---- RPC helper ----
function rpc(port, method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({
      hostname: 'localhost', port, method: 'POST', path: '/',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Bad JSON: ${body}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Derive the same seeded key that node.ts seedConfidentialPool() creates.
 * This lets us "own" one of the seed UTXOs for testing.
 */
function deriveSeedKey(chainId, index) {
  const { toBaseUnits } = require('../dist/privacy/pedersen');
  const seedHash = sha256(`${chainId}:confidential-seed:${index}`);
  const seedBytes = new Uint8Array(Buffer.from(seedHash, 'hex'));
  const secret = bytesToScalar(seedBytes);
  const pubKey = scalarMulBase(secret).toHex();

  // Derive same amount + blinding as seedConfidentialPool (using toBaseUnits)
  const amountSeed = sha256(`${chainId}:amount-seed:${index}`);
  const blindSeed = sha256(`${chainId}:blind-seed:${index}`);
  const displayAmount = Number(BigInt('0x' + amountSeed.slice(0, 8)) % 100000n + 1000n);
  const blinding = bytesToScalar(new Uint8Array(Buffer.from(blindSeed, 'hex')));
  const amountBase = toBaseUnits(displayAmount);
  const commitment = pedersenCommit(amountBase, blinding);

  return { secret, pubKey, displayAmount, amountBase, blinding, commitment };
}

async function main() {
  const port = parseInt(process.argv[2] || '18001');
  const archivePubKey = process.argv[3];
  const chainId = process.argv[4] || 'misaka-conf-test';

  if (!archivePubKey) {
    console.error('Usage: node submit-confidential-tx.js <RPC_PORT> <ARCHIVE_PUB_KEY> [CHAIN_ID]');
    process.exit(1);
  }

  console.log(`[ConfTx] Connecting to RPC port ${port}...`);

  // 1. Get confidential UTXO pool for decoys
  const confInfo = await rpc(port, 'getConfidentialUTXOs', {});
  const utxos = confInfo.result?.utxos || [];
  console.log(`[ConfTx] Confidential UTXO pool: ${utxos.length} entries`);

  if (utxos.length < 4) {
    console.error('[ConfTx] ERROR: Need at least 4 UTXOs for ring. Pool too small.');
    process.exit(1);
  }

  // 2. Use seed key #0 as "Alice" (sender) — we know its secret
  const aliceKey = deriveSeedKey(chainId, 0);
  console.log(`[ConfTx] Alice (sender) pubKey: ${aliceKey.pubKey.slice(0, 24)}...`);

  // Verify alice's key is in the pool
  const aliceInPool = utxos.find(u => u.oneTimePubKey === aliceKey.pubKey);
  if (!aliceInPool) {
    console.error('[ConfTx] ERROR: Alice key not found in pool. Chain ID mismatch?');
    process.exit(1);
  }

  // 3. Select 3 other pool entries as decoys
  const decoys = utxos
    .map(u => u.oneTimePubKey)
    .filter(pk => pk !== aliceKey.pubKey)
    .slice(0, 3);

  // 4. Build ring (alice + 3 decoys)
  const realIndex = Math.floor(Math.random() * 4);
  const ring = [];
  let di = 0;
  for (let i = 0; i < 4; i++) {
    if (i === realIndex) ring.push(aliceKey.pubKey);
    else ring.push(decoys[di++]);
  }

  // 5. Create stealth keypairs for recipient (Bob)
  const bob = generateStealthKeyPair();
  const bobMeta = { scanPub: bob.scanPub, spendPub: bob.spendPub };
  const alice = generateStealthKeyPair();
  const aliceMeta = { scanPub: alice.scanPub, spendPub: alice.spendPub };

  // 6. Amounts — derived from seed (displayAmount is in display units, same as createStealthOutput expects)
  const inputAmount = aliceKey.amountBase;   // BigInt in base units
  const inputBlinding = aliceKey.blinding;
  const inputCommitment = aliceKey.commitment;
  const displayInput = aliceKey.displayAmount; // number for display

  const fee = 500;
  const sendAmount = Math.floor(displayInput * 0.6);
  const changeAmount = displayInput - sendAmount - fee;

  if (changeAmount < 0) {
    console.error(`[ConfTx] ERROR: Insufficient seed amount: ${displayInput}`);
    process.exit(1);
  }

  console.log(`[ConfTx] Input amount: ${displayInput}, send: ${sendAmount}, fee: ${fee}, change: ${changeAmount}`);

  // 7. Build stealth outputs with Pedersen commitments
  const { output: bobOutput, commitment: bobCommit } = createStealthOutput(bobMeta, sendAmount, 0);
  const { output: changeOutput, commitment: changeCommit } = createStealthOutput(aliceMeta, changeAmount, 1);

  // 9. Pedersen balance
  const outputBlindings = [bobCommit.blinding, changeCommit.blinding];
  const excess = computeExcess([inputBlinding], outputBlindings);

  // 10. Ring signature
  const msgData = JSON.stringify({
    outputs: [bobOutput, changeOutput].map(o => ({
      oneTimePubKey: o.oneTimePubKey,
      encryptedAmount: o.encryptedAmount,
      amountNonce: o.amountNonce,
    })),
    fee,
  });
  const msgHash = createHash('sha256').update(msgData).digest('hex');
  const ringSig = ringSign(msgHash, ring, realIndex, aliceKey.secret);

  // 11. Audit envelope
  const alicePubKeyHash = sha256(aliceKey.pubKey);
  const bobPubKeyHash = sha256(bob.spendPub);

  const auditEnvelope = encryptAuditEnvelope({
    senderPubKey: aliceKey.pubKey,
    senderPubKeyHash: alicePubKeyHash,
    outputs: [
      { recipientPubKeyHash: bobPubKeyHash, amount: sendAmount },
      { recipientPubKeyHash: alicePubKeyHash, amount: changeAmount },
    ],
    inputRefs: [{ txId: aliceInPool.txId, outputIndex: 0, amount: displayInput }],
    fee,
    timestamp: Date.now(),
  }, archivePubKey);

  // 12. Build TX
  const txContent = JSON.stringify({
    version: 1, type: 'confidential',
    ringInputs: [{ ring, c0: ringSig.c0, ss: ringSig.ss, keyImage: ringSig.keyImage, inputCommitment: inputCommitment.point }],
    stealthOutputs: [bobOutput, changeOutput].map(o => ({ oneTimePubKey: o.oneTimePubKey, commitment: o.commitment })),
    keyImages: [ringSig.keyImage],
    fee,
  });
  const txId = createHash('sha256').update(txContent).digest('hex');

  const confidentialTx = {
    id: txId,
    version: 1,
    type: 'confidential',
    ringInputs: [{
      ring,
      ringSignature: { c0: ringSig.c0, ss: ringSig.ss, keyImage: ringSig.keyImage },
      inputCommitment: inputCommitment.point,
    }],
    stealthOutputs: [bobOutput, changeOutput],
    keyImages: [ringSig.keyImage],
    fee,
    excessBlinding: Buffer.from(scalarToBytes(excess)).toString('hex'),
    auditEnvelope,
    timestamp: Date.now(),
  };

  console.log(`[ConfTx] TX created: ${txId.slice(0, 16)}...`);
  console.log(`[ConfTx] Ring: ${ring.length} members (real at index ${realIndex})`);
  console.log(`[ConfTx] Stealth outputs: ${confidentialTx.stealthOutputs.length}`);
  console.log(`[ConfTx] Fee: ${fee}`);

  // 10. Submit via RPC
  try {
    const result = await rpc(port, 'sendConfidentialTransaction', { transaction: confidentialTx });
    if (result.error) {
      console.error(`[ConfTx] Submission error: ${result.error.message || JSON.stringify(result.error)}`);
    } else {
      console.log(`[ConfTx] ✅ Submitted! txId=${result.result.txId?.slice(0, 16)}...`);
    }
  } catch (e) {
    console.error(`[ConfTx] RPC error: ${e.message}`);
  }

  // Output for test verification
  console.log('\n--- AUDIT PLAINTEXT (for verification) ---');
  console.log(JSON.stringify({
    txId,
    senderPubKeyHash: alicePubKeyHash,
    bobPubKeyHash,
    sendAmount,
    changeAmount,
    fee,
  }));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
