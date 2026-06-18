// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import {IVerifier} from "./IVerifier.sol";

contract Voting{
    
    struct Candidate {
        string name;
        uint256 voteCount;
    }

    struct Election {
        bytes32 merkleRoot;
        uint256 startTime;
        uint256 endTime;
        Candidate[] candidates;
    }

    event VoteRecorded(bytes32 nullifier, uint256 indexed candidateId);
    event ElectionRegistered(uint256 indexed electionId, bytes32 indexed root);

    mapping(uint256 => mapping(bytes32 => bool)) public hasVoted;

    Election[] public elections;

    IVerifier public verifier;

    address immutable OWNER;
    constructor (address _verifierAddress) {
        OWNER = msg.sender;
        verifier = IVerifier(_verifierAddress);
    }

    modifier onlyOwner(){
        _onlyOwner();
        _;
    }

    function _onlyOwner() internal view {
        require(msg.sender == OWNER, "Only Owner may commit this action.");
    }

    modifier electionEnded(uint256 electionId){
        _electionEnded(electionId);
        _;
    }

    function _electionEnded(uint256 electionId) internal view{
        require(block.timestamp > elections[electionId].endTime, "Election wasn't yet finished.");
    }

    function createElection(Candidate[] memory cands, bytes32 root, uint256 start, uint256 end) onlyOwner() external{
        require(start < end, "Election start can't be after the election end.");
        require(cands.length == 4, "Election should have exactly 4 candidates.");
        elections.push(Election({merkleRoot: root, startTime: start, endTime: end, candidates: cands}));
        Election storage e = elections[elections.length - 1];
        emit ElectionRegistered(elections.length - 1, e.merkleRoot);
    }

    function checkNullifier(uint256 electionId, bytes32 nullifier) external view returns (bool){
        return hasVoted[electionId][nullifier];
    }

    function vote(
        uint256 electionId,
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external {
        Election storage e = elections[electionId];

        require(block.timestamp >= e.startTime, "Election hasn't started yet.");
        require(block.timestamp <= e.endTime, "Election has already passed.");
        require(uint256(publicInputs[1]) == electionId, "Mismatch in elections chosen");

        bool isValid = verifier.verify(proof, publicInputs);

        require(isValid, "Invalid proof.");

        uint256 submittedVote = uint256(publicInputs[0]);
        bytes32 root = publicInputs[2];
        bytes32 nullifier = publicInputs[3];

        require(root == e.merkleRoot, "Proof was generated against a stale or invalid root.");
        require(!hasVoted[electionId][nullifier], "This voter has already cast a vote.");
        require(submittedVote < e.candidates.length, "Invalid candidate.");

        hasVoted[electionId][nullifier] = true;
        e.candidates[submittedVote].voteCount++;

        emit VoteRecorded(nullifier, submittedVote);
    }

    function viewResults(uint256 electionId) electionEnded(electionId) external view returns (Candidate[] memory){
        return elections[electionId].candidates;
    }

    function viewCandidateNames(uint256 electionId) external view returns (string[] memory){
        Candidate[] storage c = elections[electionId].candidates;
        string[] memory names = new string[](c.length);
        for (uint256 i = 0; i < c.length; i++) {
            names[i] = c[i].name;
        }
        return names;
    }

    function getElectionCount() external view returns (uint256){
        return elections.length;
    }
}   
