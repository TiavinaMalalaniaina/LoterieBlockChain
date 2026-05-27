const { ethers } = require("hardhat");

async function main() {
  const ticketPrice = ethers.parseEther("0.01");
  const maxPlayers = 0;       // illimité
  const durationSecs = 60;    // 1 minute

  const Lottery = await ethers.getContractFactory("Lottery");
  const lottery = await Lottery.deploy(ticketPrice, maxPlayers, durationSecs);
  await lottery.waitForDeployment();

  const address = await lottery.getAddress();
  console.log("Contrat déployé :", address);
  console.log(`\nOuvre index.html et colle cette adresse :\n  ${address}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
