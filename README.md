# Elonomics — ELON

An Ethereum Mainnet (`chainId: 1`) meme token implementation for the **Programmable Custom Launch V3, profile 3.6.0** path. The ELON token is created when the launch graph executes; no ELON token needs to exist beforehand. The target pair is ELON/TSLAon, with SPCXon rewards for ELON holders.

**Status:** code and local tests are available. This project does not yet have an ELON token, a pool, a mainnet transaction, a source publication, or a Programmable admission approval. Addresses in the rehearsal are predictions for sample data, not official token addresses. The production configuration is intentionally incomplete.

## Agreed fees

| Recipient | Buy | Sell | Asset when collected |
| --- | ---: | ---: | --- |
| Holder rewards | 1% | 1% | TSLAon, then converted to SPCXon |
| Programmable | 0.3% | 0.3% | TSLAon |
| Developer | 0.7% | 0.7% | TSLAon |
| **Hook total** | **2%** | **2%** | |

A buy of 100 TSLAon uses 98 TSLAon for the swap, 1 for rewards, 0.3 for the platform, and 0.7 for the developer. A sell with gross proceeds of 100 TSLAon pays out a net 98 TSLAon. Rounding in the smallest token unit goes to the reward share. The LP fee of the ELON/TSLAon pool is **0**; the LP position owner receives no separate LP fee.

Reward conversion uses TSLAon → USDC → SPCXon through two Uniswap v3 pools with a 1% fee each. The total deduction is about 1.99% of the converted funds, before price impact; gas is paid by the transaction caller. These fees are separate from the 2% hook. There is no promise of any reward amount or APY.

The 0.3% Programmable share follows the Ethereum Custom Hook policy confirmed by the Programmable team (7 October 2026) and is bound by profile 3.6.0, active since that evening. The package is built with the `@programmable/launch` CLI 4.1.4 or later, which packs profile 3.6.0 requests for Programmable's successor Router `0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3`; `npm run pack`/`validate` reject older CLIs and packages that are not profile 3.6.0, do not target that Router, or do not bind the 3000 (0.30%) platform fee, including old profile 3.3.0 packages that bind 0.10% and CLI 4.1.3 packages that target the legacy Router. Passing local `pack`/`validate` does not prove server certification of the fee: Programmable records 0.30% as a declaration bound to the request hash, not as a verified fee. If the live profile or the policy changes, stop preparation and reconcile again before the wallet signs. Details: [Programmable research](docs/programmable.md).

## Contract behavior

| Contract | Responsibility |
| --- | --- |
| [Elonomics.sol](src/Elonomics.sol) | ERC-20 ELON, fixed supply, SPCXon bookkeeping and claims |
| [ElonomicsHook.sol](src/ElonomicsHook.sol) | Fixed 2% pool fee, recorded as ERC-6909 claims in the PoolManager for three fixed recipients |
| [ElonomicsFeeProcessor.sol](src/ElonomicsFeeProcessor.sol) | Two-hop conversion with a TWAP-based minimum output |
| [ElonomicsLauncher.sol](src/ElonomicsLauncher.sol) | Called once by GraphFactory: ETH → TSLAon zap, pool initialization, an LP holding the entire supply with its NFT sent to the dead address, then the developer first buy |

Rewards are allocated linearly over **24 hours**, based on eligible balances over time. Additional funding while a stream is active is queued for the next 24 hours. Top-ups do not push back the active stream's deadline. Rewards already earned stay with the previous holder when ELON is transferred. New buyers only start earning subsequent allocations; a loan within the same transaction does not capture past allocations.

Holders use `claim()`; anyone can pay the gas for `claimFor(holder)`, but SPCXon is always sent to that holder. The contract does not airdrop to all wallets at once. This project runs no keeper: fee collection and conversion transactions must be triggered by an operator or another party. The 24-hour period starts when SPCXon funds arrive, not when the first TSLAon fee is collected.

Balances of the PoolManager, the ELON contract, the zero address, and the dead address are excluded. **ELON in the LP position does not earn holder rewards.** If all eligible balances disappear, the stream stops counting time until an eligible balance exists again; new funding is rejected while there are no eligible holders. Treasury/dev wallets holding ELON remain eligible. Other contracts that receive ELON are also eligible and must be able to claim rewards themselves. SPCXon transferred directly to the ELON contract is not recorded as funding; use `fundRewards()`.

ELON has no owner, no additional minting, no fee setter, no upgrades, and no admin withdrawal of reward funds. The agreed supply is **1,000,000,000 ELON**, with 18 decimals. The entire supply is minted to the launcher and, in the same launch transaction, goes into the LP position whose NFT is sent to the dead address. There is no team allocation; the developer obtains ELON only through the first buy at the pool price. The contract's technical supply limit is `uint128` in base units. Very small rewards can leave dust of fractional base units.

The hook applies only to the registered ELON/TSLAon PoolKey, with LP fee 0 and tick spacing 60. **Plain transfers and other pools are not charged this hook fee.** Swaps use exact input; exact output is rejected. A buy that does not consume its entire input after the fee is rejected, so that the fee is never charged on a part of the input that was not swapped.

## One-transaction launch

The Programmable launch transaction carries `devBuyEth` (default 0.02 ETH). Inside the graph, `ElonomicsLauncher.launch`:

1. swaps all of that ETH for TSLAon through SwapRouter v3 along the route WETH → USDC (0.05% pool) → TSLAon (1% pool), using the minimum output from `npm run quote`;
2. initializes the ELON/TSLAon pool at a price that makes the initial FDV equal to `initialFdvEth` (default 1.1 ETH); this FDV is only a price, not capital;
3. places 100% of the ELON supply in a single-sided LP position from the initial price up to the maximum tick, with the position NFT minted directly to `0x000000000000000000000000000000000000dEaD` so that no one can withdraw it;
4. buys ELON for `devBuyRecipient` directly through the PoolManager with all of the TSLAon from the zap; the hook collects the 2% fee as on a normal buy.

If any step fails, the entire launch transaction reverts. The developer share follows `net / (FDV + net)`, where `net` = the dev buy after the 2% fee: 0.02 ETH at an FDV of 1.1 ETH yields about 1.75% of the supply. The launcher compares its balances with a snapshot taken on entry, so dust that others send to the launcher address before launch cannot make the launch fail and stays held there. The zap is used only at launch. After that, anyone buys and sells through routers that support Uniswap v4 pools with hooks, for example the Universal Router; support in specific bots or terminals (GMGN, BasedBot, Banana, and others) is determined by those services and needs to be checked once the pool is live.

The TSLAon market is thin: the 1% USDC/TSLAon pool used by the zap is the deepest TSLAon pool on Uniswap v3, worth about 72,000 USD in the 7 October 2026 research. Buyers starting from ETH pay v3 pool fees of about 1.05% (0.05% + 1%) to obtain TSLAon, on top of the 2% hook fee and price impact.

## Local setup

Use Node **24.14.0 or later within major version 24**, npm, and Foundry with solc 0.8.26. Dependency versions and the Programmable CLI are locked in `package-lock.json`; new profile 3.6.0 requests require CLI 4.1.4 or later (the official `programmable-launch-v4.1.4` release is locked).

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run rehearsal
npm run check:mainnet
```

`rehearsal` uses a fixture wallet, URLs, supply, zap quote, and image in a temporary directory. It checks that the installed CLI is at least 4.1.4, runs the official pack/validate, ensures the package uses profile 3.6.0 with a 3000 platform fee and the successor Router, and proves that the bytes of a repeated pack are identical. Its summary is saved to `build/rehearsal-result.json`. The official `productionLaunchAuthorized` field in the CLI output is a profile attribute, not an approval for this project.

[Test evidence and limits](docs/verification.md) details what has been run and the mainnet checks that are still required.

`check:mainnet` only reads, including the two zap route pools, the quote for `devBuyEth`, profile 3.6.0 and the 3000 platform fee in capabilities, and the successor Router's runtime code hash and its GraphFactory and PoolManager bindings on chain. Programmable's manifest version 12 still lists only the legacy Router; the checker accepts that entry only with the legacy Router's exact runtime hash. Exit 1 means an invariant differs; exit 2 means a service or data is not ready yet or cannot be proven yet. In the 7 October 2026 check, Programmable's `/readyz` returned HTTP 503 and the public RPC header was cached; on 8 October 2026 `/readyz` was `ready` with profile 3.6.0. The USDC/SPCXon reward pool stores only one oracle observation, so `observe([1800, 0])`, and therefore `convert`, succeeds only while that pool's last swap is at least 30 minutes old, and fails again after every new swap; one successful TWAP call does not make the history reliable. Before relying on `convert`, run `prepare-oracle` (about 10.3 million gas), then wait for 30 minutes of history to fill. The checker needs an RPC that still serves the genesis block; a node with pruned history makes the `chain` check report `unavailable`. [Asset research and read evidence](docs/stock-tokens.md).

## Production inputs still required

Fill in [launch.config.json](launch.config.json). All amounts use **decimal strings**, not wei: `"1000000000"` means one billion tokens and `"0.02"` means 0.02 ETH. This explains the format; it is not a supply or price recommendation.

| Input | Description |
| --- | --- |
| `launchWallet` | Public wallet that controls the Programmable request and pays for the launch transaction |
| `devRecipient` | Fixed recipient of the 0.7% developer fee in TSLAon |
| `devBuyRecipient` | Recipient of the ELON from the developer first buy |
| `totalSupply` | Already set to `"1000000000"`; cannot be increased after deployment |
| `initialFdvEth` | Initial FDV in ETH (default `"1.1"`); sets the pool price and requires no capital |
| `devBuyEth` | ETH for the first buy (default `"0.02"`); becomes the launch transaction value |
| `zapSlippageBps` | Tolerance of the ETH → TSLAon zap output relative to the quote (default 1000 = 10%, maximum 1000). Manual review can take up to 24 hours before the controller starts the launch, so the rate frozen at quote time may be stale; this limit only caps the worst case for the zap portion (at most 10% of 0.02 ETH) and avoids a launch transaction failing because of a small price move |
| `zapQuote` | Filled in by `npm run quote`; binds the minimum TSLAon and the initial price tick, valid for 30 minutes for pack |
| `imageSourcePath`, `imageUri` | Local PNG/JPEG/WebP/GIF file and a public URI for the same image bytes |
| `website`, `x` | Public HTTPS website and `https://x.com/handle` profile; required by this profile's metadata |
| `publicSourceUrl`, `publicSourceRevision` | Public HTTPS repository and the exact commit that contains that source |

Oracle defaults: a 1,800-second window and a maximum slippage of 100 bps (1%) relative to the TWAP quote after conversion fees. These values are not the result of a market risk calibration and must be reviewed against actual pool depth. Both Ondo assets are pinned in `scripts/constants.mjs`; do not swap in a different ticker/address as a substitute without an accounting and liquidity review.

The website/X can be prepared after the code, but **must be available before the production launch package is accepted**. Launch capital is ETH only: `devBuyEth` plus gas. The wallet does not need to hold TSLAon or ELON. The API key is created while `launchWallet` is connected on the Programmable API keys page, with the scopes `custom-launch:create` and `custom-launch:read`. The chain restriction is set by the server, not chosen when creating the key; make sure that page shows the Ethereum (1) chain restriction and the `launchWallet` wallet for that key, then store the key as the local secret `PROGRAMMABLE_API_KEY`, not in source or chat.

## Launch flow

1. Complete the inputs above, publish the source at a fixed revision, and review the contracts together with the configuration. No independent audit has been performed as part of this work.
2. Run the local and mainnet checks. Resolve Programmable service readiness and the oracle history; also review the eligibility/pause status of the Ondo assets.
3. With `MAINNET_RPC_URL` in the environment, run `npm run quote`. The script fetches a Uniswap quote for `devBuyEth` along the zap route, then writes `zapQuote` (the minimum TSLAon and the initial price tick) to `launch.config.json`.
4. Within 30 minutes of the quote, run `npm run check:mainnet` (capabilities must show profile 3.6.0 with fee 3000), then `npm run pack`, then `npm run validate`; pack rejects an older quote when creating a new session. Pack and validate require Node 24.14+ and the `@programmable/launch` CLI 4.1.4 or later. The tool builds four targets with the official CLI, runtime immutable bindings, source bundle, metadata, hook permission mask, nonce, and permit window. `build/deployment.expected.json` contains the **predicted** addresses and runtime hashes.
5. Run `npm run readiness` with Node 24 and `MAINNET_RPC_URL` in the environment, and continue only if every line is `PASS` ([list of checks](#readiness-before-submit)). Then perform server validation with the official CLI: `npx --no-install programmable-launch validate launch.json --config programmable-launch.config.json --remote`. The `launch-seeded-concentrated-liquidity` model is declared `assessment_required`; profile 3.6.0 does not yet run its three-vector liquidity assessment, so the liquidity claim remains unverified by the server. This command requires CLI 4.1.4 or later; it reads the public capabilities first and rejects a profile 3.6.0 package if the server no longer selects that profile. Remote preflights on 8 October 2026 and, with a CLI 4.1.4 package, on 9 October 2026 returned `needs_evidence` with no hard-block findings ([details](docs/verification.md)); run it again against the final package.
6. Submit the exact package through the official CLI with the wallet's API key. Submitting also creates a **manual review** by the Programmable team, with a target of 24 hours from `manualReview.submittedAt`. During that time, the `pending_review` status means waiting for that review, and there is no wallet action. Once the target has passed, `reviewOverdue` is true but the request stays open; there is no automatic approval or rejection. Ask the Programmable team to approve it and give them the request ID. Do not change the package bytes in the middle of a retry.
7. Approval opens a separate 24-hour window that ends at `manualReview.expiresAt`. When the controller is ready, choose **Start launch** in the Programmable wallet handoff, or call `POST /v1/custom-launch-reviews/start` with the same wallet API key and the JSON `{"chainId": "1", "launchId": "<request ID>"}` ([launch-day steps](docs/operations.md#launch-day)). The response contains `launchRequestedAt` and `launchDeadline`; starting again is idempotent and does not extend any window.
8. For a request packed with CLI 4.1.4, the prepared transaction can be signed up to 24 hours after approval according to Programmable's release notes, and never past `manualReview.expiresAt`; starting does not extend that limit. Requests packed with CLI 4.1.3 or earlier keep the legacy Router and its one-hour transaction limit, and such a request that has not been started must be packed again for a new review. Review the transaction in the wallet and sign before `launchDeadline`. The wallet must show **Ethereum chain ID 1**, the successor Router `0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3`, the same graph, and a transaction value equal to `devBuyEth` excluding gas. The CLI/API key does not sign for the wallet.
9. After the transaction is confirmed, verify all four contracts and the `Launched` event. Use the runtime hashes from pack, not just the addresses. Make sure the position NFT is owned by the dead address, the position liquidity is greater than zero, and `devBuyRecipient` received ELON. There is no liquidity-adding step.
10. Test a small buy and sell, output limits, fees, fee collection, conversion, and claims before announcing trading.

`npm run pack` stores a local session. Changing the source, image, config (including a new `zapQuote`), or lockfile, or the expiry of the permit window, requires a new session; while the session is still open, re-packing with the same inputs is still allowed even if the quote is more than 30 minutes old. Archive `build/launch-session.json`, `launch.json`, `launch.receipt.json`, and `programmable-launch.config.json` before creating a new request. For a request that has already been submitted, follow the official status. Reissuing a permit for a transaction that was issued and then expired is not supported; keep the request ID and receipt, then follow the [Programmable recovery guide](https://programmable.market/developers/custom-launch-recovery-v1.md) (the `request_new_review` action means requesting a new approval). Do not create a new nonce to complete a retry that is still in progress, and do not change the calldata, resubmit, or send a second transaction while the outcome of the previous send is still unclear.

An ERC-20 pair can go into a Programmable graph, but that does not prove the website's trading button supports its route. In the 8 October 2026 research, Ethereum swap routes on the Programmable website were only created for pools with native ETH as `currency0`, and capabilities showed onsite trading as disabled; ELON/TSLAon has no route on that website, so Programmable's 0.30% routing fee does not apply to ELON trades. The operational builder uses the Uniswap v4 Universal Router for exact-input ELON/TSLAon; it prepares calldata without signing or sending transactions. [Operations guide](docs/operations.md).

## Readiness before submit

`npm run readiness` only reads: the config, the package files, Programmable capabilities and `/readyz`, GitHub, the website, and the quote block and launch wallet balance via RPC. The script prints one `PASS`, `WAIT`, or `FAIL` line per check. `WAIT` means an input, file, service, or release is not available yet; `FAIL` means something is wrong and must be fixed. Run it with Node 24.14+ and `MAINNET_RPC_URL` in the environment, after `npm run pack` and still within 30 minutes of `npm run quote`. The script does not print the RPC URL or the API key; for `PROGRAMMABLE_API_KEY` it only reports whether it is present in the environment.

| Check | `PASS` when |
| --- | --- |
| `config` | `launch.config.json` is complete and consistent (`validateConfig`) |
| `zapQuote` | `zapQuote` is at most 30 minutes old and `quotedAt` equals the timestamp of block `blockNumber` |
| `runtime` | Node 24.14+ and `@programmable/launch` 4.1.4 or later |
| `programmable` | capabilities select profile 3.6.0, 3.6.0 accepts new requests, platform fee 3000, and `/readyz` is ready |
| `wallet` | the `launchWallet` balance is at least `devBuyEth` plus a 0.02 ETH gas reserve |
| `source` | the `publicSourceUrl` repository is public, `publicSourceRevision` exists there, and the local `SOURCE_PATHS` and `imageSourcePath` file match that revision with no uncommitted changes |
| `image` | the `imageSourcePath` file exists; its sha256 is printed for matching against `imageUri` |
| `website` | `website` answers HTTPS 200 |
| `apiKey` | `PROGRAMMABLE_API_KEY` is present in the environment |
| `package` | `launch.json` exists, profile 3.6.0 with fee 3000 for the successor Router, `validate` reproduces the same bytes, the package comes from the `build/launch-session.json` session created from the current config, source, build, and image (a new quote after pack makes it `FAIL`), and at least 10 minutes of the permit window remain |
| `cliRelease` | `package-lock.json` locks the official CLI 4.1.4 release and `node_modules` matches it; any other pin is a `FAIL` |

Exit code `0` means everything is `PASS`, `1` means there is a `FAIL`, and `2` means there is no `FAIL` but at least one `WAIT` remains. Passing readiness replaces neither server validation (`--remote`) nor reviewing the transaction in the wallet.

## Public description

> Elonomics (ELON) is an Ethereum meme token with an ELON/TSLAon market. A 2% buy and sell hook fee allocates 1% to SPCXon rewards for eligible ELON holders, 0.3% to Programmable, and 0.7% to the developer. Rewards are funded by collected trading fees, converted through available liquidity, and distributed over 24 hours. Rewards vary with trading activity and conversion costs; they are not SpaceX corporate dividends. Elonomics is independent of Elon Musk, Tesla, SpaceX, and Ondo.

This description is a draft for a configuration that has not been deployed. TSLAon/SPCXon are issuer products with compliance, pause, and upgrade controls; both use the same Ondo pause manager and beacon. A TSLAon pause halts ELON buys, sells, and hook fee claims. If the issuer rejects an SPCXon claim, the claim transaction fails and the holder's entitlement stays recorded; ELON transfers remain separate. The TWAP limits the conversion price, but does not guarantee protection against prolonged manipulation or loss of liquidity. Older claims can also be affected by balance changes/burns by the issuer. See the [tokenized stocks research](docs/stock-tokens.md) for sources and verification limits.
