# 🎰 VIP Cloud Casino: Real-Time Multiplayer Platform

A production-grade, multi-tenant casino platform built from scratch using **Node.js, Socket.IO, and PostgreSQL**. This platform features three fully playable multiplayer games, a persistent cloud economy, peer-to-peer social features, and a live administrative telemetry dashboard.

---

## 🚀 Architectural Highlights

* **Multi-Tenant State Management:** Dynamic lobby routing allows players to spin up isolated, private rooms on the fly. The Node.js server maintains independent state machines for dozens of simultaneous Blackjack, Roulette, and Poker tables without thread-blocking.
* **Sub-Millisecond Real-Time Engine:** Built on **Socket.IO** for instantaneous WebSocket broadcasting. Ensures all players see card deals, roulette spins, and chat messages at the exact same time.
* **Persistent Cloud Economy:** Every bet, win, and peer-to-peer tip is securely wrapped in asynchronous transactions and committed to a **Serverless PostgreSQL Database**. Player wealth survives server restarts and scales across all game rooms.
* **Live Telemetry & "God Mode":** An admin-only dashboard utilizing **Chart.js** to track active floor traffic, calculate the total global wealth in circulation, and stream a live terminal feed of all casino events. 
* **Social & Ephemeral Mechanics:** Features peer-to-peer tipping directly between player vaults and ephemeral floating emoji reactions broadcasted to specific sub-channels.

## 🛠️ The Tech Stack
- **Backend Environment:** Node.js & Express
- **Real-Time Networking:** Socket.IO
- **Database:** PostgreSQL (via `pg` connection pool)
- **Mathematical Evaluation:** `pokersolver` (for Texas Hold'em 7-card evaluation)
- **Frontend UI:** HTML5, CSS3, Vanilla JavaScript, Chart.js
- **Deployment:** Render (Web Service) & Neon (Serverless Postgres)

## 🎲 The Casino Floor (Games)

### 1. Texas Hold'em Poker
A complete poker engine featuring a strict state-machine (Pre-flop, Flop, Turn, River, Showdown). Includes automated blind/ante collection, turn-based action enforcement (Fold/Call/Raise), pot tracking, and mathematical hand evaluation for split-pot payouts.

### 2. Multiplayer Blackjack
Fully synchronized round-based logic. The virtual dealer automatically waits for all connected players to lock in their actions (Hit, Stand, or Bust) before executing the house's hand and paying out the table.

### 3. VIP Roulette
A concurrent betting system where multiple users can place wagers on specific numbers, colors, or evens/odds. Features a physics-simulated server spin and complex payout multipliers (e.g., 36:1 for single numbers).

## 🏗️ Project Structure
```text
├── public/              
│   ├── index.html       # Blackjack UI & Navigation
│   ├── roulette.html    # Roulette Board & Wheel UI
│   ├── poker.html       # Texas Hold'em Table & Betting UI
│   └── dashboard.html   # Admin Chart.js Telemetry Hub
├── server.js            # Core Game Engine, DB Transactions, & Sockets
├── package.json         # Dependencies
└── README.md