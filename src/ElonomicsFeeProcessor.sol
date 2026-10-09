// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

interface IElonomicsRewards {
    function rewardToken() external view returns (address);
    function fundRewards(uint256 amount) external returns (uint256 received);
}

interface IElonomicsV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IElonomicsV3Pool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function increaseObservationCardinalityNext(uint16 cardinality) external;
}

/// @dev Original Uniswap V3 SwapRouter (0xE592...), whose exactInput tuple includes a deadline.
interface IElonomicsV3Router {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function factory() external view returns (address);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Converts collected TSLA through two fixed V3 pools and funds ELON's SPCX stream.
contract ElonomicsFeeProcessor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10_000;
    IElonomicsRewards public immutable rewardDistributor;
    IERC20 public immutable quote;
    IERC20 public immutable reward;
    address public immutable usdc;
    IElonomicsV3Router public immutable swapRouter;
    IElonomicsV3Pool public immutable quotePool;
    IElonomicsV3Pool public immutable rewardPool;
    uint32 public immutable oracleWindow;
    uint16 public immutable maxSlippageBps;

    error InvalidConfiguration();
    error InvalidPool();
    error InvalidAmount();
    error UnavailableOracle();
    error InsufficientOutput();
    error IncompleteFunding();

    event FeesConverted(address indexed caller, uint256 quoteSpent, uint256 rewardsFunded);

    constructor(
        address rewardDistributor_,
        address quote_,
        address reward_,
        address usdc_,
        address swapRouter_,
        address quotePool_,
        address rewardPool_,
        uint32 oracleWindow_,
        uint16 maxSlippageBps_
    ) {
        if (
            rewardDistributor_.code.length == 0 || quote_.code.length == 0 || reward_.code.length == 0
                || usdc_.code.length == 0 || swapRouter_.code.length == 0 || quote_ == reward_ || quote_ == usdc_
                || reward_ == usdc_ || oracleWindow_ < 30 minutes || oracleWindow_ > 7 days || maxSlippageBps_ > 500
                || IElonomicsRewards(rewardDistributor_).rewardToken() != reward_
        ) revert InvalidConfiguration();
        rewardDistributor = IElonomicsRewards(rewardDistributor_);
        quote = IERC20(quote_);
        reward = IERC20(reward_);
        usdc = usdc_;
        swapRouter = IElonomicsV3Router(swapRouter_);
        quotePool = IElonomicsV3Pool(quotePool_);
        rewardPool = IElonomicsV3Pool(rewardPool_);
        oracleWindow = oracleWindow_;
        maxSlippageBps = maxSlippageBps_;

        address factory = swapRouter.factory();
        if (factory.code.length == 0) revert InvalidConfiguration();
        _validatePool(quotePool, factory, quote_, usdc_);
        _validatePool(rewardPool, factory, usdc_, reward_);
    }

    /// @notice Permissionless: caller selects only the amount; route, recipient and price guard are fixed.
    function convert(uint256 amount) external nonReentrant returns (uint256 funded) {
        uint256 minimum = minimumOutput(amount);
        uint256 beforeBalance = reward.balanceOf(address(this));
        quote.forceApprove(address(swapRouter), amount);
        swapRouter.exactInput(
            IElonomicsV3Router.ExactInputParams({
                path: abi.encodePacked(address(quote), POOL_FEE, usdc, POOL_FEE, address(reward)),
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minimum
            })
        );
        quote.forceApprove(address(swapRouter), 0);
        uint256 received = reward.balanceOf(address(this)) - beforeBalance;
        if (received < minimum) revert InsufficientOutput();

        reward.forceApprove(address(rewardDistributor), received);
        funded = rewardDistributor.fundRewards(received);
        reward.forceApprove(address(rewardDistributor), 0);
        if (funded == 0 || funded > received || reward.balanceOf(address(this)) != beforeBalance) {
            revert IncompleteFunding();
        }
        emit FeesConverted(msg.sender, amount, funded);
    }

    function minimumOutput(uint256 amount) public view returns (uint256 minimum) {
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        uint256 intermediate = _quoteAtTick(
            _meanTick(quotePool), Math.mulDiv(amount, 1_000_000 - POOL_FEE, 1_000_000), address(quote), usdc
        );
        if (intermediate == 0 || intermediate > type(uint128).max) revert InvalidAmount();
        uint256 output = _quoteAtTick(
            _meanTick(rewardPool), Math.mulDiv(intermediate, 1_000_000 - POOL_FEE, 1_000_000), usdc, address(reward)
        );
        minimum = Math.mulDiv(output, 10_000 - maxSlippageBps, 10_000);
        if (minimum == 0) revert InvalidAmount();
    }

    /// @notice Grows at most 256 slots per pool per call; swaps must still populate the requested history.
    function prepareOracle() external {
        uint16 cardinality = uint16(Math.max(256, (uint256(oracleWindow) + 11) / 12 + 2));
        _preparePool(quotePool, cardinality);
        _preparePool(rewardPool, cardinality);
    }

    function _preparePool(IElonomicsV3Pool pool, uint16 target) private {
        (,,,, uint16 currentNext,,) = pool.slot0();
        if (currentNext < target) {
            pool.increaseObservationCardinalityNext(uint16(Math.min(target, uint256(currentNext) + 256)));
        }
    }

    function _validatePool(IElonomicsV3Pool pool, address factory, address a, address b) private view {
        (address token0, address token1) = a < b ? (a, b) : (b, a);
        if (
            address(pool).code.length == 0 || pool.factory() != factory || pool.fee() != POOL_FEE
                || pool.token0() != token0 || pool.token1() != token1
                || IElonomicsV3Factory(factory).getPool(token0, token1, POOL_FEE) != address(pool)
        ) revert InvalidPool();
    }

    function _meanTick(IElonomicsV3Pool pool) private view returns (int24) {
        if (pool.liquidity() == 0) revert UnavailableOracle();
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = oracleWindow;
        (int56[] memory cumulatives,) = pool.observe(secondsAgos);
        if (cumulatives.length != 2) revert UnavailableOracle();
        int56 delta;
        unchecked {
            delta = cumulatives[1] - cumulatives[0];
        }
        int56 window = int56(uint56(oracleWindow));
        int56 mean = delta / window;
        if (delta < 0 && delta % window != 0) mean--;
        if (mean < TickMath.MIN_TICK || mean > TickMath.MAX_TICK) revert UnavailableOracle();
        return int24(mean);
    }

    function _quoteAtTick(int24 tick, uint256 amount, address tokenIn, address tokenOut)
        private
        pure
        returns (uint256)
    {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return tokenIn < tokenOut
                ? FullMath.mulDiv(ratioX192, amount, 1 << 192)
                : FullMath.mulDiv(1 << 192, amount, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return tokenIn < tokenOut
            ? FullMath.mulDiv(ratioX128, amount, 1 << 128)
            : FullMath.mulDiv(1 << 128, amount, ratioX128);
    }
}
