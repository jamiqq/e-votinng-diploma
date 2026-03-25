use std::hash;

fn main(expected_msg: pub Field, msg: Field, secret: Field) -> pub Field{
    
    let computed_hash = hash(msg);

    assert(computed_hash == expected_msg);

    let nullifier = poseidon::hash(secret);


    nullifier
}
