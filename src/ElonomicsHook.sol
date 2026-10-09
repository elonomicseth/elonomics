// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Fixed 2% TSLA swap fee: 1% dividends, 0.3% platform, 0.7% developer.
/// @dev Exact-input only. Quote-input swaps must fully fill; sells charge actual quote output.
///      Fees accrue as PoolManager ERC-6909 claims, so a buy never depends on the PoolManager already holding TSLA.
contract ElonomicsHook is BaseHook, IUnlockCallback, ReentrancyGuardTransient {
    using CurrencyLibrary for Currency;

    address public constant platformRecipient = 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c;
    address public immutable token;
    address public immutable quote;
    address public immutable initializer;
    address public immutable devRecipient;
    address public immutable dividendRecipient;

    uint256 public dividendsAccrued;
    uint256 public platformAccrued;
    uint256 public devAccrued;
    uint256 public totalFeesAccrued;
    uint256 public totalFeesClaimed;
    uint256 private _expectedQuoteInputPlusOne;

    error InvalidAddress();
    error UnauthorizedInitializer();
    error UnsupportedPool();
    error ExactOutputUnsupported();
    error PendingSwap();
    error InvalidQuoteDelta();
    error PartialFillUnsupported(uint256 expected, uint256 actual);
    error FeeDeltaOverflow();
    error UnsupportedQuoteTransfer();

    event FeesAccrued(bool indexed buy, uint256 grossQuote, uint256 dividends, uint256 platform, uint256 dev);
    event FeesClaimed(address indexed recipient, uint256 amount);

    constructor(
        IPoolManager poolManager_,
        address token_,
        address quote_,
        address initializer_,
        address devRecipient_,
        address dividendRecipient_
    ) BaseHook(poolManager_) {
        if (
            address(poolManager_) == address(0) || token_ == address(0) || quote_ == address(0) || token_ == quote_
                || initializer_ == address(0) || devRecipient_ == address(0) || dividendRecipient_ == address(0)
                || devRecipient_ == address(this) || dividendRecipient_ == address(this)
        ) revert InvalidAddress();
        token = token_;
        quote = quote_;
        initializer = initializer_;
        devRecipient = devRecipient_;
        dividendRecipient = dividendRecipient_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = true;
    }

    /// @dev Rounding dust belongs to dividends; the three amounts always sum to floor(gross / 50).
    function previewFees(uint256 grossQuote)
        public
        pure
        returns (uint256 total, uint256 dividends, uint256 platform, uint256 dev)
    {
        total = grossQuote / 50;
        platform = Math.mulDiv(grossQuote, 3, 1000);
        dev = Math.mulDiv(grossQuote, 7, 1000);
        dividends = total - platform - dev;
    }

    function claimDividends() external nonReentrant returns (uint256 amount) {
        amount = dividendsAccrued;
        dividendsAccrued = 0;
        _pay(dividendRecipient, amount);
    }

    function claimPlatform() external nonReentrant returns (uint256 amount) {
        amount = platformAccrued;
        platformAccrued = 0;
        _pay(platformRecipient, amount);
    }

    function claimDev() external nonReentrant returns (uint256 amount) {
        amount = devAccrued;
        devAccrued = 0;
        _pay(devRecipient, amount);
    }

    /// @dev Pays one claim: burns the hook's ERC-6909 fee claims and sends the TSLA to the fixed recipient.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address recipient, uint256 amount) = abi.decode(data, (address, uint256));
        Currency currency = Currency.wrap(quote);
        poolManager.burn(address(this), currency.toId(), amount);
        uint256 beforeBalance = IERC20(quote).balanceOf(recipient);
        poolManager.take(currency, recipient, amount);
        if (IERC20(quote).balanceOf(recipient) != beforeBalance + amount) revert UnsupportedQuoteTransfer();
        return "";
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        _checkPool(key);
        if (sender != initializer) revert UnauthorizedInitializer();
        return IHooks.beforeInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        nonReentrant
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _checkPool(key);
        if (params.amountSpecified >= 0) revert ExactOutputUnsupported();
        if (_expectedQuoteInputPlusOne != 0) revert PendingSwap();
        if (!_isBuy(params)) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 grossQuote = SignedMath.abs(params.amountSpecified);
        int128 fee = _accrue(true, grossQuote);
        _expectedQuoteInputPlusOne = grossQuote - uint128(fee) + 1;
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee, 0), 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        nonReentrant
        returns (bytes4, int128)
    {
        _checkPool(key);
        if (params.amountSpecified >= 0) revert ExactOutputUnsupported();
        int128 quoteDelta = quote < token ? delta.amount0() : delta.amount1();
        if (_isBuy(params)) {
            uint256 pending = _expectedQuoteInputPlusOne;
            if (pending == 0) revert PendingSwap();
            _expectedQuoteInputPlusOne = 0;
            if (quoteDelta > 0) revert InvalidQuoteDelta();
            uint256 actual = SignedMath.abs(int256(quoteDelta));
            if (actual != pending - 1) revert PartialFillUnsupported(pending - 1, actual);
            return (IHooks.afterSwap.selector, 0);
        }
        if (quoteDelta < 0) revert InvalidQuoteDelta();
        return (IHooks.afterSwap.selector, _accrue(false, uint128(quoteDelta)));
    }

    function _checkPool(PoolKey calldata key) private view {
        (address currency0, address currency1) = quote < token ? (quote, token) : (token, quote);
        if (
            Currency.unwrap(key.currency0) != currency0 || Currency.unwrap(key.currency1) != currency1
                || address(key.hooks) != address(this) || key.fee != 0 || key.tickSpacing != 60
        ) revert UnsupportedPool();
    }

    function _isBuy(SwapParams calldata params) private view returns (bool) {
        return params.zeroForOne == (quote < token);
    }

    function _accrue(bool buy, uint256 grossQuote) private returns (int128 feeDelta) {
        (uint256 total, uint256 dividends, uint256 platform, uint256 dev) = previewFees(grossQuote);
        if (total > uint256(uint128(type(int128).max))) revert FeeDeltaOverflow();
        if (total == 0) return 0;
        dividendsAccrued += dividends;
        platformAccrued += platform;
        devAccrued += dev;
        totalFeesAccrued += total;
        // Claims instead of a token transfer: the swapper's settlement later in the same unlock funds them.
        poolManager.mint(address(this), Currency.wrap(quote).toId(), total);
        emit FeesAccrued(buy, grossQuote, dividends, platform, dev);
        return int128(uint128(total));
    }

    function _pay(address recipient, uint256 amount) private {
        if (amount == 0) return;
        totalFeesClaimed += amount;
        poolManager.unlock(abi.encode(recipient, amount));
        emit FeesClaimed(recipient, amount);
    }
}
