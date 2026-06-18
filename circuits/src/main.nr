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
    let index = 2;
    let hash_path = [
        2256689276847399345359792277406644462014723416398290212952821205940959307205,
        1985195406472859805732720085313401851943726940210351648104245812061928359031,
        17637850887138168665484989447303297665818927781851584321725153796975171356544,
        20058509129372086033793589469556586593012197981700026421557673063737159116266,
        453372490960416314274918066540000171406262359142318949314164256006589949684,
        20126640341552099798587948537002247874700958206787074606352126333231241235843
    ];
    let election_id = 49;
    let root = 13477193859756245466565538420960270577998697290395943136479433768751572520273;
    let nullifier = std::hash::pedersen_hash([secret, election_id]);

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