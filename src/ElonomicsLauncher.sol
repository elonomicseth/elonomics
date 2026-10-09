// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IElonomicsV3Factory, IElonomicsV3Router} from "./ElonomicsFeeProcessor.sol";

/// @dev The part of the canonical Uniswap v4 PositionManager used by the launch.
interface IElonomicsPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Runs the ELON market launch inside the Programmable graph transaction: zaps the developer's ETH into
///         TSLA, opens the pool, burns single-sided liquidity holding the whole supply, then makes the first buy.
contract ElonomicsLauncher is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    int24 public constant TICK_SPACING = 60;
    /// @dev Largest tick usable with spacing 60.
    int24 public constant MAX_TICK = 887220;
    uint24 public constant WETH_USDC_FEE = 500;
    uint24 public constant USDC_QUOTE_FEE = 10_000;
    // v4-periphery Actions used for the position mint.
    uint8 private constant MINT_POSITION = 0x02;
    uint8 private constant SETTLE = 0x0b;
    uint8 private constant SWEEP = 0x14;

    IPoolManager public immutable poolManager;
    IElonomicsPositionManager public immutable positionManager;
    IElonomicsV3Router public immutable swapRouter;
    address public immutable weth;
    address public immutable usdc;
    address public immutable quote;
    address public immutable graphFactory;
    bool public launched;

    /// @dev Launcher balances that `launch` must leave exactly as it found them.
    struct Balances {
        uint256 eth;
        uint256 quote;
        uint256 weth;
        uint256 usdc;
    }

    error InvalidConfiguration();
    error Unauthorized();
    error AlreadyLaunched();
    error InvalidLaunch();
    error LaunchCheckFailed();

    event Launched(
        address indexed token,
        address indexed hook,
        PoolId indexed poolId,
        uint256 tokenId,
        uint256 ethIn,
        uint256 quoteIn,
        uint256 tokenToDev
    );

    constructor(
        IPoolManager poolManager_,
        address positionManager_,
        address swapRouter_,
        address weth_,
        address usdc_,
        address quote_,
        address graphFactory_
    ) {
        poolManager = poolManager_;
        positionManager = IElonomicsPositionManager(positionManager_);
        swapRouter = IElonomicsV3Router(swapRouter_);
        weth = weth_;
        usdc = usdc_;
        quote = quote_;
        graphFactory = graphFactory_;
        if (
            address(poolManager_).code.length == 0 || positionManager_.code.length == 0 || swapRouter_.code.length == 0
                || weth_.code.length == 0 || usdc_.code.length == 0 || quote_.code.length == 0 || graphFactory_ == address(0)
        ) revert InvalidConfiguration();
        IElonomicsV3Factory factory = IElonomicsV3Factory(IElonomicsV3Router(swapRouter_).factory());
        if (
            factory.getPool(weth_, usdc_, WETH_USDC_FEE) == address(0)
                || factory.getPool(usdc_, quote_, USDC_QUOTE_FEE) == address(0)
        ) revert InvalidConfiguration();
    }

    /// @param quotePerTokenTick Tick of the TSLA-per-ELON price (both use 18 decimals), a multiple of 60.
    /// @param minimumQuoteOut Smallest TSLA amount the ETH zap may return; below it the whole launch reverts.
    function launch(address token, address hook, address devRecipient, int24 quotePerTokenTick, uint256 minimumQuoteOut)
        external
        payable
        returns (uint256 tokenToDev)
    {
        if (msg.sender != graphFactory) revert Unauthorized();
        if (launched) revert AlreadyLaunched();
        if (
            msg.value == 0 || minimumQuoteOut == 0 || devRecipient == address(0) || token == quote
                || quotePerTokenTick % TICK_SPACING != 0 || quotePerTokenTick <= -MAX_TICK || quotePerTokenTick >= MAX_TICK
        ) revert InvalidLaunch();
        launched = true;
        // Anyone can send dust to this predictable CREATE2 address beforehand, so the checks compare against the
        // balances found on entry instead of requiring zero; that dust stays here untouched.
        Balances memory atEntry = _balances(msg.value);

        uint256 quoteIn = swapRouter.exactInput{value: msg.value}(
            IElonomicsV3Router.ExactInputParams({
                path: abi.encodePacked(weth, WETH_USDC_FEE, usdc, USDC_QUOTE_FEE, quote),
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: msg.value,
                amountOutMinimum: minimumQuoteOut
            })
        );
        if (quoteIn < minimumQuoteOut || IERC20(quote).balanceOf(address(this)) != atEntry.quote + quoteIn) {
            revert LaunchCheckFailed();
        }

        bool tokenIs0 = token < quote;
        int24 startTick = tokenIs0 ? quotePerTokenTick : -quotePerTokenTick;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIs0 ? token : quote),
            currency1: Currency.wrap(tokenIs0 ? quote : token),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        uint160 startPrice = TickMath.getSqrtPriceAtTick(startTick);
        poolManager.initialize(key, startPrice);

        uint256 tokenId = _mintBurnedLiquidity(key, token, tokenIs0, startTick, startPrice);
        tokenToDev = abi.decode(poolManager.unlock(abi.encode(key, tokenIs0, quoteIn, devRecipient)), (uint256));

        _requireLaunched(token, tokenId, tokenToDev, atEntry);
        emit Launched(token, hook, key.toId(), tokenId, msg.value, quoteIn, tokenToDev);
    }

    /// @dev First buy: swaps every zapped TSLA for ELON, pays the PoolManager, sends the ELON to the developer.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        (PoolKey memory key, bool tokenIs0, uint256 quoteIn, address devRecipient) =
            abi.decode(data, (PoolKey, bool, uint256, address));
        bool zeroForOne = !tokenIs0;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency quoteCurrency, Currency tokenCurrency) =
            tokenIs0 ? (key.currency1, key.currency0) : (key.currency0, key.currency1);
        (int128 quoteDelta, int128 tokenDelta) =
            tokenIs0 ? (delta.amount1(), delta.amount0()) : (delta.amount0(), delta.amount1());
        poolManager.sync(quoteCurrency);
        IERC20(quote).safeTransfer(address(poolManager), uint256(uint128(-quoteDelta)));
        poolManager.settle();
        uint256 tokenOut = uint256(uint128(tokenDelta));
        poolManager.take(tokenCurrency, devRecipient, tokenOut);
        return abi.encode(tokenOut);
    }

    /// @dev Mints a position holding only ELON, from the launch price to the extreme, owned by the dead address.
    ///      The PositionManager settles from its own balance and sweeps the rounding dust to the dead address.
    function _mintBurnedLiquidity(PoolKey memory key, address token, bool tokenIs0, int24 startTick, uint160 startPrice)
        private
        returns (uint256 tokenId)
    {
        uint256 amount = IERC20(token).balanceOf(address(this));
        (int24 lower, int24 upper) = tokenIs0 ? (startTick, MAX_TICK) : (-MAX_TICK, startTick);
        uint128 liquidity = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount0(startPrice, TickMath.getSqrtPriceAtTick(upper), amount)
            : LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lower), startPrice, amount);
        (uint128 max0, uint128 max1) = tokenIs0 ? (uint128(amount), uint128(0)) : (uint128(0), uint128(amount));

        tokenId = positionManager.nextTokenId();
        IERC20(token).safeTransfer(address(positionManager), amount);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, lower, upper, uint256(liquidity), max0, max1, DEAD, bytes(""));
        params[1] = abi.encode(Currency.wrap(token), uint256(0), false);
        params[2] = abi.encode(Currency.wrap(token), DEAD);
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(MINT_POSITION, SETTLE, SWEEP), params), block.timestamp
        );
    }

    /// @dev Final checks: the developer got ELON, the position is burned and funded, no ELON is left here, and every
    ///      other balance equals its entry snapshot.
    function _requireLaunched(address token, uint256 tokenId, uint256 tokenToDev, Balances memory atEntry) private view {
        Balances memory atExit = _balances(0);
        if (
            tokenToDev == 0 || positionManager.ownerOf(tokenId) != DEAD || positionManager.getPositionLiquidity(tokenId) == 0
                || IERC20(token).balanceOf(address(this)) != 0 || atExit.eth != atEntry.eth || atExit.quote != atEntry.quote
                || atExit.weth != atEntry.weth || atExit.usdc != atEntry.usdc
        ) revert LaunchCheckFailed();
    }

    /// @param ethInFlight ETH that arrived with the current call and is not part of the snapshot.
    function _balances(uint256 ethInFlight) private view returns (Balances memory balances) {
        balances.eth = address(this).balance - ethInFlight;
        balances.quote = IERC20(quote).balanceOf(address(this));
        balances.weth = IERC20(weth).balanceOf(address(this));
        balances.usdc = IERC20(usdc).balanceOf(address(this));
    }
}
