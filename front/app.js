// ═══════════════════════════════════════════
//  CONFIG — mettre l'adresse du contrat ici
// ═══════════════════════════════════════════
const CONTRACT_ADDRESS = "0x9c4C56e5b2222Ab63EDDD495B746Adee024145C5"; // ex: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
// ═══════════════════════════════════════════

// ───────────────────────────────────────────
// ABI — extrait du contrat Lottery.sol
// ───────────────────────────────────────────
const ABI = [
  "function ticketPrice() view returns (uint256)",
  "function maxPlayers() view returns (uint256)",
  "function durationSeconds() view returns (uint256)",
  "function currentRoundId() view returns (uint256)",
  "function owner() view returns (address)",
  "function OWNER_FEE_BPS() view returns (uint256)",
  "function getCurrentRound() view returns (tuple(uint256 id, uint256 startTime, uint256 endTime, uint256 ticketPrice, uint256 prizePool, address winner, uint8 state, address[] players))",
  "function getPlayers(uint256 roundId) view returns (address[])",
  "function getRound(uint256 roundId) view returns (tuple(uint256 id, uint256 startTime, uint256 endTime, uint256 ticketPrice, uint256 prizePool, address winner, uint8 state, address[] players))",
  "function buyTickets(uint256 _amount) payable",
  "function startRound()",
  "function setTicketPrice(uint256 _newPrice)",
  "function setDuration(uint256 _newDuration)",
  "function isRoundActive() view returns (bool)",
  "function triggerDraw()",
  "function skipEmptyRound()",
  "function rescueStuckRound()",
  "function transferOwnership(address newOwner)",
  "function renounceOwnership()",
  "event TicketPriceUpdated(uint256 oldPrice, uint256 newPrice)",
  "event DurationUpdated(uint256 oldDuration, uint256 newDuration)",
  "event RoundStarted(uint256 indexed roundId, uint256 ticketPrice, uint256 endTime)",
  "event TicketPurchased(uint256 indexed roundId, address indexed player, uint256 tickets)",
  "event DrawTriggered(uint256 indexed roundId, uint256 requestId)",
  "event WinnerPicked(uint256 indexed roundId, address indexed winner, uint256 prize)",
  "event RoundClosed(uint256 indexed roundId)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error RoundNotOpen()",
  "error RoundNotEnded()",
  "error RoundAlreadyOpen()",
  "error RoundAlreadyDrawing()",
  "error NotEnoughETH()",
  "error TooManyPlayers()",
  "error NoPlayers()",
  "error RoundHasPlayers()",
  "error TransferFailed()",
  "error InvalidDuration()",
  "error InvalidPrice()",
];

// ───────────────────────────────────────────
// State
// ───────────────────────────────────────────
let provider, signer, contract;
let userAddress = null;
let roundData = null;
let ticketPrice = 0n;
let qty = 1;
let timerInterval = null;
let totalDuration = 0;

// ───────────────────────────────────────────
// Init
// ───────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  if (!window.ethereum) {
    document.getElementById("alert-metamask").classList.add("show");
  }

  // Priorité : CONTRACT_ADDRESS > hash URL > saisie manuelle
  const addr = CONTRACT_ADDRESS || location.hash.replace("#", "");
  if (ethers.isAddress(addr)) {
    const input = document.getElementById("contract-address");
    input.value = addr;
    if (CONTRACT_ADDRESS) {
      input.readOnly = true;
      input.style.opacity = "0.5";
      input.style.cursor  = "not-allowed";
    }
  }
});

// ───────────────────────────────────────────
// Wallet
// ───────────────────────────────────────────
async function connectWallet() {
  if (!window.ethereum) {
    showAlert("err", "MetaMask non détecté.");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    const network = await provider.getNetwork();
    document.getElementById("wallet-dot").className = "dot on";
    document.getElementById("btn-connect-label").textContent = fmt(userAddress);
    document.getElementById("btn-connect").className = "connected";
    document.getElementById("network-label").textContent =
      `Réseau: ${network.name} (${network.chainId})`;

    addLog("🔌", `Wallet connecté: ${fmt(userAddress)}`);
    hideAlert("err");

    // Charger automatiquement si CONTRACT_ADDRESS défini, sinon depuis le champ
    const addr = CONTRACT_ADDRESS || document.getElementById("contract-address").value.trim();
    if (ethers.isAddress(addr)) loadContract();

    // Écoute les changements de compte
    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());
  } catch (e) {
    const msg = e.code === 4001 || e.code === "ACTION_REJECTED"
      ? "Connexion refusée par l'utilisateur."
      : "Impossible de se connecter à MetaMask : " + (e.message || "erreur inconnue");
    showAlert("err", msg);
    document.getElementById("wallet-dot").className = "dot err";
  }
}

// ───────────────────────────────────────────
// Contract
// ───────────────────────────────────────────
async function loadContract() {
  const addr = CONTRACT_ADDRESS || document.getElementById("contract-address").value.trim();
  if (!ethers.isAddress(addr)) {
    showAlert("err", "Adresse invalide.");
    return;
  }
  if (!provider) {
    showAlert("warn", "Connectez MetaMask d'abord.");
    return;
  }

  try {
    const code = await provider.getCode(addr);
    if (code === "0x") {
      const network = await provider.getNetwork();
      showAlert("err", `Aucun contrat trouvé à cette adresse sur ${network.name} (chainId ${network.chainId}). Vérifiez que MetaMask est sur le bon réseau et que le contrat est bien déployé.`);
      return;
    }

    const signerOrProvider = signer || provider;
    contract = new ethers.Contract(addr, ABI, signerOrProvider);

    // Lecture des paramètres immuables
    ticketPrice = await contract.ticketPrice();
    const owner = await contract.owner();
    const feeBps = await contract.OWNER_FEE_BPS();

    document.getElementById("owner-addr").textContent = owner;
    document.getElementById("fee-bps").textContent =
      (Number(feeBps) / 100).toFixed(0) + "%";
    document.getElementById("s-price").textContent = parseFloat(
      ethers.formatEther(ticketPrice),
    ).toFixed(4);

    updateCost();
    await refreshData();
    subscribeEvents();
    enableButtons(true);
    showAlert("ok", `Contrat chargé : ${fmt(addr)}`);
    setTimeout(() => hideAlert("ok"), 3000);
  } catch (e) {
    showAlert("err", "Impossible de charger le contrat : " + parseError(e));
    console.error(e);
  }
}

async function refreshData() {
  if (!contract) return;
  try {
    [roundData, ticketPrice] = await Promise.all([
      contract.getCurrentRound(),
      contract.ticketPrice(),
    ]);
    document.getElementById("s-price").textContent =
      parseFloat(ethers.formatEther(ticketPrice)).toFixed(4);
    updateCost();
    renderRound(roundData);
    await renderPlayers(roundData);
  } catch (e) {
    showAlert("err", "Impossible de lire les données du contrat : " + parseError(e));
  }
}

function enableButtons(on) {
  ["btn-buy", "btn-start", "btn-draw", "btn-skip", "btn-rescue", "btn-refresh", "btn-set-price", "btn-set-duration"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

// ───────────────────────────────────────────
// Render
// ───────────────────────────────────────────
function renderRound(r) {
  const stateLabel = ["Ouvert", "Tirage…", "Terminé"];
  const stateClass = ["badge-open", "badge-draw", "badge-closed"];
  const s = Number(r.state);

  // Aucun round démarré (id == 0)
  if (r.id === 0n || r.id === 0) {
    document.getElementById("r-id").textContent = "—";
    document.getElementById("s-round").textContent = "—";
    document.getElementById("s-state").textContent = "En attente";
    document.getElementById("s-pool").textContent = "0.0000";
    document.getElementById("s-players").textContent = "0";
    document.getElementById("r-badge").className = "badge badge-closed";
    document.getElementById("r-badge").innerHTML = '<span class="badge-dot"></span> En attente';
    document.getElementById("r-timer").textContent = "Aucun round actif";
    document.getElementById("r-progress").style.width = "0%";
    document.getElementById("r-start").textContent = "—";
    document.getElementById("r-end").textContent = "—";
    if (timerInterval) clearInterval(timerInterval);
    return;
  }

  document.getElementById("r-id").textContent = "#" + r.id.toString();
  document.getElementById("s-round").textContent = "#" + r.id.toString();
  document.getElementById("s-state").textContent = stateLabel[s];
  document.getElementById("s-pool").textContent = parseFloat(
    ethers.formatEther(r.prizePool),
  ).toFixed(4);
  document.getElementById("s-players").textContent = r.players.length;

  // Badge
  const badge = document.getElementById("r-badge");
  badge.className = "badge " + stateClass[s];
  badge.innerHTML = '<span class="badge-dot"></span> ' + stateLabel[s];

  // Dates
  const start = Number(r.startTime);
  const end = Number(r.endTime);
  totalDuration = end - start;

  document.getElementById("r-start").textContent = "Début " + fmtDate(start);
  document.getElementById("r-end").textContent = "Fin " + fmtDate(end);

  // Timer
  if (timerInterval) clearInterval(timerInterval);
  if (s === 0) {
    timerInterval = setInterval(() => tickTimer(end, start), 1000);
    tickTimer(end, start);
  } else {
    document.getElementById("r-timer").textContent =
      s === 2 ? "Terminé" : "⏳ Attente Chainlink VRF…";
    document.getElementById("r-progress").style.width = s === 2 ? "0%" : "100%";
  }

  updateOdds(r.players.length);
}

function tickTimer(end, start) {
  const now = Math.floor(Date.now() / 1000);
  const left = Math.max(0, end - now);
  const elapsed = Math.max(0, now - start);

  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const parts = [];
  if (h > 0) parts.push(h + "h");
  if (m > 0 || h > 0) parts.push(String(m).padStart(2, "0") + "m");
  parts.push(String(s).padStart(2, "0") + "s");

  document.getElementById("r-timer").textContent = parts.join(" ");
  const pct =
    totalDuration > 0 ? Math.max(0, (1 - elapsed / totalDuration) * 100) : 0;
  document.getElementById("r-progress").style.width = pct.toFixed(1) + "%";

  if (left === 0) {
    clearInterval(timerInterval);
    refreshData();
  }
}

async function renderPlayers(r) {
  const el = document.getElementById("players-list");
  if (!r || r.players.length === 0) {
    el.innerHTML =
      '<div style="font-size:12px;font-family:var(--mono);color:var(--text3);padding:20px 0;text-align:center;">Aucun participant</div>';
    return;
  }

  const counts = {};
  r.players.forEach((p) => {
    counts[p] = (counts[p] || 0) + 1;
  });
  const total = r.players.length;
  const unique = Object.keys(counts);

  el.innerHTML = unique
    .map((addr) => {
      const n = counts[addr];
      const pct = ((n / total) * 100).toFixed(1);
      const isMe =
        userAddress && addr.toLowerCase() === userAddress.toLowerCase();
      return `<div class="player-row">
      <div class="avatar">${addr.slice(2, 4).toUpperCase()}</div>
      <span class="p-addr">${fmt(addr)}</span>
      ${isMe ? '<span class="p-me">vous</span>' : ""}
      <span class="p-tickets">${n}t</span>
      <span class="p-pct" style="${isMe ? "color:var(--accent)" : ""}">${pct}%</span>
    </div>`;
    })
    .join("");
}

// ───────────────────────────────────────────
// Buy tickets
// ───────────────────────────────────────────
function changeQty(d) {
  qty = Math.max(1, Math.min(50, qty + d));
  document.getElementById("qty-val").textContent = qty;
  updateCost();
}

function updateCost() {
  if (ticketPrice === 0n) {
    document.getElementById("cost-total").textContent = "— ETH";
    return;
  }
  const total = parseFloat(ethers.formatEther(ticketPrice * BigInt(qty)));
  document.getElementById("cost-total").textContent = total.toFixed(4) + " ETH";
  updateOdds(roundData ? roundData.players.length : 0);
}

function updateOdds(current) {
  if (!ticketPrice || ticketPrice === 0n) return;
  const newTotal = current + qty;
  const pct = ((qty / newTotal) * 100).toFixed(1);
  document.getElementById("odds").textContent =
    `${qty} / ${newTotal} tickets → ~${pct}% de chance`;
}

async function buyTickets() {
  if (!contract || !signer) {
    showAlert("warn", "Connectez MetaMask et chargez le contrat.");
    return;
  }
  const btn = document.getElementById("btn-buy");
  const status = document.getElementById("buy-status");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>En attente de signature…';

  try {
    const value = ticketPrice * BigInt(qty);
    const tx = await contract.buyTickets(qty, { value });
    status.textContent = "Tx envoyée: " + fmt(tx.hash);
    addLog(
      "🎟",
      `${qty} ticket(s) achetés — <a class="tx-link" href="${txUrl(tx.hash)}" target="_blank">${fmt(tx.hash)}</a>`,
    );

    btn.innerHTML = '<span class="spinner"></span>Confirmation…';
    await tx.wait();

    showToast("✓ " + qty + " ticket(s) achetés !");
    showAlert("ok", "✓ Transaction confirmée !");
    setTimeout(() => hideAlert("ok"), 3000);

    await refreshData();
  } catch (e) {
    const msg = parseError(e);
    showAlert("err", "Achat échoué : " + msg);
    addLog("❌", "Achat échoué : " + msg);
  } finally {
    btn.disabled = false;
    btn.textContent = "Acheter des tickets";
    status.textContent = "";
  }
}

// ───────────────────────────────────────────
// Admin actions
// ───────────────────────────────────────────
async function startRound() {
  await adminAction("startRound", [], "▶ Round démarré");
}
async function triggerDraw() {
  await adminAction("triggerDraw", [], "⚡ Tirage déclenché");
}
async function skipRound() {
  await adminAction("skipEmptyRound", [], "↷ Round passé");
}
async function rescueRound() {
  await adminAction("rescueStuckRound", [], "🚨 Round débloqué — participants remboursés");
}
async function updateTicketPrice() {
  const input = document.getElementById("new-price-input");
  const val   = input.value.trim();
  if (!val || isNaN(val) || Number(val) <= 0) {
    showAlert("err", "Prix invalide.");
    return;
  }
  const wei = ethers.parseEther(val);
  await adminAction("setTicketPrice", [wei], `Prix mis à jour : ${val} ETH`);
  input.value = "";
}

async function updateDuration() {
  const input = document.getElementById("new-duration-input");
  const val   = parseInt(input.value.trim());
  if (!val || val <= 0) {
    showAlert("err", "Durée invalide.");
    return;
  }
  await adminAction("setDuration", [val], `Durée mise à jour : ${val}s`);
  input.value = "";
}

async function adminAction(method, args, label) {
  if (!contract || !signer) {
    showAlert("warn", "Connectez MetaMask.");
    return;
  }
  const btnId = { startRound: "start", triggerDraw: "draw", skipEmptyRound: "skip", rescueStuckRound: "rescue", setTicketPrice: "set-price", setDuration: "set-duration" };
  const btn = document.getElementById("btn-" + (btnId[method] || "draw"));
  btn.disabled = true;
  const origText = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>' + origText;

  try {
    const tx = await contract[method](...args);
    addLog(
      "📤",
      `${label} — <a class="tx-link" href="${txUrl(tx.hash)}" target="_blank">${fmt(tx.hash)}</a>`,
    );
    await tx.wait();
    showToast("✓ " + label);
    await refreshData();
  } catch (e) {
    const msg = parseError(e);
    showAlert("err", label + " échoué : " + msg);
    addLog("❌", label + " échoué : " + msg);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ───────────────────────────────────────────
// Events (on-chain listeners)
// ───────────────────────────────────────────
function showWinnerBanner(roundId, winner, prize) {
  document.getElementById("w-round").textContent = roundId;
  document.getElementById("w-addr").textContent = winner;
  document.getElementById("w-prize").textContent = prize;
  document.getElementById("winner-box").className = "winner-box show";
}

function subscribeEvents() {
  if (!contract) return;

  contract.on("RoundStarted", (id, price, endTime) => {
    addLog(
      "🚀",
      `Round #${id} démarré — prix: ${ethers.formatEther(price)} ETH`,
    );
    refreshData();
  });

  contract.on("TicketPurchased", (roundId, player, tickets) => {
    addLog(
      "🎟",
      `${fmt(player)} a acheté ${tickets} ticket(s) — Round #${roundId}`,
    );
    refreshData();
  });

  contract.on("DrawTriggered", (roundId, requestId) => {
    addLog("⚡", `Tirage déclenché — Round #${roundId} (requestId: ${requestId})`);
    addLog("🔗", "En attente de la réponse Chainlink VRF…");
    refreshData();
  });

  contract.on("WinnerPicked", (roundId, winner, prize) => {
    const p = parseFloat(ethers.formatEther(prize)).toFixed(4);
    addLog("🏆", `Gagnant Round #${roundId}: ${fmt(winner)} — ${p} ETH`);
    showToast("🏆 Gagnant: " + fmt(winner) + " (" + p + " ETH)");
    // Afficher la bannière depuis l'event avant que refreshData() charge le nouveau round
    showWinnerBanner(roundId.toString(), winner, p);
    refreshData();
  });

  contract.on("RoundClosed", (roundId) => {
    addLog("🔒", `Round #${roundId} clôturé — en attente du démarrage du prochain round`);
    refreshData();
  });

  contract.on("TicketPriceUpdated", (oldPrice, newPrice) => {
    const p = parseFloat(ethers.formatEther(newPrice)).toFixed(4);
    addLog("💰", `Prix du ticket mis à jour : ${p} ETH`);
    refreshData();
  });

  contract.on("DurationUpdated", (oldDuration, newDuration) => {
    addLog("⏱", `Durée du round mise à jour : ${newDuration}s`);
  });
}

// ───────────────────────────────────────────
// UI helpers
// ───────────────────────────────────────────
function addLog(icon, msg) {
  const log = document.getElementById("event-log");
  const now = new Date().toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const item = document.createElement("div");
  item.className = "log-item animate-in";
  item.innerHTML = `<span class="log-icon">${icon}</span><span style="flex:1">${msg}</span><span class="log-time">${now}</span>`;
  log.insertBefore(item, log.firstChild);
  if (log.children.length > 10) log.removeChild(log.lastChild);
}

function showAlert(type, msg) {
  hideAlert("warn");
  hideAlert("err");
  hideAlert("ok");
  const el = document.getElementById("alert-" + type);
  if (el) {
    el.textContent = msg;
    el.classList.add("show");
  }
}
function hideAlert(type) {
  const el = document.getElementById("alert-" + type);
  if (el) el.classList.remove("show");
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

const CONTRACT_ERRORS = {
  RoundNotOpen:               "Aucun round actif — le owner doit démarrer un round.",
  RoundNotEnded:              "Le round n'est pas encore terminé — attendez la fin du timer.",
  RoundAlreadyOpen:           "Un round est déjà en cours.",
  RoundAlreadyDrawing:        "Un tirage est déjà en cours pour ce round.",
  NotEnoughETH:               "Montant incorrect. Vérifiez le nombre de tickets et le prix.",
  TooManyPlayers:             "Capacité maximale du round atteinte.",
  NoPlayers:                  "Aucun participant — impossible de tirer au sort.",
  RoundHasPlayers:            "Des joueurs ont participé, utilisez triggerDraw() pour tirer au sort.",
  TransferFailed:             "Échec du transfert ETH vers le gagnant.",
  InvalidDuration:            "Durée du round invalide (doit être supérieure à 0).",
  InvalidPrice:               "Prix du ticket invalide (doit être supérieur à 0).",
  OwnableUnauthorizedAccount: "Action réservée au propriétaire du contrat.",
  OwnableInvalidOwner:        "Adresse du propriétaire invalide.",
};

function parseError(e) {
  // 1. Nom d'erreur décodé par ethers
  const name = e.errorName || e.revert?.name;
  if (name && CONTRACT_ERRORS[name]) return CONTRACT_ERRORS[name];
  if (name) return name;

  // 2. Décodage manuel du selector (estimateGas, MetaMask)
  const data = e.data ?? e.error?.data;
  if (data && data !== "0x" && contract) {
    try {
      const decoded = contract.interface.parseError(data);
      if (decoded) return CONTRACT_ERRORS[decoded.name] ?? decoded.name;
    } catch {}
  }

  // 3. Erreurs MetaMask / ethers connues
  const code = e.code || e.error?.code;
  const msg  = e.message || "";

  if (code === 4001 || code === "ACTION_REJECTED" || msg.includes("user rejected"))
    return "Transaction annulée par l'utilisateur.";
  if (code === "INSUFFICIENT_FUNDS" || msg.includes("insufficient funds"))
    return "Fonds ETH insuffisants dans votre wallet.";
  if (code === "NETWORK_ERROR" || msg.includes("network"))
    return "Erreur réseau — vérifiez votre connexion et le réseau MetaMask.";
  if (msg.includes("nonce"))
    return "Erreur de nonce — réinitialisez votre compte MetaMask (Paramètres → Avancé → Réinitialiser).";

  // 4. Erreurs connues du VRF Coordinator Chainlink
  const VRF_ERRORS = {
    "0x79bfd401": "Contrat non autorisé sur l'abonnement VRF — ajoutez ce contrat comme consumer sur vrf.chain.link",
    "0x8f9a2d5b": "Abonnement VRF invalide — vérifiez le subscription ID",
    "0x356680b7": "Balance LINK insuffisante sur l'abonnement VRF — rechargez sur vrf.chain.link",
  };
  if (data && VRF_ERRORS[data.slice(0, 10)])
    return VRF_ERRORS[data.slice(0, 10)];

  // 5. data=null — le RPC n'a pas retourné les données de revert
  if (data === null || msg.includes("missing revert data"))
    return "Transaction refusée par le contrat. Causes possibles : vous n'êtes pas le owner, ou le round n'est pas dans le bon état.";

  // 5. Raison lisible
  if (e.reason) return e.reason;
  const match = msg.match(/reverted with reason string '(.+?)'/);
  if (match) return match[1];

  return msg.slice(0, 120) || "Erreur inconnue.";
}

function fmt(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function txUrl(hash) {
  // Adapte l'URL selon le réseau (Ethereum mainnet par défaut)
  if (!provider) return "#";
  try {
    const chainId = provider._network?.chainId;
    if (chainId === 11155111n) return `https://sepolia.etherscan.io/tx/${hash}`;
    if (chainId === 80001n) return `https://mumbai.polygonscan.com/tx/${hash}`;
    if (chainId === 137n) return `https://polygonscan.com/tx/${hash}`;
    return `https://etherscan.io/tx/${hash}`;
  } catch {
    return "#";
  }
}
