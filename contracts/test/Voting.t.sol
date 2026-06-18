// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Voting} from "../src/Voting.sol";

// ── Mock verifiers ────────────────────────────────────────────────────────────
// These satisfy the verify(bytes, bytes32[]) interface used by Voting.sol
// without running the real Honk proof check, which requires an actual circuit proof.

contract MockVerifierAccept {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

contract MockVerifierReject {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

contract VotingTest is Test {

    // ── Constants ─────────────────────────────────────────────────────────────

    bytes32 constant ROOT        = bytes32(uint256(0xDEADBEEF));
    bytes32 constant WRONG_ROOT  = bytes32(uint256(0xBADBAD00));
    bytes32 constant NULLIFIER_A = keccak256("nullifier_A");
    bytes32 constant NULLIFIER_B = keccak256("nullifier_B");

    uint256 constant T_START  = 1_000_000;
    uint256 constant T_END    = 2_000_000;
    uint256 constant ELECTION_ID = 0; // first element in elections array

    // ── State ─────────────────────────────────────────────────────────────────

    Voting voting;
    MockVerifierAccept acceptVerifier;

    address owner;   // test contract itself (deploys Voting)
    address alice;
    address bob;
    address stranger;

    // Storage array so setUp can push into it; automatically copied to memory on call.
    Voting.Candidate[] internal _fourCandidates;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        owner    = address(this);
        alice    = makeAddr("alice");
        bob      = makeAddr("bob");
        stranger = makeAddr("stranger");

        acceptVerifier = new MockVerifierAccept();
        voting = new Voting(address(acceptVerifier));

        delete _fourCandidates;
        _fourCandidates.push(Voting.Candidate({name: "Alice", voteCount: 0}));
        _fourCandidates.push(Voting.Candidate({name: "Bob",   voteCount: 0}));
        _fourCandidates.push(Voting.Candidate({name: "Carol", voteCount: 0}));
        _fourCandidates.push(Voting.Candidate({name: "Dave",  voteCount: 0}));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Builds a minimal publicInputs array matching what vote() reads at indices 0-3.
    // Layout mirrors the circuit's public inputs: [vote, election_id, root, nullifier]
    function _pi(uint256 candidateId, uint256 elId, bytes32 root, bytes32 nullifier)
        internal pure returns (bytes32[] memory pi)
    {
        pi = new bytes32[](4);
        pi[0] = bytes32(candidateId); // vote
        pi[1] = bytes32(elId);        // election_id
        pi[2] = root;                 // merkle root
        pi[3] = nullifier;            // nullifier
    }

    // Creates one default election (index 0) and returns without warping the clock.
    function _createElection() internal {
        voting.createElection(_fourCandidates, ROOT, T_START, T_END);
    }

    // Warps to T_START and casts a vote through the accept-mock verifier.
    function _castVote(uint256 candidateId, bytes32 nullifier) internal {
        vm.warp(T_START);
        voting.vote(ELECTION_ID, new bytes(0), _pi(candidateId, ELECTION_ID, ROOT, nullifier));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ══════════════════════════════════════════════════════════════════════════

    function test_Constructor_StoresVerifierAddress() public view {
        assertEq(address(voting.verifier()), address(acceptVerifier));
    }

    function test_Constructor_NoElectionsOnDeploy() public view {
        assertEq(voting.getElectionCount(), 0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // createElection
    // ══════════════════════════════════════════════════════════════════════════

    function test_CreateElection_IncrementsElectionCount() public {
        _createElection();
        assertEq(voting.getElectionCount(), 1);
    }

    function test_CreateElection_StoresCandidateNames() public {
        _createElection();
        string[] memory names = voting.viewCandidateNames(ELECTION_ID);
        assertEq(names.length, 4);
        assertEq(names[0], "Alice");
        assertEq(names[1], "Bob");
        assertEq(names[2], "Carol");
        assertEq(names[3], "Dave");
    }

    function test_CreateElection_EmitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit Voting.ElectionRegistered(ELECTION_ID, ROOT);
        _createElection();
    }

    function test_CreateElection_MultipleElectionsGetSequentialIds() public {
        _createElection();
        voting.createElection(_fourCandidates, ROOT, T_START + 1, T_END + 1);
        assertEq(voting.getElectionCount(), 2);
    }

    // ── Access control ────────────────────────────────────────────────────────

    function test_CreateElection_RevertsIfNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert("Only Owner may commit this action.");
        voting.createElection(_fourCandidates, ROOT, T_START, T_END);
    }

    function test_CreateElection_RevertsIfNotOwner_Fuzz(address caller) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert("Only Owner may commit this action.");
        voting.createElection(_fourCandidates, ROOT, T_START, T_END);
    }

    // ── Timing validation ─────────────────────────────────────────────────────

    function test_CreateElection_RevertsIfStartAfterEnd() public {
        vm.expectRevert("Election start can't be after the election end.");
        voting.createElection(_fourCandidates, ROOT, T_END, T_START);
    }

    function test_CreateElection_RevertsIfStartEqualsEnd() public {
        vm.expectRevert("Election start can't be after the election end.");
        voting.createElection(_fourCandidates, ROOT, T_START, T_START);
    }

    // ── Candidate count validation ────────────────────────────────────────────

    function test_CreateElection_RevertsIfTooFewCandidates() public {
        Voting.Candidate[] memory three = new Voting.Candidate[](3);
        three[0] = Voting.Candidate({name: "A", voteCount: 0});
        three[1] = Voting.Candidate({name: "B", voteCount: 0});
        three[2] = Voting.Candidate({name: "C", voteCount: 0});

        vm.expectRevert("Election should have exactly 4 candidates.");
        voting.createElection(three, ROOT, T_START, T_END);
    }

    function test_CreateElection_RevertsIfTooManyCandidates() public {
        Voting.Candidate[] memory five = new Voting.Candidate[](5);
        for (uint256 i = 0; i < 5; i++) {
            five[i] = Voting.Candidate({name: "X", voteCount: 0});
        }

        vm.expectRevert("Election should have exactly 4 candidates.");
        voting.createElection(five, ROOT, T_START, T_END);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // vote
    // ══════════════════════════════════════════════════════════════════════════

    function test_Vote_SucceedsOnValidCall() public {
        _createElection();
        _castVote(0, NULLIFIER_A);

        vm.warp(T_END + 1);
        Voting.Candidate[] memory results = voting.viewResults(ELECTION_ID);
        assertEq(results[0].voteCount, 1);
    }

    function test_Vote_IncrementsCorrectCandidate() public {
        _createElection();
        _castVote(2, NULLIFIER_A); // candidate index 2 = Carol

        vm.warp(T_END + 1);
        Voting.Candidate[] memory results = voting.viewResults(ELECTION_ID);
        assertEq(results[0].voteCount, 0);
        assertEq(results[1].voteCount, 0);
        assertEq(results[2].voteCount, 1);
        assertEq(results[3].voteCount, 0);
    }

    function test_Vote_MarksNullifierUsed() public {
        _createElection();
        assertFalse(voting.checkNullifier(ELECTION_ID, NULLIFIER_A));
        _castVote(0, NULLIFIER_A);
        assertTrue(voting.checkNullifier(ELECTION_ID, NULLIFIER_A));
    }

    function test_Vote_EmitsVoteRecordedEvent() public {
        _createElection();
        vm.warp(T_START);

        vm.expectEmit(false, true, false, false);
        emit Voting.VoteRecorded(NULLIFIER_A, 1);

        voting.vote(ELECTION_ID, new bytes(0), _pi(1, ELECTION_ID, ROOT, NULLIFIER_A));
    }

    function test_Vote_MultipleVoters_AccumulatesCorrectly() public {
        _createElection();
        _castVote(0, NULLIFIER_A);
        _castVote(2, NULLIFIER_B);

        vm.warp(T_END + 1);
        Voting.Candidate[] memory results = voting.viewResults(ELECTION_ID);
        assertEq(results[0].voteCount, 1);
        assertEq(results[2].voteCount, 1);
    }

    // ── Timing guards ─────────────────────────────────────────────────────────

    function test_Vote_RevertsBeforeElectionStart() public {
        _createElection();
        vm.warp(T_START - 1);
        vm.expectRevert("Election hasn't started yet.");
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, ROOT, NULLIFIER_A));
    }

    function test_Vote_SucceedsAtExactStartTime() public {
        _createElection();
        vm.warp(T_START); // boundary: timestamp == startTime
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, ROOT, NULLIFIER_A));
        assertTrue(voting.checkNullifier(ELECTION_ID, NULLIFIER_A));
    }

    function test_Vote_SucceedsAtExactEndTime() public {
        _createElection();
        vm.warp(T_END); // boundary: timestamp == endTime (<=, so still valid)
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, ROOT, NULLIFIER_A));
        assertTrue(voting.checkNullifier(ELECTION_ID, NULLIFIER_A));
    }

    function test_Vote_RevertsAfterElectionEnd() public {
        _createElection();
        vm.warp(T_END + 1);
        vm.expectRevert("Election has already passed.");
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, ROOT, NULLIFIER_A));
    }

    // ── Public input validation ───────────────────────────────────────────────

    function test_Vote_RevertsOnElectionIdMismatch() public {
        _createElection();
        vm.warp(T_START);
        // Claim election 99 in publicInputs but pass electionId = 0
        vm.expectRevert("Mismatch in elections chosen");
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, 99, ROOT, NULLIFIER_A));
    }

    // ── ZK proof validation ───────────────────────────────────────────────────

    function test_Vote_RevertsOnInvalidProof() public {
        MockVerifierReject rejector = new MockVerifierReject();
        Voting votingWithReject = new Voting(address(rejector));
        votingWithReject.createElection(_fourCandidates, ROOT, T_START, T_END);

        vm.warp(T_START);
        vm.expectRevert("Invalid proof.");
        votingWithReject.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, ROOT, NULLIFIER_A));
    }

    // ── Merkle root validation ────────────────────────────────────────────────

    function test_Vote_RevertsOnStaleMerkleRoot() public {
        _createElection();
        vm.warp(T_START);
        vm.expectRevert("Proof was generated against a stale or invalid root.");
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, WRONG_ROOT, NULLIFIER_A));
    }

    // ── Nullifier (double-vote) guards ────────────────────────────────────────

    function test_Vote_RevertsOnNullifierReplay() public {
        _createElection();
        _castVote(0, NULLIFIER_A);

        // Same nullifier, same or different caller — must revert
        vm.warp(T_START);
        vm.expectRevert("This voter has already cast a vote.");
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, ROOT, NULLIFIER_A));
    }

    function test_Vote_NullifierReplay_DifferentCallerAddress() public {
        // The contract tracks by nullifier, not by msg.sender.
        // A different address submitting the same nullifier must still be rejected.
        _createElection();
        _castVote(0, NULLIFIER_A);

        vm.warp(T_START);
        vm.prank(alice);
        vm.expectRevert("This voter has already cast a vote.");
        voting.vote(ELECTION_ID, new bytes(0), _pi(0, ELECTION_ID, ROOT, NULLIFIER_A));
    }

    function test_Vote_DifferentNullifiersAllowed() public {
        // Two distinct voters — each gets a unique nullifier; both votes should land.
        _createElection();
        _castVote(1, NULLIFIER_A);
        _castVote(3, NULLIFIER_B);

        assertTrue(voting.checkNullifier(ELECTION_ID, NULLIFIER_A));
        assertTrue(voting.checkNullifier(ELECTION_ID, NULLIFIER_B));
    }

    // ── Candidate bounds ──────────────────────────────────────────────────────

    function test_Vote_RevertsOnCandidateIndexOutOfBounds() public {
        _createElection();
        vm.warp(T_START);
        vm.expectRevert("Invalid candidate.");
        voting.vote(ELECTION_ID, new bytes(0), _pi(4, ELECTION_ID, ROOT, NULLIFIER_A)); // index 4, only 0-3 valid
    }

    // ── Nullifier scoping across elections ────────────────────────────────────

    function test_Vote_NullifierScopedToElection() public {
        // NULLIFIER_A used in election 0 must not block the same nullifier in election 1.
        _createElection();
        voting.createElection(_fourCandidates, ROOT, T_START + 1, T_END + 1); // election id = 1

        _castVote(0, NULLIFIER_A); // election 0

        vm.warp(T_START + 1);
        // Same nullifier bytes but different electionId → different slot → should succeed.
        voting.vote(1, new bytes(0), _pi(0, 1, ROOT, NULLIFIER_A));

        assertTrue(voting.checkNullifier(0, NULLIFIER_A));
        assertTrue(voting.checkNullifier(1, NULLIFIER_A));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // viewResults
    // ══════════════════════════════════════════════════════════════════════════

    function test_ViewResults_RevertsAtExactEndTime() public {
        _createElection();
        vm.warp(T_END); // timestamp == endTime; modifier requires strictly >
        vm.expectRevert("Election wasn't yet finished.");
        voting.viewResults(ELECTION_ID);
    }

    function test_ViewResults_SucceedsOneSecondAfterEnd() public {
        _createElection();
        vm.warp(T_END + 1);
        Voting.Candidate[] memory results = voting.viewResults(ELECTION_ID);
        assertEq(results.length, 4);
    }

    function test_ViewResults_ReflectsAccumulatedVotes() public {
        _createElection();
        _castVote(0, NULLIFIER_A);
        _castVote(0, NULLIFIER_B); // two votes for Alice

        vm.warp(T_END + 1);
        Voting.Candidate[] memory results = voting.viewResults(ELECTION_ID);
        assertEq(results[0].voteCount, 2);
        assertEq(results[1].voteCount, 0);
        assertEq(results[2].voteCount, 0);
        assertEq(results[3].voteCount, 0);
    }

    function test_ViewResults_ZeroVotesAfterNoParticipation() public {
        _createElection();
        vm.warp(T_END + 1);
        Voting.Candidate[] memory results = voting.viewResults(ELECTION_ID);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(results[i].voteCount, 0);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // viewCandidateNames
    // ══════════════════════════════════════════════════════════════════════════

    function test_ViewCandidateNames_ReturnsAllFour() public {
        _createElection();
        string[] memory names = voting.viewCandidateNames(ELECTION_ID);
        assertEq(names.length, 4);
        assertEq(names[0], "Alice");
        assertEq(names[1], "Bob");
        assertEq(names[2], "Carol");
        assertEq(names[3], "Dave");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // checkNullifier
    // ══════════════════════════════════════════════════════════════════════════

    function test_CheckNullifier_FalseBeforeVoting() public {
        _createElection();
        assertFalse(voting.checkNullifier(ELECTION_ID, NULLIFIER_A));
    }

    function test_CheckNullifier_TrueAfterVoting() public {
        _createElection();
        _castVote(0, NULLIFIER_A);
        assertTrue(voting.checkNullifier(ELECTION_ID, NULLIFIER_A));
    }

    function test_CheckNullifier_UnusedNullifierRemainsUnaffected() public {
        _createElection();
        _castVote(0, NULLIFIER_A);
        assertFalse(voting.checkNullifier(ELECTION_ID, NULLIFIER_B));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // getElectionCount
    // ══════════════════════════════════════════════════════════════════════════

    function test_GetElectionCount_StartsAtZero() public view {
        assertEq(voting.getElectionCount(), 0);
    }

    function test_GetElectionCount_IncrementsWithEachCreate() public {
        assertEq(voting.getElectionCount(), 0);
        _createElection();
        assertEq(voting.getElectionCount(), 1);
        voting.createElection(_fourCandidates, ROOT, T_START + 1, T_END + 1);
        assertEq(voting.getElectionCount(), 2);
    }
}
