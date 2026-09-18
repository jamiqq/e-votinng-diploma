// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {HonkVerifier} from "../src/Verifier.sol";
import {Voting} from "../src/Voting.sol";

contract Deployer is Script{
    function run() public{

        bytes32 root = vm.envBytes32("MERKLE_ROOT");

        vm.startBroadcast();

        HonkVerifier verifier = new HonkVerifier();

        Voting voting = new Voting(address(verifier));

        string[] memory candidates = new string[](4);
        candidates[0] = "bob";
        candidates[1] = "alice";
        candidates[2] = "kevin";
        candidates[3] = "lara";
        voting.createElection(candidates, root, block.timestamp, block.timestamp + 365 days);

        vm.stopBroadcast();
    }
}

