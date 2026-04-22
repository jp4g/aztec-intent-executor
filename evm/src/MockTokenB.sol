// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Standard 18-decimal ERC20 used as the swap counterparty in the
///         intent-executor demo. Public, unrestricted mint — demo only.
contract MockTokenB is ERC20 {
    constructor() ERC20("Mock Token B", "mTKN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
