// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BridgedUSDC} from "../src/BridgedUSDC.sol";
import {MockTokenB} from "../src/MockTokenB.sol";
import {MockSwapRouter} from "../src/MockSwapRouter.sol";
import {MockLendingVault} from "../src/MockLendingVault.sol";

/// @notice Deploys MockTokenB + MockSwapRouter + MockLendingVault, seeds the
///         router with reserves and a 1 bUSDC <-> 1 mTKN rate (accounting for
///         the decimal delta), and writes addresses to mocks-deployment.json.
///
///         bUSDC address is read from ../evm-deployment.json — deploy bUSDC
///         first (yarn evm:deploy) and make sure the deployer is its owner so
///         the reserve seed-mint can run.
contract DeployMocksScript is Script {
    uint256 constant USDC_RESERVE = 1_000_000e6;   // 1,000,000 bUSDC (6 decimals)
    uint256 constant MTKN_RESERVE = 1_000_000e18;  // 1,000,000 mTKN (18 decimals)

    function run() external {
        string memory evmJson = vm.readFile("../evm-deployment.json");
        address busdc = vm.parseJsonAddress(evmJson, ".address");
        console.log("Using bUSDC at:", busdc);

        vm.startBroadcast();

        MockTokenB tokenB = new MockTokenB();
        MockSwapRouter router = new MockSwapRouter();
        MockLendingVault vault = new MockLendingVault(busdc);

        // Seed router reserves so swaps in either direction work.
        BridgedUSDC(busdc).mint(address(router), USDC_RESERVE);
        tokenB.mint(address(router), MTKN_RESERVE);

        // Rates accounting for decimals:
        //   bUSDC (6d) -> mTKN (18d): amountOut = amountIn * 1e18 / 1e6
        //   mTKN (18d) -> bUSDC (6d): amountOut = amountIn * 1e6  / 1e18
        router.setRate(busdc, address(tokenB), 1e18, 1e6);
        router.setRate(address(tokenB), busdc, 1e6, 1e18);

        vm.stopBroadcast();

        console.log("MockTokenB:        ", address(tokenB));
        console.log("MockSwapRouter:    ", address(router));
        console.log("MockLendingVault:  ", address(vault));

        string memory json = string.concat(
            '{"tokenB":"',     vm.toString(address(tokenB)),
            '","swapRouter":"', vm.toString(address(router)),
            '","vault":"',     vm.toString(address(vault)),
            '"}'
        );
        vm.writeFile("../mocks-deployment.json", json);
        console.log("Addresses written to mocks-deployment.json");
    }
}
