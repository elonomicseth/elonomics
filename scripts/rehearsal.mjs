import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PACKAGE_VERSION, packLaunch, validateLaunchFile } from '@programmable/launch';
import { build } from './build.mjs';
import { assertCliVersion, assertPackageProfile, makePackConfig } from './launch.mjs';

// Fixture identities exist only in this isolated offline rehearsal, never in launch.config.json.
assertCliVersion();
const output = await build();
const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'elonomics-offline-rehearsal-'));
for (const entry of ['src', 'scripts', 'test', 'package.json', 'package-lock.json', 'foundry.toml', 'build']) {
  await cp(path.join(root, entry), path.join(temporary, entry), { recursive: true });
}
const config = {
  ...JSON.parse(await readFile('launch.config.json', 'utf8')),
  launchWallet: '0x1111111111111111111111111111111111111111',
  devRecipient: '0x2222222222222222222222222222222222222222',
  devBuyRecipient: '0x1111111111111111111111111111111111111111',
  totalSupply: '1000000000', initialFdvEth: '1.1', devBuyEth: '0.02', zapSlippageBps: 300,
  zapQuote: { quotedAt: new Date().toISOString(), blockNumber: '0', devBuyEth: '0.02', initialFdvEth: '1.1',
    zapSlippageBps: 300, quoteOut: '134000000000000000', minimumQuoteOut: '129980000000000000',
    quotePerTokenTick: -187260, effectiveFdvEth: '1.10086' },
  website: 'https://example.com', x: 'https://x.com/fixture',
  imageSourcePath: 'fixture.png', imageUri: 'https://example.com/fixture.png',
  publicSourceUrl: 'https://github.com/example/elonomics-fixture', publicSourceRevision: 'a'.repeat(40),
};
await writeFile(path.join(temporary, 'fixture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const now = Math.floor(Date.now() / 1000);
const session = { nonce: `0x${'11'.repeat(32)}`, validAfter: String(now - 30), deadline: String(now + 3500), checkedAt: new Date().toISOString() };
await mkdir(path.join(temporary, 'build'), { recursive: true });
await writeFile(path.join(temporary, 'build/build-evidence.json'), JSON.stringify({ scope: 'OFFLINE FIXTURE ONLY', compiler: '0.8.26', targetCount: 4 }));
const configPath = path.join(temporary, 'programmable-launch.config.json');
const launchPath = path.join(temporary, 'launch.json');
await writeFile(configPath, JSON.stringify(makePackConfig(config, output, session)));
const packed = await packLaunch({ configPath, outputPath: launchPath, receiptPath: path.join(temporary, 'receipt.json') });
const validated = await validateLaunchFile({ launchPath, configPath });
const first = await readFile(launchPath);
const launch = JSON.parse(first);
// The offline proof covers what may be submitted: profile 3.6.0 binding the hook's 0.30% share.
assertPackageProfile(launch);
await packLaunch({ configPath, outputPath: launchPath, receiptPath: path.join(temporary, 'receipt-repeat.json') });
assert.deepEqual(await readFile(launchPath), first, 'Exact retries must preserve request bytes');
const result = { scope: 'OFFLINE FIXTURE ONLY; no real metadata, submission, deployment or fee certification',
  temporary, cliVersion: PACKAGE_VERSION, profileVersion: launch.launchProfile.profileVersion, packed, validated,
  deterministicRepack: true };
await writeFile('build/rehearsal-result.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ scope: result.scope, cliVersion: result.cliVersion, profileVersion: result.profileVersion,
  requestSha256: packed.requestSha256, reproducedFromConfig: validated.reproducedFromConfig, deterministicRepack: true,
  report: 'build/rehearsal-result.json' }, null, 2));
