// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IVerifier} from "./IntentVerifier.sol";

/**
 * @title IntentAccount
 * @notice Smart-account clone deployed deterministically per Poseidon2 salt.
 *         Any EVM call can be executed *as* this account by supplying a Noir
 *         proof of knowledge of the salt's preimage, bound to the exact action
 *         via a sha256 commitment.
 *
 *         Reusable: multiple distinct actions under the same salt, each gated by
 *         its own proof and single-use nullifier.
 */
contract IntentAccount is Initializable {
    /// @notice Poseidon2 hash of the user's preimage. Equal to the CREATE2 salt.
    bytes32 public salt;

    /// @notice UltraHonk verifier for the intent circuit.
    IVerifier public verifier;

    /// @notice Nullifiers spent by prior executions; replay-proof.
    mapping(bytes32 => bool) public nullified;

    event Executed(address indexed target, bytes32 indexed nullifier, uint256 value);

    error Replay(bytes32 nullifier);
    error InvalidProof();
    error CallFailed(bytes returnData);

    /// @dev Clones are created uninitialized; factory calls initialize() right after.
    function initialize(bytes32 _salt, address _verifier) external initializer {
        salt = _salt;
        verifier = IVerifier(_verifier);
    }

    /**
     * @notice Verify a proof and execute an arbitrary call as this account.
     * @param target     Callee address.
     * @param value      ETH value forwarded.
     * @param data       Calldata to forward.
     * @param nullifier  Caller-chosen bytes32 uniquely identifying this action.
     *                   Any value works; reusing one reverts with Replay.
     * @param proof      UltraHonk proof. Public inputs are
     *                   [salt, action_hash_hi, action_hash_lo] where action_hash
     *                   is sha256(chainid, address(this), target, value, data, nullifier).
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 nullifier,
        bytes calldata proof
    ) external returns (bytes memory) {
        if (nullified[nullifier]) revert Replay(nullifier);
        nullified[nullifier] = true;

        bytes32 actionHash = sha256(
            abi.encode(block.chainid, address(this), target, value, data, nullifier)
        );

        bytes32[] memory pubInputs = new bytes32[](3);
        pubInputs[0] = salt;
        (pubInputs[1], pubInputs[2]) = _splitHash(actionHash);

        if (!verifier.verify(proof, pubInputs)) revert InvalidProof();

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);

        emit Executed(target, nullifier, value);
        return ret;
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
