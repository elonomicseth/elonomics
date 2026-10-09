import assert from 'node:assert/strict';
import { PROGRAMMABLE } from './constants.mjs';

// Pure checks of Programmable's public /v3/capabilities and /readyz bodies, shared by check-mainnet and readiness.
// Never assert profile or fee against the manifest: manifest version 12 still lists profile 3.3.0 and fee 1000.

export function validateCapabilities(c) {
  const { profileVersion, platformFeeHundredthsOfBip, tradeFeePolicyHash } = PROGRAMMABLE;
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
  assert.equal(c.programmableTradeFeePolicy?.policyHash, tradeFeePolicyHash, 'Programmable routed-trade fee policy changed; review the documentation.');
  assert.equal(c.compiler?.exactBuild, '0.8.26+commit.8a97fa7a', 'Server compiler changed.');
  return { profile: c.profile, platformFee: c.feePolicy.programmableHundredthsOfBip,
    freshSubmissionExactVersions: c.requestProfiles.freshSubmissionExactVersions, tradeFeePolicyHash,
    compiler: c.compiler.exactBuild, onsiteTrading: c.onsiteTrading?.status };
}

export function validateReadiness(r) {
  assert(['ok', 'ready', 'available'].includes(r?.status), 'Programmable is not ready.');
  assert.equal(r.publicProfile?.currentWriteProfileVersion, PROGRAMMABLE.profileVersion, `Server write profile is not ${PROGRAMMABLE.profileVersion}.`);
  assert.equal(r.programmableTradeFeePolicy?.policyHash, PROGRAMMABLE.tradeFeePolicyHash, 'Routed-trade fee policy in readyz changed.');
  return { serviceStatus: r.status, currentWriteProfileVersion: r.publicProfile.currentWriteProfileVersion };
}
