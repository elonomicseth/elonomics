// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Elonomics} from "../src/Elonomics.sol";

interface ElonomicsVm {
    function warp(uint256 timestamp) external;
    function prank(address caller) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
}

contract RewardMock is ERC20 {
    address public blocked;
    uint256 public feeBps;
    address public callbackTarget;
    address public callbackHolder;
    bool public callbackSucceeded;

    constructor() ERC20("Mock tokenized SPCX", "SPCX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account) external {
        blocked = account;
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function setCallback(address target, address holder) external {
        callbackTarget = target;
        callbackHolder = holder;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(to != blocked || to == address(0), "Issuer blocked recipient");
        uint256 fee = from == address(0) ? 0 : amount * feeBps / 10_000;
        if (fee != 0) super._update(from, address(0xfee), fee);
        super._update(from, to, amount - fee);
        if (callbackTarget != address(0)) {
            (callbackSucceeded,) = callbackTarget.call(abi.encodeCall(Elonomics.claimFor, (callbackHolder)));
        }
    }
}

contract PoolManagerCustodyMock {}

contract ElonomicsTest {
    ElonomicsVm private constant vm = ElonomicsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BOB = address(0xb0b);
    address private constant BORROWER = address(0xbeef);
    uint256 private constant DAY = 1 days;
    RewardMock private reward;
    Elonomics private token;
    address private manager;

    function setUp() public {
        reward = new RewardMock();
        manager = address(new PoolManagerCustodyMock());
        token = new Elonomics(address(this), 100 ether, address(reward), manager);
        reward.mint(address(this), 1_000_000 ether);
        reward.approve(address(token), type(uint256).max);
    }

    function testFixedSupplyAndConfiguration() public {
        _eq(token.totalSupply(), 100 ether);
        _eq(token.balanceOf(address(this)), 100 ether);
        _eq(token.eligibleSupply(), 100 ether);
        require(keccak256(bytes(token.name())) == keccak256("Elonomics"));
        require(keccak256(bytes(token.symbol())) == keccak256("ELON"));
        (bool minted,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", BOB, 1));
        require(!minted);
        vm.expectRevert(Elonomics.InvalidConfiguration.selector);
        new Elonomics(manager, 100 ether, address(reward), manager);
        vm.expectRevert(Elonomics.InvalidConfiguration.selector);
        new Elonomics(address(this), 0, address(reward), manager);
    }

    function testRewardsFollowTimeAndStayWithOriginalHolderAfterTransfer() public {
        uint256 start = block.timestamp;
        token.fundRewards(100 ether);
        _eq(token.claimableRewards(address(this)), 0);
        vm.warp(start + DAY / 2);
        token.transfer(BOB, 50 ether);
        _eq(token.claimableRewards(address(this)), 50 ether);
        _eq(token.claimableRewards(BOB), 0);
        vm.warp(start + DAY);
        token.transfer(BOB, 50 ether);
        _eq(token.claim(), 75 ether);
        _eq(token.claimFor(BOB), 25 ether);
        _eq(reward.balanceOf(BOB), 25 ether);
        _eq(token.claim(), 0);
        _eq(token.totalClaimed(), 100 ether);
    }

    function testQueuedFundingDoesNotPostponeActiveStream() public {
        uint256 start = block.timestamp;
        token.fundRewards(24 ether);
        vm.warp(start + 6 hours);
        token.fundRewards(48 ether);
        _eq(token.streamFinish(), start + DAY);
        _eq(token.queuedRewards(), 48 ether);
        vm.warp(start + DAY);
        _near(token.claim(), 24 ether);
        _eq(token.streamFinish(), start + 2 * DAY);
        _eq(token.queuedRewards(), 0);
        vm.warp(start + 36 hours);
        _near(token.claim(), 24 ether);
        vm.warp(start + 48 hours);
        _near(token.claim(), 24 ether);
        _near(token.totalClaimed(), 72 ether);
        _eq(token.streamAmount(), 0);
    }

    function testLazyCheckpointConsumesAtMostCurrentAndQueuedStream() public {
        uint256 start = block.timestamp;
        token.fundRewards(24 ether);
        token.fundRewards(48 ether);
        vm.warp(start + 365 days);
        _near(token.claimableRewards(address(this)), 72 ether);
        _near(token.claim(), 72 ether);
        _eq(token.streamAmount(), 0);
        _eq(token.queuedRewards(), 0);
        token.fundRewards(12 ether);
        _eq(token.streamFinish(), block.timestamp + DAY);
    }

    function testFlashBorrowAndFundingCannotCaptureElapsedOrNewRewards() public {
        uint256 start = block.timestamp;
        token.fundRewards(24 ether);
        vm.warp(start + 12 hours);
        token.transfer(BORROWER, 100 ether);
        reward.mint(BORROWER, 100 ether);
        vm.prank(BORROWER);
        reward.approve(address(token), 100 ether);
        vm.prank(BORROWER);
        token.fundRewards(100 ether);
        vm.prank(BORROWER);
        _eq(token.claim(), 0);
        vm.prank(BORROWER);
        token.transfer(address(this), 100 ether);
        _near(token.claimableRewards(address(this)), 12 ether);
        vm.warp(start + 2 * DAY);
        _near(token.claim(), 124 ether);
        _eq(token.claimableRewards(BORROWER), 0);
    }

    function testNoEligibleSupplyPausesAndPoolInventoryNeverEarns() public {
        uint256 start = block.timestamp;
        token.fundRewards(24 ether);
        vm.warp(start + 6 hours);
        token.transfer(manager, 100 ether);
        _eq(token.eligibleSupply(), 0);
        vm.expectRevert(Elonomics.NoEligibleHolders.selector);
        token.fundRewards(1 ether);
        vm.warp(start + 16 hours);
        _near(token.claimableRewards(address(this)), 6 ether);
        vm.prank(manager);
        token.transfer(BOB, 50 ether);
        _eq(token.streamFinish(), start + DAY + 10 hours);
        _eq(token.claimableRewards(BOB), 0);
        _eq(token.eligibleSupply(), 50 ether);
        vm.warp(start + DAY + 10 hours);
        _near(token.claim(), 6 ether);
        _near(token.claimFor(BOB), 18 ether);
        _eq(token.claimFor(manager), 0);
    }

    function testActualReceivedFundingAndDirectTransfersAreNotDoubleCounted() public {
        uint256 start = block.timestamp;
        reward.transfer(address(token), 10 ether);
        reward.setFee(1_000);
        _eq(token.fundRewards(100 ether), 90 ether);
        _eq(token.totalFunded(), 90 ether);
        reward.setFee(0);
        vm.warp(start + DAY);
        _near(token.claim(), 90 ether);
        _near(reward.balanceOf(address(token)), 10 ether);
        vm.expectRevert(Elonomics.NoRewardsReceived.selector);
        token.fundRewards(0);
    }

    function testFractionalRewardsSurviveRepeatedZeroTransfers() public {
        token = new Elonomics(address(this), 3, address(reward), manager);
        reward.approve(address(token), type(uint256).max);
        token.transfer(BOB, 2);
        uint256 start = block.timestamp;
        token.fundRewards(3);
        vm.warp(start + 8 hours);
        token.transfer(BOB, 0);
        vm.warp(start + 16 hours);
        token.transfer(BOB, 0);
        vm.warp(start + DAY);
        _eq(token.claim(), 1);
        _eq(token.claimFor(BOB), 2);
    }

    function testIssuerTransferFailureRestoresClaimAndDoesNotFreezeElon() public {
        token.transfer(BOB, 50 ether);
        token.fundRewards(100 ether);
        vm.warp(block.timestamp + DAY);
        reward.setBlocked(BOB);
        vm.expectRevert();
        token.claimFor(BOB);
        _eq(token.claimableRewards(BOB), 50 ether);
        _eq(token.totalClaimed(), 0);
        vm.prank(BOB);
        token.transfer(address(this), 50 ether);
        _eq(token.claimableRewards(BOB), 50 ether);
        reward.setBlocked(address(0));
        _eq(token.claimFor(BOB), 50 ether);
    }

    function testRewardCallbackCannotReenterFundingOrClaim() public {
        reward.setCallback(address(token), address(this));
        token.fundRewards(100 ether);
        require(!reward.callbackSucceeded());
        vm.warp(block.timestamp + DAY);
        _eq(token.claim(), 100 ether);
        require(!reward.callbackSucceeded());
        _eq(token.totalClaimed(), 100 ether);
    }

    function testFuzzConservationAcrossTransfersAndQueuedFunding(uint96 first, uint96 second, uint96 moved) public {
        uint256 a = uint256(first) % 1_000 ether + 1;
        uint256 b = uint256(second) % 1_000 ether + 1;
        uint256 transferAmount = uint256(moved) % (100 ether + 1);
        uint256 start = block.timestamp;
        token.fundRewards(a);
        vm.warp(start + 8 hours);
        token.transfer(BOB, transferAmount);
        token.fundRewards(b);
        vm.warp(start + 20 hours);
        token.claimFor(BOB);
        vm.prank(BOB);
        token.transfer(manager, transferAmount / 2);
        vm.warp(start + 3 * DAY);
        uint256 pending = token.claimableRewards(address(this)) + token.claimableRewards(BOB);
        require(token.totalClaimed() + pending <= a + b);
        token.claim();
        token.claimFor(BOB);
        _eq(token.totalClaimed() + reward.balanceOf(address(token)), a + b);
        _eq(token.claimableRewards(manager), 0);
    }

    function _eq(uint256 actual, uint256 expected) private pure {
        require(actual == expected, "Values differ");
    }

    function _near(uint256 actual, uint256 expected) private pure {
        require(actual >= expected - 1 && actual <= expected + 1, "Rounding exceeds one reward atom");
    }
}
