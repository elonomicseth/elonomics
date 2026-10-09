// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Elonomics} from "../src/Elonomics.sol";
import {ElonomicsFeeProcessor} from "../src/ElonomicsFeeProcessor.sol";
import {ElonomicsHook} from "../src/ElonomicsHook.sol";
import {ElonomicsLauncher, IElonomicsPositionManager} from "../src/ElonomicsLauncher.sol";
import {mineHookSalt} from "./ElonomicsHook.t.sol";

interface ForkVm {
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function skip(bool skipTest) external;
    function deal(address account, uint256 newBalance) external;
}

interface IUniversalRouterLike {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IQuoterLike {
    function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut);
}

interface IPermit2Like {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev Same layout as v4-periphery IV4Router.ExactInputSingleParams.
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

contract ElonomicsLaunchForkTest {
    ForkVm private constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address private constant POSITION_MANAGER = 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e;
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address private constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
    address private constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address private constant QUOTER = 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address private constant SPCX = 0xc9eef266834730340A55B6CC24621B31BAF55581;
    address private constant TSLA = 0xf6b1117ec07684D3958caD8BEb1b302bfD21103f;
    address private constant QUOTE_POOL = 0x31227b50eCCDC9C589826AA2D9E7C5619B1895Da;
    address private constant REWARD_POOL = 0x0461c60Ad5fC24cB1fc075b7f202095819De6944;
    /// @dev WETH -0.05%-> USDC -1%-> TSLA: the launcher's zap route, also used by the router buy below.
    bytes private constant ZAP_PATH =
        hex"c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20001f4a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48002710f6b1117ec07684d3958cad8beb1b302bfd21103f";
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address private constant DEV = address(0xD3D3);
    uint256 private constant CONTRACT_BALANCE = 1 << 255;
    address private constant ADDRESS_THIS = address(2);
    // Universal Router commands, then v4 router actions.
    uint8 private constant UR_V3_SWAP_EXACT_IN = 0x00;
    uint8 private constant UR_WRAP_ETH = 0x0b;
    uint8 private constant UR_V4_SWAP = 0x10;
    uint8 private constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 private constant SETTLE = 0x0b;
    uint8 private constant SETTLE_ALL = 0x0c;
    uint8 private constant TAKE_ALL = 0x0f;
    uint256 private constant ETH_IN = 0.02 ether;
    uint256 private constant FDV_WEI = 1.1 ether;
    uint256 private constant SUPPLY = 1_000_000_000 ether;

    function testForkLaunchThenThirdPartyRouterTrades() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);

        ElonomicsLauncher launcher = new ElonomicsLauncher(
            IPoolManager(POOL_MANAGER), POSITION_MANAGER, SWAP_ROUTER, WETH, USDC, TSLA, address(this)
        );
        Elonomics token = new Elonomics(address(launcher), SUPPLY, SPCX, POOL_MANAGER);
        ElonomicsFeeProcessor processor =
            new ElonomicsFeeProcessor(address(token), TSLA, SPCX, USDC, SWAP_ROUTER, QUOTE_POOL, REWARD_POOL, 1800, 100);
        ElonomicsHook hook = _deployHook(address(token), address(launcher), address(processor));
        require(address(processor.quote()) == TSLA && address(processor.reward()) == SPCX, "processor converts TSLA into SPCX");

        uint256 quoteOut = IQuoterLike(QUOTER).quoteExactInput(ZAP_PATH, ETH_IN);
        uint256 tokenId = IElonomicsPositionManager(POSITION_MANAGER).nextTokenId();
        // The launcher's CREATE address may already hold mainnet ETH; the launch must work regardless.
        uint256 launcherEth = address(launcher).balance;
        uint256 launcherTsla = IERC20(TSLA).balanceOf(address(launcher));
        vm.deal(address(this), 1 ether);
        uint256 tokenToDev = launcher.launch{value: ETH_IN}(
            address(token), address(hook), DEV, _quotePerTokenTick(quoteOut), quoteOut * 97 / 100
        );
        // Exact binding: the first buy spends the whole zap output, so a launcher that zapped through any other
        // route or fee tier than ZAP_PATH would accrue a different fee than 2% of the same-block quote.
        require(hook.totalFeesAccrued() == quoteOut / 50, "zap output differs from the ZAP_PATH quote");

        require(IElonomicsPositionManager(POSITION_MANAGER).ownerOf(tokenId) == DEAD, "position not burned");
        require(tokenToDev > 0 && token.balanceOf(DEV) == tokenToDev, "developer buy");
        require(token.balanceOf(address(launcher)) == 0, "launcher kept ELON");
        require(
            IERC20(TSLA).balanceOf(address(launcher)) == launcherTsla && address(launcher).balance == launcherEth,
            "launcher balances differ from entry"
        );

        bool tokenIs0 = address(token) < TSLA;
        PoolKey memory key = PoolKey(
            Currency.wrap(tokenIs0 ? address(token) : TSLA),
            Currency.wrap(tokenIs0 ? TSLA : address(token)),
            0,
            60,
            IHooks(address(hook))
        );
        uint256 tokenBefore = token.balanceOf(address(this));
        _routerBuyWithEth(key, tokenIs0, address(token), 0.01 ether);
        uint256 bought = token.balanceOf(address(this)) - tokenBefore;
        require(bought > 0, "Universal Router ETH -> USDC -> TSLA -> ELON buy");

        uint256 tslaBefore = IERC20(TSLA).balanceOf(address(this));
        _routerSell(key, tokenIs0, address(token), bought);
        require(IERC20(TSLA).balanceOf(address(this)) > tslaBefore, "Universal Router sell");

        uint256 devTslaBefore = IERC20(TSLA).balanceOf(DEV);
        require(hook.claimDev() > 0 && IERC20(TSLA).balanceOf(DEV) > devTslaBefore, "dev fee claim");
        require(hook.claimDividends() > 0 && IERC20(TSLA).balanceOf(address(processor)) > 0, "dividend claim");
        require(hook.claimPlatform() > 0, "platform claim");
    }

    /// @dev TSLA-per-ELON tick at the target FDV, rounded to the nearest multiple of 60 like planZapQuote.
    function _quotePerTokenTick(uint256 quoteOut) private pure returns (int24) {
        uint256 priceX192 = FullMath.mulDiv(FDV_WEI * quoteOut, 1 << 192, ETH_IN * SUPPLY);
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(Math.sqrt(priceX192)));
        int24 below = tick / 60 * 60;
        if (below > tick) below -= 60;
        return tick - below >= 30 ? below + 60 : below;
    }

    function _deployHook(address token, address launcher, address processor) private returns (ElonomicsHook) {
        bytes32 codeHash = keccak256(
            abi.encodePacked(
                type(ElonomicsHook).creationCode, abi.encode(POOL_MANAGER, token, TSLA, launcher, DEV, processor)
            )
        );
        return new ElonomicsHook{salt: mineHookSalt(address(this), codeHash)}(
            IPoolManager(POOL_MANAGER), token, TSLA, launcher, DEV, processor
        );
    }

    /// @dev ETH-first buy the way wallet bots route it: wrap ETH in the router, swap V3 WETH -> USDC -> TSLA
    ///      into the router, then V4_SWAP settles that TSLA, swaps the open credit and takes all ELON to the caller.
    function _routerBuyWithEth(PoolKey memory key, bool tokenIs0, address token, uint256 value) private {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(Currency.wrap(TSLA), CONTRACT_BALANCE, false);
        params[1] = abi.encode(ExactInputSingleParams(key, !tokenIs0, 0, 0, bytes("")));
        params[2] = abi.encode(Currency.wrap(token), uint256(0));

        bytes[] memory inputs = new bytes[](3);
        inputs[0] = abi.encode(ADDRESS_THIS, value);
        inputs[1] = abi.encode(ADDRESS_THIS, CONTRACT_BALANCE, uint256(0), ZAP_PATH, false);
        inputs[2] = abi.encode(abi.encodePacked(SETTLE, SWAP_EXACT_IN_SINGLE, TAKE_ALL), params);
        IUniversalRouterLike(UNIVERSAL_ROUTER).execute{value: value}(
            abi.encodePacked(UR_WRAP_ETH, UR_V3_SWAP_EXACT_IN, UR_V4_SWAP), inputs, block.timestamp
        );
    }

    /// @dev Same encoding as `scripts/transactions.mjs sell`: Permit2 allowance, then V4_SWAP with
    ///      SWAP_EXACT_IN_SINGLE, SETTLE_ALL and TAKE_ALL.
    function _routerSell(PoolKey memory key, bool tokenIs0, address token, uint256 amount) private {
        IERC20(token).approve(PERMIT2, amount);
        IPermit2Like(PERMIT2).approve(token, UNIVERSAL_ROUTER, uint160(amount), uint48(block.timestamp + 1 hours));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(key, tokenIs0, uint128(amount), 0, bytes("")));
        params[1] = abi.encode(Currency.wrap(token), amount);
        params[2] = abi.encode(Currency.wrap(TSLA), uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
        IUniversalRouterLike(UNIVERSAL_ROUTER).execute(abi.encodePacked(UR_V4_SWAP), inputs, block.timestamp);
    }
}
