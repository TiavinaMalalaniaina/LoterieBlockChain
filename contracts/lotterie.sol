// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title Lottery
 * @notice Loterie on-chain décentralisée avec tirage au sort via Chainlink VRF
 *         (version simplifiée utilisant un pseudo-aléatoire pour les tests locaux)
 * @dev Pour la production, remplacer _requestRandomness() par Chainlink VRF v2
 */
contract Lottery {

    // ─────────────────────────────────────────────────────────────
    //  Types
    // ─────────────────────────────────────────────────────────────

    enum State { OPEN, DRAWING, CLOSED }

    struct Round {
        uint256 id;
        uint256 startTime;
        uint256 endTime;
        uint256 ticketPrice;
        uint256 prizePool;
        address winner;
        State   state;
        address[] players;
    }

    // ─────────────────────────────────────────────────────────────
    //  Storage
    // ─────────────────────────────────────────────────────────────

    address public immutable owner;
    uint256 public immutable ticketPrice;        // prix en wei
    uint256 public immutable maxPlayers;         // 0 = illimité
    uint256 public immutable durationSeconds;    // durée d'un round
    uint256 public constant OWNER_FEE_BPS = 500; // 5 % pour le gestionnaire

    uint256 public currentRoundId;
    mapping(uint256 => Round)    public rounds;
    mapping(uint256 => mapping(address => uint256)) public ticketsPerPlayer; // roundId → player → nb tickets

    // ─────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────

    event RoundStarted(uint256 indexed roundId, uint256 ticketPrice, uint256 endTime);
    event TicketPurchased(uint256 indexed roundId, address indexed player, uint256 tickets);
    event DrawTriggered(uint256 indexed roundId);
    event WinnerPicked(uint256 indexed roundId, address indexed winner, uint256 prize);
    event RoundClosed(uint256 indexed roundId);

    // ─────────────────────────────────────────────────────────────
    //  Errors (Solidity custom errors — gas efficient)
    // ─────────────────────────────────────────────────────────────

    error NotOwner();
    error RoundNotOpen();
    error RoundNotEnded();
    error RoundAlreadyDrawing();
    error NotEnoughETH();
    error TooManyPlayers();
    error NoPlayers();
    error RoundHasPlayers();
    error TransferFailed();
    error InvalidDuration();
    error InvalidPrice();

    // ─────────────────────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier roundIsOpen() {
        if (rounds[currentRoundId].state != State.OPEN) revert RoundNotOpen();
        _;
    }

    // ─────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────

    /**
     * @param _ticketPrice   Prix d'un ticket en wei (ex: 0.01 ether)
     * @param _maxPlayers    Nombre max de participants (0 = illimité)
     * @param _durationSecs  Durée d'un round en secondes
     */
    constructor(
        uint256 _ticketPrice,
        uint256 _maxPlayers,
        uint256 _durationSecs
    ) {
        if (_ticketPrice == 0)   revert InvalidPrice();
        if (_durationSecs == 0)  revert InvalidDuration();

        owner           = msg.sender;
        ticketPrice     = _ticketPrice;
        maxPlayers      = _maxPlayers;
        durationSeconds = _durationSecs;

        _startNewRound();
    }

    // ─────────────────────────────────────────────────────────────
    //  External — participants
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Achète un ou plusieurs tickets pour le round en cours.
     *         Envoyer exactement ticketPrice * nombre de tickets en ETH.
     * @param _amount Nombre de tickets à acheter
     */
    function buyTickets(uint256 _amount) external payable roundIsOpen {
        if (_amount == 0 || msg.value != ticketPrice * _amount) revert NotEnoughETH();

        Round storage r = rounds[currentRoundId];

        // Vérification du round encore ouvert dans le temps
        if (block.timestamp >= r.endTime) revert RoundNotOpen();

        // Vérification capacité max
        if (maxPlayers > 0 && r.players.length + _amount > maxPlayers)
            revert TooManyPlayers();

        // Enregistrement
        for (uint256 i = 0; i < _amount; i++) {
            r.players.push(msg.sender);
        }
        ticketsPerPlayer[currentRoundId][msg.sender] += _amount;
        r.prizePool += msg.value;

        emit TicketPurchased(currentRoundId, msg.sender, _amount);
    }

    // ─────────────────────────────────────────────────────────────
    //  External — owner / keeper
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Déclenche le tirage du round courant.
     *         Peut être appelé par n'importe qui une fois le round terminé.
     */
    function triggerDraw() external {
        Round storage r = rounds[currentRoundId];

        if (r.state != State.OPEN)              revert RoundAlreadyDrawing();
        if (block.timestamp < r.endTime)        revert RoundNotEnded();
        if (r.players.length == 0)              revert NoPlayers();

        r.state = State.DRAWING;
        emit DrawTriggered(currentRoundId);

        // ⚠️  En production : utiliser Chainlink VRF ici et traiter dans fulfillRandomWords()
        _pickWinner(currentRoundId, _pseudoRandom(currentRoundId));
    }

    /**
     * @notice Si personne n'a participé, le owner peut clôturer et démarrer un nouveau round.
     */
    function skipEmptyRound() external onlyOwner {
        Round storage r = rounds[currentRoundId];
        if (r.state != State.OPEN)        revert RoundAlreadyDrawing();
        if (block.timestamp < r.endTime) revert RoundNotEnded();
        if (r.players.length > 0)        revert RoundHasPlayers();

        r.state = State.CLOSED;
        emit RoundClosed(currentRoundId);
        _startNewRound();
    }

    // ─────────────────────────────────────────────────────────────
    //  View helpers
    // ─────────────────────────────────────────────────────────────

    function getCurrentRound() external view returns (Round memory) {
        return rounds[currentRoundId];
    }

    function getPlayers(uint256 roundId) external view returns (address[] memory) {
        return rounds[roundId].players;
    }

    function getPlayerCount(uint256 roundId) external view returns (uint256) {
        return rounds[roundId].players.length;
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    // ─────────────────────────────────────────────────────────────
    //  Internal
    // ─────────────────────────────────────────────────────────────

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

    function _pickWinner(uint256 roundId, uint256 randomWord) internal {
        Round storage r = rounds[roundId];

        uint256 winnerIndex = randomWord % r.players.length;
        address winner      = r.players[winnerIndex];
        r.winner            = winner;

        // Calcul des frais et du prix net
        uint256 fee   = (r.prizePool * OWNER_FEE_BPS) / 10_000;
        uint256 prize = r.prizePool - fee;

        r.state = State.CLOSED;
        emit WinnerPicked(roundId, winner, prize);
        emit RoundClosed(roundId);

        // Transferts
        _safeTransfer(winner, prize);
        if (fee > 0) _safeTransfer(owner, fee);

        // Démarrage automatique du round suivant
        _startNewRound();
    }

    /**
     * @dev Pseudo-aléatoire UNIQUEMENT pour tests/démo.
     *      NE PAS utiliser en production : manipulable par les mineurs.
     *      → Remplacer par Chainlink VRF v2 en production.
     */
    function _pseudoRandom(uint256 roundId) internal view returns (uint256) {
        return uint256(
            keccak256(
                abi.encodePacked(
                    blockhash(block.number - 1),
                    block.timestamp,
                    rounds[roundId].players.length,
                    roundId
                )
            )
        );
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ─────────────────────────────────────────────────────────────
    //  Fallback — refuse les ETH directs pour éviter les accidents
    // ─────────────────────────────────────────────────────────────

    receive() external payable {
        revert("Utilisez buyTickets()");
    }
}
