import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeAbiParameters, parseAbi, parseAbiParameters, keccak256 } from 'viem';
import { buildTransactions, COMMANDS } from '../scripts/transactions.mjs';
import { ADDRESSES as A } from '../scripts/constants.mjs';

const from = '0x0000000000000000000000000000000000000a11';
const dev = '0x0000000000000000000000000000000000000d33';
const runtime = '0x60006000f3';
const now = 2_000_000_000;
const abi = parseAbi([
  'function execute(bytes commands,bytes[] inputs,uint256 deadline)',
  'function approve(address spender,uint256 amount)',
  'function claimDividends() returns (uint256)',
  'function claimPlatform() returns (uint256)',
  'function claimDev() returns (uint256)',
  'function claim() returns (uint256)',
  'function prepareOracle()',
  'function convert(uint256) returns (uint256)',
]);
const permitAbi = parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)']);
const lower = value => value.toLowerCase();

function fixture(changes = {}) {
  const deployment = { chainId: 1,
    token: '0x1000000000000000000000000000000000000000',
    hook: '0x20000000000000000000000000000000000020cc',
    processor: '0x3000000000000000000000000000000000000000',
    launcher: '0x4000000000000000000000000000000000000000',
    runtimeCodeHashes: Object.fromEntries(['token', 'hook', 'processor', 'launcher'].map(x => [x, keccak256(runtime)])),
    ...changes.deployment,
  };
  const simulations = [];
  const client = {
    async getChainId() { return changes.chainId ?? 1; },
    async getBlock() { return { number: 123n, timestamp: BigInt(now), hash: '0x' + '11'.repeat(32) }; },
    async getBytecode() { return changes.runtime ?? runtime; },
    async simulateContract(request) { simulations.push(request); return { result: 1n }; },
    async readContract({ address, functionName, args, blockNumber }) {
      assert.equal(blockNumber, 123n, 'Read must use the consistent snapshot');
      const overridden = changes.read?.({ address, functionName, args });
      if (overridden !== undefined) return overridden;
      const addresses = { poolManager: A.poolManager, token: deployment.token, quote: A.quote,
        initializer: deployment.launcher, dividendRecipient: deployment.processor, devRecipient: dev,
        platformRecipient: A.platformRecipient, rewardToken: A.reward, rewardDistributor: deployment.token,
        reward: A.reward, graphFactory: A.graphFactory, positionManager: A.positionManager };
      if (functionName in addresses) return addresses[functionName];
      if (functionName === 'launched') return true;
      if (functionName === 'decimals') return 18;
      if (functionName === 'balanceOf') return 1n << 126n;
      if (functionName === 'allowance') return 0n;
      if (functionName === 'getSlot0') return [1n << 96n, 0, 0, 0];
      if (functionName === 'getLiquidity') return 10n ** 24n;
      if (functionName === 'minimumOutput') return 123n;
      throw Error(`Unexpected read ${functionName}`);
    },
  };
  return { deployment, client, simulations, from, now, deadline: String(now + 600),
    config: { chainId: 1, devRecipient: dev, ...changes.config } };
}

test('the liquidity builder is gone: liquidity is seeded and burned inside the launch transaction', () => {
  assert.equal(COMMANDS.includes('liquidity'), false);
});

test('buy/sell use gross exact input, fee-inclusive minimum, empty hook data, and bounded Permit2', async () => {
  for (const token of ['0x1000000000000000000000000000000000000000', '0xff00000000000000000000000000000000000000']) {
    for (const command of ['buy', 'sell']) {
      const options = fixture({ deployment: { token } });
      const result = await buildTransactions({ ...options, command, inputAmount: '10', minimumOutput: '1' });
      assert.equal(result.transactions.length, 3);
      const first = decodeFunctionData({ abi, data: result.transactions[0].data });
      assert.equal(first.functionName, 'approve');
      assert.equal(lower(first.args[0]), lower(A.permit2));
      assert.equal(first.args[1], 10n * 10n ** 18n);
      const permit = decodeFunctionData({ abi: permitAbi, data: result.transactions[1].data });
      assert.equal(lower(permit.args[1]), lower(A.universalRouter));
      assert.equal(permit.args[2], first.args[1]);
      assert.equal(permit.args[3], now + 600);

      const tx = result.transactions.at(-1);
      assert.equal(lower(tx.to), lower(A.universalRouter));
      assert.equal(tx.from, result.transactions[0].from);
      assert.equal(tx.value, '0');
      const call = decodeFunctionData({ abi, data: tx.data });
      assert.equal(call.args[0], '0x10');
      assert.equal(call.args[2], BigInt(now + 600));
      const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), call.args[1][0]);
      assert.equal(actions, '0x060c0f');
      const [swap] = decodeAbiParameters(parseAbiParameters('((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'), params[0]);
      const input = command === 'buy' ? A.quote : token;
      const output = command === 'buy' ? token : A.quote;
      assert.equal(swap[1], lower(swap[0][0]) === lower(input));
      assert.equal(swap[2], 10n * 10n ** 18n);
      assert.equal(swap[3], 10n ** 18n);
      assert.equal(swap[4], '0x');
      assert.equal(swap[0][2], 0);
      assert.equal(swap[0][3], 60);
      const settle = decodeAbiParameters(parseAbiParameters('address,uint256'), params[1]);
      const take = decodeAbiParameters(parseAbiParameters('address,uint256'), params[2]);
      assert.equal(lower(settle[0]), lower(input));
      assert.equal(settle[1], swap[2]);
      assert.equal(lower(take[0]), lower(output));
      assert.equal(take[1], swap[3]);
    }
  }
});

test('nonzero previous allowance resets to zero before granting the exact budget', async () => {
  const options = fixture({ read: ({ functionName }) => functionName === 'allowance' ? (1n << 256n) - 1n : undefined });
  const result = await buildTransactions({ ...options, command: 'buy', inputAmount: '10', minimumOutput: '1' });
  const first = decodeFunctionData({ abi, data: result.transactions[0].data });
  assert.equal(first.args[1], 0n);
  const second = decodeFunctionData({ abi, data: result.transactions[1].data });
  assert.equal(second.args[1], 10n * 10n ** 18n);
});

test('reward and fee calls simulate and route only to their bound contracts', async () => {
  const names = { 'claim-dividends': ['hook', 'claimDividends'], 'claim-platform': ['hook', 'claimPlatform'],
    'claim-dev': ['hook', 'claimDev'], 'claim-rewards': ['token', 'claim'], 'prepare-oracle': ['processor', 'prepareOracle'],
    convert: ['processor', 'convert'] };
  for (const [command, [role, method]] of Object.entries(names)) {
    const options = fixture();
    const result = await buildTransactions({ ...options, command, inputAmount: '2' });
    assert.equal(result.transactions.length, 1);
    assert.equal(options.simulations.length, 1);
    assert.equal(options.simulations[0].functionName, method);
    assert.equal(lower(result.transactions[0].to), lower(options.deployment[role]));
    assert.equal(decodeFunctionData({ abi, data: result.transactions[0].data }).functionName, method);
    if (command === 'convert') assert.equal(result.oracleMinimumSpcxBaseUnits, '123');
  }
});

test('unsafe bounds, stale/unlaunched state, changed code, wrong bindings, and insufficient balances fail closed', async () => {
  const base = { command: 'buy', inputAmount: '10', minimumOutput: '1' };
  for (const change of [{ minimumOutput: '0' }, { minimumOutput: undefined }, { inputAmount: '0' },
    { inputAmount: '1e18' }, { inputAmount: '0.0000000000000000001' }, { deadline: String(now - 1) },
    { deadline: String(now + 3601) }, { from: '0x0000000000000000000000000000000000000000' }]) {
    await assert.rejects(buildTransactions({ ...fixture(), ...base, ...change }));
  }
  for (const change of [
    { chainId: 5 }, { runtime: '0x6000' },
    { read: ({ functionName }) => functionName === 'poolManager' ? dev : undefined },
    { read: ({ functionName }) => functionName === 'launched' ? false : undefined },
    { read: ({ functionName }) => functionName === 'positionManager' ? dev : undefined },
    { read: ({ functionName }) => functionName === 'getSlot0' ? [0n, 0, 0, 0] : undefined },
    { read: ({ functionName }) => functionName === 'getSlot0' ? [1n << 96n, 0, 0, 3000] : undefined },
    { read: ({ functionName }) => functionName === 'getLiquidity' ? 0n : undefined },
    { read: ({ functionName }) => functionName === 'balanceOf' ? 0n : undefined },
  ]) await assert.rejects(buildTransactions({ ...fixture(change), ...base }));
  const stale = fixture();
  stale.client.getBlock = async () => ({ number: 123n, timestamp: BigInt(now - 301) });
  await assert.rejects(buildTransactions({ ...stale, ...base }));
  await assert.rejects(buildTransactions({ ...fixture({ deployment: { runtimeCodeHashes: {} } }), ...base }));
});
