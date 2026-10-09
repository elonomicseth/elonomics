// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ElonomicsHook} from "../src/ElonomicsHook.sol";

interface HookVm {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

contract HookTestCoin is ERC20 {
    constructor() ERC20("Test", "TEST") {
        _mint(msg.sender, 1e30);
    }
}

/// @dev CREATE2 salt that gives a hook deployed by `deployer` the permission mask 0x20cc.
///      Shared by the hook, launcher and fork tests.
function mineHookSalt(address deployer, bytes32 initCodeHash) pure returns (bytes32 salt) {
    for (uint256 i;; ++i) {
        salt = bytes32(i);
        if (uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash))) & 0x3fff == 0x20cc) return salt;
    }
}

contract ElonomicsHookTest {
    HookVm private constant vm = HookVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant DEV = address(0xD3);
    address private constant DIVIDENDS = address(0xD1);

    PoolManager private manager;
    PoolSwapTest private router;
    PoolModifyLiquidityTest private liquidityRouter;
    HookTestCoin private token;
    HookTestCoin private quote;
    ElonomicsHook private hook;
    PoolKey private key;

    function setUp() public {
        _deployManager();
        _deployPair(true);
    }

    function testBuySellAndPermissionlessClaimsQuoteCurrency0() public {
        _exerciseTradingAndClaims();
    }

    function testBuySellAndPermissionlessClaimsQuoteCurrency1() public {
        _deployPair(false);
        _exerciseTradingAndClaims();
    }

    function testRouterStyleBuyWorksWhenPoolManagerHoldsNoQuote() public {
        for (uint256 i; i < 2; ++i) {
            _deployManager();
            _deployHookAndPool(i == 0);
            bool tokenIs0 = address(token) < address(quote);
            (int24 lower, int24 upper) = tokenIs0 ? (int24(0), int24(887220)) : (int24(-887220), int24(0));
            liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, 1e24, bytes32(0)), "");
            require(quote.balanceOf(address(manager)) == 0, "single-sided pool holds no quote");
            uint256 gross = 1_000e18;
            uint256 tokenBefore = token.balanceOf(address(this));
            // PoolSwapTest settles only after the swap returns, like Universal Router and trading bots.
            _swap(true, -int256(gross), 0);
            require(token.balanceOf(address(this)) > tokenBefore, "buy delivered no tokens");
            require(hook.totalFeesAccrued() == gross / 50, "buy fee");
            _assertSolvent();
        }
    }

    function testFuzzFeeConservationForRealBuy(uint64 rawAmount) public {
        uint256 gross = uint256(rawAmount) + 1e6;
        uint256 balanceBefore = quote.balanceOf(address(this));
        _swap(true, -int256(gross), 0);
        require(quote.balanceOf(address(this)) == balanceBefore - gross, "buy gross spend");
        require(hook.totalFeesAccrued() == gross / 50, "total fee");
        require(hook.platformAccrued() == gross * 3 / 1000, "platform split");
        require(hook.devAccrued() == gross * 7 / 1000, "dev split");
        require(hook.dividendsAccrued() == gross / 50 - gross * 3 / 1000 - gross * 7 / 1000, "dividend split");
        _assertSolvent();
    }

    function testBuyPartialFillRollsBackFeesAndPool() public {
        uint256 quoteBefore = quote.balanceOf(address(this));
        uint160 limit = TickMath.getSqrtPriceAtTick(quoteIs0() ? int24(-1) : int24(1));
        vm.expectRevert();
        _swap(true, -int256(1e22), limit);
        require(quote.balanceOf(address(this)) == quoteBefore, "failed buy spent quote");
        require(hook.totalFeesAccrued() == 0, "failed buy accrued fees");
        _assertSolvent();
        _swap(true, -int256(1e18), 0);
        require(hook.totalFeesAccrued() == 2e16, "pending state not rolled back");
    }

    function testExactOutputBuyAndSellRevertWithoutFees() public {
        vm.expectRevert();
        _swap(true, int256(1e18), 0);
        vm.expectRevert();
        _swap(false, int256(1e18), 0);
        require(hook.totalFeesAccrued() == 0, "unsupported swaps accrued fees");
    }

    function testCallbacksRequirePoolManagerAndInitializationRequiresInitializer() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), key, uint160(1 << 96));
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, _params(true, -1e18, 0), "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, _params(true, -1e18, 0), BalanceDelta.wrap(0), "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(address(this), uint256(1)));

        vm.prank(address(manager));
        vm.expectRevert(ElonomicsHook.UnauthorizedInitializer.selector);
        hook.beforeInitialize(address(0xBAD), key, uint160(1 << 96));
    }

    function testRejectsEveryWrongPoolField() public {
        PoolKey memory wrong = key;
        wrong.fee = 3000;
        _expectWrongPool(wrong);
        wrong = key;
        wrong.tickSpacing = 1;
        _expectWrongPool(wrong);
        wrong = key;
        wrong.currency0 = key.currency1;
        _expectWrongPool(wrong);
        wrong = key;
        wrong.currency1 = Currency.wrap(address(0x1234));
        _expectWrongPool(wrong);
        wrong = key;
        wrong.hooks = IHooks(address(0x20cc));
        _expectWrongPool(wrong);
    }

    function testClaimCannotSweepUnaccountedQuote() public {
        quote.transfer(address(hook), 1e18);
        _swap(true, -int256(1e18), 0);
        hook.claimDividends();
        hook.claimDev();
        hook.claimPlatform();
        require(quote.balanceOf(address(hook)) == 1e18, "swept unaccounted quote");
        require(hook.totalFeesClaimed() == hook.totalFeesAccrued(), "claims differ");
    }

    function testTinyTradeRoundingKeepsAllLiabilitiesFunded() public {
        _swap(true, -int256(99), 0);
        require(hook.totalFeesAccrued() == 1, "total tiny fee");
        require(hook.dividendsAccrued() == 1, "rounding residue");
        require(hook.platformAccrued() == 0 && hook.devAccrued() == 0, "rounding overcharge");
        _assertSolvent();
    }

    function _exerciseTradingAndClaims() private {
        uint256 grossBuy = 1000e18;
        uint256 beforeQuote = quote.balanceOf(address(this));
        uint256 beforeToken = token.balanceOf(address(this));
        BalanceDelta buy = _swap(true, -int256(grossBuy), 0);
        require(_quoteDelta(buy) == -int256(grossBuy), "buy delta omitted fee");
        require(quote.balanceOf(address(this)) == beforeQuote - grossBuy, "buy quote spent");
        require(token.balanceOf(address(this)) > beforeToken, "buy delivered no tokens");
        require(hook.dividendsAccrued() == 10e18, "buy dividend fee");
        require(hook.platformAccrued() == 3e18, "buy platform fee");
        require(hook.devAccrued() == 7e18, "buy dev fee");
        _assertSolvent();

        beforeQuote = quote.balanceOf(address(this));
        uint256 beforeFees = hook.totalFeesAccrued();
        BalanceDelta sell = _swap(false, -int256(100e18), 0);
        uint256 received = quote.balanceOf(address(this)) - beforeQuote;
        uint256 sellFee = hook.totalFeesAccrued() - beforeFees;
        uint256 grossSell = received + sellFee;
        require(_quoteDelta(sell) == int256(received), "sell delta omitted fee");
        require(sellFee == grossSell / 50, "sell gross fee");
        require(hook.platformAccrued() == 3e18 + grossSell * 3 / 1000, "sell platform split");
        require(hook.devAccrued() == 7e18 + grossSell * 7 / 1000, "sell dev split");
        require(hook.dividendsAccrued() == 10e18 + sellFee - grossSell * 3 / 1000 - grossSell * 7 / 1000, "sell dividends split");
        _assertSolvent();

        uint256 dividends = hook.dividendsAccrued();
        uint256 platform = hook.platformAccrued();
        uint256 dev = hook.devAccrued();
        vm.prank(address(0xCA11));
        require(hook.claimDividends() == dividends, "dividend claim result");
        vm.prank(address(0xCA11));
        require(hook.claimPlatform() == platform, "platform claim result");
        vm.prank(address(0xCA11));
        require(hook.claimDev() == dev, "dev claim result");
        require(quote.balanceOf(DIVIDENDS) == dividends, "dividend payout destination");
        require(quote.balanceOf(hook.platformRecipient()) == platform, "platform payout destination");
        require(quote.balanceOf(DEV) == dev, "dev payout destination");
        require(quote.balanceOf(address(0xCA11)) == 0, "caller stole payout");
        require(hook.totalFeesClaimed() == hook.totalFeesAccrued(), "claim conservation");
        require(hook.claimDividends() == 0 && hook.claimDev() == 0 && hook.claimPlatform() == 0, "double claim");
        _assertSolvent();
    }

    function _deployManager() private {
        manager = new PoolManager(address(this));
        router = new PoolSwapTest(manager);
        liquidityRouter = new PoolModifyLiquidityTest(manager);
    }

    function _deployPair(bool quoteCurrency0) private {
        _deployHookAndPool(quoteCurrency0);
        liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, 1e24, bytes32(0)), "");
    }

    /// @dev The test contract is the hook's initializer, so it initializes the pool itself at price 1.
    function _deployHookAndPool(bool quoteCurrency0) private {
        HookTestCoin a = new HookTestCoin();
        HookTestCoin b = new HookTestCoin();
        (HookTestCoin lower, HookTestCoin upper) = address(a) < address(b) ? (a, b) : (b, a);
        (quote, token) = quoteCurrency0 ? (lower, upper) : (upper, lower);
        bytes memory arguments = abi.encode(manager, address(token), address(quote), address(this), DEV, DIVIDENDS);
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(ElonomicsHook).creationCode, arguments));
        hook = new ElonomicsHook{salt: mineHookSalt(address(this), initCodeHash)}(
            manager, address(token), address(quote), address(this), DEV, DIVIDENDS
        );
        require(uint160(address(hook)) & 0x3fff == 0x20cc, "invalid hook permissions");
        key = PoolKey(Currency.wrap(address(lower)), Currency.wrap(address(upper)), 0, 60, IHooks(address(hook)));
        manager.initialize(key, uint160(1 << 96));
        token.approve(address(liquidityRouter), type(uint256).max);
        quote.approve(address(liquidityRouter), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        quote.approve(address(router), type(uint256).max);
    }

    function _swap(bool buy, int256 amount, uint160 limit) private returns (BalanceDelta) {
        return router.swap(key, _params(buy, amount, limit), PoolSwapTest.TestSettings(false, false), "");
    }

    function _params(bool buy, int256 amount, uint160 limit) private view returns (SwapParams memory) {
        bool zeroForOne = buy == quoteIs0();
        if (limit == 0) limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        return SwapParams(zeroForOne, amount, limit);
    }

    function quoteIs0() private view returns (bool) {
        return address(quote) < address(token);
    }

    function _quoteDelta(BalanceDelta delta) private view returns (int256) {
        return quoteIs0() ? delta.amount0() : delta.amount1();
    }

    function _expectWrongPool(PoolKey memory wrong) private {
        vm.prank(address(manager));
        vm.expectRevert(ElonomicsHook.UnsupportedPool.selector);
        hook.beforeSwap(address(this), wrong, _params(true, -1e18, 0), "");
    }

    function _assertSolvent() private view {
        uint256 liability = hook.dividendsAccrued() + hook.platformAccrued() + hook.devAccrued();
        uint256 claims = manager.balanceOf(address(hook), CurrencyLibrary.toId(Currency.wrap(address(quote))));
        require(claims == liability, "fees not backed by claims");
        require(hook.totalFeesAccrued() - hook.totalFeesClaimed() == liability, "liability conservation");
    }
}
