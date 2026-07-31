// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DAX_P2P
 * @notice Trustless P2P Escrow smart contract with fully on-chain ad listings, trade matching, and a stake-based decentralized arbitration system.
 * Features a 0.1% escrow fee split directed to the protocol developer treasury.
 */
contract DAX_P2P is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum TradeStatus { PENDING, PAID, COMPLETED, DISPUTED, CANCELLED }

    struct Ad {
        uint256 id;
        address payable creator;
        address token;
        uint256 amount;        // Total tokens remaining in the ad
        uint256 minLimit;      // Min trade size in tokens
        uint256 maxLimit;      // Max trade size in tokens
        uint256 rate;          // Exchange rate (tokens per fiat unit * 10^6 for precision)
        string fiatSymbol;     // e.g. "USD", "EUR"
        string paymentMethods;  // e.g. "Revolut, Bank Transfer"
        bool isSellAd;         // true = creator is selling tokens for fiat; false = creator is buying tokens
        bool active;
    }

    struct Trade {
        uint256 id;
        uint256 adId;
        address payable buyer;
        address payable seller;
        address token;
        uint256 amount;
        TradeStatus status;
        uint256 timestamp;
        uint256 paymentDeadline;
        uint256 votesForBuyer;
        uint256 votesForSeller;
        string chatHistory;
    }

    // Protocol state
    address payable public immutable treasury;
    uint256 public escrowFeeBps = 10; // 0.1% fee (10 basis points)
    uint256 public tradeDuration = 30 minutes;
    uint256 public arbitrationStakeRequirement = 100 * 10**18; // e.g., 100 platform tokens
    uint256 public slashingAmount = 10 * 10**18; // 10 platform tokens slashed for incorrect votes
    uint256 public jurorRewardShareBps = 5000; // 50% of the trade fee goes to winning jurors (when buyer wins)

    uint256 public adCount;
    uint256 public tradeCount;

    // Arbitration Token (used for staking to become an arbitrator)
    // For simplicity, we can use the AMM LP token or a mock platform token.
    address public immutable arbitrationToken;

    // Track active P2P ads
    mapping(uint256 => Ad) public ads;
    
    // Track trades
    mapping(uint256 => Trade) public trades;

    // Staked amounts for arbitrators
    mapping(address => uint256) public stakedArbitrators;
    address[] public arbitratorList;

    // Track who voted in disputes
    // tradeId => arbitrator => voted
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // Track voters and their choices
    mapping(uint256 => address[]) public tradeVoters;
    mapping(uint256 => mapping(address => bool)) public voteChoices;
    
    // Track active votes per arbitrator to lock their stakes
    mapping(address => uint256) public activeDisputeCount;

    // Events
    event AdCreated(uint256 indexed adId, address indexed creator, address token, uint256 amount, bool isSellAd);
    event AdCancelled(uint256 indexed adId);
    event AdUpdated(uint256 indexed adId, uint256 minLimit, uint256 maxLimit, uint256 rate);
    event TradeInitiated(uint256 indexed tradeId, uint256 indexed adId, address indexed buyer, address seller, uint256 amount);
    event TradeMarkedPaid(uint256 indexed tradeId);
    event TradeReleased(uint256 indexed tradeId, uint256 amountReleased, uint256 feeCollected);
    event TradeDisputed(uint256 indexed tradeId, address indexed disputer);
    event TradeCancelled(uint256 indexed tradeId);
    event ArbitratorStaked(address indexed arbitrator, uint256 amount);
    event ArbitratorUnstaked(address indexed arbitrator, uint256 amount);
    event DisputeResolved(uint256 indexed tradeId, address indexed winner, address indexed resolver);
    event VoteCast(uint256 indexed tradeId, address indexed arbitrator, bool votedForBuyer);
    event P2pChatMessage(uint256 indexed tradeId, address indexed sender, string text, uint256 timestamp);
    event EscrowFeeBpsChanged(uint256 newFeeBps);
    event TradeDurationChanged(uint256 newDuration);
    event ArbitrationStakeRequirementChanged(uint256 newStakeRequirement);
    event SlashingAmountChanged(uint256 newSlashingAmount);
    event JurorRewardShareBpsChanged(uint256 newShareBps);

    constructor(address payable _treasury, address _arbitrationToken) {
        require(_treasury != address(0), "Invalid treasury");
        require(_arbitrationToken != address(0), "Invalid arbitration token");
        treasury = _treasury;
        arbitrationToken = _arbitrationToken;
    }

    function setEscrowFeeBps(uint256 _fee) external {
        require(msg.sender == treasury, "Not treasury");
        require(_fee <= 500, "Fee too high"); // Max 5%
        escrowFeeBps = _fee;
        emit EscrowFeeBpsChanged(_fee);
    }

    function setTradeDuration(uint256 _duration) external {
        require(msg.sender == treasury, "Not treasury");
        require(_duration >= 10 minutes, "Duration too short");
        tradeDuration = _duration;
        emit TradeDurationChanged(_duration);
    }

    function setArbitrationStakeRequirement(uint256 _stake) external {
        require(msg.sender == treasury, "Not treasury");
        arbitrationStakeRequirement = _stake;
        emit ArbitrationStakeRequirementChanged(_stake);
    }

    function setSlashingAmount(uint256 _slashingAmount) external {
        require(msg.sender == treasury, "Not treasury");
        slashingAmount = _slashingAmount;
        emit SlashingAmountChanged(_slashingAmount);
    }

    function setJurorRewardShareBps(uint256 _shareBps) external {
        require(msg.sender == treasury, "Not treasury");
        require(_shareBps <= 10000, "Invalid BPS");
        jurorRewardShareBps = _shareBps;
        emit JurorRewardShareBpsChanged(_shareBps);
    }

    /**
     * @notice Create a P2P listing (Sell Ad: locks tokens instantly; Buy Ad: lists interest without locking tokens)
     */
    function createAd(
        address token,
        uint256 amount,
        uint256 minLimit,
        uint256 maxLimit,
        uint256 rate,
        string calldata fiatSymbol,
        string calldata paymentMethods,
        bool isSellAd
    ) external nonReentrant returns (uint256 adId) {
        require(amount > 0, "Amount must be > 0");
        require(minLimit <= maxLimit, "Invalid limits");
        require(maxLimit <= amount, "Max limit exceeds total");

        adId = ++adCount;

        if (isSellAd) {
            // Lock seller's tokens into the contract instantly
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }

        ads[adId] = Ad({
            id: adId,
            creator: payable(msg.sender),
            token: token,
            amount: amount,
            minLimit: minLimit,
            maxLimit: maxLimit,
            rate: rate,
            fiatSymbol: fiatSymbol,
            paymentMethods: paymentMethods,
            isSellAd: isSellAd,
            active: true
        });

        emit AdCreated(adId, msg.sender, token, amount, isSellAd);
    }

    /**
     * @notice Update the rate and limits of an active Ad
     */
    function updateAd(
        uint256 adId,
        uint256 minLimit,
        uint256 maxLimit,
        uint256 rate,
        string calldata paymentMethods
    ) external {
        Ad storage ad = ads[adId];
        require(ad.creator == msg.sender, "Not ad creator");
        require(ad.active, "Ad not active");
        require(minLimit <= maxLimit, "Invalid limits");
        require(maxLimit <= ad.amount, "Max limit exceeds total");

        ad.minLimit = minLimit;
        ad.maxLimit = maxLimit;
        ad.rate = rate;
        ad.paymentMethods = paymentMethods;

        emit AdUpdated(adId, minLimit, maxLimit, rate);
    }

    /**
     * @notice Cancel an active Ad and refund any locked tokens
     */
    function cancelAd(uint256 adId) external nonReentrant {
        Ad storage ad = ads[adId];
        require(ad.creator == msg.sender, "Not ad creator");
        require(ad.active || (ad.isSellAd && ad.amount > 0), "Ad not active or already withdrawn");
        
        ad.active = false;
        ad.maxLimit = 0; // Mark the ad as manually cancelled/withdrawn!

        if (ad.isSellAd && ad.amount > 0) {
            uint256 refundAmount = ad.amount;
            ad.amount = 0; // Clear it to prevent double-refund or reactivation!
            IERC20(ad.token).safeTransfer(ad.creator, refundAmount);
        }

        emit AdCancelled(adId);
    }

    /**
     * @notice Initiate a trade matching a specific Ad
     */
    function initiateTrade(uint256 adId, uint256 amount) external nonReentrant returns (uint256 tradeId) {
        Ad storage ad = ads[adId];
        require(ad.active, "Ad not active");
        require(amount >= ad.minLimit && amount <= ad.maxLimit, "Amount out of limits");
        require(amount <= ad.amount, "Insufficient ad token balance");

        ad.amount -= amount;
        if (ad.amount < ad.minLimit) {
            ad.active = false; // Turn off ad if remaining amount is below min limit
        }

        tradeId = ++tradeCount;

        address payable buyer;
        address payable seller;

        if (ad.isSellAd) {
            buyer = payable(msg.sender);
            seller = ad.creator;
            // Tokens are already locked in the contract since it was a Sell Ad
        } else {
            buyer = ad.creator;
            seller = payable(msg.sender);
            // Buy Ad: Seller must deposit tokens now into escrow
            IERC20(ad.token).safeTransferFrom(msg.sender, address(this), amount);
        }

        trades[tradeId] = Trade({
            id: tradeId,
            adId: adId,
            buyer: buyer,
            seller: seller,
            token: ad.token,
            amount: amount,
            status: TradeStatus.PENDING,
            timestamp: block.timestamp,
            paymentDeadline: block.timestamp + tradeDuration,
            votesForBuyer: 0,
            votesForSeller: 0,
            chatHistory: ""
        });

        emit TradeInitiated(tradeId, adId, buyer, seller, amount);
    }

    /**
     * @notice Buyer marks the trade as paid in fiat
     */
    function markPaid(uint256 tradeId) external {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.PENDING, "Trade not pending");
        require(msg.sender == trade.buyer, "Only buyer can mark paid");
        require(block.timestamp <= trade.paymentDeadline, "Payment window expired");

        trade.status = TradeStatus.PAID;
        emit TradeMarkedPaid(tradeId);
    }

    /**
     * @notice Seller releases the locked tokens once they confirm receipt of fiat
     */
    function releaseTrade(uint256 tradeId) external nonReentrant {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.PENDING || trade.status == TradeStatus.PAID, "Cannot release");
        require(msg.sender == trade.seller, "Only seller can release");

        _completeTrade(trade);
    }

    /**
     * @notice Seller cancels the trade if buyer fails to pay within payment window
     */
    function cancelTrade(uint256 tradeId) external nonReentrant {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.PENDING, "Cannot cancel paid trade");
        require(block.timestamp > trade.paymentDeadline, "Payment window not expired");
        require(msg.sender == trade.seller, "Only seller can cancel");

        trade.status = TradeStatus.CANCELLED;

        Ad storage ad = ads[trade.adId];
        // If it is a Sell Ad and was not manually cancelled (ad.maxLimit > 0)
        if (ad.isSellAd && ad.creator == trade.seller && ad.maxLimit > 0) {
            ad.amount += trade.amount;
            if (ad.amount >= ad.minLimit) {
                ad.active = true;
            }
        } else {
            // Fallback for Buy Ads, or if the Sell Ad was manually cancelled/withdrawn
            IERC20(trade.token).safeTransfer(trade.seller, trade.amount);
        }

        emit TradeCancelled(tradeId);
    }

    /**
     * @notice Buyer cancels the trade (can be done anytime if status is PENDING, immediately releasing seller's tokens)
     */
    function buyerCancelTrade(uint256 tradeId) external nonReentrant {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.PENDING, "Cannot cancel; trade not pending");
        require(msg.sender == trade.buyer, "Only buyer can cancel");

        trade.status = TradeStatus.CANCELLED;

        Ad storage ad = ads[trade.adId];
        // If it is a Sell Ad and was not manually cancelled (ad.maxLimit > 0)
        if (ad.isSellAd && ad.creator == trade.seller && ad.maxLimit > 0) {
            ad.amount += trade.amount;
            if (ad.amount >= ad.minLimit) {
                ad.active = true;
            }
        } else {
            // Fallback for Buy Ads, or if the Sell Ad was manually cancelled/withdrawn
            IERC20(trade.token).safeTransfer(trade.seller, trade.amount);
        }

        emit TradeCancelled(tradeId);
    }

    /**
     * @notice Open a dispute if a trade goes wrong (e.g. buyer paid but seller won't release)
     */
    function disputeTrade(uint256 tradeId, string calldata chatHistoryText) external {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.PAID, "Only paid trades can be disputed");
        require(msg.sender == trade.buyer || msg.sender == trade.seller, "Only trade actors can dispute");

        trade.status = TradeStatus.DISPUTED;
        trade.chatHistory = chatHistoryText;
        emit TradeDisputed(tradeId, msg.sender);
    }

    /**
     * @notice Stake tokens to become an eligible Arbitrator
     */
    function stakeArbitrator(uint256 amount) external nonReentrant {
        require(stakedArbitrators[msg.sender] + amount >= arbitrationStakeRequirement, "Below minimum stake requirement");
        IERC20(arbitrationToken).safeTransferFrom(msg.sender, address(this), amount);
        
        if (stakedArbitrators[msg.sender] == 0) {
            arbitratorList.push(msg.sender);
        }
        stakedArbitrators[msg.sender] += amount;

        emit ArbitratorStaked(msg.sender, amount);
    }

    /**
     * @notice Unstake arbitrator tokens
     */
    function unstakeArbitrator(uint256 amount) external nonReentrant {
        require(stakedArbitrators[msg.sender] >= amount, "Insufficient staked balance");
        
        if (activeDisputeCount[msg.sender] > 0) {
            require(stakedArbitrators[msg.sender] - amount >= arbitrationStakeRequirement, "Cannot unstake below minimum requirement while holding active votes");
        }

        stakedArbitrators[msg.sender] -= amount;
        
        IERC20(arbitrationToken).safeTransfer(msg.sender, amount);
        emit ArbitratorUnstaked(msg.sender, amount);
    }

    /**
     * @notice Arbitrators vote on disputed trades
     */
    function voteDispute(uint256 tradeId, bool voteForBuyer) external {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.DISPUTED, "Trade not disputed");
        require(stakedArbitrators[msg.sender] >= arbitrationStakeRequirement, "Not registered arbitrator");
        require(!hasVoted[tradeId][msg.sender], "Already voted");

        hasVoted[tradeId][msg.sender] = true;
        voteChoices[tradeId][msg.sender] = voteForBuyer;
        tradeVoters[tradeId].push(msg.sender);
        activeDisputeCount[msg.sender]++;

        if (voteForBuyer) {
            trade.votesForBuyer += 1;
        } else {
            trade.votesForSeller += 1;
        }

        emit VoteCast(tradeId, msg.sender, voteForBuyer);
    }

    /**
     * @notice Resolve a dispute after a minimal vote threshold is met (e.g. at least 3 votes or 48 hours elapsed)
     */
    function resolveDispute(uint256 tradeId) external nonReentrant {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.DISPUTED, "Trade not disputed");
        
        uint256 totalVotes = trade.votesForBuyer + trade.votesForSeller;
        require(totalVotes >= 3 || block.timestamp > trade.timestamp + 3 days, "Insufficient votes or time");

        if (trade.votesForBuyer > trade.votesForSeller) {
            trade.status = TradeStatus.COMPLETED;
            
            // Calculate and deduct fee
            uint256 fee = (trade.amount * escrowFeeBps) / 10000;
            uint256 payout = trade.amount - fee;

            // Distribute juror rewards/slashing and treasury fees
            _distributeDisputeRewards(trade, true);

            IERC20(trade.token).safeTransfer(trade.buyer, payout);
            
            emit DisputeResolved(tradeId, trade.buyer, msg.sender);
        } else if (trade.votesForSeller > trade.votesForBuyer) {
            trade.status = TradeStatus.CANCELLED;
            
            // Distribute juror rewards/slashing (no trade fee distribution since seller gets full refund)
            _distributeDisputeRewards(trade, false);

            // Refund full tokens back to seller
            IERC20(trade.token).safeTransfer(trade.seller, trade.amount);
            
            emit DisputeResolved(tradeId, trade.seller, msg.sender);
        } else {
            revert("Cannot automatically resolve tied dispute");
        }
    }

    /**
     * @notice Admin Supreme Court to resolve ties or frozen disputes.
     */
    function adminResolveDispute(uint256 tradeId, bool buyerWins) external nonReentrant {
        require(msg.sender == treasury, "Not treasury");
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.DISPUTED, "Trade not disputed");

        if (buyerWins) {
            trade.status = TradeStatus.COMPLETED;
            uint256 fee = (trade.amount * escrowFeeBps) / 10000;
            uint256 payout = trade.amount - fee;

            _distributeDisputeRewards(trade, true);

            IERC20(trade.token).safeTransfer(trade.buyer, payout);
            emit DisputeResolved(tradeId, trade.buyer, msg.sender);
        } else {
            trade.status = TradeStatus.CANCELLED;

            _distributeDisputeRewards(trade, false);

            IERC20(trade.token).safeTransfer(trade.seller, trade.amount);
            emit DisputeResolved(tradeId, trade.seller, msg.sender);
        }
    }

    /**
     * @dev Distribute dispute rewards to winning jurors and slash losing jurors.
     */
    function _distributeDisputeRewards(Trade storage trade, bool buyerWins) internal {
        address[] memory voters = tradeVoters[trade.id];
        uint256 voterLength = voters.length;
        if (voterLength == 0) {
            // If buyer wins and there's a fee but no voters, treasury gets all fee
            if (buyerWins) {
                uint256 fee = (trade.amount * escrowFeeBps) / 10000;
                if (fee > 0) {
                    IERC20(trade.token).safeTransfer(treasury, fee);
                }
            }
            return;
        }

        // 1. Identify winning and losing jurors
        uint256 winningJurorCount = 0;
        uint256 losingJurorCount = 0;
        for (uint256 i = 0; i < voterLength; i++) {
            address voter = voters[i];
            activeDisputeCount[voter]--; // Decrement active vote count since dispute is resolved

            if (voteChoices[trade.id][voter] == buyerWins) {
                winningJurorCount++;
            } else {
                losingJurorCount++;
            }
        }

        // 2. Perform Slashing on losing jurors and collect slashed amount
        uint256 totalSlashedAmt = 0;
        if (losingJurorCount > 0) {
            for (uint256 i = 0; i < voterLength; i++) {
                address voter = voters[i];
                if (voteChoices[trade.id][voter] != buyerWins) {
                    uint256 slashAmt = stakedArbitrators[voter] >= slashingAmount ? slashingAmount : stakedArbitrators[voter];
                    if (slashAmt > 0) {
                        stakedArbitrators[voter] -= slashAmt;
                        totalSlashedAmt += slashAmt;
                    }
                }
            }
        }

        // 3. Distribute Slashed Tokens to winning jurors
        if (winningJurorCount > 0) {
            if (totalSlashedAmt > 0) {
                uint256 slashRewardPerJuror = totalSlashedAmt / winningJurorCount;
                if (slashRewardPerJuror > 0) {
                    for (uint256 i = 0; i < voterLength; i++) {
                        address voter = voters[i];
                        if (voteChoices[trade.id][voter] == buyerWins) {
                            stakedArbitrators[voter] += slashRewardPerJuror;
                        }
                    }
                }

                uint256 distributedSlashed = slashRewardPerJuror * winningJurorCount;
                uint256 leftoverSlashed = totalSlashedAmt - distributedSlashed;
                if (leftoverSlashed > 0) {
                    IERC20(arbitrationToken).safeTransfer(treasury, leftoverSlashed);
                }
            }
        } else {
            // If no winning jurors, send slashed tokens to treasury
            if (totalSlashedAmt > 0) {
                IERC20(arbitrationToken).safeTransfer(treasury, totalSlashedAmt);
            }
        }

        // 4. Distribute Trade Fees (Only if Buyer Wins)
        if (buyerWins) {
            uint256 fee = (trade.amount * escrowFeeBps) / 10000;
            if (fee > 0) {
                if (winningJurorCount > 0) {
                    uint256 totalJurorReward = (fee * jurorRewardShareBps) / 10000;
                    uint256 rewardPerJuror = totalJurorReward / winningJurorCount;
                    uint256 actualJurorDistribution = rewardPerJuror * winningJurorCount;
                    uint256 treasuryShare = fee - actualJurorDistribution;

                    if (rewardPerJuror > 0) {
                        for (uint256 i = 0; i < voterLength; i++) {
                            address voter = voters[i];
                            if (voteChoices[trade.id][voter] == buyerWins) {
                                IERC20(trade.token).safeTransfer(voter, rewardPerJuror);
                            }
                        }
                    }

                    if (treasuryShare > 0) {
                        IERC20(trade.token).safeTransfer(treasury, treasuryShare);
                    }
                } else {
                    // No winning jurors
                    IERC20(trade.token).safeTransfer(treasury, fee);
                }
            }
        }
    }

    /**
     * @dev Complete trade internal helper
     */
    function _completeTrade(Trade storage trade) internal {
        trade.status = TradeStatus.COMPLETED;

        // Calculate 0.1% fee
        uint256 fee = (trade.amount * escrowFeeBps) / 10000;
        uint256 netPayout = trade.amount - fee;

        if (fee > 0) {
            IERC20(trade.token).safeTransfer(treasury, fee);
        }
        IERC20(trade.token).safeTransfer(trade.buyer, netPayout);

        emit TradeReleased(trade.id, netPayout, fee);
    }

    /**
     * @notice Helper to fetch trade information
     */
    function getTrade(uint256 tradeId) external view returns (
        uint256 adId,
        address buyer,
        address seller,
        address token,
        uint256 amount,
        TradeStatus status,
        uint256 paymentDeadline,
        uint256 votesForBuyer,
        uint256 votesForSeller
    ) {
        Trade memory t = trades[tradeId];
        return (
            t.adId,
            t.buyer,
            t.seller,
            t.token,
            t.amount,
            t.status,
            t.paymentDeadline,
            t.votesForBuyer,
            t.votesForSeller
        );
    }

    /**
     * @notice Send a chat message associated with a P2P trade
     */
    function sendChatMessage(uint256 tradeId, string calldata text) external {
        Trade storage trade = trades[tradeId];
        require(trade.buyer == msg.sender || trade.seller == msg.sender, "Not authorized");
        require(bytes(text).length > 0, "Empty message");
        emit P2pChatMessage(tradeId, msg.sender, text, block.timestamp);
    }

    /**
     * @notice Fetch chat history for disputed trades
     */
    function getTradeChatHistory(uint256 tradeId) external view returns (string memory) {
        return trades[tradeId].chatHistory;
    }
}
