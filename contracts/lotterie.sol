// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";

/**
 * @title Lottery
 * @notice Loterie on-chain — rounds démarrés manuellement par le owner.
 *         Tirage via Chainlink VRF v2.5.
 * @dev Hérite de VRFConsumerBaseV2Plus pour recevoir les mots aléatoires, et de ReentrancyGuard pour protéger les transferts ETH.
 */
contract Lottery is VRFConsumerBaseV2Plus, ReentrancyGuard {

    // ─────────────────────────────────────────────────────────────
    //  Types
    // ─────────────────────────────────────────────────────────────
 
    /// @notice États possibles d'un round de loterie.
    /// @dev OPEN = tickets achetables, DRAWING = tirage en cours, CLOSED = terminé.
    enum State { OPEN, DRAWING, CLOSED }

    /// @notice Structure représentant un round complet de loterie.
    /// @dev Les joueurs sont stockés avec répétition pour pondérer les chances selon le nombre de tickets.
    struct Round {
        uint256 id;           ///< Identifiant unique du round
        uint256 startTime;    ///< Timestamp de début du round
        uint256 endTime;      ///< Timestamp de fin (après lequel le tirage peut être déclenché)
        uint256 ticketPrice;  ///< Prix d'un ticket en wei au moment du démarrage
        uint256 prizePool;    ///< Total des ETH misés dans ce round
        address winner;       ///< Adresse du gagnant (address(0) tant que non tiré)
        State   state;        ///< État courant du round
        address[] players;    ///< Liste des adresses des joueurs (avec doublons si multi-tickets)
    }

    // ─────────────────────────────────────────────────────────────
    //  Chainlink VRF v2.5
    // ─────────────────────────────────────────────────────────────

    /// @dev Référence au coordinateur VRF Chainlink v2.5.
    IVRFCoordinatorV2Plus private immutable i_vrfCoordinator;

    /// @dev Hash de la clé VRF (détermine la vitesse/coût de la réponse).
    bytes32  private immutable i_keyHash;

    /// @dev Identifiant de la subscription Chainlink VRF financée en LINK.
    uint256  private immutable i_subscriptionId;

    /// @dev Limite de gas allouée au callback fulfillRandomWords.
    uint32   private constant  CALLBACK_GAS_LIMIT    = 100_000;

    /// @dev Nombre de confirmations de blocs attendues avant la réponse VRF.
    uint16   private constant  REQUEST_CONFIRMATIONS  = 3;

    /// @dev Nombre de mots aléatoires demandés par tirage (1 suffit).
    uint32   private constant  NUM_WORDS              = 1;

    /// @notice Associe un requestId Chainlink à l'identifiant du round concerné.
    mapping(uint256 => uint256) public vrfRequestToRound;

    // ─────────────────────────────────────────────────────────────
    //  Storage
    // ─────────────────────────────────────────────────────────────

    /// @notice Prix actuel d'un ticket en wei. Modifiable par le owner hors round actif.
    uint256 public ticketPrice;            // modifiable par le owner hors round

    /// @notice Nombre maximum de participants par round (0 = illimité).
    uint256 public immutable maxPlayers;

    /// @notice Durée d'un round en secondes. Modifiable par le owner hors round actif.
    uint256 public durationSeconds;        // modifiable par le owner hors round

    /// @notice Commission prélevée sur le prize pool en points de base (500 = 5 %).
    uint256 public constant  OWNER_FEE_BPS = 500;

    /// @notice Identifiant du round en cours (0 = aucun round démarré).
    uint256 public currentRoundId;        // 0 = aucun round démarré

    /// @notice Mapping roundId → données du round.
    mapping(uint256 => Round) public rounds;

    /// @notice Nombre de tickets achetés par adresse pour un round donné.
    /// @dev ticketsPerPlayer[roundId][player] = nombre de tickets
    mapping(uint256 => mapping(address => uint256)) public ticketsPerPlayer;

    // ─────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────

    /// @notice Émis au démarrage d'un nouveau round.
    /// @param roundId Identifiant du round démarré.
    /// @param ticketPrice Prix du ticket en wei pour ce round.
    /// @param endTime Timestamp de fin du round.
    event RoundStarted(uint256 indexed roundId, uint256 ticketPrice, uint256 endTime);

    /// @notice Émis à chaque achat de ticket(s).
    /// @param roundId Round concerné.
    /// @param player Adresse de l'acheteur.
    /// @param tickets Nombre de tickets achetés.
    event TicketPurchased(uint256 indexed roundId, address indexed player, uint256 tickets);

    /// @notice Émis lorsque le tirage est déclenché et la demande VRF envoyée.
    /// @param roundId Round concerné.
    /// @param requestId Identifiant de la requête Chainlink VRF.
    event DrawTriggered(uint256 indexed roundId, uint256 requestId);

    /// @notice Émis lorsque le gagnant est désigné après réponse du VRF.
    /// @param roundId Round concerné.
    /// @param winner Adresse du gagnant.
    /// @param prize Montant en wei remporté (après déduction de la commission).
    event WinnerPicked(uint256 indexed roundId, address indexed winner, uint256 prize);

    /// @notice Émis à la fermeture définitive d'un round.
    /// @param roundId Round fermé.
    event RoundClosed(uint256 indexed roundId);

    /// @notice Émis lors de la mise à jour du prix du ticket.
    /// @param oldPrice Ancien prix en wei.
    /// @param newPrice Nouveau prix en wei.
    event TicketPriceUpdated(uint256 oldPrice, uint256 newPrice);

    /// @notice Émis lors de la mise à jour de la durée des rounds.
    /// @param oldDuration Ancienne durée en secondes.
    /// @param newDuration Nouvelle durée en secondes.
    event DurationUpdated(uint256 oldDuration, uint256 newDuration);

    // ─────────────────────────────────────────────────────────────
    //  Errors
    // ─────────────────────────────────────────────────────────────

    /// @notice Aucun round ouvert au moment de l'appel.
    error RoundNotOpen();
    /// @notice Le round n'est pas encore terminé.
    error RoundNotEnded();
    /// @notice Un round est déjà en cours (état OPEN).
    error RoundAlreadyOpen();
    /// @notice Un tirage est déjà en cours (état DRAWING).
    error RoundAlreadyDrawing();
    /// @notice Montant ETH envoyé insuffisant ou incorrect.
    error NotEnoughETH();
    /// @notice Le nombre maximum de participants est atteint.
    error TooManyPlayers();
    /// @notice Aucun participant dans ce round.
    error NoPlayers();
    /// @notice Le round contient des participants, opération impossible.
    error RoundHasPlayers();
    /// @notice Échec du transfert ETH.
    error TransferFailed();
    /// @notice Durée invalide (zéro non autorisé).
    error InvalidDuration();
    /// @notice Prix invalide (zéro non autorisé).
    error InvalidPrice();

    // ─────────────────────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────────────────────

    /// @dev Vérifie qu'un round est actuellement dans l'état OPEN.
    modifier roundIsOpen() {
        if (currentRoundId == 0 || rounds[currentRoundId].state != State.OPEN)
            revert RoundNotOpen();
        _;
    }

    /// @dev Vérifie qu'aucun round n'est actif (ni OPEN ni DRAWING).
    modifier noActiveRound() {
        if (currentRoundId > 0 && rounds[currentRoundId].state == State.OPEN)
            revert RoundAlreadyOpen();
        if (currentRoundId > 0 && rounds[currentRoundId].state == State.DRAWING)
            revert RoundAlreadyDrawing();
        _;
    }

    // ─────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────

    /// @notice Déploie le contrat de loterie.
    /// @dev currentRoundId est initialisé à 0 ; le owner doit appeler startRound() manuellement.
    /// @param _ticketPrice Prix initial d'un ticket en wei (doit être > 0).
    /// @param _maxPlayers Nombre maximum de joueurs par round (0 = illimité).
    /// @param _durationSecs Durée d'un round en secondes (doit être > 0).
    /// @param _vrfCoordinator Adresse du coordinateur Chainlink VRF v2.5.
    /// @param _keyHash Key hash VRF correspondant au gas lane souhaité.
    /// @param _subscriptionId Identifiant de la subscription Chainlink VRF.
    constructor(
        uint256 _ticketPrice,
        uint256 _maxPlayers,
        uint256 _durationSecs,
        address _vrfCoordinator,
        bytes32 _keyHash,
        uint256 _subscriptionId
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        if (_ticketPrice == 0)  revert InvalidPrice();
        if (_durationSecs == 0) revert InvalidDuration();

        i_vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        i_keyHash        = _keyHash;
        i_subscriptionId = _subscriptionId;

        ticketPrice     = _ticketPrice;
        maxPlayers      = _maxPlayers;
        durationSeconds = _durationSecs;
        // currentRoundId = 0 : aucun round actif, le owner démarre manuellement
    }

    // ─────────────────────────────────────────────────────────────
    //  External — owner
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Démarre un nouveau round. Réservé au owner.
     *         Impossible si un round est déjà OPEN ou en DRAWING.
     */
    function startRound() external onlyOwner noActiveRound {
        _startNewRound();
    }

    /**
     * @notice Modifie le prix du ticket. Réservé au owner.
     *         Impossible pendant un round actif.
     * @param _newPrice Nouveau prix en wei (doit être > 0).
     */
    function setTicketPrice(uint256 _newPrice) external onlyOwner noActiveRound {
        if (_newPrice == 0) revert InvalidPrice();
        emit TicketPriceUpdated(ticketPrice, _newPrice);
        ticketPrice = _newPrice;
    }

    /// @notice Met à jour la durée des prochains rounds.
    /// @dev Réservé au owner. Impossible pendant un round actif.
    /// @param _newDuration Nouvelle durée en secondes (doit être > 0).
    function setDuration(uint256 _newDuration) external onlyOwner noActiveRound {
        if (_newDuration == 0) revert InvalidDuration();
        emit DurationUpdated(durationSeconds, _newDuration);
        durationSeconds = _newDuration;
    }

    /// @notice Ferme un round vide (aucun participant) après son expiration.
    /// @dev Réservé au owner. Échoue si le round a des participants ou n'est pas expiré.
    function skipEmptyRound() external onlyOwner {
        Round storage r = rounds[currentRoundId];
        if (r.state != State.OPEN)       revert RoundAlreadyDrawing();
        if (block.timestamp < r.endTime) revert RoundNotEnded();
        if (r.players.length > 0)        revert RoundHasPlayers();

        r.state = State.CLOSED;
        emit RoundClosed(currentRoundId);
    }

    /**
     * @notice Débloque un round coincé en DRAWING si Chainlink VRF ne répond pas.
     *         Rembourse les participants. Réservé au owner.
     */
    function rescueStuckRound() external onlyOwner nonReentrant {
        Round storage r = rounds[currentRoundId];
        if (r.state != State.DRAWING) revert RoundNotOpen();

        address[] memory players = r.players;
        for (uint256 i = 0; i < players.length; i++) {
            _safeTransfer(players[i], ticketPrice);
        }

        r.state     = State.CLOSED;
        r.prizePool = 0;
        emit RoundClosed(currentRoundId);
    }

    // ─────────────────────────────────────────────────────────────
    //  External — participants
    // ─────────────────────────────────────────────────────────────

    /// @notice Achète un ou plusieurs tickets pour le round en cours.
    /// @dev Chaque ticket ajoute l'adresse de l'acheteur une fois dans le tableau players,
    ///      augmentant proportionnellement ses chances de gagner.
    ///      Protégé contre la réentrance via nonReentrant.
    /// @param _amount Nombre de tickets à acheter (doit être > 0).
    function buyTickets(uint256 _amount) external payable roundIsOpen nonReentrant {
        if (_amount == 0 || msg.value != ticketPrice * _amount) revert NotEnoughETH();

        Round storage r = rounds[currentRoundId];
        if (block.timestamp >= r.endTime) revert RoundNotOpen();
        if (maxPlayers > 0 && r.players.length + _amount > maxPlayers) revert TooManyPlayers();

        for (uint256 i = 0; i < _amount; i++) {
            r.players.push(msg.sender);
        }
        ticketsPerPlayer[currentRoundId][msg.sender] += _amount;
        r.prizePool += msg.value;

        emit TicketPurchased(currentRoundId, msg.sender, _amount);
    }

    /**
     * @notice Déclenche le tirage via Chainlink VRF v2.5.
     *         Callable par n'importe qui une fois le round terminé.
     */
    function triggerDraw() external nonReentrant {
        Round storage r = rounds[currentRoundId];
        if (r.state != State.OPEN)       revert RoundAlreadyDrawing();
        if (block.timestamp < r.endTime) revert RoundNotEnded();
        if (r.players.length == 0)       revert NoPlayers();

        r.state = State.DRAWING;

        uint256 requestId = i_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash:              i_keyHash,
                subId:                i_subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit:     CALLBACK_GAS_LIMIT,
                numWords:             NUM_WORDS,
                extraArgs:            VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({ nativePayment: false })
                )
            })
        );

        vrfRequestToRound[requestId] = currentRoundId;
        emit DrawTriggered(currentRoundId, requestId);
    }

    // ─────────────────────────────────────────────────────────────
    //  Chainlink VRF callback
    // ─────────────────────────────────────────────────────────────

    /// @notice Callback appelé par le coordinateur VRF après génération des nombres aléatoires.
    /// @dev Fonction interne héritée de VRFConsumerBaseV2Plus. Ne pas appeler directement.
    /// @param requestId Identifiant de la requête VRF correspondante.
    /// @param randomWords Tableau de mots aléatoires retournés par Chainlink (1 mot attendu).
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 roundId = vrfRequestToRound[requestId];
        delete vrfRequestToRound[requestId];
        _pickWinner(roundId, randomWords[0]);
    }

    // ─────────────────────────────────────────────────────────────
    //  View helpers
    // ─────────────────────────────────────────────────────────────

    /// @notice Retourne les données complètes du round en cours.
    /// @return Round struct du round actif (roundId = currentRoundId).
    function getCurrentRound() external view returns (Round memory) {
        return rounds[currentRoundId];
    }

    /// @notice Retourne la liste des adresses des participants d'un round.
    /// @dev Une adresse peut apparaître plusieurs fois si elle a acheté plusieurs tickets.
    /// @param roundId Identifiant du round à consulter.
    /// @return Tableau des adresses des joueurs.
    function getPlayers(uint256 roundId) external view returns (address[] memory) {
        return rounds[roundId].players;
    }

    /// @notice Retourne le nombre total de tickets vendus pour un round donné.
    /// @param roundId Identifiant du round à consulter.
    /// @return Nombre de tickets (= nombre d'entrées dans le tableau players).
    function getPlayerCount(uint256 roundId) external view returns (uint256) {
        return rounds[roundId].players.length;
    }

    /// @notice Retourne les données complètes d'un round passé ou en cours.
    /// @param roundId Identifiant du round à consulter.
    /// @return Round struct correspondant.
    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    /// @notice Indique si un round est actuellement actif et ouvert aux achats.
    /// @return true si le round courant est dans l'état OPEN, false sinon.
    function isRoundActive() external view returns (bool) {
        return currentRoundId > 0 && rounds[currentRoundId].state == State.OPEN;
    }

    // ─────────────────────────────────────────────────────────────
    //  Internal
    // ─────────────────────────────────────────────────────────────

    /// @dev Initialise et enregistre un nouveau round en incrémentant currentRoundId.
    function _startNewRound() internal {
        currentRoundId++;
        uint256 end = block.timestamp + durationSeconds;

        Round storage r = rounds[currentRoundId];
        r.id          = currentRoundId;
        r.startTime   = block.timestamp;
        r.endTime     = end;
        r.ticketPrice = ticketPrice;
        r.state       = State.OPEN;

        emit RoundStarted(currentRoundId, ticketPrice, end);
    }

    /// @dev Désigne le gagnant, calcule la commission, distribue les fonds et ferme le round.
    /// @param roundId Identifiant du round à clôturer.
    /// @param randomWord Nombre aléatoire fourni par Chainlink VRF pour sélectionner le gagnant.
    function _pickWinner(uint256 roundId, uint256 randomWord) internal {
        Round storage r = rounds[roundId];

        uint256 winnerIndex = randomWord % r.players.length;
        address winner      = r.players[winnerIndex];
        r.winner            = winner;

        uint256 fee   = (r.prizePool * OWNER_FEE_BPS) / 10_000;
        uint256 prize = r.prizePool - fee;

        r.state = State.CLOSED;
        emit WinnerPicked(roundId, winner, prize);
        emit RoundClosed(roundId);

        _safeTransfer(winner, prize);
        if (fee > 0) _safeTransfer(owner(), fee);
        // Pas de _startNewRound() ici — le owner démarre le suivant manuellement
    }

    /// @dev Effectue un transfert ETH sécurisé avec call de bas niveau.
    /// @param to Adresse destinataire.
    /// @param amount Montant en wei à transférer.
    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Rejette tout ETH envoyé directement. Utiliser buyTickets() à la place.
    receive() external payable {
        revert("Utilisez buyTickets()");
    }
}
