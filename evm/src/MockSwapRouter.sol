// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal fixed-rate AMM-alike for demoing intent-gated swaps.
///         Holds reserves of two tokens and swaps at a fixed rate per direction.
///         Rates are expressed as (numerator, denominator) so
///         `amountOut = amountIn * numerator / denominator`.
///
///         The caller must ERC20-approve this router for `amountIn` on `tokenIn`
///         before calling `swapExactTokensForTokens`. For the intent executor
///         demo this approve is the first call in the batch; the swap is the
///         second, all within one proof.
contract MockSwapRouter {
    struct Rate {
        uint256 numerator;
        uint256 denominator;
    }

    // keccak(tokenIn, tokenOut) -> swap rate
    mapping(bytes32 => Rate) public rates;

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 numerator, uint256 denominator);
    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address indexed recipient
    );

    error PairUnsupported();
    error InsufficientOutput();
    error InsufficientReserve();

    /// @dev Unrestricted for the demo; anyone can seed a rate or top up reserves.
    function setRate(address tokenIn, address tokenOut, uint256 numerator, uint256 denominator) external {
        require(denominator > 0, "denom=0");
        rates[_key(tokenIn, tokenOut)] = Rate(numerator, denominator);
        emit RateSet(tokenIn, tokenOut, numerator, denominator);
    }

    /// @notice Swap `amountIn` of `tokenIn` for `tokenOut`, delivered to `recipient`.
    /// @dev Pulls `amountIn` via `transferFrom` — caller must have approved this
    ///      contract for at least `amountIn`. Reverts if the output would fall
    ///      below `minAmountOut` or the router's `tokenOut` reserve is insufficient.
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut) {
        Rate memory r = rates[_key(tokenIn, tokenOut)];
        if (r.denominator == 0) revert PairUnsupported();

        amountOut = (amountIn * r.numerator) / r.denominator;
        if (amountOut < minAmountOut) revert InsufficientOutput();
        if (IERC20(tokenOut).balanceOf(address(this)) < amountOut) revert InsufficientReserve();

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(recipient, amountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    function _key(address a, address b) private pure returns (bytes32) {
        return keccak256(abi.encode(a, b));
    }
}
