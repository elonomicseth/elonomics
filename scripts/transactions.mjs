import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createPublicClient, http, getAddress, zeroAddress, encodeFunctionData,
  encodeAbiParameters, parseAbi, parseAbiParameters, keccak256,
} from 'viem';
import { mainnet } from 'viem/chains';
import { ADDRESSES as A } from './constants.mjs';
import { units18 } from './launch.mjs';

export const ABI = parseAbi([
  'function poolManager() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function initializer() view returns (address)',
  'function dividendRecipient() view returns (address)',
  'function devRecipient() view returns (address)',
  'function platformRecipient() view returns (address)',
  'function rewardToken() view returns (address)',
  'function rewardDistributor() view returns (address)',
  'function reward() view returns (address)',
  'function graphFactory() view returns (address)',
  'function positionManager() view returns (address)',
  'function launched() view returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function claimDividends() returns (uint256)',
  'function claimPlatform() returns (uint256)',
  'function claimDev() returns (uint256)',
  'function claim() returns (uint256)',
  'function prepareOracle()',
  'function minimumOutput(uint256) view returns (uint256)',
  'function convert(uint256) returns (uint256)',
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
  'function getLiquidity(bytes32) view returns (uint128)',
]);
const PERMIT_ABI = parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)']);
const POOL_TUPLE = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const SWAP_PARAMETERS = parseAbiParameters(`(${POOL_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`);
export const ACTION_PARAMETERS = parseAbiParameters('bytes actions,bytes[] params');
const MAX_AMOUNT = (1n << 127n) - 1n;
export const COMMANDS = ['claim-dividends', 'claim-platform', 'claim-dev', 'claim-rewards',
  'prepare-oracle', 'convert', 'buy', 'sell'];

function address(value, label) {
  assert(typeof value === 'string', `${label}: address required`);
  const result = getAddress(value);
  assert(result !== zeroAddress, `${label}: zero address`);
  return result;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function amount(value, label) {
  const result = units18(value, label);
  assert(result <= MAX_AMOUNT, `${label}: exceeds signed v4 delta limit`);
  return result;
}

export function poolKey(deployment) {
  const token = address(deployment.token, 'token');
  const quote = getAddress(A.quote);
  assert(!same(token, quote), 'Token and quote must differ');
  const tokenFirst = BigInt(token) < BigInt(quote);
  return { currency0: tokenFirst ? token : quote, currency1: tokenFirst ? quote : token,
    fee: 0, tickSpacing: 60, hooks: address(deployment.hook, 'hook') };
}

export async function buildTransactions({ command, deployment, config, from, inputAmount, minimumOutput,
  deadline, client, now = Math.floor(Date.now() / 1000) }) {
  assert(COMMANDS.includes(command), `Unknown command: ${command}`);
  assert(deployment.chainId === 1 && config.chainId === 1, 'Deployment/config must use chain ID 1');
  from = address(from, 'from');
  const roles = ['token', 'hook', 'processor', 'launcher'];
  const d = Object.fromEntries(roles.map(role => [role, address(deployment[role], role)]));
  assert(new Set(Object.values(d).map(a => a.toLowerCase())).size === 4, 'Deployment roles must be distinct');
  const dev = address(config.devRecipient, 'devRecipient');
  assert.equal(await client.getChainId(), 1, 'RPC is not Ethereum Mainnet');
  const block = await client.getBlock();
  const blockNumber = block.number;
  assert(blockNumber !== null && blockNumber !== undefined, 'RPC returned no block number');
  assert(Math.abs(now - Number(block.timestamp)) <= 300, 'RPC head is stale or system clock is wrong');
  const read = (target, functionName, args = []) => client.readContract({ address: target, abi: ABI, functionName, args, blockNumber });
  const code = target => client.getBytecode({ address: target, blockNumber });

  await Promise.all(roles.map(async role => {
    const expected = deployment.runtimeCodeHashes?.[role];
    assert(/^0x[0-9a-fA-F]{64}$/.test(expected ?? ''), `runtimeCodeHashes.${role} required from the verified launch`);
    const runtime = await code(d[role]);
    assert(runtime && runtime !== '0x', `${role}: no deployed code`);
    assert.equal(keccak256(runtime).toLowerCase(), expected.toLowerCase(), `${role}: runtime code hash mismatch`);
  }));
  const bindings = [
    [d.token, 'rewardToken', A.reward], [d.token, 'poolManager', A.poolManager],
    [d.hook, 'token', d.token], [d.hook, 'quote', A.quote], [d.hook, 'initializer', d.launcher],
    [d.hook, 'poolManager', A.poolManager], [d.hook, 'dividendRecipient', d.processor],
    [d.hook, 'devRecipient', dev], [d.hook, 'platformRecipient', A.platformRecipient],
    [d.processor, 'rewardDistributor', d.token], [d.processor, 'quote', A.quote],
    [d.processor, 'reward', A.reward], [d.launcher, 'poolManager', A.poolManager],
    [d.launcher, 'positionManager', A.positionManager], [d.launcher, 'quote', A.quote],
    [d.launcher, 'graphFactory', A.graphFactory],
  ];
  await Promise.all(bindings.map(async ([target, name, expected]) => {
    assert(same(await read(target, name), expected), `Deployment binding ${name} differs`);
  }));
  assert.equal(await read(d.launcher, 'launched'), true, 'Launch has not completed');
  assert.equal(await read(d.token, 'decimals'), 18, 'ELON decimals differ');
  assert.equal(await read(A.quote, 'decimals'), 18, 'TSLA decimals differ');

  const transactions = [];
  function add(label, to, functionName, args = [], abi = ABI) {
    transactions.push({ label, chainId: 1, from, to: getAddress(to), value: '0',
      data: encodeFunctionData({ abi, functionName, args }) });
  }
  const result = { command, chainId: 1, unsigned: true, broadcast: false,
    snapshot: { blockNumber: blockNumber.toString(), blockHash: block.hash, timestamp: Number(block.timestamp) },
    transactions, checks: 'Runtime hashes and immutable bindings checked against supplied deployment record.' };
  const simple = {
    'claim-dividends': [d.hook, 'claimDividends'], 'claim-platform': [d.hook, 'claimPlatform'],
    'claim-dev': [d.hook, 'claimDev'], 'claim-rewards': [d.token, 'claim'],
    'prepare-oracle': [d.processor, 'prepareOracle'],
  }[command];
  if (simple) {
    await client.simulateContract({ address: simple[0], abi: ABI, functionName: simple[1], account: from, blockNumber });
    add(command, ...simple);
    result.simulation = 'eth_call succeeded at the recorded block; wallet must refresh before sending';
    return result;
  }
  if (command === 'convert') {
    const input = amount(inputAmount, 'amount');
    assert(await read(A.quote, 'balanceOf', [d.processor]) >= input, 'Processor TSLA balance is insufficient; claim dividends first');
    const minimum = await read(d.processor, 'minimumOutput', [input]);
    assert(minimum > 0n, 'Oracle minimum output is zero');
    await client.simulateContract({ address: d.processor, abi: ABI, functionName: 'convert', args: [input], account: from, blockNumber });
    add(command, d.processor, 'convert', [input]);
    result.amountInBaseUnits = input.toString();
    result.oracleMinimumSpcxBaseUnits = minimum.toString();
    result.simulation = 'eth_call succeeded; contract recalculates its TWAP bound during execution';
    return result;
  }

  assert(typeof deadline === 'string' && /^[1-9][0-9]*$/.test(deadline), 'Explicit UNIX deadline required');
  const expiry = BigInt(deadline);
  assert(expiry > BigInt(now) && expiry > block.timestamp && expiry <= BigInt(now + 3600), 'Deadline must be in the next hour');
  const key = poolKey(d);
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters(POOL_TUPLE), [key]));
  const spender = A.universalRouter;
  for (const target of [A.stateView, spender, A.permit2]) {
    const runtime = await code(target);
    assert(runtime && runtime !== '0x', 'Canonical Uniswap dependency has no code');
  }
  assert(same(await read(A.stateView, 'poolManager'), A.poolManager), 'StateView PoolManager differs');
  assert(same(await read(spender, 'poolManager'), A.poolManager), 'Uniswap spender PoolManager differs');
  const [price, tick, protocolFee, lpFee] = await read(A.stateView, 'getSlot0', [poolId]);
  assert(price > 0n, 'Pool is uninitialized');
  assert(protocolFee === 0 && lpFee === 0, 'Unexpected LP/protocol fee; total trading fee would exceed 2%');
  result.pool = { poolId, key, sqrtPriceX96: price.toString(), tick };
  result.deadline = deadline;
  result.simulation = 'Pool state and bounded calldata checked; simulate final transaction in wallet after approvals';

  async function approve(asset, value) {
    assert(await read(asset, 'balanceOf', [from]) >= value, 'Wallet balance is below the requested amount');
    const existing = await read(asset, 'allowance', [from, A.permit2]);
    if (existing !== value) {
      if (existing !== 0n) add('Reset bounded ERC20 allowance', asset, 'approve', [A.permit2, 0n]);
      add('Approve exact ERC20 amount to Permit2', asset, 'approve', [A.permit2, value]);
    }
    add('Approve exact Permit2 amount until deadline', A.permit2, 'approve', [asset, spender, value, Number(expiry)], PERMIT_ABI);
  }
  assert(await read(A.stateView, 'getLiquidity', [poolId]) > 0n, 'Pool has no active liquidity');
  const input = amount(inputAmount, 'amount');
  const minimum = amount(minimumOutput, 'min-out after all hook fees');
  const assetIn = command === 'buy' ? A.quote : d.token;
  const assetOut = command === 'buy' ? d.token : A.quote;
  await approve(assetIn, input);
  const params = [
    encodeAbiParameters(SWAP_PARAMETERS, [{ poolKey: key, zeroForOne: same(assetIn, key.currency0),
      amountIn: input, amountOutMinimum: minimum, hookData: '0x' }]),
    encodeAbiParameters(parseAbiParameters('address,uint256'), [assetIn, input]),
    encodeAbiParameters(parseAbiParameters('address,uint256'), [assetOut, minimum]),
  ];
  // UniversalRouter V4_SWAP: exact input, settle the gross debt, take the net output.
  add(`Exact-input ${command}`, A.universalRouter, 'execute',
    ['0x10', [encodeAbiParameters(ACTION_PARAMETERS, ['0x060c0f', params])], expiry]);
  result.swap = { assetIn, assetOut, grossAmountInBaseUnits: input.toString(), minimumNetAmountOutBaseUnits: minimum.toString(),
    fee: '2% in TSLA: 1% dividends, 0.3% platform, 0.7% developer; no LP fee',
    constraint: 'Exact input only; quote-input partial fills revert' };
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    deployment: { type: 'string' }, config: { type: 'string', default: 'launch.config.json' },
    from: { type: 'string' }, amount: { type: 'string' }, 'min-out': { type: 'string' },
    deadline: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`node scripts/transactions.mjs <${COMMANDS.join('|')}> --deployment deployment.json --from 0x...\n`
      + 'Requires MAINNET_RPC_URL. Buy/sell: --amount <decimal> --min-out <decimal> --deadline <unix>.\n'
      + 'Convert: --amount <TSLA decimal>.\n'
      + 'Outputs unsigned transactions only. No private keys, signatures, or broadcast.');
    return;
  }
  assert(positionals.length === 1 && values.deployment, 'One command and --deployment are required; see --help');
  assert(process.env.MAINNET_RPC_URL, 'MAINNET_RPC_URL required for deployment and pool readback');
  const [deployment, config] = await Promise.all([values.deployment, values.config].map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const result = await buildTransactions({ command: positionals[0], deployment, config, from: values.from,
    inputAmount: values.amount, minimumOutput: values['min-out'], deadline: values.deadline,
    client: createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL) }) });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.code === 'ERR_ASSERTION' || error.name === 'Error'
      ? error.message.split('\n')[0] : 'RPC or encoding failed; check input and private RPC locally.');
    process.exitCode = 1;
  });
}
