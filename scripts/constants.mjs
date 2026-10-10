import { encodePacked } from 'viem';

// Pair asset (quote): TSLAon. Holder rewards: SPCXon, bought by the processor with TSLAon through USDC.
export const ADDRESSES = Object.freeze({
  poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  graphFactory: '0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887',
  // Successor Launch Stamp Router that CLI 4.1.4 and later bind into new profile 3.6.0 requests: the wallet's destination.
  programmableRouter: '0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3',
  // Programmable's current Ethereum treasury: ElonomicsHook.platformRecipient, the recipient of the routed-trade policy in
  // /v3/capabilities, and the claim recipient CLI 4.1.5 binds into new requests.
  platformRecipient: '0xD88539d3c4C460136a733A3Fd60cf6BF269079da',
  quote: '0xf6b1117ec07684D3958caD8BEb1b302bfD21103f',
  reward: '0xc9eef266834730340A55B6CC24621B31BAF55581',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  quotePool: '0x31227b50eCCDC9C589826AA2D9E7C5619B1895Da',
  rewardPool: '0x0461c60Ad5fC24cB1fc075b7f202095819De6944',
  v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  positionManager: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  stateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
  universalRouter: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
  zapWethUsdcPool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
  // The same USDC/TSLAon 1% pool as quotePool: the deepest TSLAon pool.
  zapUsdcQuotePool: '0x31227b50eCCDC9C589826AA2D9E7C5619B1895Da',
});

// Launch zap route, the same one ElonomicsLauncher swaps through: WETH -0.05%-> USDC -1%-> TSLAon.
export const ZAP_PATH = encodePacked(['address', 'uint24', 'address', 'uint24', 'address'],
  [ADDRESSES.weth, 500, ADDRESSES.usdc, 10000, ADDRESSES.quote]);

// Programmable Ethereum profile this package targets. Fee 3000 is the 0.30% ElonomicsHook charges.
export const PROGRAMMABLE = Object.freeze({
  profileVersion: '3.6.0',
  platformFeeHundredthsOfBip: '3000',
  minimumCliVersion: '4.1.5',
  // Runtime code hash of ADDRESSES.programmableRouter, as pinned by CLI 4.1.4 and 4.1.5 (ROUTER_24H_RUNTIME_CODE_HASH).
  routerRuntimeCodeHash: '0xf2d611fb92718c63cf5767300e79d7c9b49480b2e9001448b96c1385f4edb6f3',
  // Live /v3/capabilities programmableTradeFeePolicy as read on 10 October 2026: policy
  // programmable.ethereum-routed-native-fee.v2, whose recipients are ADDRESSES.platformRecipient.
  tradeFeePolicyVersion: 'programmable.ethereum-routed-native-fee.v2',
  tradeFeePolicyHash: 'sha256:e2025776ad3b12e6277575259cccf11444810365975209083fea534d8e70b4b5',
});

// Legacy one-hour Router that CLI 4.1.3 and earlier bound into requests. Never a destination for a new launch;
// kept only because Programmable manifest version 12 still lists this Router, and check-mainnet must match it exactly.
export const LEGACY_ROUTER = Object.freeze({
  address: '0x8622DD5bAb44185f2A458ac90384Ac99248f8d56',
  runtimeCodeHash: '0x40e27ecf201761d5eb66bc4f2d5c6124831ef078d7baf458ca5f41b1a8108546',
});
