// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fixed-supply ELON with SPCX rewards earned over time by circulating holders.
contract Elonomics is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant REWARD_DURATION = 1 days;
    uint256 private constant SCALE = 1 << 128;
    address private constant DEAD = address(0xdead);

    IERC20 public immutable rewardToken;
    address public immutable poolManager;
    uint256 public eligibleSupply;
    uint256 public rewardPerToken;
    uint256 public streamAmount;
    uint256 public streamStart;
    uint256 public streamFinish;
    uint256 public streamReleased;
    uint256 public queuedRewards;
    uint256 public totalFunded;
    uint256 public totalClaimed;

    uint256 private lastRewardUpdate;
    uint256 private globalRemainder;
    mapping(address => uint256) private paidIndex;
    mapping(address => uint256) private accrued;
    mapping(address => uint256) private fraction;

    error InvalidConfiguration();
    error NoEligibleHolders();
    error NoRewardsReceived();

    event RewardsFunded(address indexed funder, uint256 received, bool queued);
    event RewardsClaimed(address indexed holder, uint256 amount);

    constructor(address initialRecipient, uint256 initialSupply, address rewardToken_, address poolManager_)
        ERC20("Elonomics", "ELON")
    {
        rewardToken = IERC20(rewardToken_);
        poolManager = poolManager_;
        if (
            rewardToken_.code.length == 0 || poolManager_.code.length == 0 || rewardToken_ == poolManager_
                || initialSupply == 0 || initialSupply > type(uint128).max || isExcluded(initialRecipient)
        ) revert InvalidConfiguration();
        _mint(initialRecipient, initialSupply);
    }

    function isExcluded(address account) public view returns (bool) {
        return account == address(0) || account == address(this) || account == poolManager || account == DEAD;
    }

    /// @notice Active streams keep their finish time; top-ups stream during the following day.
    function fundRewards(uint256 amount) external nonReentrant returns (uint256 received) {
        _checkpointGlobal();
        if (eligibleSupply == 0) revert NoEligibleHolders();
        uint256 beforeBalance = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        received = rewardToken.balanceOf(address(this)) - beforeBalance;
        if (received == 0) revert NoRewardsReceived();
        if (eligibleSupply == 0) revert NoEligibleHolders();

        totalFunded += received;
        bool queued = streamAmount != 0;
        if (queued) {
            queuedRewards += received;
        } else {
            streamAmount = received;
            streamStart = block.timestamp;
            streamFinish = block.timestamp + REWARD_DURATION;
        }
        emit RewardsFunded(msg.sender, received, queued);
    }

    function claim() external returns (uint256) {
        return claimFor(msg.sender);
    }

    /// @notice Anyone may pay the gas, but only the holder receives their rewards.
    function claimFor(address holder) public nonReentrant returns (uint256 amount) {
        _checkpointGlobal();
        _checkpointHolder(holder);
        amount = accrued[holder];
        if (amount != 0) {
            accrued[holder] = 0;
            totalClaimed += amount;
            rewardToken.safeTransfer(holder, amount);
            emit RewardsClaimed(holder, amount);
        }
    }

    function claimableRewards(address holder) external view returns (uint256) {
        if (isExcluded(holder)) return 0;
        uint256 index = rewardPerToken;
        if (eligibleSupply != 0 && streamAmount != 0) {
            uint256 released = _vested(streamAmount, streamStart) - streamReleased;
            if (block.timestamp >= streamFinish && queuedRewards != 0) {
                released += _vested(queuedRewards, streamFinish);
            }
            (uint256 increment,) = _indexIncrement(released);
            index += increment;
        }
        uint256 delta = index - paidIndex[holder];
        uint256 balance = balanceOf(holder);
        return accrued[holder] + Math.mulDiv(balance, delta, SCALE) + (fraction[holder] + mulmod(balance, delta, SCALE))
            / SCALE;
    }

    function _update(address from, address to, uint256 value) internal override {
        _checkpointGlobal();
        _checkpointHolder(from);
        if (to != from) _checkpointHolder(to);
        super._update(from, to, value);
        bool fromExcluded = isExcluded(from);
        bool toExcluded = isExcluded(to);
        if (fromExcluded != toExcluded) {
            if (fromExcluded) eligibleSupply += value;
            else eligibleSupply -= value;
        }
    }

    function _checkpointHolder(address holder) private {
        if (isExcluded(holder)) return;
        uint256 delta = rewardPerToken - paidIndex[holder];
        if (delta != 0) {
            uint256 balance = balanceOf(holder);
            uint256 combinedFraction = fraction[holder] + mulmod(balance, delta, SCALE);
            accrued[holder] += Math.mulDiv(balance, delta, SCALE) + combinedFraction / SCALE;
            fraction[holder] = combinedFraction % SCALE;
            paidIndex[holder] = rewardPerToken;
        }
    }

    function _checkpointGlobal() private {
        if (streamAmount != 0) {
            if (eligibleSupply == 0) {
                // No-holder time pauses both streams instead of gifting elapsed rewards to the next buyer.
                uint256 paused = block.timestamp - lastRewardUpdate;
                streamStart += paused;
                streamFinish += paused;
            } else {
                uint256 vested = _vested(streamAmount, streamStart);
                uint256 released = vested - streamReleased;
                streamReleased = vested;
                if (block.timestamp >= streamFinish) {
                    if (queuedRewards != 0) {
                        streamAmount = queuedRewards;
                        queuedRewards = 0;
                        streamStart = streamFinish;
                        streamFinish += REWARD_DURATION;
                        streamReleased = _vested(streamAmount, streamStart);
                        released += streamReleased;
                    }
                    if (block.timestamp >= streamFinish) {
                        streamAmount = 0;
                        streamStart = 0;
                        streamFinish = 0;
                        streamReleased = 0;
                    }
                }
                (uint256 increment, uint256 remainder) = _indexIncrement(released);
                rewardPerToken += increment;
                globalRemainder = remainder;
            }
        }
        lastRewardUpdate = block.timestamp;
    }

    function _vested(uint256 amount, uint256 start) private view returns (uint256) {
        return Math.mulDiv(amount, Math.min(block.timestamp - start, REWARD_DURATION), REWARD_DURATION);
    }

    function _indexIncrement(uint256 released) private view returns (uint256 increment, uint256 remainder) {
        uint256 combinedRemainder = mulmod(released, SCALE, eligibleSupply) + globalRemainder;
        increment = Math.mulDiv(released, SCALE, eligibleSupply) + combinedRemainder / eligibleSupply;
        remainder = combinedRemainder % eligibleSupply;
    }
}
