use poseidon::poseidon2::Poseidon2;

// Prove knowledge of `preimage` such that `poseidon2(preimage) == salt`.
//
// `action_hash_hi` and `action_hash_lo` are the two 16-byte halves of
// sha256(chainid, intent_account, target, value, calldata, nullifier).
// They are public inputs only; the EVM verifier re-hashes the action on-chain
// and checks equality, binding this proof to a specific action.
fn main(
    preimage: Field,
    salt: pub Field,
    action_hash_hi: pub Field,
    action_hash_lo: pub Field,
) {
    let computed = Poseidon2::hash([preimage], 1);
    assert(computed == salt);

    // Reference the action-hash halves so they remain live public inputs.
    // Being `pub` binds them to the proof statement; no further constraint is
    // needed because the EVM verifier enforces equality with sha256(action).
    let _bind = action_hash_hi + action_hash_lo;
}

#[test]
fn test_valid_preimage() {
    let preimage: Field = 1234567;
    let salt = Poseidon2::hash([preimage], 1);
    main(preimage, salt, 0xabcdef, 0x123456);
}

#[test(should_fail)]
fn test_wrong_preimage() {
    let preimage: Field = 1234567;
    let salt = Poseidon2::hash([preimage], 1);
    main(9999999, salt, 0, 0);
}
