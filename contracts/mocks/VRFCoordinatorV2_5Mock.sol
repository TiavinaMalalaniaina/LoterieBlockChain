// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";

/**
 * @title VRFCoordinatorV2_5Mock
 * @notice Mock minimal du coordinateur Chainlink VRF v2.5 pour les tests locaux Hardhat/Foundry.
 * @dev Implémente IVRFCoordinatorV2Plus avec des stubs vides et une fonction
 *       fulfillRandomWords() manuelle pour simuler la réponse Chainlink en environnement de test.
 */
contract VRFCoordinatorV2_5Mock is IVRFCoordinatorV2Plus {

    /// @dev Compteur auto-incrémenté pour générer des requestId uniques.
    uint256 private s_nextRequestId = 1;

    /// @dev Compteur auto-incrémenté pour générer des subscriptionId uniques.
    uint256 private s_nextSubId     = 1;

    /// @notice Données d'une requête VRF en attente de fulfillment.
    struct Request {
        address consumer;  ///< Adresse du contrat consommateur ayant fait la demande
        uint32  numWords;  ///< Nombre de mots aléatoires demandés
    }

    /// @notice Mapping requestId → données de la requête en attente.
    mapping(uint256 => Request) public s_requests;

    /// @notice Émis lors d'une nouvelle demande de mots aléatoires.
    /// @param requestId Identifiant unique de la requête.
    /// @param subId Identifiant de la subscription utilisée.
    event RandomWordsRequested(uint256 indexed requestId, uint256 indexed subId);

    /// @notice Émis après l'exécution du fulfillment d'une requête.
    /// @param requestId Identifiant de la requête résolue.
    event RandomWordsFulfilled(uint256 indexed requestId);

    // ── IVRFCoordinatorV2Plus ──────────────────────────────────────

    /// @notice Enregistre une nouvelle demande de mots aléatoires.
    /// @dev Simule le comportement du vrai coordinateur : stocke la requête et émet un event.
    /// @param req Paramètres de la requête VRF (keyHash, subId, numWords, etc.).
    /// @return requestId Identifiant unique attribué à cette requête.
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external override returns (uint256 requestId)
    {
        requestId = s_nextRequestId++;
        s_requests[requestId] = Request({ consumer: msg.sender, numWords: req.numWords });
        emit RandomWordsRequested(requestId, req.subId);
    }

    // ── IVRFSubscriptionV2Plus ─────────────────────────────────────

    /// @notice Crée une nouvelle subscription (stub de test).
    /// @return subId Identifiant de la subscription créée.
    function createSubscription() external override returns (uint256 subId) {
        subId = s_nextSubId++;
    }

    /// @notice Retourne les détails d'une subscription (stub — valeurs vides).
    /// @return balance Solde LINK (toujours 0).
    /// @return nativeBalance Solde natif (toujours 0).
    /// @return reqCount Nombre de requêtes (toujours 0).
    /// @return owner Propriétaire (toujours address(0)).
    /// @return consumers Liste des consommateurs (toujours vide).
    function getSubscription(uint256) external pure override returns (
        uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers
    ) {
        return (0, 0, 0, address(0), new address[](0));
    }

    /// @notice Retourne les IDs des subscriptions actives (stub — liste vide).
    /// @return Tableau vide d'identifiants.
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
