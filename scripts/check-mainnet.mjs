import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeFunctionResult, encodeFunctionData, encodePacked, formatUnits, keccak256, parseAbi, parseEther } from 'viem';
import { ADDRESSES as A, PROGRAMMABLE, ZAP_PATH } from './constants.mjs';
import { validateCapabilities, validateReadiness } from './programmable.mjs';

const routescan = 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api';
const manifestUrl = 'https://developers.programmable.family/api/v2/manifest';
const apiBase = 'https://api.programmable.market';
const genesisHash = '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3';
const hashes = {
  programmableRouter: '0x40e27ecf201761d5eb66bc4f2d5c6124831ef078d7baf458ca5f41b1a8108546',
  graphFactory: '0xd23692fae59331592048e71a96d4963e170ee56e449683dc9f7fa3f9470018b8',
  poolManager: '0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293',
};
const abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function factory() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function getPool(address,address,uint24) view returns (address)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function observe(uint32[]) view returns (int56[],uint160[])',
  'function CHAIN_ID() view returns (uint256)',
  'function GRAPH_FACTORY() view returns (address)',
  'function POOL_MANAGER() view returns (address)',
  'function quoteExactInput(bytes,uint256) returns (uint256)',
]);
const equalAddress = (a, b) => a.toLowerCase() === b.toLowerCase();

// [report key, expected pool fields, whether ElonomicsFeeProcessor reads its TWAP]
const POOLS = [
  ['quotePool', { token0: A.usdc, token1: A.quote, fee: 10000 }, true],
  ['rewardPool', { token0: A.usdc, token1: A.reward, fee: 10000 }, true],
  ['zapWethUsdcPool', { token0: A.usdc, token1: A.weth, fee: 500 }, false],
  ['zapUsdcQuotePool', { token0: A.usdc, token1: A.quote, fee: 10000 }, false],
];

function validatePool(pool, { token0, token1, fee }) {
  assert(equalAddress(pool.token0, token0), 'Pool token0 differs from the expected value.');
  assert(equalAddress(pool.token1, token1), 'Pool token1 differs from the expected value.');
  assert(equalAddress(pool.factory, A.v3Factory), 'Pool factory is not the canonical Uniswap v3 factory.');
  assert.equal(pool.fee, fee, `Pool fee must be ${fee}.`);
  assert(pool.liquidity > 0n, 'Pool has no active liquidity.');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Object.assign(new Error('HTTP request failed'), { status: response.status });
  return response.json();
}

let useConfiguredRpc = Boolean(process.env.MAINNET_RPC_URL);

async function rpc(method, params = []) {
  assert(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method), 'Only read-only RPC methods are allowed.');
  let body;
  if (useConfiguredRpc) {
    body = await fetchJson(process.env.MAINNET_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } else {
    const query = { module: 'proxy', action: method };
    if (method === 'eth_call') Object.assign(query, { to: params[0].to, data: params[0].data, tag: 'latest' });
    else if (method === 'eth_getCode') Object.assign(query, { address: params[0], tag: 'latest' });
    else if (method === 'eth_getBlockByNumber') Object.assign(query, { tag: params[0], boolean: 'false' });
    else throw new Error('Routescan does not provide eth_chainId.');
    body = await fetchJson(`${routescan}?${new URLSearchParams(query)}`);
  }
  if (body.error || body.status === '0' || body.result == null) throw new Error('RPC returned no valid result.');
  return body.result;
}

async function read(address, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  return decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to: address, data }, 'latest']) });
}

if (process.argv.includes('--self-test')) {
  const valid = { token0: A.usdc, token1: A.quote, factory: A.v3Factory, fee: 10000, liquidity: 1n };
  validatePool(valid, POOLS[0][1]);
  validatePool({ ...valid, token1: A.weth, fee: 500 }, POOLS[2][1]);
  validatePool(valid, POOLS[3][1]);
  for (const changed of [{ token1: A.reward }, { factory: A.swapRouter }, { fee: 3000 }, { liquidity: 0n }]) {
    assert.throws(() => validatePool({ ...valid, ...changed }, POOLS[0][1]));
  }
  const capabilities = {
    chain: { id: '1' }, compiler: { exactBuild: '0.8.26+commit.8a97fa7a' }, onsiteTrading: { status: 'disabled' },
    profile: { profileId: 'programmable.direct-native-hook-graph.v1', profileRevision: 3, profileVersion: '3.6.0',
      productionLaunchAuthorized: true },
    requestProfiles: { freshSubmissionExactVersions: ['3.6.0'] },
    feePolicy: { programmableHundredthsOfBip: '3000', denominator: '1000000', requiredForProfileVersion: '3.6.0' },
    profile36Release: { selected: true, staticAdmissionBaseline: '3.3.0', customHookAllowlistRequired: false,
      mandatoryCanonicalFeeVaultTarget: false },
    graph: { minimumTargets: 3, maximumTargets: 16 },
    fundingModes: ['none', 'wallet-transaction-value'], liquidityModels: ['launch-seeded-concentrated-liquidity'],
    programmableTradeFeePolicy: { policyHash: PROGRAMMABLE.tradeFeePolicyHash },
  };
  validateCapabilities(capabilities);
  for (const change of [c => { c.profile.profileVersion = '3.3.0'; }, c => { c.feePolicy.programmableHundredthsOfBip = '1000'; },
    c => { c.requestProfiles.freshSubmissionExactVersions = ['3.7.0']; }, c => { c.profile36Release.customHookAllowlistRequired = true; }]) {
    const changed = structuredClone(capabilities);
    change(changed);
    assert.throws(() => validateCapabilities(changed));
  }
  const readyz = { status: 'ready', publicProfile: { currentWriteProfileVersion: '3.6.0' },
    programmableTradeFeePolicy: { policyHash: PROGRAMMABLE.tradeFeePolicyHash } };
  validateReadiness(readyz);
  assert.throws(() => validateReadiness({ ...readyz, publicProfile: { currentWriteProfileVersion: '3.3.0' } }));
  await assert.rejects(() => rpc('eth_sendRawTransaction', ['0x']));
  console.log('PASS: pool bindings, fee, liquidity, zap route, capabilities 3.6.0, and read-only RPC.');
} else {
  const config = JSON.parse(await readFile(new URL('../launch.config.json', import.meta.url), 'utf8'));
  const window = config.oracleWindowSeconds;
  assert(Number.isInteger(window) && window > 0 && window <= 0xffffffff, 'oracleWindowSeconds is invalid.');
  const report = { checkedAt: new Date().toISOString(), chainId: 1, readOnly: true, checks: {} };
  async function check(label, run) {
    try {
      const result = await run();
      report.checks[label] = { status: 'pass', ...result };
      return result;
    } catch (error) {
      report.checks[label] = error.code === 'ERR_ASSERTION'
        ? { status: 'fail', reason: error.message.split('\n')[0] }
        : { status: 'unavailable', reason: error.status ? `HTTP ${error.status}` : 'Read failed; RPC URL and credential details are hidden.' };
      if (label.endsWith('.oracle')) Object.assign(report.checks[label], { ready: false, windowSeconds: window });
      return null;
    }
  }

  let configuredChainId;
  if (useConfiguredRpc) {
    try { configuredChainId = await rpc('eth_chainId'); }
    catch { useConfiguredRpc = false; report.rpcFallback = 'MAINNET_RPC_URL could not be read; using public Routescan.'; }
  }
  report.provider = useConfiguredRpc ? 'MAINNET_RPC_URL' : 'Routescan Ethereum GET';
  report.blockConsistency = 'Separate reads at latest; not a single-block snapshot.';
  const chain = await check('chain', async () => {
    if (configuredChainId) assert.equal(BigInt(configuredChainId), 1n, 'MAINNET_RPC_URL is not chain ID 1.');
    const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
    assert.equal(genesis.hash.toLowerCase(), genesisHash, 'Genesis is not Ethereum Mainnet.');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    return { blockNumber: BigInt(block.number), blockHash: block.hash, timestamp: Number(BigInt(block.timestamp)), chainIdMethod: configuredChainId ? 'eth_chainId + genesis' : 'genesis + Ethereum namespace; Routescan does not provide eth_chainId' };
  });

  if (chain) {
    const blockAgeSeconds = Math.floor(Date.now() / 1000) - chain.timestamp;
    report.checks.chainFreshness = {
      status: blockAgeSeconds >= -60 && blockAgeSeconds <= 300 ? 'pass' : 'unavailable',
      blockAgeSeconds,
      maximumAgeSeconds: 300,
      ...(blockAgeSeconds >= -60 && blockAgeSeconds <= 300 ? {} : { reason: 'Latest header is too old or the clock does not match; an RPC that returns current data is required.' }),
    };
    for (const [key, symbol, decimals, expectedName] of [
      ['quote', 'TSLAon', 18, /^Tesla \(Ondo Tokenized(?: Stock)?\)$/],
      ['reward', 'SPCXon', 18, /^SpaceX \(Ondo Tokenized(?: Stock)?\)$/],
      ['usdc', 'USDC', 6, /^USD Coin$/],
    ]) {
      await check(`asset.${symbol}`, async () => {
        const code = await rpc('eth_getCode', [A[key], 'latest']);
        assert(code !== '0x', 'Asset address has no contract code.');
        const name = await read(A[key], 'name');
        const actualSymbol = await read(A[key], 'symbol');
        const actualDecimals = await read(A[key], 'decimals');
        assert(expectedName.test(name), 'Asset name differs from the checked issuer metadata.');
        assert.equal(actualSymbol, symbol, 'Asset symbol does not match.');
        assert.equal(actualDecimals, decimals, 'Asset decimals do not match.');
        return { address: A[key], name, symbol: actualSymbol, decimals: actualDecimals, runtimeCodeHash: keccak256(code) };
      });
    }

    for (const [key, expected, oracle] of POOLS) {
      const pool = await check(key, async () => {
        const values = {};
        for (const fn of ['token0', 'token1', 'fee', 'factory', 'liquidity']) values[fn] = await read(A[key], fn);
        validatePool(values, expected);
        assert(equalAddress(await read(A.v3Factory, 'getPool', [expected.token0, expected.token1, expected.fee]), A[key]), 'Factory getPool does not match.');
        const slot = await read(A[key], 'slot0');
        return { address: A[key], ...values, tick: slot[1], observationCardinality: slot[3], observationCardinalityNext: slot[4], unlocked: slot[6] };
      });
      if (pool && oracle) await check(`${key}.oracle`, async () => {
        const [ticks] = await read(A[key], 'observe', [[window, 0]]);
        const delta = ticks[1] - ticks[0];
        const divisor = BigInt(window);
        const arithmeticMeanTick = delta / divisor - (delta < 0n && delta % divisor !== 0n ? 1n : 0n);
        return { windowSeconds: window, arithmeticMeanTick, ready: true, ...(pool.observationCardinality === 1 ? { warning: 'Only one observation; the next swap can erase the history of this window. Increase capacity and wait for history to fill.' } : {}) };
      });
    }

    await check('swapRouter', async () => {
      assert(equalAddress(await read(A.swapRouter, 'factory'), A.v3Factory), 'SwapRouter factory does not match.');
      return { address: A.swapRouter, factory: A.v3Factory, interface: 'ISwapRouter exactInput with deadline' };
    });
    await check('conversionQuote', async () => {
      const path = encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [A.quote, 10000, A.usdc, 10000, A.reward]);
      const amountOut = await read(A.quoter, 'quoteExactInput', [path, 10n ** 18n]);
      assert(amountOut > 0n, 'Conversion quote is zero.');
      return { input: '1 TSLAon', output: `${formatUnits(amountOut, 18)} SPCXon`, executableGuarantee: false };
    });
    await check('zapQuote', async () => {
      const amountOut = await read(A.quoter, 'quoteExactInput', [ZAP_PATH, parseEther(config.devBuyEth)]);
      assert(amountOut > 0n, 'Zap quote is zero.');
      return { input: `${config.devBuyEth} ETH`, output: `${formatUnits(amountOut, 18)} TSLAon`, executableGuarantee: false };
    });
    for (const [key, expected] of Object.entries(hashes)) {
      await check(`runtime.${key}`, async () => {
        const codeHash = keccak256(await rpc('eth_getCode', [A[key], 'latest']));
        assert.equal(codeHash, expected, 'Canonical runtime code hash differs.');
        return { address: A[key], codeHash };
      });
    }
    await check('programmableBindings', async () => {
      assert.equal(await read(A.programmableRouter, 'CHAIN_ID'), 1n, 'Router CHAIN_ID is not 1.');
      assert(equalAddress(await read(A.programmableRouter, 'GRAPH_FACTORY'), A.graphFactory), 'GRAPH_FACTORY binding differs.');
      assert(equalAddress(await read(A.programmableRouter, 'POOL_MANAGER'), A.poolManager), 'POOL_MANAGER binding differs.');
      return { chainId: 1 };
    });
  }

  await check('manifest', async () => {
    const manifest = await fetchJson(manifestUrl);
    assert.equal(manifest.chainId, 1, 'Manifest chainId is not 1.');
    const router = manifest.launchStampRouter;
    assert(equalAddress(router.address, A.programmableRouter), 'Manifest replaces the canonical Router.');
    assert.equal(router.runtimeCodeHash, hashes.programmableRouter, 'Manifest replaces the canonical Router hash.');
    for (const key of ['graphFactory', 'poolManager']) {
      assert(equalAddress(router.bindings[key], A[key]), 'Manifest replaces a canonical binding.');
      assert.equal(router.bindings[`${key}RuntimeCodeHash`], hashes[key], 'Manifest replaces a canonical runtime hash.');
    }
    return { url: manifestUrl, version: manifest.manifestVersion, generatedAt: manifest.generatedAt };
  });
  // Capabilities and readyz are the authority for profile and fee; the manifest above still lists profile 3.3.0.
  await check('capabilities', async () => validateCapabilities(await fetchJson(`${apiBase}/v3/capabilities`)));
  await check('readyz', async () => validateReadiness(await fetchJson(`${apiBase}/readyz`)));
  const checks = Object.values(report.checks);
  report.ready = checks.every(({ status }) => status === 'pass');
  report.scope = 'Mainnet dependencies only; does not prove a complete launch config, an audit, wallet funding, or that Programmable admission will pass.';
  console.log(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  process.exitCode = checks.some(({ status }) => status === 'fail') ? 1 : report.ready ? 0 : 2;
}
