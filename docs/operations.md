# Launch and post-deployment operations

All `scripts/transactions.mjs` commands below **produce unsigned transactions**. The script does not accept private keys, sign, or broadcast. Use Node 24.14+ within major version 24 and an Ethereum chain ID 1 wallet.

## Launch day

The sequence: submit → manual review → approval → **Start launch** → signing before `launchDeadline` → finality. The API key only authorizes the API; the transaction is reviewed, signed, and sent by the controller wallet.

1. **Submit.** Once `npm run readiness` is entirely `PASS` and remote validation has been run against the final package, submit the exact package through the official CLI with the `PROGRAMMABLE_API_KEY` that belongs to `launchWallet`. Keep the request ID and `launch.receipt.json`. Do not change the package bytes or the idempotency key in the middle of a retry.
2. **Manual review.** Submitting also creates a review by the Programmable team, with a target of 24 hours from `manualReview.submittedAt`. During that time, the `pending_review` status means waiting for that review, and there is no wallet action. Ask the Programmable team to approve it and give them the request ID. Once the target has passed, `reviewOverdue` is true but the request stays open; there is no automatic approval or rejection. Poll the same resource after `Retry-After`; do not resend the creation request just to poll.
3. **Approval.** Approval opens a separate 24-hour window that ends at `manualReview.expiresAt`. The controller starts the launch when ready, as long as that window is still open.
4. **Prepare the balance.** `launchWallet` needs ETH for the `devBuyEth` transaction value (0.02 ETH) plus a gas reserve. `npm run readiness` requires a balance of at least `devBuyEth` plus 0.02 ETH; the recommended balance is about 0.05 ETH. Check the balance again right before Start launch, because the review can take 24 hours or more.
5. **Start launch.** Choose **Start launch** in the wallet handoff. Alternatively, call the API with the same wallet API key, in the same authorization header the CLI uses (the key value is not included in this document; replace `<request ID>` with the request ID):

   ```sh
   curl --fail-with-body --request POST \
     --header "Authorization: Bearer $PROGRAMMABLE_API_KEY" \
     --header "Content-Type: application/json" \
     --data '{"chainId": "1", "launchId": "<request ID>"}' \
     https://api.programmable.market/v1/custom-launch-reviews/start
   ```

   The response contains `launchRequestedAt` and `launchDeadline`. After starting, poll the same resource for the prepared wallet action. Starting again is idempotent: it does not extend any window and does not replace a transaction that has already been issued.
6. **Signing.** The prepared transaction is valid for at most one hour and never past `manualReview.expiresAt`. Before signing, refetch the handoff and check **Ethereum chain ID 1**, the canonical Router `0x8622DD5bAb44185f2A458ac90384Ac99248f8d56`, the same graph, a transaction value equal to `devBuyEth` excluding gas, and the gas. Sign and send before `launchDeadline`, then keep the transaction hash and monitor it until finality without resending.
7. **Expired transaction.** Reissuing a permit for a transaction that was issued and then expired is not supported. Keep the request ID and all receipts, then follow the [Programmable recovery guide](https://programmable.market/developers/custom-launch-recovery-v1.md): the `Programmable-Next-Action` header gives the next step, and `request_new_review` means requesting a new approval (resubmitting does not extend a window that has already ended). While the outcome of the previous send is still unclear, do not change the calldata, resubmit, or send a second transaction.

After finality, continue with the checks of the four contracts, the LP position, and the first-buy recipient in the README, then with the sections below.

## Deployment identity

`npm run pack` produces `build/deployment.expected.json`. This file contains the four predicted addresses and the runtime hashes from the official CLI. Once the mainnet receipt matches the package, copy it to `deployment.json` for operations:

```sh
cp build/deployment.expected.json deployment.json
node scripts/transactions.mjs --help
```

Copying does not prove that the contracts have been deployed. Every command checks the chain ID, the latest header, the runtime hashes of all four contracts, the relationships between the contracts, decimals, and the launcher status (`launched`) through `MAINNET_RPC_URL` at a single block number. Empty/undeployed addresses and mismatched hashes are rejected. Provide a private RPC as an environment secret; the script does not print that URL.

Use `WALLET` as the sender's public address, and `DEADLINE` as an explicit UNIX timestamp within the next hour. The sender needs ETH for gas. The `from` field in the JSON must equal the wallet used to sign. Review `chainId`, `to`, `value`, `data`, amounts, recipients, and expiry before execution.

## Liquidity

There is no liquidity step after deployment. The launch transaction has already placed the entire ELON supply in a single-sided LP position and sent its position NFT to `0x000000000000000000000000000000000000dEaD`. Take the `tokenId` from the launcher's `Launched` event, then confirm that `ownerOf(tokenId)` on the PositionManager `0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e` is that dead address and that `getPositionLiquidity(tokenId)` is greater than zero. No one can withdraw that position. The pool LP fee is 0, so the position collects no fees.

## Buy and sell

Use TSLAon to buy and ELON to sell. `AMOUNT` and `MIN_OUT` are decimal amounts in token units; `MIN_OUT` must be positive and must already account for the 2% hook fee. Get a fresh quote for the amount to be executed, including price impact. The script does not guess the minimum output.

```sh
node scripts/transactions.mjs buy --deployment deployment.json \
  --from "$WALLET" --amount "$AMOUNT" --min-out "$MIN_OUT" \
  --deadline "$DEADLINE" > transactions.json

node scripts/transactions.mjs sell --deployment deployment.json \
  --from "$WALLET" --amount "$AMOUNT" --min-out "$MIN_OUT" \
  --deadline "$DEADLINE" > transactions.json
```

For a buy, the minimum output is in ELON; for a sell, it is in net TSLAon after fees. The builder uses the Universal Router with `V4_SWAP`, `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, and `TAKE_ALL`. The output goes to the sender. It rejects pools without liquidity and pools whose LP/protocol fee is non-zero. The final transaction must be simulated again in the wallet after approval; a quote or snapshot is not a guarantee of execution.

The output contains an ERC-20 approval to Permit2 and a Permit2 approval to the Universal Router, then the swap transaction. An old approval that does not equal the amount is reset to zero. The approval amount is limited to the input; the Permit2 approval expires at `DEADLINE`. The ERC-20 approval itself has no expiry, so any remaining allowance can be revoked after use.

## Fees and rewards

Anyone can trigger the three fee claims. The recipients are fixed in the contract; the caller cannot take another party's share.

```sh
node scripts/transactions.mjs claim-dividends --deployment deployment.json --from "$WALLET"
node scripts/transactions.mjs claim-platform --deployment deployment.json --from "$WALLET"
node scripts/transactions.mjs claim-dev --deployment deployment.json --from "$WALLET"
```

`claim-dividends` moves TSLAon from the hook to the processor. At the time of research, the USDC/SPCXon reward pool stored only one observation, so the 30-minute TWAP used by `convert` is available only while that pool's last swap is at least 30 minutes old, and disappears again after every new swap. Before relying on `convert`, prepare and execute the following transaction (about 10.3 million gas in the 7 October 2026 research), then wait for 30 minutes of history to fill:

```sh
node scripts/transactions.mjs prepare-oracle --deployment deployment.json --from "$WALLET"
npm run check:mainnet
```

The default 30-minute window targets a capacity of 256 observations on both pools. Adding capacity does not create history; wait for pool activity to fill it. Capacity grows by at most 256 slots per pool per call, so that choosing a long window does not require one overly large transaction. Check again that `observe([1800, 0])` succeeds, and check the pool depth.

After the dividend claim is confirmed, choose a conversion batch that is reasonable relative to pool depth and gas cost:

```sh
node scripts/transactions.mjs convert --deployment deployment.json \
  --from "$WALLET" --amount "$AMOUNT"
```

`AMOUNT` is in TSLAon. The script runs an `eth_call` simulation and shows the minimum SPCXon limit at the checked block. The contract recomputes the minimum from the TWAP at execution. The route, recipient, and slippage limit are not chosen by the caller. If the issuer rejects a transfer, the swap fails, the price is below the minimum, or there are no eligible holders, the entire conversion and funding revert atomically; the TSLAon is not spent.

A successful conversion calls `ELON.fundRewards(received)` directly. The funds go into a new 24-hour stream, or into the queue if a stream is still running. There is no need to call `fundRewards` separately for the processor's output.

Holders can prepare a reward claim:

```sh
node scripts/transactions.mjs claim-rewards --deployment deployment.json --from "$WALLET"
```

The claimable balance can be read through `claimableRewards(holder)`. A claim that fails because of SPCXon policy does not erase the entitlement and does not stop ELON transfers. Rewards do not automatically become ETH/USDC; holders receive SPCXon tokens subject to the applicable issuer restrictions.

## Limits of the evidence

The project tests run the accounting, hook, and launcher against the real Uniswap v4 PoolManager and PositionManager on a local EVM, with mocks for the issuer/V3 swap in the processor and launcher tests. The official rehearsal verifies the profile 3.6.0 pack, immutable materialization, hashes, and byte reproducibility. The fork test `test/ElonomicsLaunch.fork.t.sol` runs the launch against the mainnet SwapRouter, PoolManager, PositionManager, and TSLAon, then buys and sells through the Universal Router, only if `MAINNET_RPC_URL` is available; the test contract stands in for GraphFactory. **The Programmable graph, the canonical Router, server admission, reward conversion through the Ondo route, and wallet transactions have not been tested.**

Do not treat the profile's `productionLaunchAuthorized` metadata, a passing local pack, or predicted addresses as evidence of deployment, liquidity, fee certification, or an independent security audit.
