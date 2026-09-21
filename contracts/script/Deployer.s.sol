// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {HonkVerifier} from "../src/Verifier.sol";
import {Voting} from "../src/Voting.sol";

contract Deployer is Script{
    function run() public{


        vm.startBroadcast();

        HonkVerifier verifier = new HonkVerifier();

        Voting voting = new Voting(address(verifier));
        
        vm.stopBroadcast();
    }
}

