// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DAX_AMM
 * @notice A high-efficiency, multi-pool Automated Market Maker (AMM) using the constant product formula (x * y = k).
 * @dev Manages multiple trading pairs within a single contract to optimize deployment and trading gas costs.
 * Features a 0.3% fee split: 0.25% added to pool reserves for LPs, 0.05% collected for the protocol developer treasury.
 */
contract DAX_AMM is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Structure to represent a pool
    struct Pool {
        address token0;
        address token1;
        uint256 reserve0;
        uint256 reserve1;
        uint256 totalLPShares;
    }

    // Dev treasury address to collect protocol fees (0.05%)
    address public treasury;

    // Track all pools by a unique pair hash: keccak256(abi.encodePacked(token0, token1))
    mapping(bytes32 => Pool) public pools;
    
    // Track LP share balances per pair per user
    // pairHash => user => balance
    mapping(bytes32 => mapping(address => uint256)) public lpShares;

    // List of active pool hashes for frontend indexing
    bytes32[] public poolList;
    
    // Check if pool exists
    mapping(bytes32 => bool) public poolExists;

    // Events
    event PoolCreated(bytes32 indexed pairHash, address indexed token0, address indexed token1);
    event LiquidityAdded(bytes32 indexed pairHash, address indexed provider, uint256 amount0, uint256 amount1, uint256 lpSharesMinted);
    event LiquidityRemoved(bytes32 indexed pairHash, address indexed provider, uint256 amount0, uint256 amount1, uint256 lpSharesBurned);
    event Swap(bytes32 indexed pairHash, address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);

    constructor(address _treasury) {
        require(_treasury != address(0), "Invalid treasury address");
        treasury = _treasury;
    }

    /**
     * @notice Sort token addresses to ensure consistency (token0 < token1)
     */
    function sortTokens(address tokenA, address tokenB) public pure returns (address token0, address token1) {
        require(tokenA != tokenB, "Identical addresses");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "Zero address token");
    }

    /**
     * @notice Get unique pair hash for a token pair
     */
    function getPairHash(address tokenA, address tokenB) public pure returns (bytes32) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return keccak256(abi.encodePacked(token0, token1));
    }

    /**
     * @notice Create a new liquidity pool for a token pair
     */
    function createPool(address tokenA, address tokenB) external returns (bytes32 pairHash) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pairHash = keccak256(abi.encodePacked(token0, token1));
        
        require(!poolExists[pairHash], "Pool already exists");

        pools[pairHash] = Pool({
            token0: token0,
            token1: token1,
            reserve0: 0,
            reserve1: 0,
            totalLPShares: 0
        });

        poolExists[pairHash] = true;
        poolList.push(pairHash);

        emit PoolCreated(pairHash, token0, token1);
    }

    /**
     * @notice Add liquidity to a pool
     */
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 minShares,
        uint256 deadline
    ) external nonReentrant returns (uint256 amount0, uint256 amount1, uint256 shares) {
        require(block.timestamp <= deadline, "Transaction expired");
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        bytes32 pairHash = keccak256(abi.encodePacked(token0, token1));
        
        require(poolExists[pairHash], "Pool does not exist");
        Pool storage pool = pools[pairHash];

        uint256 amount0Desired = tokenA == token0 ? amountADesired : amountBDesired;
        uint256 amount1Desired = tokenA == token0 ? amountBDesired : amountADesired;

        if (pool.reserve0 == 0 && pool.reserve1 == 0) {
            // Initial liquidity deposit
            amount0 = amount0Desired;
            amount1 = amount1Desired;
            // Use geometric mean for initial shares calculation
            shares = _sqrt(amount0 * amount1);
        } else {
            // Constant product ratio matching
            uint256 amount1Optimal = (amount0Desired * pool.reserve1) / pool.reserve0;
            if (amount1Optimal <= amount1Desired) {
                amount0 = amount0Desired;
                amount1 = amount1Optimal;
            } else {
                uint256 amount0Optimal = (amount1Desired * pool.reserve0) / pool.reserve1;
                require(amount0Optimal <= amount0Desired, "Insufficient optimal amount");
                amount0 = amount0Optimal;
                amount1 = amount1Desired;
            }
            // Shares proportional to token0 reserve addition
            shares = (amount0 * pool.totalLPShares) / pool.reserve0;
        }

        require(shares > 0, "Zero shares minted");
        require(shares >= minShares, "Slippage: shares below minimum");

        // Transfer tokens from user
        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);

        // Update pool state
        pool.reserve0 += amount0;
        pool.reserve1 += amount1;
        pool.totalLPShares += shares;
        lpShares[pairHash][msg.sender] += shares;

        emit LiquidityAdded(pairHash, msg.sender, amount0, amount1, shares);
    }

    /**
     * @notice Remove liquidity from a pool and claim reserves
     */
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        uint256 deadline
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        require(block.timestamp <= deadline, "Transaction expired");
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        bytes32 pairHash = keccak256(abi.encodePacked(token0, token1));
        
        require(poolExists[pairHash], "Pool does not exist");
        Pool storage pool = pools[pairHash];
        
        require(lpShares[pairHash][msg.sender] >= shares, "Insufficient LP shares balance");
        require(shares > 0, "Zero shares provided");

        // Calculate payout amounts proportional to pool share
        amount0 = (shares * pool.reserve0) / pool.totalLPShares;
        amount1 = (shares * pool.reserve1) / pool.totalLPShares;

        require(amount0 > 0 && amount1 > 0, "Insufficient liquidity returned");
        require(amount0 >= minAmount0 && amount1 >= minAmount1, "Slippage: amounts below minimum");

        // Update state
        lpShares[pairHash][msg.sender] -= shares;
        pool.totalLPShares -= shares;
        pool.reserve0 -= amount0;
        pool.reserve1 -= amount1;

        // Send tokens back
        IERC20(token0).safeTransfer(msg.sender, amount0);
        IERC20(token1).safeTransfer(msg.sender, amount1);

        emit LiquidityRemoved(pairHash, msg.sender, amount0, amount1, shares);
    }

    /**
     * @notice Swap tokenIn for tokenOut
     * @dev Fee is 0.3%: 0.25% added to reserves, 0.05% sent directly to the treasury address.
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "Transaction expired");
        require(amountIn > 0, "Zero input amount");
        (address token0, address token1) = sortTokens(tokenIn, tokenOut);
        bytes32 pairHash = keccak256(abi.encodePacked(token0, token1));
        
        require(poolExists[pairHash], "Pool does not exist");
        Pool storage pool = pools[pairHash];

        bool isToken0 = tokenIn == token0;
        uint256 reserveIn = isToken0 ? pool.reserve0 : pool.reserve1;
        uint256 reserveOut = isToken0 ? pool.reserve1 : pool.reserve0;

        require(reserveIn > 0 && reserveOut > 0, "Zero liquidity pool");

        // Calculate fees
        // 0.3% total fee = 3 / 1000.
        // Let's break it down:
        // Treasury fee is 0.05% = 5 / 10000 = 1 / 2000.
        // LP fee is 0.25% = 25 / 10000 = 1 / 400.
        uint256 treasuryFee = amountIn / 2000;
        uint256 amountInAfterTotalFee = amountIn - (amountIn * 3 / 1000); 

        // Constant Product Swap formula: dy = (y * dx) / (x + dx)
        amountOut = (reserveOut * amountInAfterTotalFee) / (reserveIn + amountInAfterTotalFee);
        require(amountOut >= minAmountOut, "Slippage limit exceeded");
        require(amountOut < reserveOut, "Insufficient reserve liquidity");

        // Transfer input tokens from user
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Disburse the treasury fee immediately to the treasury address to prevent reserve bloating
        if (treasuryFee > 0) {
            IERC20(tokenIn).safeTransfer(treasury, treasuryFee);
        }

        // Update reserves: pool receives input tokens (minus the treasury fee which left the pool)
        if (isToken0) {
            pool.reserve0 += (amountIn - treasuryFee);
            pool.reserve1 -= amountOut;
        } else {
            pool.reserve1 += (amountIn - treasuryFee);
            pool.reserve0 -= amountOut;
        }

        // Send output tokens to user
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);

        emit Swap(pairHash, msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    /**
     * @notice Get pool reserve information
     */
    function getPool(address tokenA, address tokenB) external view returns (
        uint256 reserve0,
        uint256 reserve1,
        uint256 totalLPShares
    ) {
        bytes32 pairHash = getPairHash(tokenA, tokenB);
        if (!poolExists[pairHash]) return (0, 0, 0);
        Pool memory pool = pools[pairHash];
        return (pool.reserve0, pool.reserve1, pool.totalLPShares);
    }

    /**
     * @notice Read active pools length
     */
    function getPoolListLength() external view returns (uint256) {
        return poolList.length;
    }

    /**
     * @notice Change the fee treasury address
     */
    function setTreasury(address _treasury) external {
        require(msg.sender == treasury, "Only treasury can update treasury address");
        require(_treasury != address(0), "Invalid treasury address");
        emit TreasuryChanged(treasury, _treasury);
        treasury = _treasury;
    }

    // Helper Babylonian method for square root
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
