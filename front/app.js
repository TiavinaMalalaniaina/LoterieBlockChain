// ═══════════════════════════════════════════
//  CONFIG — mettre l'adresse du contrat ici
// ═══════════════════════════════════════════
const CONTRACT_ADDRESS = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707"; // ex: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
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
  "function triggerDraw()",
  "function skipEmptyRound()",
  "function transferOwnership(address newOwner)",
  "function renounceOwnership()",
  "event RoundStarted(uint256 indexed roundId, uint256 ticketPrice, uint256 endTime)",
  "event TicketPurchased(uint256 indexed roundId, address indexed player, uint256 tickets)",
  "event DrawTriggered(uint256 indexed roundId)",
  "event WinnerPicked(uint256 indexed roundId, address indexed winner, uint256 prize)",
  "event RoundClosed(uint256 indexed roundId)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error RoundNotOpen()",
  "error RoundNotEnded()",
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
    showAlert("err", "Connexion refusée: " + e.message);
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
      showAlert("err", `Aucun contrat à cette adresse sur le réseau ${network.name} (chainId ${network.chainId}). Vérifie que le nœud Hardhat tourne et que MetaMask est sur Hardhat Local (31337).`);
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
    showAlert("err", "Erreur chargement contrat: " + parseError(e));
    console.error(e);
  }
}

async function refreshData() {
  if (!contract) return;
  try {
    roundData = await contract.getCurrentRound();
    renderRound(roundData);
    await renderPlayers(roundData);
  } catch (e) {
    showAlert("err", "Erreur lecture: " + parseError(e));
  }
}

function enableButtons(on) {
  ["btn-buy", "btn-draw", "btn-skip", "btn-refresh"].forEach((id) => {
    document.getElementById(id).disabled = !on;
  });
}

// ───────────────────────────────────────────
// Render
// ───────────────────────────────────────────
function renderRound(r) {
  const stateMap = ["OPEN", "DRAWING", "CLOSED"];
  const stateLabel = ["Ouvert", "Tirage…", "Terminé"];
  const stateClass = ["badge-open", "badge-draw", "badge-closed"];
  const s = Number(r.state);

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
      s === 2 ? "Terminé" : "En cours…";
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
    showAlert("err", "Erreur: " + msg);
    addLog("❌", "Achat échoué: " + msg);
  } finally {
    btn.disabled = false;
    btn.textContent = "Acheter des tickets";
    status.textContent = "";
  }
}

// ───────────────────────────────────────────
// Admin actions
// ───────────────────────────────────────────
async function triggerDraw() {
  await adminAction("triggerDraw", [], "⚡ Tirage déclenché");
}
async function skipRound() {
  await adminAction("skipEmptyRound", [], "↷ Round passé");
}

async function adminAction(method, args, label) {
  if (!contract || !signer) {
    showAlert("warn", "Connectez MetaMask.");
    return;
  }
  const btn = document.getElementById(
    "btn-" + (method === "triggerDraw" ? "draw" : "skip"),
  );
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
    showAlert("err", "Erreur: " + msg);
    addLog("❌", msg);
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

  contract.on("DrawTriggered", (roundId) => {
    addLog("⚡", `Tirage déclenché — Round #${roundId}`);
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
    addLog("🔒", `Round #${roundId} clôturé`);
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

function parseError(e) {
  if (e.errorName) return e.errorName;
  if (e.revert?.name) return e.revert.name;
  if (e.reason) return e.reason;

  // Décode le selector brut via l'interface du contrat (ex: estimateGas revert)
  const data = e.data ?? e.error?.data;
  if (data && data !== "0x" && contract) {
    try {
      const decoded = contract.interface.parseError(data);
      if (decoded) return decoded.name;
    } catch {}
  }

  const m = e.message || "";
  const match = m.match(/reverted with reason string '(.+?)'/);
  if (match) return match[1];
  return m.slice(0, 100) || "Erreur inconnue";
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
