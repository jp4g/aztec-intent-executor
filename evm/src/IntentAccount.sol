// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IVerifier} from "./IntentVerifier.sol";

/// @notice Single call within a batched intent execution.
struct Call {
    address target;
    uint256 value;
    bytes   data;
}

/**
 * @title IntentAccount
 * @notice Smart-account clone deployed deterministically per Poseidon2 salt.
 *         Arbitrary batches of EVM calls can be executed *as* this account by
 *         supplying a Noir proof of knowledge of the salt's preimage, bound to
 *         the exact batch via a sha256 commitment.
 *
 *         Reusable: multiple distinct batches under the same salt, each gated
 *         by its own proof and single-use nullifier.
 */
contract IntentAccount is Initializable {
    /// @notice Poseidon2 hash of the user's preimage. Equal to the CREATE2 salt.
    bytes32 public salt;

    /// @notice UltraHonk verifier for the intent circuit.
    IVerifier public verifier;

    /// @notice Nullifiers spent by prior executions; replay-proof.
    mapping(bytes32 => bool) public nullified;

    event ExecutedBatch(bytes32 indexed nullifier, uint256 callCount);

    error Replay(bytes32 nullifier);
    error InvalidProof();
    error CallFailed(uint256 index, bytes returnData);
    error EmptyBatch();

    /// @dev Clones are created uninitialized; factory calls initialize() right after.
    function initialize(bytes32 _salt, address _verifier) external initializer {
        salt = _salt;
        verifier = IVerifier(_verifier);
    }

    /**
     * @notice Verify one proof and execute a batch of calls as this account.
     *
     *         Every `calls[i]` runs in order. Any single failure reverts the
     *         whole batch, preserving atomicity (e.g. approve + swap cannot
     *         desync). `nullifier` is single-use across the account.
     *
     *         Public inputs to the verifier are
     *         `[salt, action_hash_hi, action_hash_lo]` where `action_hash` is
     *         `sha256(abi.encode(chainid, address(this), calls, nullifier))`.
     *
     * @param  calls      Ordered calls to execute.
     * @param  nullifier  Caller-chosen bytes32 uniquely identifying this batch.
     * @param  proof      UltraHonk proof bound to the batch.
     */
    function executeBatch(
        Call[] calldata calls,
        bytes32 nullifier,
        bytes calldata proof
    ) external returns (bytes[] memory returnData) {
        if (calls.length == 0) revert EmptyBatch();
        if (nullified[nullifier]) revert Replay(nullifier);
        nullified[nullifier] = true;

        bytes32 actionHash = sha256(
            abi.encode(block.chainid, address(this), calls, nullifier)
        );

        bytes32[] memory pubInputs = new bytes32[](3);
        pubInputs[0] = salt;
        (pubInputs[1], pubInputs[2]) = _splitHash(actionHash);

        if (!verifier.verify(proof, pubInputs)) revert InvalidProof();

        returnData = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
            returnData[i] = ret;
        }

        emit ExecutedBatch(nullifier, calls.length);
    }

    /// @dev Split a bytes32 into two bytes32 values, each holding 16 bytes in
    ///      the low-order positions. Matches the two-field encoding used by the
    ///      Noir circuit for sha256 outputs (fits inside Noir's 254-bit Field).
    function _splitHash(bytes32 h) internal pure returns (bytes32 hi, bytes32 lo) {
        hi = bytes32(uint256(uint128(uint256(h) >> 128)));
        lo = bytes32(uint256(uint128(uint256(h))));
    }

    receive() external payable {}
}
