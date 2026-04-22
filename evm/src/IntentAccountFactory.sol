// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IntentAccount, Call} from "./IntentAccount.sol";

/**
 * @title IntentAccountFactory
 * @notice Deploys IntentAccount minimal-proxy clones deterministically by salt.
 *         Because the minimal-proxy init code is fixed, off-chain clients can
 *         precompute an intent account's address from just (factory, salt).
 *
 *         Funds can be sent to the predicted address before deployment; the
 *         clone is deployed lazily on the first execution.
 */
contract IntentAccountFactory {
    using Clones for address;

    /// @notice IntentAccount implementation cloned by cloneDeterministic.
    address public immutable implementation;

    /// @notice UltraHonk verifier passed to every freshly-initialized clone.
    address public immutable verifier;

    event IntentAccountDeployed(address indexed account, bytes32 indexed salt);

    constructor(address _implementation, address _verifier) {
        implementation = _implementation;
        verifier = _verifier;
    }

    /// @notice Compute the clone address for a given salt without deploying.
    function predict(bytes32 salt) external view returns (address) {
        return implementation.predictDeterministicAddress(salt, address(this));
    }

    /// @notice Deploy the clone for `salt` and initialize it. Reverts if already deployed.
    function deploy(bytes32 salt) public returns (address account) {
        account = implementation.cloneDeterministic(salt);
        IntentAccount(payable(account)).initialize(salt, verifier);
        emit IntentAccountDeployed(account, salt);
    }

    /// @notice Deploy (if needed) and execute an intent batch in one tx.
    function deployAndExecuteBatch(
        bytes32 salt,
        Call[] calldata calls,
        bytes32 nullifier,
        bytes calldata proof
    ) external returns (bytes[] memory) {
        address predicted = implementation.predictDeterministicAddress(salt, address(this));
        if (predicted.code.length == 0) {
            deploy(salt);
        }
        return IntentAccount(payable(predicted)).executeBatch(calls, nullifier, proof);
    }
}
