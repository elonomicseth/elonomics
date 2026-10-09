// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Elonomics} from "../src/Elonomics.sol";
import {IElonomicsV3Router} from "../src/ElonomicsFeeProcessor.sol";
import {ElonomicsHook} from "../src/ElonomicsHook.sol";
import {ElonomicsLauncher, IElonomicsPositionManager} from "../src/ElonomicsLauncher.sol";
import {RewardMock} from "./Elonomics.t.sol";
import {ProcessorV3FactoryMock} from "./ElonomicsFeeProcessor.t.sol";
import {HookTestCoin, mineHookSalt} from "./ElonomicsHook.t.sol";

interface LauncherVm {
    function prank(address caller) external;
    function deal(address account, uint256 newBalance) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function deployCode(string calldata artifactPath, bytes calldata constructorArgs) external returns (address);
}

/// @dev Stands in for the Uniswap v3 SwapRouter: takes the ETH and pays a configured TSLA amount.
contract LauncherRouterMock is IElonomicsV3Router {
    address public immutable factory;
    IERC20 private immutable quoteToken;
    bytes32 private immutable expectedPath;
    uint256 public output;
    bool public underpay;

    constructor(address factory_, address quote_, bytes32 expectedPath_) {
        factory = factory_;
        quoteToken = IERC20(quote_);
        expectedPath = expectedPath_;
    }

    function setOutput(uint256 amount) external {
        output = amount;
    }

    function setUnderpay(bool value) external {
        underpay = value;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256) {
        require(msg.value == params.amountIn, "value");
        require(keccak256(params.path) == expectedPath, "path");
        require(params.deadline >= block.timestamp, "deadline");
        require(output >= params.amountOutMinimum, "Too little received");
        quoteToken.transfer(params.recipient, underpay ? output - 1 : output);
        return output;
    }
}

contract ElonomicsLauncherTest {
    LauncherVm private constant vm = LauncherVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string private constant POSITION_MANAGER_ARTIFACT =
        "node_modules/@uniswap/v4-periphery/foundry-out/PositionManager.sol/PositionManager.json";
    address private constant DEV = address(0xD3);
    address private constant DEV_BUYER = address(0xB0B);
    address private constant DIVIDENDS = address(0xD1);
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant ETH_IN = 0.02 ether;
    uint256 private constant ZAP_OUT = 0.134 ether;
    int24 private constant QUOTE_PER_TOKEN_TICK = -187260;

    PoolManager private manager;
    IElonomicsPositionManager private positionManager;
    PoolSwapTest private router;
    HookTestCoin private quote;
    HookTestCoin private weth;
    HookTestCoin private usdc;
    RewardMock private reward;
    LauncherRouterMock private zapRouter;
    ElonomicsLauncher private launcher;
    Elonomics private token;
    ElonomicsHook private hook;
    PoolKey private key;

    function setUp() public {
        manager = new PoolManager(address(this));
        router = new PoolSwapTest(manager);
        quote = new HookTestCoin();
        weth = new HookTestCoin();
        usdc = new HookTestCoin();
        reward = new RewardMock();
        positionManager = IElonomicsPositionManager(
            vm.deployCode(
                POSITION_MANAGER_ARTIFACT,
                abi.encode(address(manager), address(0x2222), uint256(300_000), address(0x3333), address(weth))
            )
        );
        ProcessorV3FactoryMock factory = new ProcessorV3FactoryMock();
        factory.setPool(address(weth), address(usdc), 500, address(0x1001));
        factory.setPool(address(usdc), address(quote), 10_000, address(0x1002));
        zapRouter = new LauncherRouterMock(
            address(factory),
            address(quote),
            keccak256(abi.encodePacked(address(weth), uint24(500), address(usdc), uint24(10_000), address(quote)))
        );
        quote.transfer(address(zapRouter), 1_000_000 ether);
        zapRouter.setOutput(ZAP_OUT);
        launcher = new ElonomicsLauncher(
            manager, address(positionManager), address(zapRouter), address(weth), address(usdc), address(quote), address(this)
        );
        quote.approve(address(router), type(uint256).max);
        vm.deal(address(this), 10 ether);
    }

    function testLaunchWhenTokenIsCurrency0() public {
        _checkLaunch(true, 0);
    }

    /// @dev Also sends dust to the predictable launcher address first: it must not block the launch and stays put.
    function testLaunchWhenTokenIsCurrency1() public {
        _checkLaunch(false, 1);
    }

    function testOnlyTheGraphFactoryCanLaunchAndOnlyOnce() public {
        _deployTokenAndHook(true);
        vm.deal(address(0xBAD), 1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(ElonomicsLauncher.Unauthorized.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, 1);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, 1);
        vm.expectRevert(ElonomicsLauncher.AlreadyLaunched.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, 1);
        vm.expectRevert(ElonomicsLauncher.Unauthorized.selector);
        launcher.unlockCallback("");
    }

    function testRejectsInvalidLaunchArguments() public {
        _deployTokenAndHook(true);
        vm.expectRevert(ElonomicsLauncher.InvalidLaunch.selector);
        launcher.launch(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, 1);
        vm.expectRevert(ElonomicsLauncher.InvalidLaunch.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK + 1, 1);
        vm.expectRevert(ElonomicsLauncher.InvalidLaunch.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, 887220, 1);
        vm.expectRevert(ElonomicsLauncher.InvalidLaunch.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, -887220, 1);
        vm.expectRevert(ElonomicsLauncher.InvalidLaunch.selector);
        launcher.launch{value: ETH_IN}(address(quote), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, 1);
        vm.expectRevert(ElonomicsLauncher.InvalidLaunch.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, 0);
        vm.expectRevert(ElonomicsLauncher.InvalidLaunch.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), address(0), QUOTE_PER_TOKEN_TICK, 1);
        require(!launcher.launched(), "invalid calls must not consume the launch");
        vm.expectRevert(ElonomicsLauncher.InvalidConfiguration.selector);
        new ElonomicsLauncher(
            manager, address(0xBEEF), address(zapRouter), address(weth), address(usdc), address(quote), address(this)
        );
    }

    function testZapBelowMinimumRevertsEverything() public {
        _deployTokenAndHook(true);
        vm.expectRevert(bytes("Too little received"));
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, ZAP_OUT + 1);
        require(!launcher.launched(), "failed launch consumed the flag");
        require(token.balanceOf(address(launcher)) == SUPPLY, "supply moved");
        require(address(launcher).balance == 0, "ETH kept");
    }

    function testZapThatPaysLessThanItReportsIsRejected() public {
        _deployTokenAndHook(true);
        zapRouter.setUnderpay(true);
        vm.expectRevert(ElonomicsLauncher.LaunchCheckFailed.selector);
        launcher.launch{value: ETH_IN}(address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, 1);
    }

    function testRouterStyleTradingWorksAfterLaunch() public {
        _launch(false); // TSLA is currency0, so buying ELON is zeroForOne
        token.approve(address(router), type(uint256).max);
        uint256 tokenBefore = token.balanceOf(address(this));
        // Fifty times the TSLA now in the pool, settled only after the swap like GMGN or Universal Router.
        router.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ZAP_OUT * 50), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 bought = token.balanceOf(address(this)) - tokenBefore;
        require(bought > 0, "router buy");
        uint256 quoteBefore = quote.balanceOf(address(this));
        router.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(bought / 2), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        require(quote.balanceOf(address(this)) > quoteBefore, "router sell");
        uint256 claims = manager.balanceOf(address(hook), CurrencyLibrary.toId(Currency.wrap(address(quote))));
        require(claims == hook.dividendsAccrued() + hook.platformAccrued() + hook.devAccrued(), "fees backed by claims");
    }

    function testDeveloperCanSellTheFirstBuyBack() public {
        uint256 tokenToDev = _launch(true); // ELON is currency0, so selling ELON is zeroForOne
        vm.prank(DEV_BUYER);
        token.approve(address(router), tokenToDev);
        vm.prank(DEV_BUYER);
        router.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(tokenToDev), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 received = quote.balanceOf(DEV_BUYER);
        require(received > 0 && received < ZAP_OUT, "developer sells back below the zapped amount");
        require(token.balanceOf(DEV_BUYER) < tokenToDev, "sell consumed tokens");
    }

    /// @dev A complete withdrawal (DECREASE_LIQUIDITY + TAKE_PAIR) that succeeds for the owner is refused for anyone else.
    function testBurnedPositionCannotBeWithdrawn() public {
        _launch(true);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(uint256(1), uint256(positionManager.getPositionLiquidity(1)), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        vm.expectRevert(abi.encodeWithSignature("NotApproved(address)", address(this)));
        positionManager.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x01), uint8(0x11)), params), block.timestamp);
    }

    function _checkLaunch(bool tokenIs0, uint256 dust) private {
        _deployTokenAndHook(tokenIs0);
        vm.deal(address(launcher), dust);
        quote.transfer(address(launcher), dust);
        weth.transfer(address(launcher), dust);
        usdc.transfer(address(launcher), dust);
        uint256 tokenToDev = launcher.launch{value: ETH_IN}(
            address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, ZAP_OUT * 97 / 100
        );
        require(positionManager.ownerOf(1) == DEAD, "position not burned");
        require(positionManager.getPositionLiquidity(1) > 0, "no liquidity");
        require(tokenToDev > 0 && token.balanceOf(DEV_BUYER) == tokenToDev, "developer buy");
        require(token.balanceOf(address(launcher)) == 0, "launcher kept ELON");
        require(
            quote.balanceOf(address(launcher)) == dust && weth.balanceOf(address(launcher)) == dust
                && usdc.balanceOf(address(launcher)) == dust && address(launcher).balance == dust,
            "launcher balances differ from entry"
        );
        require(token.balanceOf(DEAD) < 1e6, "only rounding dust is burned");
        require(token.balanceOf(address(manager)) + tokenToDev + token.balanceOf(DEAD) == SUPPLY, "supply conservation");
        require(hook.totalFeesAccrued() == ZAP_OUT / 50, "first buy pays the hook fee");
        _requireDeveloperShare(tokenToDev);
        require(launcher.launched(), "launch flag");
    }

    /// @dev Single-sided liquidity from the launch price to the extreme: share = net / (FDV + net), within 1 bp.
    function _requireDeveloperShare(uint256 tokenToDev) private pure {
        uint160 sqrtQuotePerToken = TickMath.getSqrtPriceAtTick(QUOTE_PER_TOKEN_TICK);
        uint256 fdvInQuote = FullMath.mulDiv(FullMath.mulDiv(SUPPLY, sqrtQuotePerToken, 1 << 96), sqrtQuotePerToken, 1 << 96);
        uint256 netQuote = ZAP_OUT - ZAP_OUT / 50;
        uint256 expected = FullMath.mulDiv(SUPPLY, netQuote, fdvInQuote + netQuote);
        require(
            tokenToDev <= expected + expected / 10_000 && tokenToDev + expected / 10_000 >= expected,
            "share differs from net / (fdv + net)"
        );
    }

    function _launch(bool tokenIs0) private returns (uint256) {
        _deployTokenAndHook(tokenIs0);
        return launcher.launch{value: ETH_IN}(
            address(token), address(hook), DEV_BUYER, QUOTE_PER_TOKEN_TICK, ZAP_OUT * 97 / 100
        );
    }

    /// @dev Mines CREATE2 salts so ELON sorts on the requested side of TSLA and the hook has mask 0x20cc.
    function _deployTokenAndHook(bool tokenIs0) private {
        bytes32 tokenCodeHash = keccak256(
            abi.encodePacked(
                type(Elonomics).creationCode, abi.encode(address(launcher), SUPPLY, address(reward), address(manager))
            )
        );
        uint256 salt;
        for (;; ++salt) {
            if ((_create2Address(bytes32(salt), tokenCodeHash) < address(quote)) == tokenIs0) break;
        }
        token = new Elonomics{salt: bytes32(salt)}(address(launcher), SUPPLY, address(reward), address(manager));

        bytes32 hookCodeHash = keccak256(
            abi.encodePacked(
                type(ElonomicsHook).creationCode,
                abi.encode(address(manager), address(token), address(quote), address(launcher), DEV, DIVIDENDS)
            )
        );
        hook = new ElonomicsHook{salt: mineHookSalt(address(this), hookCodeHash)}(
            manager, address(token), address(quote), address(launcher), DEV, DIVIDENDS
        );
        key = PoolKey(
            Currency.wrap(tokenIs0 ? address(token) : address(quote)),
            Currency.wrap(tokenIs0 ? address(quote) : address(token)),
            0,
            60,
            IHooks(address(hook))
        );
    }

    function _create2Address(bytes32 salt, bytes32 codeHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }
}
