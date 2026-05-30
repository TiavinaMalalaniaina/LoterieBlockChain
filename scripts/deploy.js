const { ethers, network } = require("hardhat");

// ─── Config Sepolia VRF v2.5 ──────────────────────────────────────
const SEPOLIA_VRF_COORDINATOR = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B";
const SEPOLIA_KEY_HASH        = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
// ─────────────────────────────────────────────────────────────────

async function main() {
  const isLocal = network.name === "localhost" || network.name === "hardhat";

  let vrfCoordinator, keyHash, subscriptionId;

  if (isLocal) {
    // Déploiement du mock VRF pour les tests locaux
    console.log("Réseau local détecté — déploiement du mock VRF...");
    const VRFMock = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const vrfMock = await VRFMock.deploy();
    await vrfMock.waitForDeployment();
    vrfCoordinator = await vrfMock.getAddress();
    keyHash = SEPOLIA_KEY_HASH; // valeur quelconque en local

    // Créer et financer un abonnement
    const tx      = await vrfMock.createSubscription();
    const receipt = await tx.wait();
    subscriptionId = receipt.logs[0].args[0];
    await vrfMock.fundSubscription(subscriptionId, ethers.parseEther("10"));
    console.log("Mock VRF     :", vrfCoordinator);
    console.log("Subscription :", subscriptionId.toString());
  } else {
    // Sepolia — lire les vars d'environnement
    if (!process.env.VRF_SUBSCRIPTION_ID) {
      throw new Error("VRF_SUBSCRIPTION_ID manquant dans .env\nCréez un abonnement sur https://vrf.chain.link");
    }
    vrfCoordinator = SEPOLIA_VRF_COORDINATOR;
    keyHash        = SEPOLIA_KEY_HASH;
    subscriptionId = process.env.VRF_SUBSCRIPTION_ID; // string → le contrat reçoit un uint256
  }

  // Déploiement du contrat
  const Lottery = await ethers.getContractFactory("Lottery");
  const lottery  = await Lottery.deploy(
    ethers.parseEther("0.01"), // ticketPrice
    0,                          // maxPlayers (illimité)
    60,                         // durationSeconds
    vrfCoordinator,
    keyHash,
    subscriptionId
  );
  await lottery.waitForDeployment();
  const lotteryAddress = await lottery.getAddress();

  if (isLocal) {
    // Enregistrer le contrat comme consumer sur le mock
    const VRFMock = await ethers.getContractFactory("VRFCoordinatorV2Mock");
    const vrfMock = VRFMock.attach(vrfCoordinator);
    await vrfMock.addConsumer(subscriptionId, lotteryAddress);
    console.log("Consumer enregistré sur le mock");
  } else {
    console.log("\n⚠️  N'oubliez pas d'ajouter le contrat comme consumer sur https://vrf.chain.link");
    console.log("   Subscription ID :", process.env.VRF_SUBSCRIPTION_ID);
    console.log("   Consumer        :", lotteryAddress);
  }

  console.log("\nContrat déployé :", lotteryAddress);
  console.log(`\nOuvre front/app.js et mets :\n  const CONTRACT_ADDRESS = "${lotteryAddress}";`);
}

main().catch((e) => { console.error(e); process.exit(1); });
