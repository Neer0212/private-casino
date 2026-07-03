const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const { Hand } = require('pokersolver');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- CLOUD DATABASE SETUP ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query(`CREATE TABLE IF NOT EXISTS users (username VARCHAR(255) UNIQUE, balance INTEGER)`)
    .then(() => console.log("☁️ Connected to Cloud Database!"))
    .catch(err => console.error(err));

app.get('/api/admin/stats', async (req, res) => {
    try {
        const wealthRes = await pool.query(`SELECT SUM(balance) as total FROM users`);
        res.json({
            totalWealth: wealthRes.rows[0].total || 0,
            blackjackPlayers: activePlayers.filter(p => p.game === 'blackjack').length,
            roulettePlayers: activePlayers.filter(p => p.game === 'roulette').length,
            pokerPlayers: activePlayers.filter(p => p.game === 'poker').length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 🏆 PUBLIC LEADERBOARD API
// ==========================================
app.get('/api/leaderboard', async (req, res) => {
    try {
        // Fetch the top 10 richest players
        const result = await pool.query(`SELECT username, balance FROM users ORDER BY balance DESC LIMIT 10`);
        res.json(result.rows);
    } catch (err) { 
        console.error("Leaderboard DB Error:", err);
        res.status(500).json({ error: "Failed to load leaderboard" }); 
    }
});

function logActivity(message) {
    const time = new Date().toLocaleTimeString();
    io.emit('adminActivity', { time, message });
}

let activePlayers = [];
let tableStates = {};

// ==========================================
// CARD ENGINE (Shared)
// ==========================================
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    let deck = [];
    for (let suit of suits) for (let value of values) deck.push({ suit, value });
    return deck.sort(() => Math.random() - 0.5);
}

function calculateScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) {
        if (['J', 'Q', 'K'].includes(card.value)) score += 10;
        else if (card.value === 'A') { score += 11; aces += 1; }
        else score += parseInt(card.value);
    }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

// ==========================================
// BLACKJACK & ROULETTE (Skipped definitions for brevity, logic remains identical)
// ==========================================
function initTable(tableId) {
    if (!tableStates[tableId]) tableStates[tableId] = { deck: createDeck(), dealer: { hand: [], score: 0 } };
}
function drawCard(tableId) {
    if (!tableStates[tableId] || tableStates[tableId].deck.length < 10) {
        initTable(tableId); tableStates[tableId].deck = createDeck();
    }
    return tableStates[tableId].deck.pop();
}
function broadcastTableState(tableId) {
    io.to(tableId).emit('tableStateUpdate', activePlayers.filter(p => p.tableId === tableId && p.game === 'blackjack'));
}
async function checkRoundEnd(tableId) {
    const tablePlayers = activePlayers.filter(p => p.tableId === tableId && p.game === 'blackjack');
    if (!tablePlayers.some(p => p.status === 'playing') && tablePlayers.length > 0) {
        let dealer = tableStates[tableId].dealer;
        while (dealer.score < 17) { dealer.hand.push(drawCard(tableId)); dealer.score = calculateScore(dealer.hand); }
        io.to(tableId).emit('dealerPlayed', dealer);
        for (let player of tablePlayers) {
            if (player.status === 'stood') {
                let msg = "", winAmount = 0;
                if (dealer.score > 21 || player.score > dealer.score) { msg = "YOU WIN!"; winAmount = player.bet * 2; }
                else if (player.score === dealer.score) { msg = "PUSH (Tie)."; winAmount = player.bet; }
                else { msg = "DEALER WINS."; }
                io.to(player.socketId).emit('gameStatus', msg);
                if (winAmount > 0) {
                    try {
                        const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [player.username]);
                        const newBalance = res.rows[0].balance + winAmount;
                        await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, player.username]);
                        io.to(player.socketId).emit('updateBalance', newBalance);
                    } catch (err) { }
                }
            }
        }
        tableStates[tableId].dealer = { hand: [], score: 0 };
        broadcastTableState(tableId); io.emit('triggerChartUpdate');
    }
}
const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
function getRouletteColor(num) { return num === 0 ? 'Green' : redNumbers.includes(num) ? 'Red' : 'Black'; }
function broadcastRouletteState(tableId) { io.to(tableId).emit('rouletteStateUpdate', activePlayers.filter(p => p.tableId === tableId && p.game === 'roulette')); }


// ==========================================
// TEXAS HOLD'EM POKER ENGINE (Phase 3 - Betting)
// ==========================================
let pokerRooms = {};

function toPokerFormat(card) {
    let v = card.value === '10' ? 'T' : card.value;
    let s = card.suit.charAt(0).toLowerCase();
    return v + s;
}

function broadcastPokerState(tableId) {
    let table = pokerRooms[tableId];
    let players = activePlayers.filter(p => p.tableId === tableId && p.game === 'poker');

    // Determine whose turn it actually is (username)
    let currentTurnUser = "";
    if (players.length > 0 && table.stage !== 'waiting' && table.stage !== 'showdown') {
        let activeOnly = players.filter(p => p.status === 'playing');
        if (activeOnly.length > 0) {
            currentTurnUser = activeOnly[table.turnIndex % activeOnly.length].username;
        }
    }

    let safePlayers = players.map(p => {
        return {
            username: p.username,
            status: p.status,
            handDesc: p.handDesc,
            currentBet: p.currentBet, // How much they put in this round
            isTurn: p.username === currentTurnUser,
            cards: (table.stage === 'showdown' || p.status === 'winner') ? p.hand : []
        };
    });

    io.to(tableId).emit('pokerStateUpdate', {
        stage: table.stage,
        communityCards: table.communityCards,
        pot: table.pot,
        highestBet: table.highestBet,
        players: safePlayers
    });
}

function nextTurn(tableId) {
    let table = pokerRooms[tableId];
    let players = activePlayers.filter(p => p.tableId === tableId && p.game === 'poker' && p.status === 'playing');
    if (players.length > 1) {
        table.turnIndex = (table.turnIndex + 1) % players.length;
    }
}

// ==========================================
// SOCKET CONNECTIONS
// ==========================================
io.on('connection', (socket) => {

    async function getUserBalance(username) {
        const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [username]);
        if (res.rows.length > 0) return res.rows[0].balance;
        await pool.query(`INSERT INTO users (username, balance) VALUES ($1, $2)`, [username, 1000]);
        return 1000;
    }

    async function updateBalance(username, newBalance) {
        await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, username]);
        const player = activePlayers.find(p => p.username === username);
        if (player) io.to(player.socketId).emit('updateBalance', newBalance);
    }

    // --- GOD MODE (RESTORED) ---
    socket.on('adminGetUsers', async () => {
        try {
            const res = await pool.query(`SELECT username, balance FROM users ORDER BY balance DESC`);
            socket.emit('adminUserData', res.rows);
        } catch (err) { console.error(err); }
    });
    socket.on('adminAddChips', async (data) => {
        const { targetUser, amount } = data;
        try {
            const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [targetUser]);
            if (res.rows.length > 0) {
                const newBalance = res.rows[0].balance + parseInt(amount);
                await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, targetUser]);
                io.emit('godModeUpdate', { username: targetUser, newBalance: newBalance, added: parseInt(amount) });
                logActivity(`⚡ GOD MODE: Injected ₹${amount} to ${targetUser}`);
            }
        } catch (err) { }
    });

    // --- BLACKJACK LISTENERS ---
    socket.on('joinTable', async (data) => {
        const tableId = (data.tableId && data.tableId.trim() !== "") ? data.tableId.trim() : "Public-1";
        socket.join(tableId); initTable(tableId);
        try {
            let balance = await getUserBalance(data.username);
            balance -= parseInt(data.betAmount); await updateBalance(data.username, balance);
            const player = { socketId: socket.id, username: data.username, tableId, bet: parseInt(data.betAmount), hand: [drawCard(tableId), drawCard(tableId)], status: 'playing', game: 'blackjack' };
            player.score = calculateScore(player.hand);
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id); activePlayers.push(player);
            if (tableStates[tableId].dealer.hand.length === 0) {
                tableStates[tableId].dealer.hand = [drawCard(tableId), drawCard(tableId)];
                tableStates[tableId].dealer.score = calculateScore(tableStates[tableId].dealer.hand);
            }
            socket.emit('dealCards', player); broadcastTableState(tableId); io.emit('triggerChartUpdate');
        } catch (err) { }
    });
    socket.on('hit', (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id && p.game === 'blackjack');
        if (player && player.status === 'playing') {
            player.hand.push(drawCard(tableId)); player.score = calculateScore(player.hand);
            socket.emit('dealCards', player); broadcastTableState(tableId);
            if (player.score > 21) { player.status = 'bust'; socket.emit('gameStatus', 'BUST! You lose.'); broadcastTableState(tableId); checkRoundEnd(tableId); }
        }
    });
    socket.on('stand', (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id && p.game === 'blackjack');
        if (player && player.status === 'playing') { player.status = 'stood'; socket.emit('gameStatus', 'Waiting...'); broadcastTableState(tableId); checkRoundEnd(tableId); }
    });

    // --- ROULETTE LISTENERS ---
    socket.on('joinRoulette', async (data) => {
        const tableId = (data.tableId && data.tableId.trim() !== "") ? data.tableId.trim() : "Roulette-1";
        socket.join(tableId);
        try {
            let balance = await getUserBalance(data.username); socket.emit('updateBalance', balance);
            const player = { socketId: socket.id, username: data.username, tableId, bet: 0, target: null, status: 'waiting', game: 'roulette' };
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id); activePlayers.push(player);
            broadcastRouletteState(tableId); io.emit('triggerChartUpdate');
        } catch (err) { }
    });
    socket.on('placeRouletteBet', async (data) => {
        let player = activePlayers.find(p => p.socketId === socket.id && p.game === 'roulette');
        if (player) {
            try {
                let balance = await getUserBalance(player.username);
                if (balance >= data.betAmount) {
                    balance -= parseInt(data.betAmount); await updateBalance(player.username, balance);
                    player.bet = parseInt(data.betAmount); player.target = data.target.toString().toLowerCase(); player.status = 'bet_placed';
                    broadcastRouletteState(player.tableId);
                }
            } catch (err) { }
        }
    });
    socket.on('spinRoulette', async (tableId) => {
        let bettors = activePlayers.filter(p => p.tableId === tableId && p.game === 'roulette' && p.status === 'bet_placed');
        if (bettors.length === 0) return;
        const winningNumber = Math.floor(Math.random() * 37);
        const winningColor = getRouletteColor(winningNumber).toLowerCase();
        const isEven = winningNumber !== 0 && winningNumber % 2 === 0;
        io.to(tableId).emit('rouletteResult', { number: winningNumber, color: winningColor });

        for (let player of bettors) {
            let winAmount = 0, target = player.target;
            if (target === winningNumber.toString()) winAmount = player.bet * 36;
            else if (target === winningColor) winAmount = player.bet * 2;
            else if (target === 'even' && isEven) winAmount = player.bet * 2;
            else if (target === 'odd' && !isEven && winningNumber !== 0) winAmount = player.bet * 2;
            if (winAmount > 0) {
                try {
                    let balance = await getUserBalance(player.username); balance += winAmount;
                    await updateBalance(player.username, balance);
                    io.to(player.socketId).emit('gameStatus', `WINNER! Payout: ₹${winAmount}`);
                } catch (err) { }
            } else { io.to(player.socketId).emit('gameStatus', `Loss.`); }
            player.bet = 0; player.target = null; player.status = 'waiting';
        }
        setTimeout(() => broadcastRouletteState(tableId), 3000);
    });

    // --- POKER LISTENERS (PHASE 3 - BETTING) ---
    socket.on('joinPoker', async (data) => {
        const tableId = (data.tableId && data.tableId.trim() !== "") ? data.tableId.trim() : "Texas-1";
        socket.join(tableId);

        if (!pokerRooms[tableId]) {
            pokerRooms[tableId] = { deck: createDeck(), communityCards: [], stage: 'waiting', pot: 0, highestBet: 0, turnIndex: 0 };
        }
        try {
            let balance = await getUserBalance(data.username);
            socket.emit('updateBalance', balance);

            const player = { socketId: socket.id, username: data.username, tableId, hand: [], status: 'waiting', game: 'poker', handDesc: '', currentBet: 0 };
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            activePlayers.push(player);

            broadcastPokerState(tableId);
            io.emit('triggerChartUpdate');
        } catch (err) { }
    });

    socket.on('pokerAction', async (data) => {
        const { tableId, action, amount } = data;
        let table = pokerRooms[tableId];
        let player = activePlayers.find(p => p.socketId === socket.id && p.game === 'poker');

        if (!table || !player || player.status !== 'playing') return;

        try {
            let balance = await getUserBalance(player.username);
            let cost = 0;

            if (action === 'fold') {
                player.status = 'folded';
                io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🛑 ${player.username} folds.` });
            }
            else if (action === 'call') {
                cost = table.highestBet - player.currentBet;
                if (balance >= cost) {
                    await updateBalance(player.username, balance - cost);
                    player.currentBet += cost;
                    table.pot += cost;
                    io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `✅ ${player.username} calls (₹${cost}).` });
                }
            }
            else if (action === 'raise') {
                let raiseTo = parseInt(amount);
                if (raiseTo > table.highestBet) {
                    cost = raiseTo - player.currentBet;
                    if (balance >= cost) {
                        await updateBalance(player.username, balance - cost);
                        player.currentBet += cost;
                        table.highestBet = raiseTo;
                        table.pot += cost;
                        io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🔥 ${player.username} raises to ₹${raiseTo}!` });
                    }
                }
            }

            nextTurn(tableId);
            broadcastPokerState(tableId);
        } catch (err) { console.error("Poker Action Error:", err); }
    });

    socket.on('devAdvancePokerStage', async (tableId) => {
        let table = pokerRooms[tableId];
        let players = activePlayers.filter(p => p.tableId === tableId && p.game === 'poker');

        if (!table || players.length === 0) return;

        if (table.stage === 'waiting' || table.stage === 'showdown') {
            table.deck = createDeck();
            table.communityCards = [];
            table.pot = 0;
            table.highestBet = 0;
            table.turnIndex = 0;

            // Collect ₹50 Ante from everyone
            for (let p of players) {
                try {
                    let bal = await getUserBalance(p.username);
                    if (bal >= 50) {
                        await updateBalance(p.username, bal - 50);
                        p.hand = [table.deck.pop(), table.deck.pop()];
                        p.status = 'playing';
                        p.handDesc = '';
                        p.currentBet = 50;
                        table.pot += 50;
                        io.to(p.socketId).emit('receiveHoleCards', p.hand);
                    } else {
                        p.status = 'waiting'; // Too broke to play
                    }
                } catch (err) { }
            }

            table.highestBet = 50;
            table.stage = 'preflop';
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 New Hand! ₹50 Ante collected.` });

        } else if (table.stage === 'preflop') {
            table.deck.pop();
            table.communityCards.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
            table.stage = 'flop';
            resetRoundBets(tableId, players);
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 The Flop is dealt.` });

        } else if (table.stage === 'flop') {
            table.deck.pop();
            table.communityCards.push(table.deck.pop());
            table.stage = 'turn';
            resetRoundBets(tableId, players);
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 The Turn is dealt.` });

        } else if (table.stage === 'turn') {
            table.deck.pop();
            table.communityCards.push(table.deck.pop());
            table.stage = 'river';
            resetRoundBets(tableId, players);
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 The River is dealt.` });

        } else if (table.stage === 'river') {
            table.stage = 'showdown';
            let communityFormatted = table.communityCards.map(toPokerFormat);

            let solvedHands = [];
            players.forEach(p => {
                if (p.status === 'playing') {
                    let fullHand = p.hand.map(toPokerFormat).concat(communityFormatted);
                    let solved = Hand.solve(fullHand);
                    solved.player = p;
                    p.handDesc = solved.descr;
                    solvedHands.push(solved);
                }
            });

            if (solvedHands.length > 0) {
                let winners = Hand.winners(solvedHands);
                let splitPot = Math.floor(table.pot / winners.length);

                winners.forEach(async w => {
                    w.player.status = 'winner';
                    io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🏆 ${w.player.username} wins ₹${splitPot} with ${w.descr}!` });
                    try {
                        let bal = await getUserBalance(w.player.username);
                        await updateBalance(w.player.username, bal + splitPot);
                    } catch (err) { }
                });
            }
        }

        broadcastPokerState(tableId);
    });

    function resetRoundBets(tableId, players) {
        let table = pokerRooms[tableId];
        table.highestBet = 0;
        table.turnIndex = 0;
        players.forEach(p => p.currentBet = 0);
    }

    // --- SOCIAL FEATURES (TIPS & EMOJIS) ---
    socket.on('tipPlayer', async (data) => {
        const { tableId, sender, receiver, amount } = data;
        try {
            let senderBal = await getUserBalance(sender);
            if (senderBal >= parseInt(amount)) {
                let receiverBal = await getUserBalance(receiver);
                await updateBalance(sender, senderBal - parseInt(amount));
                await updateBalance(receiver, receiverBal + parseInt(amount));
                io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `💸 ${sender} tipped ${receiver} ₹${amount}!` });
            }
        } catch (err) { }
    });

    socket.on('sendReaction', (data) => io.to(data.tableId).emit('triggerReaction', { username: data.username, emoji: data.emoji }));
    socket.on('sendChat', (data) => io.to(data.tableId).emit('receiveChat', { username: data.username, message: data.message }));

    socket.on('disconnect', () => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player) {
            const tableId = player.tableId;
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            if (player.game === 'blackjack') { broadcastTableState(tableId); checkRoundEnd(tableId); }
            else if (player.game === 'roulette') broadcastRouletteState(tableId);
            else if (player.game === 'poker') broadcastPokerState(tableId);
            io.emit('triggerChartUpdate');
        }
    });
});

// ==========================================
// 🗺️ CASINO FLOOR TELEMETRY (LIVE MAP)
// ==========================================
function broadcastFloorState() {
    let floorMap = {};

    // Group active players by their tableId
    activePlayers.forEach(p => {
        if (!floorMap[p.tableId]) {
            floorMap[p.tableId] = { id: p.tableId, game: p.game, players: [] };
        }
        floorMap[p.tableId].players.push(p.username);
    });

    // Send the packaged array to everyone connected
    io.emit('liveFloorMap', Object.values(floorMap));
}

// Automatically broadcast the map every 3 seconds
setInterval(broadcastFloorState, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎰 Casino Server is running on port ${PORT}`));