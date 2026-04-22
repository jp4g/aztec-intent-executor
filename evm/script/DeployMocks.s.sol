// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BridgedUSDC} from "../src/BridgedUSDC.sol";
import {MockWETH} from "../src/MockWETH.sol";
import {MockSwapRouter} from "../src/MockSwapRouter.sol";
import {MockLendingVault} from "../src/MockLendingVault.sol";

/// @notice Deploys MockWETH + MockSwapRouter + two MockLendingVault instances
///         (one per underlying asset: bUSDC and WETH), seeds the router with
///         bUSDC + WETH reserves and a 1 bUSDC <-> 1 WETH rate accounting for
///         decimal deltas, then writes addresses to mocks-deployment.json.
///
///         bUSDC address is read from ../evm-deployment.json — deploy bUSDC
///         first (yarn evm:deploy) and make sure the deployer is its owner so
///         the reserve seed-mint can run.
contract DeployMocksScript is Script {
    uint256 constant USDC_RESERVE = 1_000_000e6;   // 1,000,000 bUSDC (6 decimals)
    uint256 constant WETH_RESERVE = 1_000_000e18;  // 1,000,000 WETH (18 decimals)

    function run() external {
        string memory evmJson = vm.readFile("../evm-deployment.json");
        address busdc = vm.parseJsonAddress(evmJson, ".address");
        console.log("Using bUSDC at:", busdc);

        vm.startBroadcast();

        MockWETH weth = new MockWETH();
        MockSwapRouter router = new MockSwapRouter();
        MockLendingVault usdcVault = new MockLendingVault(busdc);
        MockLendingVault wethVault = new MockLendingVault(address(weth));

        // Seed router reserves so swaps in either direction work.
        BridgedUSDC(busdc).mint(address(router), USDC_RESERVE);
        weth.mint(address(router), WETH_RESERVE);

        // Rates accounting for decimals:
        //   bUSDC (6d) -> WETH (18d): amountOut = amountIn * 1e18 / 1e6
        //   WETH (18d) -> bUSDC (6d): amountOut = amountIn * 1e6  / 1e18
        router.setRate(busdc, address(weth), 1e18, 1e6);
        router.setRate(address(weth), busdc, 1e6, 1e18);

        vm.stopBroadcast();

        console.log("MockWETH:                  ", address(weth));
        console.log("MockSwapRouter:            ", address(router));
        console.log("MockLendingVault (bUSDC):  ", address(usdcVault));
        console.log("MockLendingVault (WETH):   ", address(wethVault));

        string memory json = string.concat(
            '{"weth":"',       vm.toString(address(weth)),
            '","swapRouter":"', vm.toString(address(router)),
            '","usdcVault":"', vm.toString(address(usdcVault)),
            '","wethVault":"', vm.toString(address(wethVault)),
            '"}'
        );
        vm.writeFile("../mocks-deployment.json", json);
        console.log("Addresses written to mocks-deployment.json");
    }
}
