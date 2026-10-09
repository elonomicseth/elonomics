// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Elonomics} from "../src/Elonomics.sol";
import {ElonomicsFeeProcessor, IElonomicsV3Router} from "../src/ElonomicsFeeProcessor.sol";
import {RewardMock, PoolManagerCustodyMock, ElonomicsVm} from "./Elonomics.t.sol";

contract ProcessorV3FactoryMock {
    mapping(bytes32 => address) private pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        (a, b) = a < b ? (a, b) : (b, a);
        pools[keccak256(abi.encode(a, b, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        (a, b) = a < b ? (a, b) : (b, a);
        return pools[keccak256(abi.encode(a, b, fee))];
    }
}

contract ProcessorV3PoolMock {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 10_000;
    uint128 public liquidity = 1 ether;
    uint16 public cardinality;
    bool public hasHistory = true;
    int56 public cumulativeDelta;

    constructor(address factory_, address a, address b) {
        factory = factory_;
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setDelta(int56 delta) external {
        cumulativeDelta = delta;
    }

    function setLiquidity(uint128 value) external {
        liquidity = value;
    }

    function setHistory(bool available) external {
        hasHistory = available;
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        cardinality = next;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory ticks, uint160[] memory secondsPerLiquidity)
    {
        require(hasHistory, "OLD");
        require(secondsAgos.length == 2 && secondsAgos[1] == 0);
        ticks = new int56[](2);
        ticks[1] = cumulativeDelta;
        secondsPerLiquidity = new uint160[](2);
        secondsPerLiquidity[1] = 1;
    }
}

contract ProcessorV3RouterMock is IElonomicsV3Router {
    address public immutable factory;
    IERC20 private immutable quote;
    IERC20 private immutable reward;
    uint256 public output;
    uint256 public lastMinimum;
    address public lastRecipient;
    bytes public lastPath;
    bool public ignoreMinimum;
    bool public reenter;
    bool public callbackSucceeded;

    constructor(address factory_, address quote_, address reward_) {
        factory = factory_;
        quote = IERC20(quote_);
        reward = IERC20(reward_);
    }

    function setOutput(uint256 amount) external {
        output = amount;
    }

    function setIgnoreMinimum(bool ignore) external {
        ignoreMinimum = ignore;
    }

    function setReenter(bool value) external {
        reenter = value;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256) {
        require(params.deadline >= block.timestamp);
        require(ignoreMinimum || output >= params.amountOutMinimum, "Too little received");
        lastMinimum = params.amountOutMinimum;
        lastRecipient = params.recipient;
        lastPath = params.path;
        quote.transferFrom(msg.sender, address(this), params.amountIn);
        if (reenter) {
            (callbackSucceeded,) = msg.sender.call(abi.encodeCall(ElonomicsFeeProcessor.convert, (params.amountIn)));
        }
        reward.transfer(params.recipient, output);
        return output;
    }
}

contract ElonomicsFeeProcessorTest {
    ElonomicsVm private constant vm = ElonomicsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    RewardMock private quote;
    RewardMock private reward;
    RewardMock private usdc;
    Elonomics private token;
    ProcessorV3FactoryMock private factory;
    ProcessorV3RouterMock private router;
    ProcessorV3PoolMock private quotePool;
    ProcessorV3PoolMock private rewardPool;
    ElonomicsFeeProcessor private processor;

    function setUp() public {
        quote = new RewardMock();
        reward = new RewardMock();
        usdc = new RewardMock();
        token = new Elonomics(address(this), 100 ether, address(reward), address(new PoolManagerCustodyMock()));
        factory = new ProcessorV3FactoryMock();
        quotePool = new ProcessorV3PoolMock(address(factory), address(quote), address(usdc));
        rewardPool = new ProcessorV3PoolMock(address(factory), address(usdc), address(reward));
        factory.setPool(address(quote), address(usdc), 10_000, address(quotePool));
        factory.setPool(address(usdc), address(reward), 10_000, address(rewardPool));
        router = new ProcessorV3RouterMock(address(factory), address(quote), address(reward));
        processor = _deploy(1_800, 100);
        quote.mint(address(processor), 1_000 ether);
        reward.mint(address(router), 2_000 ether);
        router.setOutput(975 ether);
    }

    function testTwoHopFeeAdjustedMinimumAndAllProceedsFundElon() public {
        _eq(processor.minimumOutput(1_000 ether), 970.299 ether);
        reward.mint(address(processor), 7 ether);
        vm.prank(address(0xbeef));
        _eq(processor.convert(1_000 ether), 975 ether);
        _eq(quote.balanceOf(address(processor)), 0);
        _eq(reward.balanceOf(address(processor)), 7 ether);
        _eq(token.totalFunded(), 975 ether);
        _eq(router.lastMinimum(), 970.299 ether);
        require(router.lastRecipient() == address(processor));
        require(
            keccak256(router.lastPath())
                == keccak256(
                    abi.encodePacked(address(quote), uint24(10_000), address(usdc), uint24(10_000), address(reward))
                )
        );
        _eq(quote.allowance(address(processor), address(router)), 0);
        _eq(reward.allowance(address(processor), address(token)), 0);
        _eq(token.claimableRewards(address(this)), 0);
        vm.warp(block.timestamp + 1 days);
        uint256 claimed = token.claim();
        require(claimed >= 975 ether - 1 && claimed <= 975 ether);
    }

    function testOutputBelowOracleMinimumRevertsWithoutSpending() public {
        router.setOutput(950 ether);
        vm.expectRevert();
        processor.convert(1_000 ether);
        _eq(quote.balanceOf(address(processor)), 1_000 ether);
        _eq(token.totalFunded(), 0);
        _eq(quote.allowance(address(processor), address(router)), 0);
        router.setIgnoreMinimum(true);
        vm.expectRevert(ElonomicsFeeProcessor.InsufficientOutput.selector);
        processor.convert(1_000 ether);
        _eq(quote.balanceOf(address(processor)), 1_000 ether);
    }

    function testMissingOracleHistoryAndZeroLiquidityFailClosed() public {
        quotePool.setHistory(false);
        vm.expectRevert();
        processor.convert(1_000 ether);
        _eq(quote.balanceOf(address(processor)), 1_000 ether);
        quotePool.setHistory(true);
        rewardPool.setLiquidity(0);
        vm.expectRevert(ElonomicsFeeProcessor.UnavailableOracle.selector);
        processor.convert(1_000 ether);
        _eq(quote.balanceOf(address(processor)), 1_000 ether);
    }

    function testIssuerFundingFailureRollsBackBothSwapAndApprovals() public {
        reward.setBlocked(address(token));
        vm.expectRevert();
        processor.convert(1_000 ether);
        _eq(quote.balanceOf(address(processor)), 1_000 ether);
        _eq(quote.balanceOf(address(router)), 0);
        _eq(reward.balanceOf(address(router)), 2_000 ether);
        _eq(reward.balanceOf(address(processor)), 0);
        _eq(token.totalFunded(), 0);
        _eq(quote.allowance(address(processor), address(router)), 0);
        _eq(reward.allowance(address(processor), address(token)), 0);
    }

    function testNegativeFractionalMeanTickRoundsDown() public {
        uint256 before = processor.minimumOutput(1_000 ether);
        quotePool.setDelta(-1);
        uint256 afterValue = processor.minimumOutput(1_000 ether);
        if (address(quote) < address(usdc)) require(afterValue < before);
        else require(afterValue > before);
    }

    function testPoolRegistryAndTokenIdentityMustMatch() public {
        factory.setPool(address(quote), address(usdc), 10_000, address(rewardPool));
        vm.expectRevert(ElonomicsFeeProcessor.InvalidPool.selector);
        _deploy(1_800, 100);
        factory.setPool(address(quote), address(usdc), 10_000, address(quotePool));
        vm.expectRevert(ElonomicsFeeProcessor.InvalidPool.selector);
        new ElonomicsFeeProcessor(
            address(token),
            address(quote),
            address(reward),
            address(usdc),
            address(router),
            address(rewardPool),
            address(quotePool),
            1_800,
            100
        );
    }

    function testConfigurationBoundsAndRewardAssetMustMatch() public {
        vm.expectRevert(ElonomicsFeeProcessor.InvalidConfiguration.selector);
        _deploy(1_799, 100);
        vm.expectRevert(ElonomicsFeeProcessor.InvalidConfiguration.selector);
        _deploy(7 days + 1, 100);
        vm.expectRevert(ElonomicsFeeProcessor.InvalidConfiguration.selector);
        _deploy(1_800, 501);
        vm.expectRevert(ElonomicsFeeProcessor.InvalidConfiguration.selector);
        new ElonomicsFeeProcessor(
            address(token),
            address(quote),
            address(usdc),
            address(reward),
            address(router),
            address(quotePool),
            address(rewardPool),
            1_800,
            100
        );
        vm.expectRevert(ElonomicsFeeProcessor.InvalidAmount.selector);
        processor.convert(0);
        vm.expectRevert(ElonomicsFeeProcessor.InvalidAmount.selector);
        processor.convert(uint256(type(uint128).max) + 1);
    }

    function testPrepareOracleReservesEnoughObservationsButDoesNotInventHistory() public {
        processor.prepareOracle();
        _eq(quotePool.cardinality(), 256);
        _eq(rewardPool.cardinality(), 256);
        ElonomicsFeeProcessor weekly = _deploy(7 days, 100);
        weekly.prepareOracle();
        _eq(quotePool.cardinality(), 512);
        weekly.prepareOracle();
        _eq(quotePool.cardinality(), 768);
        quotePool.setHistory(false);
        vm.expectRevert();
        weekly.minimumOutput(1_000 ether);
    }

    function testSwapCallbackCannotReenterConversion() public {
        router.setReenter(true);
        _eq(processor.convert(1_000 ether), 975 ether);
        require(!router.callbackSucceeded());
        _eq(token.totalFunded(), 975 ether);
    }

    function _deploy(uint32 window, uint16 slippage) private returns (ElonomicsFeeProcessor) {
        return new ElonomicsFeeProcessor(
            address(token),
            address(quote),
            address(reward),
            address(usdc),
            address(router),
            address(quotePool),
            address(rewardPool),
            window,
            slippage
        );
    }

    function _eq(uint256 actual, uint256 expected) private pure {
        require(actual == expected, "Values differ");
    }
}
