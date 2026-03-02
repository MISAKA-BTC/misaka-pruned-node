// ============================================================
// Misaka Network - Privacy & Testnet Tests
// ============================================================

import {
  initCurve,
  generateStealthKeyPair,
  getStealthMeta,
  createStealthOutput,
  scanStealthOutput,
  scanWithViewKey,
  computeKeyImage,
  ringSign,
  ringVerify,
  InMemoryKeyImageStore,
  selectDecoys,
  createPrivateTransaction,
  validatePrivateTransaction,
} from '../../src/privacy';
import {
  scalarMulBase, hashToScalar, randomScalar, modScalar,
  hashToPoint, scalarMul, pointFromHex,
} from '../../src/privacy/curve';
import {
  bootstrapTestnet,
  createTestnetValidator,
  TestnetFaucet,
} from '../../src/testnet';
import { hashPubKey } from '../../src/utils/crypto';

beforeAll(async () => {
  await initCurve();
}, 15000);

// ============================================================
// 1. Ed25519 Curve Operations
// ============================================================

describe('Ed25519 Curve Ops', () => {
  test('scalar multiplication and point addition', () => {
    const a = randomScalar();
    const b = randomScalar();
    const A = scalarMulBase(a);
    const B = scalarMulBase(b);
    const sum = modScalar(a + b);
    const left = scalarMulBase(sum);
    const right = A.add(B);
    expect(left.equals(right)).toBe(true);
  });

  test('hash to scalar produces valid scalar', () => {
    const s = hashToScalar('test_input');
    expect(s > 0n).toBe(true);
    expect(scalarMulBase(s).equals(scalarMulBase(0n))).toBe(false);
  });

  test('hash to point produces valid point', () => {
    expect(hashToPoint('test_data').equals(scalarMulBase(0n))).toBe(false);
  });
});

// ============================================================
// 2. Stealth Addresses
// ============================================================

describe('Stealth Addresses', () => {
  test('generate stealth keypair', () => {
    const kp = generateStealthKeyPair();
    expect(kp.scanSecret).toHaveLength(64);
    expect(kp.scanPub).toHaveLength(64);
    expect(kp.spendSecret).toHaveLength(64);
    expect(kp.spendPub).toHaveLength(64);
    expect(kp.scanPub).not.toBe(kp.spendPub);
  });

  test('create and scan stealth output — recipient detects', () => {
    const recipient = generateStealthKeyPair();
    const meta = getStealthMeta(recipient);
    const { output } = createStealthOutput(meta, 50000, 0);

    expect(output.oneTimePubKey).toHaveLength(64);
    expect(output.ephemeralPubKey).toHaveLength(64);

    const scanned = scanStealthOutput(
      output, 'tx1', recipient.scanSecret, recipient.spendSecret, recipient.spendPub
    );
    expect(scanned).not.toBeNull();
    expect(scanned!.amount).toBeCloseTo(50000, 5);
    expect(scanned!.keyImage).toHaveLength(64);
  });

  test('non-recipient cannot detect', () => {
    const recipient = generateStealthKeyPair();
    const stranger = generateStealthKeyPair();
    const { output } = createStealthOutput(getStealthMeta(recipient), 12345, 0);

    const scanned = scanStealthOutput(
      output, 'tx2', stranger.scanSecret, stranger.spendSecret, stranger.spendPub
    );
    expect(scanned).toBeNull();
  });

  test('view-only scan — detects output but no spend key', () => {
    const recipient = generateStealthKeyPair();
    const meta = getStealthMeta(recipient);
    const { output } = createStealthOutput(meta, 77777, 0);

    const viewResult = scanWithViewKey(output, 'tx3', recipient.scanSecret, recipient.spendPub);
    expect(viewResult).not.toBeNull();
    expect(viewResult!.amount).toBeCloseTo(77777, 5);
  });

  test('outputs to same recipient have different one-time keys (unlinkable)', () => {
    const recipient = generateStealthKeyPair();
    const meta = getStealthMeta(recipient);
    const { output: o1 } = createStealthOutput(meta, 1000, 0);
    const { output: o2 } = createStealthOutput(meta, 2000, 1);
    const { output: o3 } = createStealthOutput(meta, 3000, 0);
    expect(o1.oneTimePubKey).not.toBe(o2.oneTimePubKey);
    expect(o1.oneTimePubKey).not.toBe(o3.oneTimePubKey);
  });

  test('key image is deterministic for same output', () => {
    const recipient = generateStealthKeyPair();
    const { output } = createStealthOutput(getStealthMeta(recipient), 5000, 0);
    const s1 = scanStealthOutput(output, 'tx', recipient.scanSecret, recipient.spendSecret, recipient.spendPub);
    const s2 = scanStealthOutput(output, 'tx', recipient.scanSecret, recipient.spendSecret, recipient.spendPub);
    expect(s1!.keyImage).toBe(s2!.keyImage);
  });
});

// ============================================================
// 3. Ring Signatures (SAG)
// ============================================================

describe('Ring Signatures', () => {
  test('sign and verify ring size 4', () => {
    const keys = Array.from({ length: 4 }, () => {
      const x = randomScalar();
      return { secret: x, pub: scalarMulBase(x).toHex() };
    });
    const ring = keys.map(k => k.pub);
    const sig = ringSign('msg', ring, 2, keys[2].secret);
    expect(ringVerify('msg', ring, sig)).toBe(true);
  });

  test('reject tampered message', () => {
    const keys = Array.from({ length: 3 }, () => {
      const x = randomScalar(); return { secret: x, pub: scalarMulBase(x).toHex() };
    });
    const ring = keys.map(k => k.pub);
    const sig = ringSign('original', ring, 0, keys[0].secret);
    expect(ringVerify('tampered', ring, sig)).toBe(false);
  });

  test('reject tampered ring member', () => {
    const keys = Array.from({ length: 3 }, () => {
      const x = randomScalar(); return { secret: x, pub: scalarMulBase(x).toHex() };
    });
    const ring = keys.map(k => k.pub);
    const sig = ringSign('msg', ring, 1, keys[1].secret);
    const bad = [...ring]; bad[0] = scalarMulBase(randomScalar()).toHex();
    expect(ringVerify('msg', bad, sig)).toBe(false);
  });

  test('same key → same key image (linkability for double-spend)', () => {
    const x = randomScalar();
    const pub = scalarMulBase(x).toHex();
    const others = Array.from({ length: 2 }, () => scalarMulBase(randomScalar()).toHex());
    const sig1 = ringSign('msg1', [pub, ...others], 0, x);
    const sig2 = ringSign('msg2', [others[0], pub, others[1]], 1, x);
    expect(sig1.keyImage).toBe(sig2.keyImage);
  });

  test('different keys → different key images', () => {
    const x1 = randomScalar(), x2 = randomScalar();
    const filler = scalarMulBase(randomScalar()).toHex();
    const sig1 = ringSign('msg', [scalarMulBase(x1).toHex(), filler], 0, x1);
    const sig2 = ringSign('msg', [scalarMulBase(x2).toHex(), filler], 0, x2);
    expect(sig1.keyImage).not.toBe(sig2.keyImage);
  });

  test('ring size 2 (minimum)', () => {
    const keys = [randomScalar(), randomScalar()].map(x => ({ secret: x, pub: scalarMulBase(x).toHex() }));
    const ring = keys.map(k => k.pub);
    expect(ringVerify('msg', ring, ringSign('msg', ring, 0, keys[0].secret))).toBe(true);
  });

  test('ring size 8', () => {
    const keys = Array.from({ length: 8 }, () => {
      const x = randomScalar(); return { secret: x, pub: scalarMulBase(x).toHex() };
    });
    const ring = keys.map(k => k.pub);
    expect(ringVerify('msg', ring, ringSign('msg', ring, 5, keys[5].secret))).toBe(true);
  });
});

// ============================================================
// 4. Key Image Store & Decoy Selection
// ============================================================

describe('Key Image Store', () => {
  test('track and detect double-spend', () => {
    const store = new InMemoryKeyImageStore();
    expect(store.has('ki1')).toBe(false);
    store.add('ki1', 'tx1');
    expect(store.has('ki1')).toBe(true);
    expect(store.size()).toBe(1);
  });
});

describe('Decoy Selection', () => {
  test('select correct number of decoys', () => {
    const pool = Array.from({ length: 10 }, () => scalarMulBase(randomScalar()).toHex());
    const real = pool[3];
    const { ring, realIndex } = selectDecoys(real, pool, 4);
    expect(ring).toHaveLength(4);
    expect(ring[realIndex]).toBe(real);
    expect(new Set(ring).size).toBe(4);
  });

  test('throw on insufficient decoys', () => {
    const pool = [scalarMulBase(randomScalar()).toHex()];
    expect(() => selectDecoys(scalarMulBase(randomScalar()).toHex(), pool, 4)).toThrow();
  });
});

// ============================================================
// 5. Full Private Transaction Flow
// ============================================================

describe('Private Transaction', () => {
  test('create and validate end-to-end', () => {
    const alice = generateStealthKeyPair();
    const bob = generateStealthKeyPair();
    const aliceMeta = getStealthMeta(alice);
    const bobMeta = getStealthMeta(bob);

    // Alice has a prior UTXO
    const prev = createStealthOutput(aliceMeta, 100_000, 0);
    const aliceUtxo = scanStealthOutput(
      prev.output, 'prev_tx', alice.scanSecret, alice.spendSecret, alice.spendPub
    )!;

    const decoyPool = Array.from({ length: 20 }, () => scalarMulBase(randomScalar()).toHex());
    decoyPool.push(aliceUtxo.oneTimePubKey);

    // Alice → Bob: 50,000
    const tx = createPrivateTransaction({
      inputs: [{ ...aliceUtxo }],
      recipients: [{ meta: bobMeta, amount: 50_000 }],
      senderMeta: aliceMeta,
      decoyPool,
      ringSize: 4,
    });

    expect(tx.type).toBe('private_transfer');
    expect(tx.ringInputs).toHaveLength(1);
    expect(tx.stealthOutputs.length).toBeGreaterThanOrEqual(2);
    expect(tx.fee).toBe(1500); // 3% of 50,000

    // Validate
    const kiStore = new InMemoryKeyImageStore();
    const allPubs = new Set(decoyPool);
    expect(validatePrivateTransaction(tx, kiStore, pk => allPubs.has(pk))).toBeNull();
    for (const ki of tx.keyImages) kiStore.add(ki, tx.id);

    // Bob finds his output
    let bobFound = false;
    for (const out of tx.stealthOutputs) {
      const result = scanStealthOutput(out, tx.id, bob.scanSecret, bob.spendSecret, bob.spendPub);
      if (result) { expect(result.amount).toBeCloseTo(50_000, 5); bobFound = true; }
    }
    expect(bobFound).toBe(true);

    // Alice finds her change
    let aliceChange = false;
    for (const out of tx.stealthOutputs) {
      const result = scanStealthOutput(out, tx.id, alice.scanSecret, alice.spendSecret, alice.spendPub);
      if (result && result.amount < 100_000) {
        expect(result.amount).toBeCloseTo(48500, 5);
        aliceChange = true;
      }
    }
    expect(aliceChange).toBe(true);
  });

  test('double-spend detected via key image', () => {
    const alice = generateStealthKeyPair();
    const bob = generateStealthKeyPair();
    const aliceMeta = getStealthMeta(alice);

    const prev = createStealthOutput(aliceMeta, 100_000, 0);
    const aliceUtxo = scanStealthOutput(
      prev.output, 'prev_tx', alice.scanSecret, alice.spendSecret, alice.spendPub
    )!;

    const decoyPool = Array.from({ length: 10 }, () => scalarMulBase(randomScalar()).toHex());
    decoyPool.push(aliceUtxo.oneTimePubKey);

    const tx1 = createPrivateTransaction({
      inputs: [{ ...aliceUtxo }],
      recipients: [{ meta: getStealthMeta(bob), amount: 50_000 }],
      senderMeta: aliceMeta, decoyPool, ringSize: 3,
    });

    const kiStore = new InMemoryKeyImageStore();
    const allPubs = new Set(decoyPool);
    expect(validatePrivateTransaction(tx1, kiStore, pk => allPubs.has(pk))).toBeNull();
    for (const ki of tx1.keyImages) kiStore.add(ki, tx1.id);

    const tx2 = createPrivateTransaction({
      inputs: [{ ...aliceUtxo }],
      recipients: [{ meta: getStealthMeta(bob), amount: 30_000 }],
      senderMeta: aliceMeta, decoyPool, ringSize: 3,
    });
    expect(validatePrivateTransaction(tx2, kiStore, pk => allPubs.has(pk))).toContain('Double spend');
  });

  test('stranger cannot see amounts or parties', () => {
    const alice = generateStealthKeyPair();
    const bob = generateStealthKeyPair();
    const stranger = generateStealthKeyPair();

    const prev = createStealthOutput(getStealthMeta(alice), 100_000, 0);
    const aliceUtxo = scanStealthOutput(
      prev.output, 'prev_tx', alice.scanSecret, alice.spendSecret, alice.spendPub
    )!;

    const decoyPool = Array.from({ length: 10 }, () => scalarMulBase(randomScalar()).toHex());
    decoyPool.push(aliceUtxo.oneTimePubKey);

    const tx = createPrivateTransaction({
      inputs: [{ ...aliceUtxo }],
      recipients: [{ meta: getStealthMeta(bob), amount: 50_000 }],
      senderMeta: getStealthMeta(alice), decoyPool,
    });

    // Stranger finds nothing
    for (const out of tx.stealthOutputs) {
      expect(scanStealthOutput(out, tx.id, stranger.scanSecret, stranger.spendSecret, stranger.spendPub)).toBeNull();
    }
  });
});

// ============================================================
// 6. Testnet
// ============================================================

describe('Testnet', () => {
  test('create permissionless validator', () => {
    const v = createTestnetValidator('test-v');
    expect(v.keyPair.publicKey).toHaveLength(32);
    expect(v.address.startsWith('tmisaka1')).toBe(true);
    expect(v.pubKeyHex).toHaveLength(64);
    expect(v.name).toBe('test-v');
  });

  test('bootstrap testnet with 4 validators', () => {
    const { validators, faucet, genesisTxs } = bootstrapTestnet({ numValidators: 4 });
    expect(validators).toHaveLength(4);
    // 1 faucet genesis + 4 validator genesis = 5
    expect(genesisTxs).toHaveLength(5);
    expect(faucet.getRemaining()).toBeGreaterThan(0);
    for (const v of validators) {
      expect(v.address.startsWith('tmisaka1')).toBe(true);
    }
  });

  test('faucet distributes tokens', () => {
    const faucet = new TestnetFaucet({ dripAmount: 100_000, cooldownMs: 100, totalSupply: 1_000_000 });
    const result = faucet.drip(hashPubKey(new Uint8Array(32)));
    expect('tx' in result).toBe(true);
    if ('tx' in result) {
      expect(result.amount).toBe(100_000);
    }
  });

  test('faucet enforces cooldown', () => {
    const faucet = new TestnetFaucet({ dripAmount: 100_000, cooldownMs: 60_000, totalSupply: 1_000_000 });
    const addr = 'addr1';
    faucet.drip(addr);
    const result = faucet.drip(addr);
    expect('error' in result).toBe(true);
  });

  test('faucet enforces max supply', () => {
    const faucet = new TestnetFaucet({ dripAmount: 500, cooldownMs: 0, totalSupply: 1000, maxDripsPerAddress: 100 });
    faucet.drip('a1');
    faucet.drip('a2');
    const result = faucet.drip('a3');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('depleted');
  });

  test('faucet stats tracking', () => {
    const faucet = new TestnetFaucet({ dripAmount: 1000, cooldownMs: 0, totalSupply: 100_000, maxDripsPerAddress: 10 });
    faucet.drip('user1');
    faucet.drip('user2');
    faucet.drip('user1');
    const stats = faucet.getStats();
    expect(stats.distributed).toBe(3000);
    expect(stats.uniqueRecipients).toBe(2);
    expect(stats.totalDrips).toBe(3);
    expect(stats.remaining).toBe(97_000);
  });
});

// ============================================================
// Cash-Like Privacy Properties (現金レベルプライバシー)
// ============================================================

describe('Cash-like Privacy Properties (現金レベル)', () => {
  let alice: ReturnType<typeof generateStealthKeyPair>;
  let bob: ReturnType<typeof generateStealthKeyPair>;
  let carol: ReturnType<typeof generateStealthKeyPair>;
  let decoyPool: string[];
  let aliceUTXO: any;

  beforeAll(() => {
    alice = generateStealthKeyPair();
    bob = generateStealthKeyPair();
    carol = generateStealthKeyPair();

    decoyPool = Array.from({ length: 30 }, () =>
      scalarMulBase(randomScalar()).toHex()
    );

    // Alice gets 100k tokens (stealth output)
    const { output, commitment } =
      createStealthOutput(getStealthMeta(alice), 100_000, 0);
    const scanned = scanStealthOutput(
      output, 'gen', alice.scanSecret, alice.spendSecret, alice.spendPub
    )!;
    decoyPool.push(scanned.oneTimePubKey);

    aliceUTXO = {
      txId: 'gen', outputIndex: 0,
      oneTimePubKey: scanned.oneTimePubKey,
      amount: scanned.amount,
      oneTimeSecret: scanned.oneTimeSecret,
      keyImage: scanned.keyImage,
      commitment: commitment.point,
      blinding: commitment.blinding,
    };
  });

  test('PROPERTY: 誰が誰に渡したか記録されない', () => {
    const tx = createPrivateTransaction({
      inputs: [aliceUTXO],
      recipients: [{ meta: getStealthMeta(bob), amount: 50_000 }],
      senderMeta: getStealthMeta(alice),
      decoyPool, ringSize: 4,
    });

    const data = JSON.stringify(tx);
    // Neither Alice's nor Bob's persistent keys appear on-chain
    expect(data).not.toContain(alice.scanPub);
    expect(data).not.toContain(alice.spendPub);
    expect(data).not.toContain(bob.scanPub);
    expect(data).not.toContain(bob.spendPub);
    // Ring hides real sender
    expect(tx.ringInputs[0].ring.length).toBe(4);
  });

  test('PROPERTY: 残高は台帳に存在しない', () => {
    const tx = createPrivateTransaction({
      inputs: [aliceUTXO],
      recipients: [{ meta: getStealthMeta(bob), amount: 50_000 }],
      senderMeta: getStealthMeta(alice),
      decoyPool, ringSize: 4,
    });

    const data = JSON.stringify(tx);
    // Plaintext amount does NOT appear
    expect(data).not.toContain('"50000"');
    expect(data).not.toContain('"49999.5"');
    // Commitment is present instead
    for (const out of tx.stealthOutputs) {
      expect(out.commitment.length).toBe(64);
      expect(out.encryptedAmount).toBeTruthy();
    }
  });

  test('PROPERTY: 当事者だけが知っている', () => {
    const tx = createPrivateTransaction({
      inputs: [aliceUTXO],
      recipients: [{ meta: getStealthMeta(bob), amount: 50_000 }],
      senderMeta: getStealthMeta(alice),
      decoyPool, ringSize: 4,
    });

    // Bob detects and reads amount
    let bobAmount = 0;
    for (const out of tx.stealthOutputs) {
      const s = scanStealthOutput(out, tx.id, bob.scanSecret, bob.spendSecret, bob.spendPub);
      if (s) bobAmount += s.amount;
    }
    expect(bobAmount).toBe(50_000);

    // Carol (unrelated) cannot see anything
    for (const out of tx.stealthOutputs) {
      const s = scanStealthOutput(out, tx.id, carol.scanSecret, carol.spendSecret, carol.spendPub);
      expect(s).toBeNull();
    }
  });

  test('PROPERTY: 追跡しにくい (unlinkable one-time addresses)', () => {
    const meta = getStealthMeta(alice);
    const addrs = [];
    for (let i = 0; i < 10; i++) {
      const { output } = createStealthOutput(meta, 1000, i);
      addrs.push(output.oneTimePubKey);
    }
    // All 10 addresses are different
    expect(new Set(addrs).size).toBe(10);
    // None match Alice's persistent key
    for (const a of addrs) {
      expect(a).not.toBe(alice.spendPub);
    }
  });

  test('PROPERTY: View Key で選択的開示（監査可能）', () => {
    const tx = createPrivateTransaction({
      inputs: [aliceUTXO],
      recipients: [{ meta: getStealthMeta(bob), amount: 40_000 }],
      senderMeta: getStealthMeta(alice),
      decoyPool, ringSize: 4,
    });

    // Auditor with Bob's view key (scanSecret only) can see amount
    let auditorResult: any = null;
    for (const out of tx.stealthOutputs) {
      const r = scanWithViewKey(out, tx.id, bob.scanSecret, bob.spendPub);
      if (r) auditorResult = r;
    }
    expect(auditorResult).not.toBeNull();
    expect(auditorResult.amount).toBe(40_000);
    // But auditor cannot spend (no oneTimeSecret returned)
  });

  test('PROPERTY: Pedersen balance verification without knowing amounts', () => {
    const { pedersenCommit: pc, toBaseUnits: tu, computeExcess: ce,
            verifyCommitmentBalance: vcb } = require('../../src/privacy/pedersen');
    const inC = pc(tu(8000));
    const outC = pc(tu(7999.5));
    const feeB = tu(0.5);
    const ex = ce([inC.blinding], [outC.blinding]);
    expect(vcb([inC.point], [outC.point], feeB, ex)).toBe(true);
    // Wrong amounts fail
    const badC = pc(tu(9000));
    const ex2 = ce([inC.blinding], [badC.blinding]);
    expect(vcb([inC.point], [badC.point], feeB, ex2)).toBe(false);
  });
});
