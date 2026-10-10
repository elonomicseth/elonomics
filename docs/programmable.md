# Programmable integration for Elonomics

This research covers **Ethereum Mainnet, chain ID 1** only. It was checked on 7 October 2026, updated on 8 October 2026 after Programmable activated profile `3.6.0`, updated on 9 October 2026 for CLI `4.1.4` and the successor Router, and updated on 10 October 2026 for CLI `4.1.5` and Programmable's current treasury. Elonomics uses the **Custom Launch V3** path, profile `3.6.0`, the `@programmable/launch` CLI `4.1.5`, and compiler `0.8.26+commit.8a97fa7a`. The API version, the profile, and the CLI are distinct identities. [Ethereum capabilities](https://api.programmable.market/v3/capabilities), [API and CLI reference](https://programmable.market/developers/custom-launch-api-v1.md).

## Why the token is created through a deployment graph

The user does not need to hold an ELON token beforehand. The project graph deploys four new contracts: `Elonomics`, `ElonomicsHook`, `ElonomicsFeeProcessor`, and `ElonomicsLauncher`. The token, hook, launcher, predicted CREATE2 addresses, source, and post-initialization runtime are bound in a single request.

SPCXon and TSLAon already exist and are external references, not stock tokens reissued by this project. The profile accepts both native/ERC-20 and ERC-20/ERC-20 pairs, with one primary token, hook, and pool, and 3–16 deployment targets. The primary token and the hook must have different addresses. [Capabilities, graph and architectureSupport sections](https://api.programmable.market/v3/capabilities).

**Do not deploy ELON separately and then try to add a stamp.** The Launch Stamp applies to new deployment output through the canonical Router. The direct CustomGraph path also requires authorization from the Programmable authority through EIP-1271; the creator wallet's signature alone is not enough. [Ethereum direct guide](https://programmable.family/developer-reference/ethereum-custom-hook).

## The flow as seen on the website

The [Launch page](https://programmable.family/launch) offers a choice between Module Mode and Custom hook. Elonomics needs Custom hook because the fees, the TSLAon pair, reward conversion, and holder accounting are built into the project's contracts.

At the time of this check, the Custom hook link on the general page pointed to `chainId=4663`. For this project, open [API keys with the Ethereum chain set explicitly](https://programmable.family/developers/api-keys?chainId=1&start=custom), and still check chain `1` in both the request and the wallet. Do not follow the general page's default network.

The API keys page describes the user flow: connect a wallet and create an API key, give the specification to the builder, then open the review link for the builder's output and confirm the transaction through the wallet. The API key is stored as the secret `PROGRAMMABLE_API_KEY`, with the scopes `custom-launch:create` and `custom-launch:read` and a chain restriction that includes `1`; the wallet API key must also be bound to `launchWallet`, and both are visible on the API keys page. The API key grants no right to sign or send wallet transactions. [API keys page](https://programmable.family/developers/api-keys), [capabilities authentication contract](https://api.programmable.market/v3/capabilities).

The technical Ethereum flow is:

```text
complete source and configuration
→ local build and pack
→ local and remote/preflight validate
→ submit exactly the same request
→ pending_review: manual review by the Programmable team (target 24 hours from manualReview.submittedAt)
→ approval: 24-hour window until manualReview.expiresAt
→ Start launch (wallet handoff or POST /v1/custom-launch-reviews/start)
→ wallet action prepared (CLI 4.1.4 or later requests: signing up to 24 hours after approval; never past expiresAt)
→ transaction review in the wallet
→ broadcast by the wallet before launchDeadline
→ finalized
```

Submitting also creates a manual review by the Programmable team. Its target is 24 hours from `manualReview.submittedAt`; after that, `reviewOverdue` is true and the request stays open, with no automatic approval or rejection. The `pending_review` status means waiting for that review and has no wallet action. Approval opens a separate 24-hour window that ends at `manualReview.expiresAt`. When the controller is ready, it chooses **Start launch** in the wallet handoff or calls `POST /v1/custom-launch-reviews/start` with the same wallet API key and the JSON `{"chainId": "1", "launchId": "<request ID>"}`; the response contains `launchRequestedAt` and `launchDeadline`. For a request packed with CLI 4.1.4 or later, the prepared transaction can be signed up to 24 hours after approval according to Programmable's release notes and its 10 October 2026 review, and never past `manualReview.expiresAt`; requests packed with CLI 4.1.3 or earlier keep the legacy Router and its one-hour transaction limit, and such a request that has not been started must be packed again for a new review. Starting again is idempotent and does not extend any window. Signing must be completed before `launchDeadline`. Reissuing a permit for a transaction that was issued and then expired is not supported: keep the request ID and receipt, then follow the [recovery guide](https://programmable.market/developers/custom-launch-recovery-v1.md) (the `request_new_review` action means requesting a new approval).

Use the HTTPS `walletHandoffUrl` returned by the server while it is still valid. Before signing, check the chain, controller, destination Router, calldata, ETH value, and gas. Retries use the same request bytes and idempotency key; changes to the source or metadata require a new package. [V3 lifecycle reference](https://programmable.market/developers/custom-launch-api-v1.md).

This repository launches the market inside the same graph transaction. The `launcher` target is the graph initializer (`initializerTargetId`) and is called with an `initializerValueWei` of `devBuyEth`, so the package uses `fundingMode: wallet-transaction-value` and the wallet pays that value along with gas. Its liquidity model is `launch-seeded-concentrated-liquidity` with `liquidityTargetId: launcher` and `declaredLaunchState: assessment_required`; the request asks the server to assess three vectors: `liquidity.seeded.pool-active-liquidity`, `liquidity.seeded.position-custody-and-withdrawal`, and `liquidity.seeded.buy-and-sell`. On profile `3.6.0` the server does not yet run that assessment, so the liquidity claim remains unverified. The launcher swaps ETH for TSLAon, initializes the pool, locks the entire supply in a single-sided LP with its NFT sent to the dead address, then performs the developer first buy. The server can still reject the request, and submitting creates a manual review by the Programmable team (status `pending_review`); passing a local pack is not proof of admission.

## Different versions and fee policies

The public documentation has several paths that must not be mixed:

| Path | Relevant status or terms |
| --- | --- |
| Ethereum Custom Launch API V3 profile `3.6.0` | Active since 7 October 2026 and the only version that accepts new requests; platform fee 3000 (0.30%); used by this repository. |
| API V1/V2 | History and old recovery; fresh POSTs are rejected as read-only. |
| Profile `3.3.0` | Legacy: old requests can be read and replayed exactly, new requests are rejected. This profile binds a platform fee of 1000 (0.10%). |
| Profiles `3.4.0` and `3.5.0` | Not active for production in the capabilities at the time of research. |
| Programmable trading route (profile `3.6.0`) | Programmable's own ETH route charges an extra 30 bps in ETH, paid to its treasury `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`. A custom hook allocation does not automatically waive it: the API verifies the applicable collection mode per trade, and only Programmable's exact Native30 hook and vault runtime qualify for the waiver. It does not apply to external routers. Onsite trading was disabled at the time of research. |
| Ethereum manifest version 12 | Still lists profile `3.3.0`, a 0.10% platform fee, and only the legacy Router; for new requests, the capabilities and the CLI release are what apply. |
| CLI `4.1.3` or earlier on profile `3.6.0` | Packs requests for the legacy Router `0x8622DD5bAb44185f2A458ac90384Ac99248f8d56` with a one-hour transaction limit; an unstarted request of that kind must be packed again for a new review. |
| CLI `4.1.4` on profile `3.6.0` | Packs requests for the successor Router `0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3`; signing up to 24 hours after approval according to Programmable's release notes. Knows only the earlier treasury policy, which current capabilities no longer publish. |
| CLI `4.1.5` on profile `3.6.0` | Same successor Router. A fresh pack (no explicit profile version) reads `/v3/capabilities` and binds the current treasury policy `programmable.ethereum-routed-native-fee.v2`, whose claim authority and payout recipient are `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`; a pack with an explicit profile version keeps the earlier policy. Used by this repository, always as a fresh pack. |

[V3 API reference](https://programmable.market/developers/custom-launch-api-v1.md), [fees by contract version](https://programmable.market/docs/developers/machine-readable/fee-versions.md), [current fees](https://programmable.market/docs/launch/economics.md).

The Elonomics contracts implement a **2% total fee**, with `inclusive-selected-total` accounting:

| Allocation of the gross TSLAon quote | Percentage | Parts per million |
| --- | --- | --- |
| Holder reward fund | 1.00% | 10000 |
| Programmable | 0.30% | 3000 |
| Developer | 0.70% | 7000 |
| Total | 2.00% | 20000 |

The 0.30% Programmable share follows the Ethereum Custom Hook policy confirmed by the Programmable team on 7 October 2026. Since profile `3.6.0` became active, `/v3/capabilities` states `feePolicy.programmableHundredthsOfBip` 3000 for that profile, and CLI 4.1.5 binds 3000 in both `platformFeePolicy` and `platformFeeBinding` (a 1.70% project share of the 2% total). Manifest version 12 still lists 1000 (0.10%), which belongs to profile `3.3.0`. The hook takes the 0.30% from every swap itself, and `claimPlatform()`, which anyone may call, pays it only to the immutable platform recipient `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`, Programmable's current Ethereum treasury and the claim recipient of its current policy in `/v3/capabilities`. Until 10 October 2026 the hook named `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c`; Programmable's manual review of the third request asked for the current destination as a platform destination update, not as a correction of the 0.30% calculation ([verification](verification.md)). `scripts/launch.mjs` rejects `pack`/`validate` if the CLI is older than 4.1.5, or if the package is not profile `3.6.0`, does not target the successor Router and GraphFactory, binds anything other than 3000, names a platform fee claim authority or payout recipient other than the hook's `platformRecipient`, or embeds a routed-trade policy other than the current one. Integer rounding can produce a difference of the smallest unit; the contract gives the division remainder to the reward fund.

**The Launch Stamp does not certify fees.** The capabilities require per-launch fee path evidence before the platform can call that path enforced/verified. An arbitrary custom hook does not automatically earn that claim. The local implementation and tests prove the tested project behavior, but do not replace admission and server evidence for the final request. If the server rejects this accounting or demands a different fee policy, the configuration must be reviewed; do not assume the total fee can be raised silently. [V3 fee and evidence semantics](https://api.programmable.market/v3/capabilities).

## Stamp, indexing, trading, and source verification

Canonical bindings used by the project:

| Contract | Address |
| --- | --- |
| Launch Stamp Router (successor, CLI 4.1.4 and later) | `0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3` |
| Create2 Graph Factory | `0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887` |
| Uniswap v4 PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` |

The legacy Launch Stamp Router `0x8622DD5bAb44185f2A458ac90384Ac99248f8d56` only applies to requests packed with CLI 4.1.3 or earlier; it is not a destination for a new Elonomics launch. The GraphFactory is unchanged, so the launcher needs no change.

The [Ethereum manifest](https://developers.programmable.family/api/v2/manifest) contains ABIs, runtime hashes, getter bindings, deployment evidence, and the finality policy. On 9 October 2026 it was still version 12 and listed only the legacy Router. The successor Router and its runtime hash `0xf2d611fb92718c63cf5767300e79d7c9b49480b2e9001448b96c1385f4edb6f3` come from the official CLI 4.1.4 release and are unchanged in 4.1.5. `npm run check:mainnet` checks that runtime hash on chain, reads the successor Router's `CHAIN_ID`, `GRAPH_FACTORY`, `POOL_MANAGER` and their runtime-hash getters, checks the GraphFactory and PoolManager hashes, and accepts the manifest's Router entry only if it is exactly the legacy or the successor Router with its own runtime hash and the same GraphFactory and PoolManager bindings. It also requires the routed-trade fee policy in `/v3/capabilities` and `/readyz` to carry the pinned hash `sha256:e2025776ad3b12e6277575259cccf11444810365975209083fea534d8e70b4b5`, to hash to that value from its own published body, and to name the hook's `platformRecipient` as both recipients. The check must be repeated before execution.

A stamp states the provenance of a launch. Explore can index a valid finalized stamp even if market data is not yet available or the trading adapter does not support the pool. Third-party terminals decide their own ingestion process. API support for the ERC-20 quote format does not prove that a website trading route exists that can execute ELON/TSLAon; in the 8 October 2026 research, Ethereum website swap routes were only created for pools with native ETH as `currency0`. In the capabilities checked, onsite trading was **disabled**. Profile `3.6.0` also sets an additional 30 bps routed fee, collected in ETH for Programmable's treasury, on trades through Programmable's own ETH route. A custom hook allocation such as the hook's 0.30% does not automatically waive it: the API verifies the applicable collection mode per trade, so on such a route it would be charged on top of the 2% hook fee. It does not apply to external routers such as the Universal Router, and the website offers no route for the ERC-20-quote ELON/TSLAon pool, so Programmable's revenue from ELON is the 0.3% hook share, paid in TSLAon to `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`. Deployment or indexing must not be presented as proof that swaps are ready to use on the website. [Ethereum indexing guide](https://programmable.family/developer-reference/ethereum-custom-hook), [capabilities onsiteTrading](https://api.programmable.market/v3/capabilities).

Source verification has its own lifecycle after finality. Only a literal `exact_match` result on every component can be presented as verified source. Finalized status, a funded LP, fee evidence, indexing, and trading capability must be checked separately. [Verification limits](https://programmable.market/docs/developers/machine-readable/trust.md).

## Data and capital still to be provided

Empty values in `launch.config.json` are inputs that have not been decided yet, not zero values for mainnet.

| Input | Purpose |
| --- | --- |
| Total supply | Already agreed at 1,000,000,000 ELON, with 18 decimals. |
| Launch wallet | Wallet that signs the launch; pays `devBuyEth` and gas. |
| Developer recipient | Address that receives the developer fee allocation. |
| Dev buy recipient | Recipient of the ELON from the developer first buy. |
| Initial FDV and dev buy | `initialFdvEth` sets the pool price without capital; `devBuyEth` is the ETH swapped for the first buy. |
| Zap quote | `zapQuote` from `npm run quote`; must be less than 30 minutes old at pack time. |
| Original logo and public URI | The actual image file and a URI with matching content. |
| Website and X | Project URLs that actually exist; do not use placeholder URLs. |
| Public source URL and commit | Origin of the public source and an immutable Git revision that matches the package. |
| API key | Ethereum API access; store it in an environment secret, not in source or chat. |
| ETH | `devBuyEth` for the zap and first buy, plus launch gas. |

The profile `3.6.0` metadata requirements (the same as `3.3.0`) include name, symbol, description, original image and URI, HTTPS website, and X. Ethereum accepts PNG/JPEG/WebP/GIF; the bytes, hash, and source manifest must match. The supply, price, recipient, and capital information determine the project's transaction, so its preparation must be complete before the final request. [Capabilities metadata policy](https://api.programmable.market/v3/capabilities).

The initial LP position holds only ELON; the pool's TSLAon side is filled by purchases, starting with the developer first buy. SPCXon comes from converting fees that have actually been collected; there is no assumption of fixed rewards, automatic buyers, or guaranteed yield. Details on the issuer tokens, the two conversion pools, route costs, and oracle preparation are in [stock-tokens.md](stock-tokens.md).

## Operational check results

In the 7 October 2026 check, the capabilities stated profile `3.3.0` as production-authorized, while `/readyz` returned **HTTP 503**. That evening Programmable activated profile `3.6.0`; on 8 October 2026 the capabilities stated `3.6.0` as the only version for new requests and `/readyz` was `ready`. The SPCXon oracle briefly lacked 30 minutes of history and later succeeded once time had passed; a cardinality of 1 remains prone to losing history when the next swap happens. The public Routescan endpoint also returned a lagging `latest` header, so the checker marked freshness as not yet proven.

Run `npm run check:mainnet` with an up-to-date mainnet RPC before remote validation and transactions. Dependency read results do not authorize the wallet, do not allocate a server nonce, and do not send transactions. [Readiness](https://api.programmable.market/readyz), [indexing status](https://developers.programmable.family/api/v2/status).
