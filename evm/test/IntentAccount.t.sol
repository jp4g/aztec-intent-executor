// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {BridgedUSDC} from "../src/BridgedUSDC.sol";
import {HonkVerifier} from "../src/IntentVerifier.sol";
import {IntentAccount, Call} from "../src/IntentAccount.sol";
import {IntentAccountFactory} from "../src/IntentAccountFactory.sol";

/// @notice Security regression tests for the intent executor.
///
///         Real Noir proofs are produced by FFI into `src/gen-fixture.ts`,
///         which caches them under `evm/test/fixtures/cache/` so repeated
///         `forge test` runs don't re-run bb.js.
///
///         Preimages and salts are precomputed offchain (Poseidon2 is not
///         available on EVM) and embedded as constants; see
///         `src/compute-salts.ts` for the generator.
contract IntentAccountTest is Test {
    // ---- Precomputed (preimage, salt) pairs ---------------------------------
    // see src/compute-salts.ts
    bytes32 constant PREIMAGE_A = 0x00696e74656e742d746573742d41202020202020202020202020202020202020;
    bytes32 constant SALT_A     = 0x12ae6811e45a66539e4c26c57aea22f5a869b7ee25cc0b634fec06ede8c10cff;
    bytes32 constant PREIMAGE_B = 0x00696e74656e742d746573742d42202020202020202020202020202020202020;
    bytes32 constant SALT_B     = 0x278291d2e6be9f7387258b3915e735f78ad24b71a799b068a4e5c18931c21eba;

    address constant RECIPIENT = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint256 constant CHAIN_ID = 31337;

    BridgedUSDC busdc;
    HonkVerifier verifier;
    IntentAccount impl;
    IntentAccountFactory factory;

    address intentA;
    address intentB;

    // Canonical 1-call batch on A. Proof is reused across tampering tests.
    Call[] canonCalls;
    bytes32 canonNullifier = bytes32(uint256(0x10));
    bytes canonProof;

    // 2-call batch on A for the reorder test.
    Call[] multiCalls;
    bytes32 multiNullifier = bytes32(uint256(0x11));
    bytes multiProof;

    // Proof on A that we'll misuse on B.
    bytes32 crossNullifier = bytes32(uint256(0x12));
    bytes crossProof;

    function setUp() public {
        vm.chainId(CHAIN_ID);

        busdc = new BridgedUSDC();
        verifier = new HonkVerifier();
        impl = new IntentAccount();
        factory = new IntentAccountFactory(address(impl), address(verifier));

        intentA = factory.predict(SALT_A);
        intentB = factory.predict(SALT_B);

        busdc.mint(intentA, 10e6);
        busdc.mint(intentB, 10e6);

        // Canonical batch: transfer 1 bUSDC to RECIPIENT
        canonCalls.push(Call({
            target: address(busdc),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", RECIPIENT, uint256(1e6))
        }));
        canonProof = _prove(PREIMAGE_A, SALT_A, intentA, canonCalls, canonNullifier);

        // Multi-call batch on A: transfer 1 then 2 bUSDC
        multiCalls.push(canonCalls[0]);
        multiCalls.push(Call({
            target: address(busdc),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", RECIPIENT, uint256(2e6))
        }));
        multiProof = _prove(PREIMAGE_A, SALT_A, intentA, multiCalls, multiNullifier);

        // Cross-account: same canonCalls, different nullifier, proof for A
        crossProof = _prove(PREIMAGE_A, SALT_A, intentA, canonCalls, crossNullifier);
    }

    // ---- 1. Empty batch reverts -------------------------------------------
    function test_EmptyBatch_Reverts() public {
        Call[] memory empty = new Call[](0);
        vm.expectRevert(IntentAccount.EmptyBatch.selector);
        factory.deployAndExecuteBatch(SALT_A, empty, bytes32(uint256(0x99)), hex"");
    }

    // ---- 2. Tampered target ------------------------------------------------
    function test_TamperedTarget_Reverts() public {
        Call[] memory mutated = _shallowCopy(canonCalls);
        mutated[0].target = address(0xdEaDbEeF);
        vm.expectRevert(); // any verifier-family revert is acceptable
        factory.deployAndExecuteBatch(SALT_A, mutated, canonNullifier, canonProof);
    }

    // ---- 3. Tampered value -------------------------------------------------
    function test_TamperedValue_Reverts() public {
        Call[] memory mutated = _shallowCopy(canonCalls);
        mutated[0].value = 1;
        vm.expectRevert();
        factory.deployAndExecuteBatch(SALT_A, mutated, canonNullifier, canonProof);
    }

    // ---- 4. Tampered data --------------------------------------------------
    function test_TamperedData_Reverts() public {
        Call[] memory mutated = _shallowCopy(canonCalls);
        // flip the low nibble of the last byte of the calldata
        bytes memory data = mutated[0].data;
        data[data.length - 1] = data[data.length - 1] ^ bytes1(uint8(1));
        mutated[0].data = data;
        vm.expectRevert();
        factory.deployAndExecuteBatch(SALT_A, mutated, canonNullifier, canonProof);
    }

    // ---- 5. Tampered nullifier ---------------------------------------------
    function test_TamperedNullifier_Reverts() public {
        bytes32 mutated = canonNullifier ^ bytes32(uint256(1));
        vm.expectRevert();
        factory.deployAndExecuteBatch(SALT_A, canonCalls, mutated, canonProof);
    }

    // ---- 6. Reordered calls ------------------------------------------------
    function test_ReorderedCalls_Reverts() public {
        Call[] memory reordered = new Call[](2);
        reordered[0] = multiCalls[1];
        reordered[1] = multiCalls[0];
        vm.expectRevert();
        factory.deployAndExecuteBatch(SALT_A, reordered, multiNullifier, multiProof);
    }

    // ---- 7. Cross-account replay -------------------------------------------
    // Proof was generated for intentA (uses salt_A and address(this)=intentA in
    // the action hash). Submitting on intentB, where stored salt = salt_B and
    // action_hash recomputes with address(this) = intentB, must fail.
    function test_CrossAccountReplay_Reverts() public {
        vm.expectRevert();
        factory.deployAndExecuteBatch(SALT_B, canonCalls, crossNullifier, crossProof);
    }

    // ---- 8. Re-init attack -------------------------------------------------
    function test_ReInit_Reverts() public {
        // Deploy + initialize via factory (normal path; no proof needed).
        factory.deploy(SALT_A);
        // Now try to re-initialize directly with different inputs.
        // OZ Initializable v5 reverts with InvalidInitialization().
        bytes4 invalidInit = bytes4(keccak256("InvalidInitialization()"));
        vm.expectRevert(invalidInit);
        IntentAccount(payable(intentA)).initialize(bytes32(uint256(0xdead)), address(0xdead));
    }

    // ---- 9. Duplicate deploy -----------------------------------------------
    function test_DuplicateDeploy_Reverts() public {
        factory.deploy(SALT_A);
        vm.expectRevert(); // OZ Clones -> Errors.FailedDeployment
        factory.deploy(SALT_A);
    }

    // ---- 10. Replay of a consumed nullifier --------------------------------
    function test_Replay_Reverts() public {
        // First execute — succeeds.
        factory.deployAndExecuteBatch(SALT_A, canonCalls, canonNullifier, canonProof);
        // Second execute with the same nullifier — reverts.
        vm.expectRevert(
            abi.encodeWithSelector(IntentAccount.Replay.selector, canonNullifier)
        );
        IntentAccount(payable(intentA)).executeBatch(canonCalls, canonNullifier, canonProof);
    }

    // ---- 11. Call-level atomicity ------------------------------------------
    // Batch: [transfer 1 bUSDC, transfer 100M bUSDC (must fail — intent only
    // holds 10)]. The whole batch must revert and the first transfer must be
    // rolled back. Needs its own proof.
    function test_CallLevelAtomicity_Rolls_Back() public {
        Call[] memory calls = new Call[](2);
        calls[0] = canonCalls[0]; // transfer 1 bUSDC
        calls[1] = Call({
            target: address(busdc),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", RECIPIENT, uint256(100_000_000e6))
        });
        bytes32 nullifier = bytes32(uint256(0x13));
        bytes memory proof = _prove(PREIMAGE_A, SALT_A, intentA, calls, nullifier);

        uint256 recipBefore = busdc.balanceOf(RECIPIENT);
        uint256 intentBefore = busdc.balanceOf(intentA);

        vm.expectRevert(); // CallFailed(...) — we accept any revert
        factory.deployAndExecuteBatch(SALT_A, calls, nullifier, proof);

        // State must be unchanged — both the overflow transfer AND the earlier
        // successful transfer must have rolled back.
        assertEq(busdc.balanceOf(RECIPIENT), recipBefore, "recipient delta leaked");
        assertEq(busdc.balanceOf(intentA), intentBefore, "intent balance changed");
    }

    // ---- helpers ----------------------------------------------------------

    /// @dev Compute action hash, split it, and shell out to the fixture
    ///      generator to obtain a real UltraHonk proof for (preimage, salt, hi, lo).
    function _prove(
        bytes32 preimage,
        bytes32 salt,
        address intent,
        Call[] memory calls,
        bytes32 nullifier
    ) internal returns (bytes memory) {
        bytes32 actionHash = sha256(abi.encode(CHAIN_ID, intent, calls, nullifier));
        bytes32 hi = bytes32(uint256(uint128(uint256(actionHash) >> 128)));
        bytes32 lo = bytes32(uint256(uint128(uint256(actionHash))));

        // Go through tsx directly (not yarn) — yarn's own stdout noise would
        // get concatenated to the proof hex and corrupt its length.
        string[] memory argv = new string[](6);
        argv[0] = "../node_modules/.bin/tsx";
        argv[1] = "../src/gen-fixture.ts";
        argv[2] = vm.toString(preimage);
        argv[3] = vm.toString(salt);
        argv[4] = vm.toString(hi);
        argv[5] = vm.toString(lo);
        return vm.ffi(argv);
    }

    function _shallowCopy(Call[] storage src) internal view returns (Call[] memory dst) {
        dst = new Call[](src.length);
        for (uint256 i; i < src.length; ++i) {
            dst[i] = Call({
                target: src[i].target,
                value: src[i].value,
                data: src[i].data
            });
        }
    }
}
