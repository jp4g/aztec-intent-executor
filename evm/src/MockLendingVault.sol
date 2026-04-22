// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal ERC4626-ish lending vault used in the intent-executor demo.
///         One underlying asset (set at deploy), shares at a fixed 1:1 rate so
///         the test is deterministic. `redeem` requires `owner == msg.sender`
///         (no allowance machinery).
contract MockLendingVault is ERC20 {
    IERC20 public immutable asset;

    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    error OwnerMismatch();

    constructor(address _asset) ERC20("Mock Vault", "mVAULT") {
        asset = IERC20(_asset);
    }

    /// @notice Pull `assets` from caller via transferFrom, mint `shares` (1:1) to receiver.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = assets;
        asset.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Burn `shares` from `owner` (must equal msg.sender), send `assets` (1:1) to receiver.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        if (owner != msg.sender) revert OwnerMismatch();
        assets = shares;
        _burn(owner, shares);
        asset.transfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }
}
