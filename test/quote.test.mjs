import test from 'node:test';
import assert from 'node:assert/strict';
import { planZapQuote } from '../scripts/launch.mjs';

const base = { quoteOut: 134000000000000000n, devBuyWei: 20000000000000000n,
  initialFdvWei: 1100000000000000000n, supply: 10n ** 27n, slippageBps: 300 };

test('zap quote fixes the minimum output and a tick-aligned launch price near the target FDV', () => {
  const plan = planZapQuote(base);
  assert.equal(plan.minimumQuoteOut, '129980000000000000');
  assert.equal(plan.quotePerTokenTick, -187260);
  assert.equal(plan.effectiveFdvEth, '1.10086');
  assert.ok(Math.abs(Number(plan.effectiveFdvEth) / 1.1 - 1) < 0.006, 'tick rounding stays within 0.6% of the FDV');
});

test('more TSLA per ETH raises the TSLA-per-ELON launch tick', () => {
  assert.ok(planZapQuote({ ...base, quoteOut: base.quoteOut * 2n }).quotePerTokenTick > planZapQuote(base).quotePerTokenTick);
});

test('unusable quotes are rejected', () => {
  assert.throws(() => planZapQuote({ ...base, quoteOut: 0n }), /positive/);
  assert.throws(() => planZapQuote({ ...base, slippageBps: 10_000 }), /unusable/);
});
