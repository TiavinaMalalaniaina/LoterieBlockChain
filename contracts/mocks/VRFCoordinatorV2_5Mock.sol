// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";

/**
 * @dev Mock minimal du VRFCoordinator v2.5 pour les tests locaux Hardhat.
 */
contract VRFCoordinatorV2_5Mock is IVRFCoordinatorV2Plus {

    uint256 private s_nextRequestId = 1;
    uint256 private s_nextSubId     = 1;

    struct Request {
        address consumer;
        uint32  numWords;
    }
    mapping(uint256 => Request) public s_requests;

    event RandomWordsRequested(uint256 indexed requestId, uint256 indexed subId);
    event RandomWordsFulfilled(uint256 indexed requestId);

    // ── IVRFCoordinatorV2Plus ──────────────────────────────────────

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external override returns (uint256 requestId)
    {
        requestId = s_nextRequestId++;
        s_requests[requestId] = Request({ consumer: msg.sender, numWords: req.numWords });
        emit RandomWordsRequested(requestId, req.subId);
    }

    // ── IVRFSubscriptionV2Plus ─────────────────────────────────────

    function createSubscription() external override returns (uint256 subId) {
        subId = s_nextSubId++;
    }

    function getSubscription(uint256) external pure override returns (
        uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers
    ) {
        return (0, 0, 0, address(0), new address[](0));
    }

    function getActiveSubscriptionIds(uint256, uint256) external pure override returns (uint256[] memory) {
        return new uint256[](0);
    }

    function fundSubscriptionWithNative(uint256) external payable override {}
    function addConsumer(uint256, address) external override {}
    function removeConsumer(uint256, address) external override {}
    function cancelSubscription(uint256, address) external override {}
    function pendingRequestExists(uint256) external pure override returns (bool) { return false; }
    function requestSubscriptionOwnerTransfer(uint256, address) external override {}
    function acceptSubscriptionOwnerTransfer(uint256) external override {}

    // ── Helper pour les tests ──────────────────────────────────────

    /**
     * @notice Simule la réponse Chainlink. Appeler depuis Hardhat après triggerDraw().
     */
    function fulfillRandomWords(uint256 requestId, uint256 randomWord) external {
        Request memory req = s_requests[requestId];
        require(req.consumer != address(0), "Request not found");

        uint256[] memory words = new uint256[](req.numWords);
        for (uint32 i = 0; i < req.numWords; i++) {
            words[i] = uint256(keccak256(abi.encode(randomWord, i)));
        }

        delete s_requests[requestId];
        VRFConsumerBaseV2Plus(req.consumer).rawFulfillRandomWords(requestId, words);
        emit RandomWordsFulfilled(requestId);
    }
}
