# Elonomics assets and conversion path

Elonomics (`ELON`) uses the **ELON/TSLAon** pair on Ethereum Mainnet (`chain ID 1`). Holder rewards are paid in **SPCXon**. Those rewards come from ELON trading fees, not from SpaceX corporate dividends. The project configuration splits the 2% buy/sell fee into 1% rewards, 0.3% Programmable, and 0.7% developer.

## Selected assets

| Asset | Ethereum contract | Decimals |
| --- | --- | --- |
| SpaceX, SPCXon | `0xc9eef266834730340A55B6CC24621B31BAF55581` | 18 |
| Tesla, TSLAon | `0xf6b1117ec07684D3958caD8BEb1b302bfD21103f` | 18 |
| USD Coin, USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |

Both stock token addresses provided by the user match the [official Ondo token list](https://raw.githubusercontent.com/ondoprotocol/ondo-global-markets-token-list/main/tokenlist.json), dated 17 September 2026. The issuer pages identify [SPCXon as SpaceX](https://app.ondo.finance/assets/spcxon) and [TSLAon as Tesla](https://app.ondo.finance/assets/tslaon). A ticker without an address is not enough to identify an asset; there are other issuer products with similar tickers.

Ondo provides economic exposure to the underlying stocks. The ELON contract does not issue Tesla/SpaceX shares and grants no ownership rights to those companies' shares. [Issuer product explanation](https://ondo.finance/ondo-stocks).

## Token behavior that affects the contracts

The [Ondo GMToken source](https://github.com/ondoprotocol/rwa-contracts/blob/main/contracts/globalMarkets/GMToken.sol) uses ordinary ERC-20 accounting with compliance checks and global/per-token pauses. Transfers check the sender, the recipient, and the `transferFrom` caller if it differs from both parties. The [published compliance implementation](https://github.com/ondoprotocol/rwa-contracts/blob/main/contracts/xManager/OndoCompliance.sol) checks a blocklist and sanctions. The issuer can upgrade through the beacon and manage mint/burn. That latest source has not been matched byte for byte against the currently active proxy implementation.

Because SPCXon transfers can be rejected by the issuer, reward claims must be separate from ELON transfers. A failed claim must preserve the holder's entitlement. An SPCXon pause or blocklist status must not freeze ELON transfers. TSLAon, as the pair asset, cannot be separated in the same way: a TSLAon pause halts the launch zap, ELON buys and sells, and hook fee claims. In the 8 October 2026 check, TSLAon and SPCXon used the same Ondo pause manager, beacon, and compliance contract.

[Ondo corporate actions](https://docs.ondo.finance/ondo-stocks/corporate-actions) explains that dividends on the underlying stock are reinvested and reflected in the token price. Raw token accounting does not follow the xStocks rebase model. [xStocks on EVM change `balanceOf()` through a multiplier](https://docs.xstocks.fi/developers); for that reason TSLAx must not replace TSLAon without accounting changes and testing.

The [issuer eligibility requirements](https://docs.ondo.finance/ondo-stocks/eligibility) also apply to acquisition through the secondary market. Direct redemption requires issuer onboarding/KYC, and holding the token by itself does not guarantee a redemption right. [Secondary market restrictions](https://docs.ondo.finance/ondo-stocks/secondary-market-restrictions).

## Fee-to-reward conversion path

Fees are collected in TSLAon, then converted through:

```text
TSLAon → USDC → SPCXon
       1%     1%
```

| Uniswap v3 pool | Address |
| --- | --- |
| USDC/TSLAon | `0x31227b50eCCDC9C589826AA2D9E7C5619B1895Da` |
| USDC/SPCXon | `0x0461c60Ad5fC24cB1fc075b7f202095819De6944` |

On 7 October 2026 at about 08:53 UTC, contract reads through the Routescan Ethereum proxy endpoint verified that:

- Both pools use USDC as `token0`, and the respective Ondo address above as `token1`.
- Both `fee()` values are `10000`, i.e. 1% per hop.
- Both `factory()` values are `0x1F98431c8aD98523631AE4a59f267346ea31F984`.
- `getPool(USDC, token, 10000)` on that factory returns the same pool address.
- The raw active liquidity is `48857156970519352` and `245763628240421794` respectively; these numbers are not USD values.
- The official Quoter at that time returned **0.441542505989562195 TSLAon for 1 SPCXon** (the old conversion direction). For the TSLAon → USDC → SPCXon direction, Quoter v1 at block 26142353 (7 October 2026 18:38:35 UTC) returned **2.215590302896305899 SPCXon for 1 TSLAon**. Both quotes are historical and must not be used as the minimum output of later transactions.

The two 1% pool fees reduce the conversion output by about 1.99% before price impact and gas costs. That cost is charged to the converted fee share; it is not an additional percentage on ELON transfers. Deployment source: [Uniswap Ethereum v3](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).

The router used is `0xE592427A0AEce92De3Edee1F18E0157C05861564`. The router's `factory()` has also been read and matches. This [`ISwapRouter` interface](https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/ISwapRouter.sol) uses `exactInput` with the fields `path`, `recipient`, `deadline`, `amountIn`, and `amountOutMinimum`. That ABI differs from SwapRouter02.

The launch zap uses the route WETH → USDC (0.05% pool `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`) → TSLAon (the same 1% USDC/TSLAon pool as the first conversion hop). At block 26142353 (7 October 2026 18:38:35 UTC), that pool held about 52,435 USDC and 50.59 TSLAon, far deeper than the 0.3% USDC/TSLAon pool (about 737 USDC); Quoter v1 returned 0.133762088605498834 TSLAon for 0.02 ETH along this route. The TSLAon market is thin: buyers starting from ETH pay v3 pool fees of about 1.05% before price impact to obtain TSLAon, on top of the 2% hook fee.

## Oracle readiness

The initial read found that the SPCXon pool stored only **1 observation**, while the TSLAon pool stored 48. `observe([1800, 0])` on TSLAon succeeded. The same call on SPCXon failed with RPC error code 3; the endpoint does not expose the revert text.

The SPCXon observation at that time was timestamped **08:25:59 UTC**, less than 30 minutes before the nearest block read, block **26139439** at **08:53:23 UTC**. This means that 30 minutes of history was not yet available at that check. Because all reads used separate `latest` calls, this result is not an atomic single-block snapshot.

When the checker was run at about **09:03 UTC**, the `observe([1800, 0])` calls on both pools succeeded, but the SPCXon capacity was still 1. Temporary success after time has passed does not guarantee that the window stays available after the next swap. All asset metadata, pool/factory bindings, and Programmable runtime hashes also matched; `/readyz` was still HTTP 503.

Before conversion is used:

1. Call `ElonomicsFeeProcessor.prepareOracle()` to increase the history capacity of both pools. For the default 1800-second window, the target is **256 observations**; longer windows use a larger target, growing by at most 256 slots per pool per call. Before the processor exists, pool capacity can be prepared directly through `increaseObservationCardinalityNext(256)`. The checker has not performed this transaction.
2. Wait for history to fill through pool activity. Adding capacity does not immediately create historical data.
3. Run the checker until both `observe([oracleWindowSeconds, 0])` calls succeed. A capacity of 1 is unreliable because the next swap can overwrite the only observation.

Do not downgrade the protection to the spot price if history is not yet available. The [Uniswap oracle source](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Oracle.sol) explains observation storage and history limits.

## Running the read checks

```sh
npm run check:mainnet
node scripts/check-mainnet.mjs --self-test
```

The checker uses `MAINNET_RPC_URL` if it is provided. The URL value and error details that might contain credentials are not printed. If the initial connection fails, the checker uses Routescan's public GET endpoint. That fallback does not provide `eth_chainId`, so the network is proven by the Ethereum genesis hash and the Programmable Router's `CHAIN_ID()`, not by a synthesized chain ID result. A `latest` header older than 5 minutes leaves readiness unproven; the public endpoint can serve cached data. Use an up-to-date RPC for checks before execution.

The checker checks asset bytecode/metadata, pools/factory, oracles, the conversion quote, Programmable bindings and runtime hashes, the manifest, capabilities (profile `3.6.0` and platform fee 3000), and `/readyz`. It only allows read RPC methods and needs no wallet/private key. Results are printed as JSON; exit code `0` means all dependency checks passed, `1` means an invariant does not match, and `2` means a read or service readiness has not been proven yet.

Example of a repeatable read source: [SPCXon pool token0](https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?module=proxy&action=eth_call&to=0x0461c60Ad5fC24cB1fc075b7f202095819De6944&data=0x0dfe1681&tag=latest). The `latest` value changes as the chain advances.

GraphFactory and PoolManager hash matches are compared against the [Programmable manifest](https://developers.programmable.family/api/v2/manifest); the successor Router's runtime hash comes from the official CLI 4.1.4 release and is unchanged in the locked 4.1.5 release, because the manifest (version 12 on 9 October 2026, version 15 on 10 October 2026) still lists only the legacy Router. On 7 October 2026, [V3 capabilities](https://api.programmable.market/v3/capabilities) advertised profile `3.3.0` and compiler `0.8.26+commit.8a97fa7a`, while [readiness](https://api.programmable.market/readyz) returned HTTP 503; since that evening the active profile has been `3.6.0` (platform fee 3000), and on 8 October 2026 readiness was `ready`. A passing dependency status does not replace a complete launch configuration, wallet funding, simulation, Programmable admission, or a contract security review.
