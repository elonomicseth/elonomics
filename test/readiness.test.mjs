import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROGRAMMABLE } from '../scripts/constants.mjs';
import { RELEASE_URL, exitCode, formatLine, runReadiness } from '../scripts/readiness.mjs';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const SECRET_KEY = 'pm_live_fixture-secret-value';
const SECRET_RPC = 'https://rpc.invalid/fixture-secret-path';
const IMAGE = Buffer.from('fixture image');
const REVISION = 'a'.repeat(40);
const ETH = 10n ** 18n;
const QUOTED_AT = NOW - 5 * 60_000;
const NONCE = `0x${'11'.repeat(32)}`;
const digestOf = c => createHash('sha256').update(JSON.stringify(c)).digest('hex');

const config = () => ({
  chainId: 1, name: 'Elonomics', symbol: 'ELON', description: 'Fixture description that is long enough.',
  launchWallet: '0x1111111111111111111111111111111111111111',
  devRecipient: '0x2222222222222222222222222222222222222222',
  devBuyRecipient: '0x1111111111111111111111111111111111111111',
  totalSupply: '1000000000', initialFdvEth: '1.1', devBuyEth: '0.02', zapSlippageBps: 300,
  zapQuote: { quotedAt: new Date(QUOTED_AT).toISOString(), blockNumber: '1', devBuyEth: '0.02', initialFdvEth: '1.1',
    zapSlippageBps: 300, quoteOut: '134000000000000000', minimumQuoteOut: '129980000000000000',
    quotePerTokenTick: -187260, effectiveFdvEth: '1.10086' },
  website: 'https://example.com', x: 'https://x.com/example', imageSourcePath: 'logo.png',
  imageUri: 'https://example.com/logo.png', publicSourceUrl: 'https://github.com/example/elonomics',
  publicSourceRevision: REVISION, oracleWindowSeconds: 1800, maximumOracleSlippageBps: 100,
});

const capabilities = () => ({
  chain: { id: '1' }, compiler: { exactBuild: '0.8.26+commit.8a97fa7a' }, onsiteTrading: { status: 'disabled' },
  profile: { profileId: 'programmable.direct-native-hook-graph.v1', profileRevision: 3, profileVersion: '3.6.0',
    productionLaunchAuthorized: true },
  requestProfiles: { freshSubmissionExactVersions: ['3.6.0'] },
  feePolicy: { programmableHundredthsOfBip: '3000', denominator: '1000000', requiredForProfileVersion: '3.6.0' },
  profile36Release: { selected: true, staticAdmissionBaseline: '3.3.0', customHookAllowlistRequired: false,
    mandatoryCanonicalFeeVaultTarget: false },
  graph: { minimumTargets: 3, maximumTargets: 16 },
  fundingModes: ['wallet-transaction-value'], liquidityModels: ['launch-seeded-concentrated-liquidity'],
  programmableTradeFeePolicy: { policyHash: PROGRAMMABLE.tradeFeePolicyHash },
});

const launch = () => ({
  nonce: NONCE,
  launchProfile: { profileVersion: '3.6.0', platformFeePolicy: { programmableFeeHundredthsOfBip: '3000' },
    programmableTradeFeePolicy: { ratePpm: '3000' }, router: '0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3',
    routerRuntimeCodeHash: '0xf2d611fb92718c63cf5767300e79d7c9b49480b2e9001448b96c1385f4edb6f3',
    graphFactory: '0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887' },
  launchProfileSelection: { platformFeeBinding: { programmableFeeHundredthsOfBip: '3000', economics: {
    buy: { effectiveTotalHundredthsOfBip: '20000', projectHundredthsOfBip: '17000' },
    sell: { effectiveTotalHundredthsOfBip: '20000', projectHundredthsOfBip: '17000' } } } },
});

const OLD_RELEASE_URL = 'https://github.com/programmablehq/PROGRAMMABLE/releases/download/programmable-launch-v4.1.3/programmable-launch-4.1.3.tgz';
const lock = (resolved = RELEASE_URL, integrity = 'sha512-release', version = '4.1.4') => JSON.stringify({ packages: {
  'node_modules/@programmable/launch': { version, resolved, integrity } } });

/** Every dependency of runReadiness, ready to launch unless a test changes it. */
function io(change = {}) {
  const files = {
    'launch.config.json': JSON.stringify(change.config ?? config()),
    'launch.json': JSON.stringify(launch()),
    'build/launch-session.json': JSON.stringify({ inputDigest: digestOf(config()), nonce: NONCE, deadline: String(NOW / 1000 + 3000) }),
    'package-lock.json': lock(),
    'node_modules/.package-lock.json': lock(),
    ...change.files,
  };
  const responses = {
    'https://api.programmable.market/v3/capabilities': { status: 200, body: capabilities() },
    'https://api.programmable.market/readyz': { status: 200, body: { status: 'ready',
      publicProfile: { currentWriteProfileVersion: '3.6.0' }, programmableTradeFeePolicy: { policyHash: PROGRAMMABLE.tradeFeePolicyHash } } },
    'https://api.github.com/repos/example/elonomics': { status: 200, body: { private: false } },
    [`https://api.github.com/repos/example/elonomics/commits/${REVISION}`]: { status: 200, body: { sha: REVISION } },
    'https://example.com': { status: 200, body: {} },
    ...change.responses,
  };
  return {
    now: NOW, nodeVersion: '24.14.0', cliVersion: '4.1.4', env: { PROGRAMMABLE_API_KEY: SECRET_KEY },
    readText: async file => {
      if (files[file] === undefined) throw Error(`ENOENT: ${file}`);
      return files[file];
    },
    readBytes: async file => {
      if (file !== 'logo.png') throw Error(`ENOENT: ${file}`);
      return IMAGE;
    },
    fetch: async url => {
      const response = responses[url];
      if (!response) throw Error(`unexpected fetch ${url}`);
      return { ok: response.status === 200, status: response.status, url, json: async () => response.body };
    },
    rpc: async (method, params = []) => ({ eth_chainId: '0x1', eth_getBalance: `0x${(5n * ETH / 100n).toString(16)}`,
      eth_getBlockByNumber: params[0] === '0x1' ? { number: '0x1', timestamp: `0x${(QUOTED_AT / 1000).toString(16)}` } : null })[method],
    git: async () => ({ code: 0, stdout: '' }),
    validateLaunch: async () => ({ reproducedFromConfig: true, requestSha256: 'sha256:fixture' }),
    digest: async c => digestOf(c),
    ...change.io,
  };
}

const statuses = results => Object.fromEntries(results.map(({ id, status }) => [id, status]));

test('readiness passes only when every input, service, file and release is ready', async () => {
  const results = await runReadiness(io());
  assert.deepEqual(results.map(r => r.id), ['config', 'zapQuote', 'runtime', 'programmable', 'wallet', 'source', 'image',
    'website', 'apiKey', 'package', 'cliRelease']);
  assert.deepEqual(results.filter(r => r.status !== 'PASS'), []);
  assert.equal(exitCode(results), 0);
  const image = results.find(r => r.id === 'image').detail;
  assert.ok(image.includes(createHash('sha256').update(IMAGE).digest('hex')), image);
  assert.match(formatLine(results[0]), /^PASS config +config is complete and consistent$/);
});

test('readiness waits for missing inputs and unpublished sources without printing secrets', async () => {
  const pending = io({
    config: { ...config(), zapQuote: null, imageSourcePath: null, publicSourceRevision: null },
    files: { 'launch.json': undefined },
    responses: { 'https://api.github.com/repos/example/elonomics': { status: 404, body: {} } },
    io: { rpc: async () => { throw Error(`connect failed ${SECRET_RPC}`); } },
  });
  const results = await runReadiness(pending);
  assert.deepEqual(statuses(results), { config: 'WAIT', zapQuote: 'WAIT', runtime: 'PASS', programmable: 'PASS', wallet: 'WAIT',
    source: 'WAIT', image: 'WAIT', website: 'PASS', apiKey: 'PASS', package: 'WAIT', cliRelease: 'PASS' });
  assert.equal(exitCode(results), 2);
  const printed = results.map(formatLine).join('\n');
  assert.ok(!printed.includes(SECRET_KEY) && !printed.includes(SECRET_RPC), printed);
  const noKey = await runReadiness(io({ io: { env: {}, rpc: null } }));
  assert.deepEqual([statuses(noKey).apiKey, statuses(noKey).wallet], ['WAIT', 'WAIT']);
});

test('readiness fails on stale quotes, old runtimes, wrong profiles, low balances, changed sources and closing permits', async () => {
  const stale = config();
  stale.zapQuote.quotedAt = new Date(NOW - 31 * 60_000).toISOString();
  const broken = io({
    config: stale,
    files: { 'build/launch-session.json': JSON.stringify({ inputDigest: digestOf(stale), nonce: NONCE, deadline: String(NOW / 1000 + 300) }),
      'node_modules/.package-lock.json': lock(RELEASE_URL, 'sha512-other') },
    responses: { 'https://api.programmable.market/v3/capabilities': { status: 200,
      body: { ...capabilities(), profile: { ...capabilities().profile, profileVersion: '3.3.0' } } },
    'https://example.com': { status: 404, body: {} } },
    io: { cliVersion: '3.3.9', git: async args => ({ code: args[0] === 'diff' ? 1 : 0, stdout: '' }),
      rpc: async method => ({ eth_chainId: '0x1', eth_getBalance: `0x${(3n * ETH / 100n).toString(16)}` })[method] },
  });
  const results = await runReadiness(broken);
  assert.deepEqual(statuses(results), { config: 'PASS', zapQuote: 'FAIL', runtime: 'FAIL', programmable: 'FAIL', wallet: 'FAIL',
    source: 'FAIL', image: 'PASS', website: 'FAIL', apiKey: 'PASS', package: 'FAIL', cliRelease: 'FAIL' });
  assert.equal(exitCode(results), 1);
  assert.match(results.find(r => r.id === 'wallet').detail, /need 0\.04 ETH/);
  assert.match(results.find(r => r.id === 'runtime').detail, /4\.1\.4 or newer/);
  assert.match(results.find(r => r.id === 'package').detail, /permit window/);

  // The official 4.1.4 release exists: a 4.1.3 pin, which packs for the legacy Router, fails even when node_modules matches it.
  const oldPin = lock(OLD_RELEASE_URL, 'sha512-old', '4.1.3');
  const oldCli = await runReadiness(io({ files: { 'package-lock.json': oldPin, 'node_modules/.package-lock.json': oldPin } }));
  assert.equal(statuses(oldCli).cliRelease, 'FAIL');
  assert.match(oldCli.find(r => r.id === 'cliRelease').detail, /pins @programmable\/launch 4\.1\.3, not the official release 4\.1\.4/);
  const legacyPackage = launch();
  legacyPackage.launchProfile.router = '0x8622DD5bAb44185f2A458ac90384Ac99248f8d56';
  legacyPackage.launchProfile.routerRuntimeCodeHash = '0x40e27ecf201761d5eb66bc4f2d5c6124831ef078d7baf458ca5f41b1a8108546';
  const legacy = await runReadiness(io({ files: { 'launch.json': JSON.stringify(legacyPackage) } }));
  assert.equal(statuses(legacy).package, 'FAIL');
  assert.match(legacy.find(r => r.id === 'package').detail, /successor Router/);

  // After pack: a newer quote, an uncommitted logo, a relabelled quote time or another session's package must each block submission.
  const requoted = config();
  Object.assign(requoted.zapQuote, { quoteOut: '135000000000000000', minimumQuoteOut: '130950000000000000',
    quotePerTokenTick: -187200, effectiveFdvEth: '1.09928' });
  const drift = statuses(await runReadiness(io({ config: requoted,
    io: { git: async args => ({ code: 0, stdout: args[0] === 'status' && args.includes('logo.png') ? '?? logo.png\n' : '' }) } })));
  assert.deepEqual([drift.config, drift.zapQuote, drift.source, drift.package], ['PASS', 'PASS', 'FAIL', 'FAIL']);
  const relabelled = config();
  relabelled.zapQuote.quotedAt = new Date(NOW - 60_000).toISOString();
  assert.equal(statuses(await runReadiness(io({ config: relabelled }))).zapQuote, 'FAIL');
  const otherSession = io({ files: { 'launch.json': JSON.stringify({ ...launch(), nonce: `0x${'22'.repeat(32)}` }) } });
  assert.equal(statuses(await runReadiness(otherSession)).package, 'FAIL');
});
