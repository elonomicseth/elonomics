import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther, getAddress } from 'viem';
import { PACKAGE_VERSION, validateLaunchFile } from '@programmable/launch';
import { PROGRAMMABLE } from './constants.mjs';
import {
  CONFIG_PATH, SESSION_PATH, SOURCE_PATHS, assertCliVersion, assertFreshZapQuote, assertPackageProfile, inputDigest, units18,
  validateConfig,
} from './launch.mjs';
import { validateCapabilities, validateReadiness } from './programmable.mjs';

// Read-only launch readiness. One line per check; nothing here signs, sends, or prints an RPC URL or API key.
export const GAS_RESERVE_WEI = 20_000_000_000_000_000n; // 0.02 ETH of launch gas on top of devBuyEth
export const RELEASE_URL = `https://github.com/programmablehq/PROGRAMMABLE/releases/download/programmable-launch-v${PROGRAMMABLE.minimumCliVersion}/programmable-launch-${PROGRAMMABLE.minimumCliVersion}.tgz`;
const API_BASE = 'https://api.programmable.market';
const PERMIT_MARGIN_SECONDS = 600;

class Pending extends Error {}
// WAIT: an input, file, service or release is not there yet. FAIL: something is there but wrong.
const wait = message => { throw new Pending(message); };

export async function runReadiness(io) {
  const results = [];
  async function check(id, run) {
    try {
      results.push({ id, status: 'PASS', detail: await run() });
    } catch (error) {
      results.push({ id, status: error instanceof Pending ? 'WAIT' : 'FAIL', detail: String(error?.message ?? error).split('\n')[0] });
    }
  }
  async function json(url) {
    let response;
    try { response = await io.fetch(url); } catch { wait(`${url} could not be read`); }
    if (!response.ok) wait(`${url} returned HTTP ${response.status}`);
    return response.json();
  }
  let config = null;
  try { config = JSON.parse(await io.readText('launch.config.json')); } catch { config = null; }
  const needConfig = () => { if (!config) throw Error('launch.config.json could not be read'); return config; };

  await check('config', async () => {
    try { validateConfig(needConfig()); } catch (error) {
      if (/^Launch inputs still required/.test(error.message)) wait(error.message);
      throw error;
    }
    return 'config is complete and consistent';
  });

  await check('zapQuote', async () => {
    const quote = needConfig().zapQuote;
    if (!quote) wait('zapQuote is empty; run npm run quote at most 30 minutes before pack');
    assertFreshZapQuote(quote, io.now);
    // npm run quote writes the quote block's timestamp; an edited quotedAt does not match its block.
    const blockTag = `0x${BigInt(quote.blockNumber).toString(16)}`;
    if (!io.rpc) wait('MAINNET_RPC_URL is not set; quotedAt not yet matched against the quote block');
    let block;
    try { block = await io.rpc('eth_getBlockByNumber', [blockTag, false]); } catch { wait('quote block could not be read from the RPC; URL not printed'); }
    if (Number(BigInt(block.timestamp)) * 1000 !== Date.parse(quote.quotedAt)) {
      throw Error(`quotedAt ${quote.quotedAt} is not the timestamp of block ${quote.blockNumber}; run npm run quote`);
    }
    return `quote ${Math.floor((io.now - Date.parse(quote.quotedAt)) / 60_000)} minutes old at block ${quote.blockNumber}`;
  });

  await check('runtime', async () => {
    const [major, minor] = io.nodeVersion.split('.').map(Number);
    if (major !== 24 || minor < 14) throw Error(`Node ${io.nodeVersion}; Programmable CLI requires Node >=24.14.0 <25`);
    assertCliVersion(io.cliVersion);
    return `Node ${io.nodeVersion}, @programmable/launch ${io.cliVersion}`;
  });

  await check('programmable', async () => {
    const capabilities = validateCapabilities(await json(`${API_BASE}/v3/capabilities`));
    const readyz = validateReadiness(await json(`${API_BASE}/readyz`));
    return `profile ${capabilities.profile.profileVersion}, new requests ${capabilities.freshSubmissionExactVersions.join(',')}, `
      + `platform fee ${capabilities.platformFee}, readyz ${readyz.serviceStatus}`;
  });

  await check('wallet', async () => {
    const c = needConfig();
    if (!c.launchWallet) wait('launchWallet is empty');
    if (!io.rpc) wait('MAINNET_RPC_URL is not set');
    let chainId, balance;
    try {
      chainId = BigInt(await io.rpc('eth_chainId'));
      balance = BigInt(await io.rpc('eth_getBalance', [getAddress(c.launchWallet), 'latest']));
    } catch { wait('RPC could not be read; URL not printed'); }
    if (chainId !== 1n) throw Error('MAINNET_RPC_URL is not chain ID 1');
    const required = units18(c.devBuyEth, 'devBuyEth') + GAS_RESERVE_WEI;
    if (balance < required) {
      throw Error(`balance ${formatEther(balance)} ETH, need ${formatEther(required)} ETH (devBuyEth + ${formatEther(GAS_RESERVE_WEI)} gas reserve)`);
    }
    return `balance ${formatEther(balance)} ETH >= ${formatEther(required)} ETH`;
  });

  await check('source', async () => {
    const c = needConfig();
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(c.publicSourceUrl ?? '');
    if (!c.publicSourceUrl) wait('publicSourceUrl is empty');
    if (!match) throw Error('publicSourceUrl is not a GitHub repository');
    const api = `https://api.github.com/repos/${match[1]}/${match[2]}`;
    let repository;
    try { repository = await io.fetch(api); } catch { wait('GitHub API could not be read'); }
    if (repository.status === 404) wait('repository is not public yet (unauthenticated GitHub API returns 404)');
    if (!repository.ok) wait(`GitHub API returned HTTP ${repository.status}`);
    if ((await repository.json()).private !== false) wait('repository is not public yet');
    const revision = c.publicSourceRevision;
    if (!revision) wait('publicSourceRevision is empty; pin a commit that has been pushed');
    let commit;
    try { commit = await io.fetch(`${api}/commits/${revision}`); } catch { wait('GitHub API could not be read'); }
    if (!commit.ok) throw Error(`revision ${revision.slice(0, 12)} is not in the public repository (HTTP ${commit.status})`);
    if ((await io.git(['cat-file', '-e', `${revision}^{commit}`])).code !== 0) throw Error('revision is not in the local repository; run git fetch');
    // pack also puts imageSourcePath into the source bundle, so the logo must match the public revision too.
    const paths = [...SOURCE_PATHS, c.imageSourcePath].filter(Boolean);
    if ((await io.git(['diff', '--quiet', revision, 'HEAD', '--', ...paths])).code !== 0) {
      throw Error('SOURCE_PATHS or the image at HEAD differ from publicSourceRevision');
    }
    if ((await io.git(['status', '--porcelain', '--', ...paths])).stdout.trim()) {
      throw Error('SOURCE_PATHS or the image have uncommitted changes');
    }
    return `repository is public; ${revision.slice(0, 12)} matches HEAD for SOURCE_PATHS and the image`;
  });

  await check('image', async () => {
    const file = needConfig().imageSourcePath;
    if (!file) wait('imageSourcePath is empty');
    let bytes;
    try { bytes = await io.readBytes(file); } catch { throw Error(`${file} not found`); }
    return `${file} sha256 ${createHash('sha256').update(bytes).digest('hex')}`;
  });

  await check('website', async () => {
    const website = needConfig().website;
    if (!website) wait('website is empty');
    let response;
    try { response = await io.fetch(website); } catch { throw Error(`${website} could not be reached`); }
    if (response.status !== 200 || !String(response.url || website).startsWith('https://')) {
      throw Error(`${website} returned HTTP ${response.status}`);
    }
    return `${website} HTTPS 200`;
  });

  await check('apiKey', async () => {
    if (!io.env.PROGRAMMABLE_API_KEY) wait('PROGRAMMABLE_API_KEY is not set in the environment');
    return 'PROGRAMMABLE_API_KEY is set in the environment';
  });

  await check('package', async () => {
    let launch;
    try { launch = JSON.parse(await io.readText('launch.json')); } catch { wait('launch.json does not exist yet; run npm run pack'); }
    assertPackageProfile(launch);
    const validated = await io.validateLaunch();
    if (validated.reproducedFromConfig !== true) throw Error(`launch.json cannot be reproduced from ${CONFIG_PATH}`);
    const session = JSON.parse(await io.readText(SESSION_PATH));
    // The package must come from this session, and the session from today's config, source, build and image.
    if (launch.nonce !== session.nonce) throw Error(`launch.json is not the package from ${SESSION_PATH}; archive the package, then quote and pack again`);
    if (session.inputDigest !== await io.digest(needConfig())) {
      throw Error('inputs changed since pack (quote, config, source, build or image); archive the package, then quote and pack again');
    }
    const left = Number(session.deadline) - Math.floor(io.now / 1000);
    if (left < PERMIT_MARGIN_SECONDS) throw Error(`permit window has ${Math.max(left, 0)} seconds left; archive the package, then quote and pack again`);
    return `${validated.requestSha256}, profile ${launch.launchProfile.profileVersion}, permit window ${Math.floor(left / 60)} minutes`;
  });

  await check('cliRelease', async () => {
    const pinned = JSON.parse(await io.readText('package-lock.json')).packages?.['node_modules/@programmable/launch'];
    const installed = JSON.parse(await io.readText('node_modules/.package-lock.json')).packages?.['node_modules/@programmable/launch'];
    if (pinned?.resolved !== RELEASE_URL) wait(`package-lock.json pins ${pinned?.version ?? 'another CLI'}; pin official release ${PROGRAMMABLE.minimumCliVersion} (Task 10)`);
    if (installed?.resolved !== pinned.resolved || installed?.integrity !== pinned.integrity) {
      throw Error('node_modules does not match package-lock.json; run npm ci --ignore-scripts');
    }
    return `official release ${pinned.version} is pinned in package-lock.json`;
  });
  return results;
}

export const formatLine = ({ id, status, detail }) => `${status} ${id.padEnd(12)} ${detail}`;
export const exitCode = results => results.some(r => r.status === 'FAIL') ? 1 : results.every(r => r.status === 'PASS') ? 0 : 2;

async function main() {
  const rpcUrl = process.env.MAINNET_RPC_URL;
  const results = await runReadiness({
    now: Date.now(), nodeVersion: process.versions.node, cliVersion: PACKAGE_VERSION, env: process.env,
    readText: file => readFile(file, 'utf8'), readBytes: file => readFile(file),
    fetch: url => fetch(url, { headers: { 'user-agent': 'elonomics-readiness' }, signal: AbortSignal.timeout(20_000) }),
    rpc: rpcUrl ? async (method, params = []) => {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json();
      if (body.error || body.result == null) throw Error('RPC error');
      return body.result;
    } : null,
    git: args => new Promise(resolve => execFile('git', args, (error, stdout) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout) }))),
    validateLaunch: () => validateLaunchFile({ launchPath: 'launch.json', configPath: CONFIG_PATH }),
    digest: config => inputDigest(config),
  });
  for (const result of results) console.log(formatLine(result));
  process.exitCode = exitCode(results);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => { console.error('Readiness check could not run'); process.exitCode = 1; });
}
