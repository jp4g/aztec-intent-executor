// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {HonkVerifier} from "../src/IntentVerifier.sol";
import {IntentAccount} from "../src/IntentAccount.sol";
import {IntentAccountFactory} from "../src/IntentAccountFactory.sol";

/// @notice Deploys IntentVerifier (HonkVerifier), IntentAccount implementation,
///         and IntentAccountFactory wired to both. Writes addresses to
///         intent-deployment.json alongside evm-deployment.json so the client
///         and tests can pick them up.
contract DeployIntent is Script {
    function run() external {
        vm.startBroadcast();

        HonkVerifier verifier = new HonkVerifier();
        IntentAccount impl = new IntentAccount();
        IntentAccountFactory factory = new IntentAccountFactory(address(impl), address(verifier));

        vm.stopBroadcast();

        console.log("IntentVerifier:         ", address(verifier));
        console.log("IntentAccount (impl):   ", address(impl));
        console.log("IntentAccountFactory:   ", address(factory));

        string memory json = string.concat(
            '{"verifier":"',
            vm.toString(address(verifier)),
            '","implementation":"',
            vm.toString(address(impl)),
            '","factory":"',
            vm.toString(address(factory)),
            '"}'
        );
        vm.writeFile("../intent-deployment.json", json);
        console.log("Addresses written to intent-deployment.json");
    }
}
