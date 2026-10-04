/**
 * In-memory stand-in for the DDC chain as attestHashOnChain and scripts/reattestCommerceOrders.js
 * see it: a provider and a wallet that mine every transaction at once and emit the
 * CommerceAttester Attested(hash, sender) log exactly as the contract would (only when the target
 * has code). No network. Hashes and addresses are generated at run time, never committed.
 */
const { ethers } = require('ethers');
const { ATTESTED_TOPIC, addressTopic, toBytes32 } = require('../../src/utils/commerceAttestChain');

const attestInterface = new ethers.Interface(['function attest(bytes32 hash)']);

const randomHash = () => ethers.hexlify(ethers.randomBytes(32));
const randomAddress = () => ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)));
const contentHash = () => randomHash().slice(2); // stored without 0x, like sha256 hex

function attestedLog({ attester, hash, sender, txHash, index = 0, ...over }) {
  return {
    address: attester,
    topics: [ATTESTED_TOPIC, toBytes32(hash), addressTopic(sender)],
    data: '0x',
    index,
    removed: false,
    transactionHash: txHash,
    ...over,
  };
}

function makeReceipt({ txHash, from, to, status = 1, logs = [] }) {
  return { hash: txHash, from, to, status, logs, blockNumber: 1 };
}

class FakeChain {
  constructor({ attester = randomAddress(), withCode = true } = {}) {
    this.attester = attester;
    this.code = new Map();
    if (withCode) this.code.set(attester.toLowerCase(), '0x6080604052');
    this.receipts = new Map();
    this.pendingTxs = new Map();
    this.nonces = new Map(); // address -> { latest, pending }
    this.sent = [];
    this.calls = [];
    this.failures = {}; // method -> Error to throw
    const self = this;
    const call = (name, fn) => async (...args) => {
      self.calls.push(name);
      if (self.failures[name]) throw self.failures[name];
      return fn(...args);
    };
    this.provider = {
      getBlockNumber: call('getBlockNumber', () => 100),
      getCode: call('getCode', (address) => self.code.get(String(address).toLowerCase()) || '0x'),
      getTransactionReceipt: call('getTransactionReceipt', (hash) => self.receipts.get(String(hash).toLowerCase()) || null),
      send: call('send', (method, params) => {
        if (method === 'eth_getTransactionByHash') return self.pendingTxs.get(String(params[0]).toLowerCase()) || null;
        throw new Error(`FakeChain: unsupported raw method ${method}`);
      }),
      getTransactionCount: call('getTransactionCount', (address, tag) => {
        const n = self.nonces.get(String(address).toLowerCase()) || { latest: 0, pending: 0 };
        return tag === 'pending' ? n.pending : n.latest;
      }),
      getLogs: call('getLogs', (filter) => {
        const out = [];
        for (const receipt of self.receipts.values()) {
          for (const log of receipt.logs) {
            if (filter.address && String(log.address).toLowerCase() !== String(filter.address).toLowerCase()) continue;
            const ok = (filter.topics || []).every((t, i) => t == null || String(log.topics[i]).toLowerCase() === String(t).toLowerCase());
            if (ok) out.push({ ...log });
          }
        }
        return out;
      }),
    };
  }

  /** Stores a receipt as if a transaction had been mined. */
  mine(receipt) {
    this.receipts.set(String(receipt.hash).toLowerCase(), receipt);
    return receipt.hash;
  }

  /** A mined attest(hash) call to `to` from `sender`; emits the log only if `to` has code. */
  mineAttest({ hash, sender, to = this.attester, status = 1 }) {
    const txHash = randomHash();
    const hasCode = this.code.has(String(to).toLowerCase());
    const logs = hasCode && status === 1 ? [attestedLog({ attester: to, hash, sender, txHash })] : [];
    return this.mine(makeReceipt({ txHash, from: sender, to, status, logs }));
  }

  /**
   * A wallet whose sendTransaction mines immediately. `behaviour(tx)` may return
   * { receipt } to override what wait() resolves to, or { waitError } to make wait() reject.
   */
  wallet(address = randomAddress(), behaviour = null) {
    const self = this;
    return {
      address,
      getAddress: async () => address,
      sendTransaction: async (tx) => {
        self.calls.push('sendTransaction');
        if (self.failures.sendTransaction) throw self.failures.sendTransaction;
        const decoded = attestInterface.decodeFunctionData('attest', tx.data);
        const hash = decoded[0];
        self.sent.push({ to: tx.to, hash });
        const custom = behaviour ? behaviour({ ...tx, hash, from: address }) : null;
        let txHash;
        let receipt;
        if (custom && 'receipt' in custom) {
          txHash = custom.txHash || randomHash();
          receipt = custom.receipt;
          if (receipt) self.mine(receipt);
        } else {
          txHash = self.mineAttest({ hash, sender: address, to: tx.to });
          receipt = self.receipts.get(txHash.toLowerCase());
        }
        return {
          hash: txHash,
          wait: async () => {
            if (custom && custom.waitError) throw custom.waitError;
            return receipt;
          },
        };
      },
    };
  }
}

module.exports = {
  FakeChain,
  attestedLog,
  makeReceipt,
  randomHash,
  randomAddress,
  contentHash,
};
