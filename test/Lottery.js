const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Lottery", function () {
  let lottery;
  let owner;
  let player1;
  let player2;

  const ticketPrice = ethers.parseEther("0.01");
  const duration = 60; // 1 minute

  beforeEach(async function () {
    [owner, player1, player2] = await ethers.getSigners();

    const Lottery = await ethers.getContractFactory("Lottery");
    lottery = await Lottery.deploy(ticketPrice, 0, duration);
    await lottery.waitForDeployment();
  });

  // 1. INIT
  it("should start with round 1 open", async function () {
    const round = await lottery.getCurrentRound();

    expect(round.id).to.equal(1n);
    expect(round.state).to.equal(0n); // OPEN
  });

  // 2. BUY TICKETS
  it("should allow buying tickets", async function () {
    await lottery.connect(player1).buyTickets(2, {
      value: ticketPrice * 2n,
    });

    const players = await lottery.getPlayers(1);

    expect(players.length).to.equal(2);
  });

  it("should not allow wrong ETH amount", async function () {
    await expect(
      lottery.connect(player1).buyTickets(2, {
        value: ticketPrice, // faux montant
      })
    ).to.be.revertedWithCustomError(lottery, "NotEnoughETH");
  });

  // 3. DRAW
  it("should allow draw after time passes", async function () {
    await lottery.connect(player1).buyTickets(1, {
      value: ticketPrice,
    });

    // avancer le temps
    await ethers.provider.send("evm_increaseTime", [70]);
    await ethers.provider.send("evm_mine");

    await expect(lottery.triggerDraw()).to.emit(
      lottery,
      "WinnerPicked"
    );
  });

  it("should fairly distribute winner (2 players)", async function () {
    await lottery.connect(player1).buyTickets(1, { value: ticketPrice });
    await lottery.connect(player2).buyTickets(1, { value: ticketPrice });

    await ethers.provider.send("evm_increaseTime", [70]);
    await ethers.provider.send("evm_mine");

    await lottery.triggerDraw();

    const round = await lottery.getCurrentRound();

    expect(round.state).to.equal(2n); // CLOSED
    expect(round.winner).to.not.equal(ethers.ZeroAddress);
  });

  // 4. OWNER RESTRICTION
  it("only owner can skip empty round", async function () {
    await expect(
      lottery.connect(player1).skipEmptyRound()
    ).to.be.revertedWithCustomError(
      lottery,
      "OwnableUnauthorizedAccount"
    );
  });
});