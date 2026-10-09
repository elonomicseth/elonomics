import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, zeroAddress } from 'viem';
import { PACKAGE_VERSION, packLaunch, validateLaunchFile } from '@programmable/launch';
import { ADDRESSES as A, PROGRAMMABLE } from './constants.mjs';
import { build, CONTRACTS } from './build.mjs';

export const CONFIG_PATH = 'programmable-launch.config.json';
export const SESSION_PATH = 'build/launch-session.json';
export const SOURCE_PATHS = ['src', 'scripts', 'test', 'package.json', 'package-lock.json', 'foundry.toml'];
// Programmable's 0.30% share, as charged by ElonomicsHook.previewFees (3,000 / 1,000,000).
export const PLATFORM_FEE_HUNDREDTHS_OF_BIP = PROGRAMMABLE.platformFeeHundredthsOfBip;
const TICK_SPACING = 60;
const MAX_TICK = 887220;

export function assertPlatformFeeBinding(launch) {
  const rates = new Set();
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'programmableFeeHundredthsOfBip') rates.add(value); else visit(value);
    }
  }
  visit(launch);
  if (rates.size !== 1 || !rates.has(PLATFORM_FEE_HUNDREDTHS_OF_BIP)) {
    throw Error(`Package binds platform fee ${[...rates].join(', ') || 'none'} hundredths of a bip, but ElonomicsHook charges ${PLATFORM_FEE_HUNDREDTHS_OF_BIP}. Do not submit launch.json; pack profile ${PROGRAMMABLE.profileVersion} with @programmable/launch ${PROGRAMMABLE.minimumCliVersion} or newer.`);
  }
}

// CLI 3.3.9 can only pack profile 3.3.0 (0.10%), which Programmable no longer accepts for new requests.
export function assertCliVersion(version = PACKAGE_VERSION) {
  const want = PROGRAMMABLE.minimumCliVersion.split('.').map(Number);
  const have = String(version).split('.').map(Number);
  const first = have.findIndex((part, index) => part !== want[index]);
  if (have.length !== 3 || have.some(Number.isNaN) || (first !== -1 && have[first] < want[first])) {
    throw Error(`@programmable/launch ${version} cannot pack profile ${PROGRAMMABLE.profileVersion}; install ${PROGRAMMABLE.minimumCliVersion} or newer`);
  }
}

// The only package this repository may submit: profile 3.6.0, 2% total per side, 0.30% of it for Programmable.
export function assertPackageProfile(launch) {
  assertPlatformFeeBinding(launch);
  const economics = launch.launchProfileSelection?.platformFeeBinding?.economics;
  if (launch.launchProfile?.profileVersion !== PROGRAMMABLE.profileVersion
    // Profile 3.6.0 carries Programmable's routed-trade policy (3000 ppm); null or another rate is not that profile.
    || launch.launchProfile?.programmableTradeFeePolicy?.ratePpm !== '3000'
    || ['buy', 'sell'].some(side => economics?.[side]?.effectiveTotalHundredthsOfBip !== '20000'
      || economics?.[side]?.projectHundredthsOfBip !== '17000')) {
    throw Error(`Package is not a profile ${PROGRAMMABLE.profileVersion} request with a 2% total and a 0.30% platform share; do not submit launch.json`);
  }
}

export async function inputDigest(config, root = '.') {
  const hash = createHash('sha256').update(JSON.stringify(config));
  async function visit(relative) {
    const absolute = path.resolve(root, relative);
    const boundary = path.resolve(root) + path.sep;
    if (!absolute.startsWith(boundary)) throw Error(`Path escapes source root: ${relative}`);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw Error(`Source symlinks are unsupported: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const bytes = await readFile(absolute);
      hash.update(JSON.stringify([relative, bytes.length])).update(bytes);
    } else throw Error(`Unsupported source entry: ${relative}`);
  }
  for (const entry of [...SOURCE_PATHS, 'build/standard-json.json', 'build/artifacts', config.imageSourcePath]) await visit(entry);
  return hash.digest('hex');
}

export function expectedDeployment(packed, launch) {
  return {
    chainId: 1,
    ...Object.fromEntries(packed.predictions.map(p => [p.targetId, p.predictedAddress])),
    runtimeCodeHashes: Object.fromEntries(launch.graphBundle.targets.map(t => [t.targetId, t.expectedRuntimeCodeHash])),
  };
}

export function units18(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value)) {
    throw Error(`${label}: use a decimal string with at most 18 decimals`);
  }
  const [whole, fractional = ''] = value.split('.');
  const amount = BigInt(whole) * 10n ** 18n + BigInt(fractional.padEnd(18, '0'));
  if (amount <= 0n) throw Error(`${label} must be positive`);
  return amount;
}

/** Turns a zap quote into the launcher arguments. Amounts are base units; ELON and TSLA both use 18 decimals. */
export function planZapQuote({ quoteOut, devBuyWei, initialFdvWei, supply, slippageBps }) {
  if (quoteOut <= 0n || devBuyWei <= 0n || initialFdvWei <= 0n || supply <= 0n) throw Error('Quote inputs must be positive');
  const minimumQuoteOut = quoteOut * BigInt(10_000 - slippageBps) / 10_000n;
  // TSLA per ELON = FDV in ETH x TSLA received per ETH / supply.
  const price = Number(initialFdvWei) * Number(quoteOut) / Number(devBuyWei) / Number(supply);
  const tick = Math.round(Math.log(price) / Math.log(1.0001) / TICK_SPACING) * TICK_SPACING;
  if (minimumQuoteOut <= 0n || !(Math.abs(tick) < MAX_TICK)) throw Error('Quote produces an unusable launch price');
  const effectiveFdvEth = Math.pow(1.0001, tick) * Number(supply) * Number(devBuyWei) / Number(quoteOut) / 1e18;
  return { minimumQuoteOut: minimumQuoteOut.toString(), quotePerTokenTick: tick, effectiveFdvEth: effectiveFdvEth.toPrecision(6) };
}

export function validateConfig(c) {
  const required = ['launchWallet', 'devRecipient', 'devBuyRecipient', 'totalSupply', 'initialFdvEth', 'devBuyEth',
    'website', 'x', 'imageSourcePath', 'imageUri', 'publicSourceUrl', 'publicSourceRevision', 'zapQuote'];
  const missing = required.filter(key => c[key] == null || c[key] === '');
  if (missing.length) throw Error(`Launch inputs still required: ${missing.join(', ')}`);
  if (c.chainId !== 1 || c.name !== 'Elonomics' || c.symbol !== 'ELON') throw Error('Expected Elonomics/ELON on chain ID 1');
  for (const key of ['launchWallet', 'devRecipient', 'devBuyRecipient']) {
    const value = getAddress(c[key]);
    if ([zeroAddress, A.poolManager, '0x000000000000000000000000000000000000dEaD'].some(a => a.toLowerCase() === value.toLowerCase())) {
      throw Error(`${key}: invalid recipient`);
    }
  }
  const supply = units18(c.totalSupply, 'totalSupply');
  if (supply > (1n << 128n) - 1n) throw Error('Supply exceeds uint128 base units');
  const devBuyWei = units18(c.devBuyEth, 'devBuyEth');
  const initialFdvWei = units18(c.initialFdvEth, 'initialFdvEth');
  if (!Number.isInteger(c.zapSlippageBps) || c.zapSlippageBps < 0 || c.zapSlippageBps > 1000) throw Error('zapSlippageBps must be 0..1000');
  // The minimum, tick and FDV must be exactly what npm run quote derives from quoteOut and this config.
  const q = c.zapQuote;
  let expected = null;
  if (typeof q === 'object' && q.devBuyEth === c.devBuyEth && q.initialFdvEth === c.initialFdvEth
    && q.zapSlippageBps === c.zapSlippageBps && /^[1-9][0-9]*$/.test(q.quoteOut ?? '') && !Number.isNaN(Date.parse(q.quotedAt))) {
    try {
      expected = planZapQuote({ quoteOut: BigInt(q.quoteOut), devBuyWei, initialFdvWei, supply, slippageBps: c.zapSlippageBps });
    } catch { expected = null; }
  }
  if (!expected || q.minimumQuoteOut !== expected.minimumQuoteOut || q.quotePerTokenTick !== expected.quotePerTokenTick
    || q.effectiveFdvEth !== expected.effectiveFdvEth) {
    throw Error('zapQuote is missing or does not match quoteOut, totalSupply, devBuyEth, initialFdvEth and zapSlippageBps; run npm run quote');
  }
  for (const key of ['website', 'publicSourceUrl']) {
    const url = new URL(c[key]);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error(`${key}: public HTTPS URL required`);
  }
  if (!/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(c.x)) throw Error('x: canonical https://x.com/handle required');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(c.publicSourceRevision)) throw Error('Exact public Git revision required');
  if (!Number.isInteger(c.oracleWindowSeconds) || c.oracleWindowSeconds < 1800 || c.oracleWindowSeconds > 604800) throw Error('Oracle window must be 1800..604800 seconds');
  if (!Number.isInteger(c.maximumOracleSlippageBps) || c.maximumOracleSlippageBps < 0 || c.maximumOracleSlippageBps > 500) throw Error('Oracle slippage must be 0..500 bps');
  return { supply: supply.toString(), devBuyWei: devBuyWei.toString() };
}

// The zap minimum and launch price are frozen into the request; refuse quotes the permit window would outlive.
export function assertFreshZapQuote(zapQuote, nowMs = Date.now()) {
  const age = nowMs - Date.parse(zapQuote.quotedAt);
  if (!(age >= -2 * 60_000 && age <= 30 * 60_000)) {
    throw Error('zapQuote is not from the last 30 minutes; run npm run quote again before packing');
  }
}

// pack reuses an unchanged session inside its open permit window whatever the quote's age; only a new session needs a fresh quote.
export function sessionAction(session, digest, zapQuote, nowMs = Date.now()) {
  if (!session) {
    assertFreshZapQuote(zapQuote, nowMs);
    return 'new';
  }
  if (session.inputDigest !== digest || BigInt(session.deadline) <= BigInt(Math.floor(nowMs / 1000))) {
    throw Error('Launch inputs changed or permit window expired. Archive build/launch-session.json and previous launch files before preparing a new request.');
  }
  return 'reuse';
}

export function makePackConfig(c, output, session) {
  const { supply, devBuyWei } = validateConfig(c);
  const ref = target => ({ target });
  const declarations = new Map();
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') declarations.set(String(node.id), node);
    for (const value of Object.values(node)) if (typeof value === 'object') {
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  }
  Object.values(output.sources).forEach(source => visit(source.ast));
  const immutableValues = {
    token: { rewardToken: A.reward, poolManager: A.poolManager },
    launcher: { poolManager: A.poolManager, positionManager: A.positionManager, swapRouter: A.swapRouter,
      weth: A.weth, usdc: A.usdc, quote: A.quote, graphFactory: A.graphFactory },
    processor: { rewardDistributor: ref('token'), quote: A.quote, reward: A.reward, usdc: A.usdc,
      swapRouter: A.swapRouter, quotePool: A.quotePool, rewardPool: A.rewardPool,
      oracleWindow: c.oracleWindowSeconds, maxSlippageBps: c.maximumOracleSlippageBps },
    hook: { poolManager: A.poolManager, token: ref('token'), quote: A.quote,
      initializer: ref('launcher'), devRecipient: c.devRecipient, dividendRecipient: ref('processor') },
  };
  const constructors = {
    token: [ref('launcher'), supply, A.reward, A.poolManager],
    launcher: [A.poolManager, A.positionManager, A.swapRouter, A.weth, A.usdc, A.quote, A.graphFactory],
    processor: [ref('token'), A.quote, A.reward, A.usdc, A.swapRouter, A.quotePool, A.rewardPool,
      c.oracleWindowSeconds, c.maximumOracleSlippageBps],
    hook: [A.poolManager, ref('token'), A.quote, ref('launcher'), c.devRecipient, ref('processor')],
  };
  const targets = Object.entries(CONTRACTS).map(([id, name], index) => {
    const compiled = output.contracts[`src/${name}.sol`][name];
    const runtimeImmutables = Object.keys(compiled.evm.deployedBytecode.immutableReferences).map(immutableId => {
      const declaration = declarations.get(immutableId);
      const value = immutableValues[id][declaration?.name];
      if (value === undefined) throw Error(`Unmapped immutable: ${id}.${declaration?.name} (${immutableId})`);
      const abiType = declaration.name === 'oracleWindow' ? 'uint32' : declaration.name === 'maxSlippageBps' ? 'uint16' : 'address';
      return { immutableId, abiType, ...(typeof value === 'object' ? value : { literal: abiType === 'address' ? value : String(value) }) };
    });
    return {
      targetId: id, compilationUnitId: 'elonomics-solc', artifact: `build/artifacts/${id}.json`,
      applicantSalt: id === 'hook' ? { mode: 'deterministic-hook-permission-grind-v1', start: '0', maxAttempts: '262144' }
        : `0x${String(index + 1).padStart(64, '0')}`,
      constructorArguments: constructors[id],
      initializer: id === 'launcher' ? { function: 'launch', arguments: [ref('token'), ref('hook'), c.devBuyRecipient,
        String(c.zapQuote.quotePerTokenTick), c.zapQuote.minimumQuoteOut] } : null,
      deploymentValueWei: '0', initializerValueWei: id === 'launcher' ? devBuyWei : '0',
      componentKind: ['hook', 'token'].includes(id) ? id : 'other',
      declaredHookPermissions: id === 'hook' ? ['beforeInitialize', 'beforeSwap', 'afterSwap', 'beforeSwapReturnDelta', 'afterSwapReturnDelta'] : null,
      runtimeImmutables,
    };
  });
  return {
    schemaVersion: 'programmable.launch-pack-config.v3', profileVersion: PROGRAMMABLE.profileVersion, launchWallet: c.launchWallet,
    chainId: '1', nonce: session.nonce,
    source: { root: '.', paths: SOURCE_PATHS,
      sourceLineageNonce: '1', publicOrigin: { url: c.publicSourceUrl, revision: c.publicSourceRevision } },
    compilationUnits: [{ compilationUnitId: 'elonomics-solc', standardJson: 'build/standard-json.json' }], targets,
    pool: { tokenTargetId: 'token', hookTargetId: 'hook', fee: 0, tickSpacing: 60, quoteCurrency: A.quote },
    projectMetadata: { schemaVersion: 'programmable.project-metadata-input.v1', token: { name: c.name, symbol: c.symbol },
      presentation: { description: c.description, image: { sourcePath: c.imageSourcePath, uri: c.imageUri },
        links: [{ kind: 'website', uri: new URL(c.website).toString() }, { kind: 'x', uri: c.x }] } },
    launchProfile: {
      schemaVersion: 'programmable.direct-native-hook-graph-profile-selection.v3', profileId: 'programmable.direct-native-hook-graph.v1', profileRevision: 3,
      targetRoles: { tokenTargetId: 'token', hookTargetId: 'hook', initializerTargetId: 'launcher', platformFeeBindingTargetId: 'hook' },
      liquidityModel: { schemaVersion: 'programmable.direct-native-liquidity-model-intent.v1',
        model: 'launch-seeded-concentrated-liquidity', declaredLaunchState: 'assessment_required', liquidityTargetId: 'launcher',
        assessment: { schemaVersion: 'programmable.direct-native-liquidity-model-assessment.v1', status: 'required',
          requestClaimsExecution: false, requiredVectorIds: ['liquidity.seeded.pool-active-liquidity',
            'liquidity.seeded.position-custody-and-withdrawal', 'liquidity.seeded.buy-and-sell'] } },
      fundingMode: 'wallet-transaction-value', accountingMode: 'inclusive-selected-total', assessmentBase: 'executed-gross-declared-quote',
      feeCurrency: 'declared-quote-currency', claimMode: 'immutable-payout-recipient', payoutRecipient: A.platformRecipient,
      applicantSelectedBuyHundredthsOfBip: '20000', applicantSelectedSellHundredthsOfBip: '20000',
    },
    permitWindow: { validAfter: session.validAfter, deadline: session.deadline },
    agentAttestation: { agentId: 'elonomics-local-build', checkedAt: session.checkedAt,
      checks: [{ checkId: 'exact-solc-build', evidence: 'build/build-evidence.json' }] },
  };
}

async function main() {
  const command = process.argv[2];
  if (!['pack', 'validate', 'check-config'].includes(command)) throw Error('Usage: node scripts/launch.mjs pack|validate|check-config');
  if (command === 'validate') {
    assertCliVersion();
    assertPackageProfile(JSON.parse(await readFile('launch.json', 'utf8')));
    console.log(JSON.stringify(await validateLaunchFile({ launchPath: 'launch.json', configPath: CONFIG_PATH }), null, 2));
    return;
  }
  const c = JSON.parse(await readFile('launch.config.json', 'utf8'));
  validateConfig(c);
  if (command === 'check-config') { console.log('Launch inputs complete; official pack validation still required.'); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14) throw Error('Programmable CLI requires Node >=24.14.0 <25');
  assertCliVersion();
  const output = await build();
  const digest = await inputDigest(c);
  let session;
  try { session = JSON.parse(await readFile(SESSION_PATH, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  if (sessionAction(session, digest, c.zapQuote, nowMs) === 'new') {
    session = { inputDigest: digest, nonce: `0x${randomBytes(32).toString('hex')}`, validAfter: String(now - 30),
      deadline: String(now + 3500), checkedAt: new Date().toISOString() };
    await writeFile(SESSION_PATH, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  }
  await writeFile('build/build-evidence.json', `${JSON.stringify({ compiler: '0.8.26+commit.8a97fa7a',
    inputDigest: digest, checkedAt: session.checkedAt, scope: 'local compilation only; no remote approval or transaction',
    targetCount: 4, feePartsPerMillion: { total: 20000, dividends: 10000, platform: 3000, dev: 7000 }, rewardDurationSeconds: 86400,
  }, null, 2)}\n`);
  await writeFile(CONFIG_PATH, `${JSON.stringify(makePackConfig(c, output, session), null, 2)}\n`, { mode: 0o600 });
  const packed = await packLaunch({ configPath: CONFIG_PATH, outputPath: 'launch.json', receiptPath: 'launch.receipt.json' });
  const launch = JSON.parse(await readFile('launch.json', 'utf8'));
  assertPackageProfile(launch);
  const validated = await validateLaunchFile({ launchPath: 'launch.json', configPath: CONFIG_PATH });
  await writeFile('build/deployment.expected.json', `${JSON.stringify(expectedDeployment(packed, launch), null, 2)}\n`);
  console.log(JSON.stringify({ scope: 'Local package only; addresses are predictions until deployed',
    cliVersion: PACKAGE_VERSION, profileVersion: launch.launchProfile.profileVersion,
    requestSha256: packed.requestSha256, reproducedFromConfig: validated.reproducedFromConfig,
    expectedDeployment: 'build/deployment.expected.json',
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
