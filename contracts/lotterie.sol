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
 */
contract Lottery is VRFConsumerBaseV2Plus, ReentrancyGuard {

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
    //  Chainlink VRF v2.5
    // ─────────────────────────────────────────────────────────────

    IVRFCoordinatorV2Plus private immutable i_vrfCoordinator;
    bytes32  private immutable i_keyHash;
    uint256  private immutable i_subscriptionId;
    uint32   private constant  CALLBACK_GAS_LIMIT    = 100_000;
    uint16   private constant  REQUEST_CONFIRMATIONS  = 3;
    uint32   private constant  NUM_WORDS              = 1;

    mapping(uint256 => uint256) public vrfRequestToRound;

    // ─────────────────────────────────────────────────────────────
    //  Storage
    // ─────────────────────────────────────────────────────────────

    uint256 public ticketPrice;            // modifiable par le owner hors round
    uint256 public immutable maxPlayers;
    uint256 public durationSeconds;        // modifiable par le owner hors round
    uint256 public constant  OWNER_FEE_BPS = 500;

    uint256 public currentRoundId;        // 0 = aucun round démarré
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public ticketsPerPlayer;

    // ─────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────

    event RoundStarted(uint256 indexed roundId, uint256 ticketPrice, uint256 endTime);
    event TicketPurchased(uint256 indexed roundId, address indexed player, uint256 tickets);
    event DrawTriggered(uint256 indexed roundId, uint256 requestId);
    event WinnerPicked(uint256 indexed roundId, address indexed winner, uint256 prize);
    event RoundClosed(uint256 indexed roundId);
    event TicketPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event DurationUpdated(uint256 oldDuration, uint256 newDuration);

    // ─────────────────────────────────────────────────────────────
    //  Errors
    // ─────────────────────────────────────────────────────────────

    error RoundNotOpen();
    error RoundNotEnded();
    error RoundAlreadyOpen();
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

    modifier roundIsOpen() {
        if (currentRoundId == 0 || rounds[currentRoundId].state != State.OPEN)
            revert RoundNotOpen();
        _;
    }

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
     */
    function setTicketPrice(uint256 _newPrice) external onlyOwner noActiveRound {
        if (_newPrice == 0) revert InvalidPrice();
        emit TicketPriceUpdated(ticketPrice, _newPrice);
        ticketPrice = _newPrice;
    }

    function setDuration(uint256 _newDuration) external onlyOwner noActiveRound {
        if (_newDuration == 0) revert InvalidDuration();
        emit DurationUpdated(durationSeconds, _newDuration);
        durationSeconds = _newDuration;
    }

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

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 roundId = vrfRequestToRound[requestId];
        delete vrfRequestToRound[requestId];
        _pickWinner(roundId, randomWords[0]);
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

    function isRoundActive() external view returns (bool) {
        return currentRoundId > 0 && rounds[currentRoundId].state == State.OPEN;
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

        uint256 fee   = (r.prizePool * OWNER_FEE_BPS) / 10_000;
        uint256 prize = r.prizePool - fee;

        r.state = State.CLOSED;
        emit WinnerPicked(roundId, winner, prize);
        emit RoundClosed(roundId);

        _safeTransfer(winner, prize);
        if (fee > 0) _safeTransfer(owner(), fee);
        // Pas de _startNewRound() ici — le owner démarre le suivant manuellement
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {
        revert("Utilisez buyTickets()");
    }
}
