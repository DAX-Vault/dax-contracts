// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DAX_Swap
 * @notice On-chain Swap Facility for the DAX Protocol.
 * @dev Enables users to swap digital assets (native ETH, USDT, USDC, etc.) into DAX tokens.
 *      CRITICAL PROTOCOL INVARIANT: 100% of the swapped digital assets are forwarded directly
 *      to the deployed protocol ledger (Treasury). DAX tokens are disbursed to the user from
 *      the liquidity reserve.
 */
contract DAX_Swap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The canonical DAX token contract
    IERC20 public immutable daxToken;

    /// @notice The deployed protocol ledger (Treasury) that receives 100% of swapped assets
    address payable public deployedLedger;

    /// @notice Rate of DAX (in 18 decimals) per 1 full ETH (10^18 wei)
    uint256 public ethRate;

    /// @notice Mapping from token address to amount of DAX (in 18 decimals) per 1 full token
    mapping(address => uint256) public tokenRates;

    /// @notice Mapping from token address to token decimals
    mapping(address => uint8) public tokenDecimals;

    /// @notice Spread / fee in basis points applied when swapping DAX -> Digital Assets (e.g. 250 = 2.50%)
    uint256 public exitSpreadBps = 250;

    /// @notice Emitted whenever a user swaps digital assets for DAX or vice versa
    event TokensSwapped(
        address indexed user,
        address indexed assetIn,
        uint256 amountIn,
        uint256 daxAmountOut,
        address indexed deployedLedger
    );

    /// @notice Emitted when the deployed ledger address is updated
    event DeployedLedgerUpdated(address indexed previousLedger, address indexed newLedger);

    /// @notice Emitted when an exchange rate is updated
    event RateUpdated(address indexed asset, uint256 newRate);

    /// @notice Emitted when the exit spread is updated
    event ExitSpreadUpdated(uint256 previousSpread, uint256 newSpread);

    modifier onlyLedger() {
        require(msg.sender == deployedLedger, "DAX_Swap: Only deployed ledger authorized");
        _;
    }

    /**
     * @param _daxToken Address of the canonical DAX ERC-20 token
     * @param _deployedLedger Address of the deployed platform ledger / treasury
     * @param _initialEthRate DAX amount per 1 ETH (e.g. 25,000 * 10^18 for $2,500 ETH at $0.10/DAX)
     */
    constructor(
        address _daxToken,
        address payable _deployedLedger,
        uint256 _initialEthRate
    ) {
        require(_daxToken != address(0), "DAX_Swap: Invalid DAX token address");
        require(_deployedLedger != address(0), "DAX_Swap: Invalid deployed ledger address");

        daxToken = IERC20(_daxToken);
        deployedLedger = _deployedLedger;
        ethRate = _initialEthRate;
    }

    /// @dev Allows deployed ledger to fund ETH redemption reserves
    receive() external payable {}

    /**
     * @notice Swap native ETH into DAX tokens.
     * @dev Forwards 100% of msg.value directly to deployedLedger.
     * @param minDaxOut Minimum expected DAX output (slippage protection).
     */
    function swapEthForDax(uint256 minDaxOut) external payable nonReentrant {
        require(msg.value > 0, "DAX_Swap: Zero ETH amount");
        require(ethRate > 0, "DAX_Swap: ETH swap disabled");

        // Calculate DAX output: (msg.value * ethRate) / 1e18
        uint256 daxOut = (msg.value * ethRate) / 1e18;
        require(daxOut >= minDaxOut, "DAX_Swap: Slippage limit exceeded");
        require(daxToken.balanceOf(address(this)) >= daxOut, "DAX_Swap: Insufficient DAX reserve in swap gate");

        // Forward 100% of received ETH to deployed ledger
        (bool sent, ) = deployedLedger.call{value: msg.value}("");
        require(sent, "DAX_Swap: Failed to forward ETH to deployed ledger");

        // Transfer DAX to user
        daxToken.safeTransfer(msg.sender, daxOut);

        emit TokensSwapped(msg.sender, address(0), msg.value, daxOut, deployedLedger);
    }

    /**
     * @notice Swap an approved ERC-20 digital asset (e.g. USDT, USDC) into DAX tokens.
     * @dev Transfers amountIn of tokenIn directly from msg.sender to deployedLedger.
     * @param tokenIn Address of the ERC-20 token being swapped.
     * @param amountIn Amount of tokenIn to swap.
     * @param minDaxOut Minimum expected DAX output (slippage protection).
     */
    function swapTokenForDax(
        address tokenIn,
        uint256 amountIn,
        uint256 minDaxOut
    ) external nonReentrant {
        require(tokenIn != address(0) && tokenIn != address(daxToken), "DAX_Swap: Invalid token");
        require(amountIn > 0, "DAX_Swap: Zero token amount");

        uint256 rate = tokenRates[tokenIn];
        require(rate > 0, "DAX_Swap: Token not supported for swap");

        uint8 decimals = tokenDecimals[tokenIn];
        uint256 daxOut = (amountIn * rate) / (10 ** decimals);
        require(daxOut >= minDaxOut, "DAX_Swap: Slippage limit exceeded");
        require(daxToken.balanceOf(address(this)) >= daxOut, "DAX_Swap: Insufficient DAX reserve in swap gate");

        // Forward tokenIn directly from caller to deployed ledger
        IERC20(tokenIn).safeTransferFrom(msg.sender, deployedLedger, amountIn);

        // Transfer DAX to user
        daxToken.safeTransfer(msg.sender, daxOut);

        emit TokensSwapped(msg.sender, tokenIn, amountIn, daxOut, deployedLedger);
    }

    /**
     * @notice Swap DAX tokens for native ETH with protocol exit spread deducted.
     * @dev Deducts exitSpreadBps from gross ETH and forwards spread ETH to deployedLedger.
     * @param daxAmountIn Amount of DAX tokens to swap.
     * @param minEthOut Minimum net ETH expected (slippage protection).
     */
    function swapDaxForEth(uint256 daxAmountIn, uint256 minEthOut) external nonReentrant {
        require(daxAmountIn > 0, "DAX_Swap: Zero DAX amount");
        require(ethRate > 0, "DAX_Swap: ETH swap disabled");

        uint256 grossEth = (daxAmountIn * 1e18) / ethRate;
        require(grossEth > 0, "DAX_Swap: Output too small");

        uint256 spreadEth = (grossEth * exitSpreadBps) / 10000;
        uint256 netEth = grossEth - spreadEth;

        require(netEth >= minEthOut, "DAX_Swap: Slippage limit exceeded");
        require(address(this).balance >= grossEth, "DAX_Swap: Insufficient ETH reserve in swap gate");

        // Transfer DAX from user to swap gate
        daxToken.safeTransferFrom(msg.sender, address(this), daxAmountIn);

        // Send net ETH to user
        (bool sentToUser, ) = msg.sender.call{value: netEth}("");
        require(sentToUser, "DAX_Swap: Failed to send ETH to user");

        // Send spread ETH directly to deployed ledger
        if (spreadEth > 0) {
            (bool sentToLedger, ) = deployedLedger.call{value: spreadEth}("");
            require(sentToLedger, "DAX_Swap: Failed to send spread ETH to ledger");
        }

        emit TokensSwapped(msg.sender, address(0), daxAmountIn, netEth, deployedLedger);
    }

    /**
     * @notice Swap DAX tokens for an approved ERC-20 token with protocol exit spread deducted.
     * @dev Deducts exitSpreadBps from gross token and forwards spread token to deployedLedger.
     * @param tokenOut Address of the ERC-20 token to receive.
     * @param daxAmountIn Amount of DAX tokens to swap.
     * @param minTokenOut Minimum net token expected (slippage protection).
     */
    function swapDaxForToken(
        address tokenOut,
        uint256 daxAmountIn,
        uint256 minTokenOut
    ) external nonReentrant {
        require(tokenOut != address(0) && tokenOut != address(daxToken), "DAX_Swap: Invalid token");
        require(daxAmountIn > 0, "DAX_Swap: Zero DAX amount");

        uint256 rate = tokenRates[tokenOut];
        require(rate > 0, "DAX_Swap: Token not supported for swap");

        uint8 decimals = tokenDecimals[tokenOut];
        uint256 grossToken = (daxAmountIn * (10 ** decimals)) / rate;
        require(grossToken > 0, "DAX_Swap: Output too small");

        uint256 spreadToken = (grossToken * exitSpreadBps) / 10000;
        uint256 netToken = grossToken - spreadToken;

        require(netToken >= minTokenOut, "DAX_Swap: Slippage limit exceeded");
        require(IERC20(tokenOut).balanceOf(address(this)) >= grossToken, "DAX_Swap: Insufficient token reserve");

        // Transfer DAX from user to swap gate
        daxToken.safeTransferFrom(msg.sender, address(this), daxAmountIn);

        // Send net token to user
        IERC20(tokenOut).safeTransfer(msg.sender, netToken);

        // Send spread token directly to deployed ledger
        if (spreadToken > 0) {
            IERC20(tokenOut).safeTransfer(deployedLedger, spreadToken);
        }

        emit TokensSwapped(msg.sender, tokenOut, daxAmountIn, netToken, deployedLedger);
    }

    /**
     * @notice Configure or update rate for an ERC-20 token.
     * @param token Address of the token.
     * @param decimals Number of decimals for the token (e.g., 6 for USDT/USDC, 18 for DAI).
     * @param daxPerTokenUnit Amount of DAX (in 18 decimals) per 1 full unit of token.
     */
    function setTokenRate(
        address token,
        uint8 decimals,
        uint256 daxPerTokenUnit
    ) external onlyLedger {
        require(token != address(0), "DAX_Swap: Invalid token address");
        tokenRates[token] = daxPerTokenUnit;
        tokenDecimals[token] = decimals;
        emit RateUpdated(token, daxPerTokenUnit);
    }

    /**
     * @notice Configure or update rate for native ETH.
     * @param newEthRate Amount of DAX (in 18 decimals) per 1 full ETH.
     */
    function setEthRate(uint256 newEthRate) external onlyLedger {
        ethRate = newEthRate;
        emit RateUpdated(address(0), newEthRate);
    }

    /**
     * @notice Configure exit spread in basis points (max 1000 bps = 10%).
     * @param newSpread The new spread in basis points (e.g. 250 for 2.5%).
     */
    function setExitSpreadBps(uint256 newSpread) external onlyLedger {
        require(newSpread <= 1000, "DAX_Swap: Spread cannot exceed 10%");
        emit ExitSpreadUpdated(exitSpreadBps, newSpread);
        exitSpreadBps = newSpread;
    }

    /**
     * @notice Fund ERC-20 redemption reserves into the swap gate.
     * @param token Address of the token.
     * @param amount Amount to deposit.
     */
    function fundTokenReserve(address token, uint256 amount) external onlyLedger {
        require(token != address(0), "DAX_Swap: Invalid token");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Withdraw digital asset reserves back to the deployed ledger.
     * @param token Address of token (or address(0) for native ETH).
     * @param amount Amount to withdraw.
     */
    function withdrawAssetReserve(address token, uint256 amount) external onlyLedger {
        if (token == address(0)) {
            (bool sent, ) = deployedLedger.call{value: amount}("");
            require(sent, "DAX_Swap: Failed to withdraw ETH");
        } else {
            IERC20(token).safeTransfer(deployedLedger, amount);
        }
    }

    /**
     * @notice Update the deployed ledger address.
     * @param newLedger The new deployed ledger / treasury address.
     */
    function setDeployedLedger(address payable newLedger) external onlyLedger {
        require(newLedger != address(0), "DAX_Swap: Invalid ledger address");
        emit DeployedLedgerUpdated(deployedLedger, newLedger);
        deployedLedger = newLedger;
    }

    /**
     * @notice Withdraw excess DAX liquidity back to the deployed ledger.
     * @param amount Amount of DAX to withdraw.
     */
    function withdrawDaxLiquidity(uint256 amount) external onlyLedger {
        daxToken.safeTransfer(deployedLedger, amount);
    }

    /**
     * @notice View helper to estimate DAX output for a given asset and input amount.
     */
    function getQuote(address tokenIn, uint256 amountIn) external view returns (uint256) {
        if (amountIn == 0) return 0;
        if (tokenIn == address(0)) {
            return (amountIn * ethRate) / 1e18;
        }
        uint256 rate = tokenRates[tokenIn];
        if (rate == 0) return 0;
        return (amountIn * rate) / (10 ** tokenDecimals[tokenIn]);
    }

    /**
     * @notice View helper to estimate net output and spread when swapping DAX -> Digital Asset.
     */
    function getReverseQuote(
        address tokenOut,
        uint256 daxAmountIn
    ) external view returns (uint256 netOut, uint256 spreadAmount) {
        if (daxAmountIn == 0) return (0, 0);

        uint256 grossOut;
        if (tokenOut == address(0)) {
            if (ethRate == 0) return (0, 0);
            grossOut = (daxAmountIn * 1e18) / ethRate;
        } else {
            uint256 rate = tokenRates[tokenOut];
            if (rate == 0) return (0, 0);
            grossOut = (daxAmountIn * (10 ** tokenDecimals[tokenOut])) / rate;
        }

        spreadAmount = (grossOut * exitSpreadBps) / 10000;
        netOut = grossOut - spreadAmount;
    }
}
