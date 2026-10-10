import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalizeJson } from '@programmable/launch';
import { ADDRESSES as A, PROGRAMMABLE } from './constants.mjs';

// Pure checks of Programmable's public /v3/capabilities and /readyz bodies, shared by check-mainnet and readiness.
// Never assert profile or fee against the manifest: manifest version 12 still lists profile 3.3.0 and fee 1000.

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameAddress = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** The digest the CLI and the API publish as policyHash: sha256 over schemaVersion, a zero byte and canonical JSON. */
export function tradeFeePolicyHash(policy) {
  assert(isObject(policy) && typeof policy.schemaVersion === 'string', 'Routed-trade fee policy body is missing.');
  return `sha256:${createHash('sha256').update(Buffer.concat([Buffer.from(policy.schemaVersion, 'utf8'), Buffer.from([0]),
    Buffer.from(canonicalizeJson(policy), 'utf8')])).digest('hex')}`;
}

/** The routed-trade fee policies the installed CLI release lists in its profile 3.6.0 pack-config contract. */
export async function cliTradeFeePolicies() {
  const schema = JSON.parse(await readFile(new URL('../node_modules/@programmable/launch/schemas/programmable-launch-pack-config-v3.6.json', import.meta.url), 'utf8'));
  return schema['x-programmable-profile-3-6-contract'].supportedTradeFeePolicies;
}

/**
 * A { policyHash, policy } report must be the pinned policy, its hash must be the hash of the body it ships with, both
 * of its recipients must be the treasury ElonomicsHook pays, and fee collection must stay per-trade server evidence.
 */
export function validateTradeFeePolicy(report, source) {
  assert(isObject(report) && isObject(report.policy), `${source} has no routed-trade fee policy body.`);
  assert.equal(report.policyHash, PROGRAMMABLE.tradeFeePolicyHash, `${source} routed-trade fee policy changed; review the documentation and the hook recipient.`);
  assert.equal(tradeFeePolicyHash(report.policy), report.policyHash, `${source} routed-trade fee policy body does not hash to its policyHash.`);
  const { policy } = report;
  assert.equal(policy.policyVersion, PROGRAMMABLE.tradeFeePolicyVersion, `${source} routed-trade fee policy version changed.`);
  assert.equal(policy.ratePpm, '3000', `${source} routed-trade fee rate changed.`);
  for (const mode of ['defaultCollection', 'native30Waiver']) {
    assert(sameAddress(policy[mode]?.recipient, A.platformRecipient),
      `${source} ${mode} recipient is not ${A.platformRecipient}, the hook's platformRecipient.`);
  }
  assert.equal(report.collectionStatus, 'required-per-trade-evidence', `${source} routed-trade fee collection is no longer per-trade evidence.`);
  return { policyHash: report.policyHash, policyVersion: policy.policyVersion, recipient: policy.defaultCollection.recipient,
    collectionStatus: report.collectionStatus };
}

export function validateCapabilities(c) {
  const { profileVersion, platformFeeHundredthsOfBip } = PROGRAMMABLE;
  assert.equal(String(c?.chain?.id), '1', 'Capabilities chain is not 1.');
  assert.equal(c.profile?.profileId, 'programmable.direct-native-hook-graph.v1', 'Profile id changed.');
  assert.equal(c.profile?.profileRevision, 3, 'Profile revision changed.');
  assert.equal(c.profile?.profileVersion, profileVersion, `Active profile is not ${profileVersion}; review the CLI and launch config.`);
  assert.equal(c.profile?.productionLaunchAuthorized, true, 'Profile is not authorized for production.');
  assert.equal(c.profile36Release?.selected, true, `Profile ${profileVersion} is not selected by the server.`);
  assert(c.requestProfiles?.freshSubmissionExactVersions?.includes(profileVersion), `New requests no longer accept profile ${profileVersion}.`);
  assert.equal(c.feePolicy?.programmableHundredthsOfBip, platformFeeHundredthsOfBip, 'Server platform fee differs from the 3000 the hook charges.');
  assert.equal(c.feePolicy?.denominator, '1000000', 'Platform fee denominator changed.');
  assert.equal(c.feePolicy?.requiredForProfileVersion, profileVersion, `Fee policy does not belong to profile ${profileVersion}.`);
  assert.equal(c.profile36Release?.customHookAllowlistRequired, false, 'Custom hooks now require an allowlist.');
  assert.equal(c.profile36Release?.mandatoryCanonicalFeeVaultTarget, false, 'A canonical fee vault target is now mandatory.');
  assert.equal(c.profile36Release?.staticAdmissionBaseline, '3.3.0', 'Static admission baseline changed.');
  assert(c.graph?.minimumTargets <= 4 && c.graph?.maximumTargets >= 4, 'A four-target graph is no longer accepted.');
  assert(c.fundingModes?.includes('wallet-transaction-value'), 'Funding mode wallet-transaction-value is not available.');
  assert(c.liquidityModels?.includes('launch-seeded-concentrated-liquidity'), 'Liquidity model launch-seeded-concentrated-liquidity is not available.');
  const tradeFeePolicy = validateTradeFeePolicy(c.programmableTradeFeePolicy, 'Capabilities');
  // The displayed summary must name the same policy and treasury as the hashed body.
  assert.equal(c.currentTradeFeePolicy?.policyVersion, tradeFeePolicy.policyVersion, 'Displayed routed-trade fee policy differs from the hashed policy.');
  assert(sameAddress(c.currentTradeFeePolicy?.recipient, A.platformRecipient), 'Displayed routed-trade fee recipient is not the hook platformRecipient.');
  assert.equal(c.compiler?.exactBuild, '0.8.26+commit.8a97fa7a', 'Server compiler changed.');
  return { profile: c.profile, platformFee: c.feePolicy.programmableHundredthsOfBip,
    freshSubmissionExactVersions: c.requestProfiles.freshSubmissionExactVersions, tradeFeePolicy,
    compiler: c.compiler.exactBuild, onsiteTrading: c.onsiteTrading?.status };
}

export function validateReadiness(r) {
  assert(['ok', 'ready', 'available'].includes(r?.status), 'Programmable is not ready.');
  assert.equal(r.publicProfile?.currentWriteProfileVersion, PROGRAMMABLE.profileVersion, `Server write profile is not ${PROGRAMMABLE.profileVersion}.`);
  const tradeFeePolicy = validateTradeFeePolicy(r.programmableTradeFeePolicy, 'readyz');
  return { serviceStatus: r.status, currentWriteProfileVersion: r.publicProfile.currentWriteProfileVersion, tradeFeePolicy };
}
