# OnChain Lottery

Loterie décentralisée on-chain. Le contrat tourne sur Ethereum (ou un réseau local Hardhat), le frontend est en HTML/JS pur avec ethers.js v6.

## Prérequis

- [Node.js](https://nodejs.org) v18+
- [MetaMask](https://metamask.io) installé dans le navigateur

## Installation

```bash
npm install
```

## Lancer en local

### 1. Démarrer le nœud Hardhat (Terminal 1)

```bash
npx hardhat node
```

Laisse ce terminal ouvert. Il affiche 20 comptes de test avec leurs clés privées (10 000 ETH chacun).

### 2. Déployer le contrat (Terminal 2)

```bash
npx hardhat run scripts/deploy.js --network localhost
```

Note l'adresse affichée, ex : `0x5FbDB2315678afecb367f032d93F642f64180aa3`

### 3. Configurer MetaMask

Ajouter le réseau local manuellement dans MetaMask :

| Champ | Valeur |
|---|---|
| Nom | `Hardhat Local` |
| URL RPC | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Symbole | `ETH` |

Importer un compte de test : copie une clé privée affichée dans le Terminal 1 → MetaMask → Importer un compte.

### 4. Servir le frontend

```bash
npx serve front
```

Ouvre `http://localhost:3000` dans le navigateur.

### 5. Charger le contrat

- Connecte MetaMask (bouton en haut à droite)
- Colle l'adresse du contrat déployé
- Clique **Charger**

## Déployer sur Sepolia (testnet public)

> Nécessaire pour utiliser le frontend hébergé en ligne (GitHub Pages, Vercel, etc.) — un nœud Hardhat local n'est pas accessible depuis internet.

### 1. Obtenir un RPC Sepolia

Crée un compte gratuit sur [Infura](https://infura.io) ou [Alchemy](https://alchemy.com) et récupère l'URL RPC de ton projet Sepolia.

### 2. Obtenir des ETH de test

Utilise un faucet gratuit :
- https://sepoliafaucet.com
- https://faucets.chain.link

### 3. Installer dotenv

```bash
npm install --save-dev dotenv
```

### 4. Configurer la clé privée

Crée un fichier `.env` à la racine (**ne jamais le committer**) :

```
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/TON_PROJET_ID
PRIVATE_KEY=ta_cle_privee_sans_0x
```

Ajoute `.env` dans `.gitignore` si ce n'est pas déjà fait :

```
.env
```

Met à jour `hardhat.config.js` :

```js
require("dotenv").config();

module.exports = {
  solidity: "0.8.19",
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL,
      accounts: [process.env.PRIVATE_KEY],
    },
  },
};
```

### 5. Déployer

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

### 6. Utiliser le frontend en ligne

Connecte MetaMask sur le réseau **Sepolia**, ouvre le site, colle l'adresse du contrat déployé et clique **Charger**.

## Paramètres du contrat

Modifiables dans `scripts/deploy.js` avant le déploiement :

| Paramètre | Défaut | Description |
|---|---|---|
| `ticketPrice` | `0.01 ETH` | Prix d'un ticket |
| `maxPlayers` | `0` | Max participants (0 = illimité) |
| `durationSecs` | `60` | Durée d'un round en secondes |

## Structure du projet

```
├── contracts/
│   └── lotterie.sol      # Contrat Solidity
├── scripts/
│   └── deploy.js         # Script de déploiement
├── front/
│   ├── index.html        # Interface utilisateur
│   ├── index.css         # Styles
│   └── ethers.js         # Logique frontend (ABI, wallet, contrat)
└── hardhat.config.js
```

## Fonctionnement

1. Le owner déploie le contrat → Round #1 démarre automatiquement
2. Les participants achètent des tickets via `buyTickets(n)` en envoyant `n × ticketPrice` ETH
3. Une fois le round terminé, n'importe qui peut appeler `triggerDraw()`
4. Le contrat tire un gagnant au sort, lui transfère 95% du pool et démarre le round suivant
5. Si personne n'a participé, le owner peut appeler `skipEmptyRound()`

> **Note** : le tirage utilise un pseudo-aléatoire pour les tests locaux. En production, remplacer par [Chainlink VRF v2](https://docs.chain.link/vrf).
