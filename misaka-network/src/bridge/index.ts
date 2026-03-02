// ============================================================
// Misaka Network - ZK Bridge Module
// ============================================================
export * from './types';
export { SolanaBridgeProgram, ANCHOR_IDL } from './solana/program';
export {
  evaluateCircuit, computeCircuitChallenge,
  hashProgramId, hashRecipient,
  computeLockEventHash, computeBurnEventHash,
} from './zk/circuit';
export { generateVerificationKey, proveDeposit, proveWithdraw } from './zk/prover';
export { verifyBridgeProof, quickVerify } from './zk/verifier';
export type { VerificationResult, VerificationCheck } from './zk/verifier';
export { MisakaBridgeHandler } from './misaka/handler';
export { BridgeRelayer } from './relayer/service';
export type { RelayerEvent } from './relayer/service';
