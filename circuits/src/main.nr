fn compute_root(leaf: Field, index: Field, hash_path: [Field; 6]) -> Field{
    let mut current = leaf;
    let index_bits: [bool; 6] = index.to_le_bits();

    for i in 0..6 {
        let (left, right) = if index_bits[i] {
            (hash_path[i], current)
        } else{
            (current, hash_path[i])
        };
        current = std::hash::pedersen_hash([left, right]);
    }
    current
}
fn main(
    secret: Field,
    index: Field,
    hash_path: [Field; 6],
    vote: pub u8,
    election_id: pub Field,
    root: pub Field,
    nullifier: pub Field,
) {
    let leaf = std::hash::pedersen_hash([secret]);

    let expected_root = compute_root(leaf, index, hash_path);

    assert(expected_root == root);

    let expected_nullifier = std::hash::pedersen_hash([secret, election_id]);

    assert(expected_nullifier == nullifier);

    assert(vote < 4);
}


#[test]
fn test_valid_proof() {
    let secret = 3;
    let index = 0;
    let hash_path = [
        0,
        17954372136461894568820199868962143715279932924957662285438325406238856880109,
        15315010434373228768515045847926951401477884091230007539886053341418284848464,
        5337862867875115524214345623787399434458805399542698299566394924328104755643,
        3120476356109763337029616398980250392595092048585115036648644377950387540381,
        1713640813182293640789595917939697287037938209669543521747647487822835744672
    ];
    let election_id = 0;
    let root = 3300441032650236887354211366070703519281443075579043158455757719044760512664;
    let nullifier = std::hash::pedersen_hash([secret, election_id]);
    println(nullifier);
    main(secret, index, hash_path, 2, election_id, root, nullifier);
}

#[test(should_fail)]
fn test_wrong_secret_fails() {
    let secret = 1;
    let wrong_secret = 999; // attacker doesn't know the real secret
    let leaf = std::hash::pedersen_hash([secret]);
    let other_leaf = std::hash::pedersen_hash([2]);
    let root = std::hash::pedersen_hash([leaf, other_leaf]);

    let index = 0;
    let hash_path = [other_leaf, 0, 0, 0, 0, 0];
    let election_id = 100;
    let nullifier = std::hash::pedersen_hash([secret, election_id]); // correct nullifier for real secret

    main(wrong_secret, index, hash_path, 2, election_id, root, nullifier);
}

#[test(should_fail)]
fn test_invalid_vote_value_fails() {
    let secret = 1;
    let leaf = std::hash::pedersen_hash([secret]);
    let other_leaf = std::hash::pedersen_hash([2]);
    let root = std::hash::pedersen_hash([leaf, other_leaf]);

    let index = 0;
    let hash_path = [other_leaf, 0, 0, 0, 0, 0];
    let election_id = 100;
    let nullifier = std::hash::pedersen_hash([secret, election_id]);

    main(secret, index, hash_path, 10, election_id, root, nullifier);
}

#[test(should_fail)]
fn test_wrong_nullifier_fails() {
    let secret = 1;
    let leaf = std::hash::pedersen_hash([secret]);
    let other_leaf = std::hash::pedersen_hash([2]);
    let root = std::hash::pedersen_hash([leaf, other_leaf]);

    let index = 0;
    let hash_path = [other_leaf, 0, 0, 0, 0, 0];
    let election_id = 100;
    let fake_nullifier = 12345; // not derived correctly

    main(secret, index, hash_path, 2, election_id, root, fake_nullifier);
}

#[test(should_fail)]
fn test_wrong_root_fails() {
    let secret = 1;
    let other_leaf = std::hash::pedersen_hash([2]);
    let wrong_root = std::hash::pedersen_hash([99, 99]); // doesn't match the actual tree

    let index = 0;
    let hash_path = [other_leaf, 0, 0, 0, 0, 0];
    let election_id = 100;
    let nullifier = std::hash::pedersen_hash([secret, election_id]);

    main(secret, index, hash_path, 2, election_id, wrong_root, nullifier);
}