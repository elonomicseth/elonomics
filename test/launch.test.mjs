import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { units18, validateConfig, inputDigest, assertPlatformFeeBinding, assertFreshZapQuote, assertCliVersion, assertPackageProfile, sessionAction } from '../scripts/launch.mjs';

// Literal values from the official CLI 4.1.4 release (ROUTER_24H and its runtime code hash), not read from constants.mjs.
const SUCCESSOR_ROUTER = '0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3';
const SUCCESSOR_ROUTER_HASH = '0xf2d611fb92718c63cf5767300e79d7c9b49480b2e9001448b96c1385f4edb6f3';
const GRAPH_FACTORY = '0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887';

test('decimal amounts are exact and reject rounded inputs', () => {
  assert.equal(units18('1.000000000000000001', 'amount'), 1000000000000000001n);
  for (const value of ['0', '-1', '01', '1e9', '0.0000000000000000001', 1, ' 1']) {
    assert.throws(() => units18(value, 'amount'));
  }
});

test('production configuration refuses incomplete real launch inputs', async () => {
  const config = JSON.parse(await readFile(new URL('../launch.config.json', import.meta.url), 'utf8'));
  // This check stays meaningful after users fill their local configuration.
  assert.throws(() => validateConfig({ ...config, launchWallet: null }), /launchWallet/);
});

test('package must bind the 0.30% platform fee the hook charges in every policy field and target the successor Router', () => {
  const bound = (policy, binding = policy) => ({
    launchProfile: { platformFeePolicy: { programmableFeeHundredthsOfBip: policy } },
    launchProfileSelection: { platformFeeBinding: { programmableFeeHundredthsOfBip: binding } },
  });
  assert.doesNotThrow(() => assertPlatformFeeBinding(bound('3000')));
  assert.throws(() => assertPlatformFeeBinding(bound('1000')), /binds platform fee 1000/);
  assert.throws(() => assertPlatformFeeBinding(bound('3000', '1000')), /3000, 1000/);
  assert.throws(() => assertPlatformFeeBinding({}), /binds platform fee none/);
  assert.doesNotThrow(() => assertCliVersion('4.1.4'));
  assert.doesNotThrow(() => assertCliVersion('4.2.0'));
  assert.throws(() => assertCliVersion('4.1.3'), /4\.1\.4 or newer/);
  assert.throws(() => assertCliVersion('3.3.9'), /4\.1\.4 or newer/);
  const pkg = (profileVersion, fee = '3000') => ({
    launchProfile: { profileVersion, platformFeePolicy: { programmableFeeHundredthsOfBip: fee },
      ...(profileVersion === '3.6.0' ? { programmableTradeFeePolicy: { ratePpm: '3000' } } : {}),
      router: SUCCESSOR_ROUTER, routerRuntimeCodeHash: SUCCESSOR_ROUTER_HASH, graphFactory: GRAPH_FACTORY },
    launchProfileSelection: { platformFeeBinding: { programmableFeeHundredthsOfBip: fee, economics: Object.fromEntries(['buy', 'sell']
      .map(side => [side, { effectiveTotalHundredthsOfBip: '20000', projectHundredthsOfBip: String(20000 - Number(fee)) }])) } },
  });
  assert.doesNotThrow(() => assertPackageProfile(pkg('3.6.0')));
  assert.throws(() => assertPackageProfile(pkg('3.3.0', '1000')), /binds platform fee 1000/);
  assert.throws(() => assertPackageProfile(pkg('3.3.0')), /profile 3\.6\.0/);
  const noPolicy = pkg('3.6.0');
  noPolicy.launchProfile.programmableTradeFeePolicy = null;
  assert.throws(() => assertPackageProfile(noPolicy), /profile 3\.6\.0/);
  // A CLI 4.1.3 package binds the legacy one-hour Router; it, or any other Router or factory, must be packed again.
  for (const change of [{ router: '0x8622DD5bAb44185f2A458ac90384Ac99248f8d56',
    routerRuntimeCodeHash: '0x40e27ecf201761d5eb66bc4f2d5c6124831ef078d7baf458ca5f41b1a8108546' },
  { routerRuntimeCodeHash: '0x40e27ecf201761d5eb66bc4f2d5c6124831ef078d7baf458ca5f41b1a8108546' },
  { router: undefined }, { graphFactory: '0x000000000004444c5dc75cB358380D2e3dE08A90' }]) {
    const other = pkg('3.6.0');
    Object.assign(other.launchProfile, change);
    assert.throws(() => assertPackageProfile(other), /successor Router 0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3/);
  }
  const lowercase = pkg('3.6.0');
  lowercase.launchProfile.router = SUCCESSOR_ROUTER.toLowerCase();
  assert.doesNotThrow(() => assertPackageProfile(lowercase));
});

test('retry fingerprint covers bundled scripts, lockfile and image bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elon-digest-test-'));
  try {
    for (const dir of ['src', 'scripts', 'test', 'build/artifacts']) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ['src/Token.sol', 'scripts/launch.mjs', 'test/Token.sol', 'package.json', 'package-lock.json', 'foundry.toml', 'build/standard-json.json', 'build/artifacts/token.json', 'logo.png']) {
      await writeFile(path.join(root, file), 'original');
    }
    const config = { imageSourcePath: 'logo.png' };
    const original = await inputDigest(config, root);
    assert.equal(await inputDigest(config, root), original);
    for (const file of ['scripts/launch.mjs', 'package-lock.json', 'logo.png']) {
      await writeFile(path.join(root, file), 'changed');
      assert.notEqual(await inputDigest(config, root), original, file);
      await writeFile(path.join(root, file), 'original');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const completeConfig = () => ({
  chainId: 1, name: 'Elonomics', symbol: 'ELON', description: 'Fixture description that is long enough.',
  launchWallet: '0x1111111111111111111111111111111111111111',
  devRecipient: '0x2222222222222222222222222222222222222222',
  devBuyRecipient: '0x1111111111111111111111111111111111111111',
  totalSupply: '1000000000', initialFdvEth: '1.1', devBuyEth: '0.02', zapSlippageBps: 300,
  zapQuote: { quotedAt: '2026-10-07T12:00:00.000Z', blockNumber: '1', devBuyEth: '0.02', initialFdvEth: '1.1',
    zapSlippageBps: 300, quoteOut: '134000000000000000', minimumQuoteOut: '129980000000000000',
    quotePerTokenTick: -187260, effectiveFdvEth: '1.10086' },
  website: 'https://example.com', x: 'https://x.com/example', imageSourcePath: 'logo.png',
  imageUri: 'https://example.com/logo.png', publicSourceUrl: 'https://github.com/example/elonomics',
  publicSourceRevision: 'a'.repeat(40), oracleWindowSeconds: 1800, maximumOracleSlippageBps: 100,
});

test('launch config binds the dev buy, the supply and the zap quote that fixed its price', () => {
  const config = completeConfig();
  assert.deepEqual(validateConfig(config), { supply: '1000000000000000000000000000', devBuyWei: '20000000000000000' });
  for (const change of [{ devBuyEth: '0.03' }, { initialFdvEth: '2' }, { zapSlippageBps: 100 }, { totalSupply: '2000000000' }]) {
    assert.throws(() => validateConfig({ ...config, ...change }), /zapQuote/);
  }
  for (const zapQuote of [{ ...config.zapQuote, quotePerTokenTick: -187261 }, { ...config.zapQuote, quotePerTokenTick: 887220 },
    { ...config.zapQuote, minimumQuoteOut: '0' }, { ...config.zapQuote, quoteOut: '135000000000000000' },
    { ...config.zapQuote, effectiveFdvEth: '1.1' }]) {
    assert.throws(() => validateConfig({ ...config, zapQuote }), /zapQuote/);
  }
  assert.throws(() => validateConfig({ ...config, devBuyRecipient: '0x000000000000000000000000000000000000dEaD' }), /devBuyRecipient/);
});

test('pack refuses a zap quote older than thirty minutes unless it re-packs an open session', () => {
  const quotedAt = '2026-10-07T12:00:00.000Z';
  const at = Date.parse(quotedAt);
  assert.doesNotThrow(() => assertFreshZapQuote({ quotedAt }, at + 29 * 60_000));
  assert.throws(() => assertFreshZapQuote({ quotedAt }, at + 31 * 60_000), /npm run quote/);
  assert.throws(() => assertFreshZapQuote({ quotedAt }, at - 5 * 60_000), /npm run quote/);
  const session = { inputDigest: 'digest', deadline: String(at / 1000 + 3500) };
  assert.equal(sessionAction(undefined, 'digest', { quotedAt }, at + 29 * 60_000), 'new');
  assert.throws(() => sessionAction(undefined, 'digest', { quotedAt }, at + 31 * 60_000), /npm run quote/);
  assert.equal(sessionAction(session, 'digest', { quotedAt }, at + 45 * 60_000), 'reuse');
  assert.throws(() => sessionAction(session, 'changed', { quotedAt }, at + 45 * 60_000), /inputs changed/);
  assert.throws(() => sessionAction(session, 'digest', { quotedAt }, at + 3500 * 1000), /permit window expired/);
});
