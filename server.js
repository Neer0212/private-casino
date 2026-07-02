const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const { Hand } = require('pokersolver'); // ♠️ The new Poker Math Engine

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- CLOUD DATABASE SETUP ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query(`CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(255) UNIQUE,
    balance INTEGER
)`).then(() => console.log("☁️ Connected to the Permanent Cloud Database!"))
    .catch(err => console.error("Database connection error:", err));

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

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`SELECT username, balance FROM users ORDER BY balance DESC LIMIT 10`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "Failed to load leaderboard" }); }
});

function logActivity(message) {
    const time = new Date().toLocaleTimeString();
    io.emit('adminActivity', { time, message });
}

let activePlayers = [];
let tableStates = {}; // Blackjack Tables

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

// ==========================================
// BLACKJACK ENGINE
// ==========================================
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

function initTable(tableId) {
    if (!tableStates[tableId]) {
        tableStates[tableId] = { deck: createDeck(), dealer: { hand: [], score: 0 } };
        logActivity(`🟢 New Blackjack room opened: ${tableId}`);
    }
}

function drawCard(tableId) {
    if (!tableStates[tableId] || tableStates[tableId].deck.length < 10) {
        if (!tableStates[tableId]) initTable(tableId);
        tableStates[tableId].deck = createDeck();
    }
    return tableStates[tableId].deck.pop();
}

function broadcastTableState(tableId) {
    const playersAtTable = activePlayers.filter(p => p.tableId === tableId && p.game === 'blackjack');
    io.to(tableId).emit('tableStateUpdate', playersAtTable);
}

async function checkRoundEnd(tableId) {
    const tablePlayers = activePlayers.filter(p => p.tableId === tableId && p.game === 'blackjack');
    const isAnyonePlaying = tablePlayers.some(p => p.status === 'playing');

    if (!isAnyonePlaying && tablePlayers.length > 0) {
        let dealer = tableStates[tableId].dealer;
        while (dealer.score < 17) {
            dealer.hand.push(drawCard(tableId));
            dealer.score = calculateScore(dealer.hand);
        }
        io.to(tableId).emit('dealerPlayed', dealer);

        for (let player of tablePlayers) {
            if (player.status === 'stood') {
                let msg = "", winAmount = 0;
                if (dealer.score > 21 || player.score > dealer.score) { msg = "YOU WIN!"; winAmount = player.bet * 2; }
                else if (player.score === dealer.score) { msg = "PUSH (Tie)."; winAmount = player.bet; }
                else { msg = "DEALER WINS. You lose."; }
                io.to(player.socketId).emit('gameStatus', msg);

                if (winAmount > 0) {
                    try {
                        const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [player.username]);
                        if (res.rows.length > 0) {
                            const newBalance = res.rows[0].balance + winAmount;
                            await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, player.username]);
                            io.to(player.socketId).emit('updateBalance', newBalance);
                        }
                    } catch (err) { console.error(err); }
                }
            }
        }
        tableStates[tableId].dealer = { hand: [], score: 0 };
        broadcastTableState(tableId);
        io.emit('triggerChartUpdate');
    }
}

// ==========================================
// ROULETTE ENGINE
// ==========================================
const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
function getRouletteColor(num) {
    if (num === 0) return 'Green';
    return redNumbers.includes(num) ? 'Red' : 'Black';
}
function broadcastRouletteState(tableId) {
    const players = activePlayers.filter(p => p.tableId === tableId && p.game === 'roulette');
    io.to(tableId).emit('rouletteStateUpdate', players);
}

// ==========================================
// TEXAS HOLD'EM POKER ENGINE (Phase 2)
// ==========================================
let pokerRooms = {};

// Helper: Converts our {suit: 'Hearts', value: '10'} format to Pokersolver's 'Th' format
function toPokerFormat(card) {
    let v = card.value === '10' ? 'T' : card.value;
    let s = card.suit.charAt(0).toLowerCase();
    return v + s;
}

function broadcastPokerState(tableId) {
    let table = pokerRooms[tableId];
    let players = activePlayers.filter(p => p.tableId === tableId && p.game === 'poker');

    // We must HIDE other players' hole cards unless it's showdown
    let safePlayers = players.map(p => {
        return {
            username: p.username,
            status: p.status,
            handDesc: p.handDesc,
            // Only send cards if game is over, otherwise send blanks
            cards: (table.stage === 'showdown' || p.status === 'winner') ? p.hand : []
        };
    });

    io.to(tableId).emit('pokerStateUpdate', {
        stage: table.stage,
        communityCards: table.communityCards,
        players: safePlayers
    });
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

    // --- BLACKJACK LISTENERS ---
    socket.on('joinTable', async (data) => {
        const tableId = (data.tableId && data.tableId.trim() !== "") ? data.tableId.trim() : "Public-1";
        socket.join(tableId);
        initTable(tableId);
        try {
            let balance = await getUserBalance(data.username);
            balance -= parseInt(data.betAmount);
            await updateBalance(data.username, balance);

            const player = { socketId: socket.id, username: data.username, tableId, bet: parseInt(data.betAmount), hand: [drawCard(tableId), drawCard(tableId)], status: 'playing', game: 'blackjack' };
            player.score = calculateScore(player.hand);

            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            activePlayers.push(player);

            if (tableStates[tableId].dealer.hand.length === 0) {
                tableStates[tableId].dealer.hand = [drawCard(tableId), drawCard(tableId)];
                tableStates[tableId].dealer.score = calculateScore(tableStates[tableId].dealer.hand);
            }
            socket.emit('dealCards', player);
            broadcastTableState(tableId);
            io.emit('triggerChartUpdate');
        } catch (err) { console.error(err); }
    });
    socket.on('hit', (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id && p.game === 'blackjack');
        if (player && player.status === 'playing') {
            player.hand.push(drawCard(tableId));
            player.score = calculateScore(player.hand);
            socket.emit('dealCards', player);
            broadcastTableState(tableId);
            if (player.score > 21) {
                player.status = 'bust';
                socket.emit('gameStatus', 'BUST! You lose.');
                broadcastTableState(tableId);
                checkRoundEnd(tableId);
            }
        }
    });
    socket.on('stand', (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id && p.game === 'blackjack');
        if (player && player.status === 'playing') {
            player.status = 'stood';
            socket.emit('gameStatus', 'Waiting for other players...');
            broadcastTableState(tableId);
            checkRoundEnd(tableId);
        }
    });

    // --- ROULETTE LISTENERS ---
    socket.on('joinRoulette', async (data) => {
        const tableId = (data.tableId && data.tableId.trim() !== "") ? data.tableId.trim() : "Roulette-1";
        socket.join(tableId);
        try {
            let balance = await getUserBalance(data.username);
            socket.emit('updateBalance', balance);

            const player = { socketId: socket.id, username: data.username, tableId, bet: 0, target: null, status: 'waiting', game: 'roulette' };
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            activePlayers.push(player);
            broadcastRouletteState(tableId);
            io.emit('triggerChartUpdate');
        } catch (err) { console.error(err); }
    });
    socket.on('placeRouletteBet', async (data) => {
        let player = activePlayers.find(p => p.socketId === socket.id && p.game === 'roulette');
        if (player) {
            try {
                let balance = await getUserBalance(player.username);
                if (balance >= data.betAmount) {
                    balance -= parseInt(data.betAmount);
                    await updateBalance(player.username, balance);
                    player.bet = parseInt(data.betAmount);
                    player.target = data.target.toString().toLowerCase();
                    player.status = 'bet_placed';
                    broadcastRouletteState(player.tableId);
                }
            } catch (err) { console.error(err); }
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
                    let balance = await getUserBalance(player.username);
                    balance += winAmount;
                    await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [balance, player.username]);
                    io.to(player.socketId).emit('updateBalance', balance);
                    io.to(player.socketId).emit('gameStatus', `WINNER! Payout: ₹${winAmount}`);
                } catch (err) { }
            } else {
                io.to(player.socketId).emit('gameStatus', `Loss.`);
            }
            player.bet = 0; player.target = null; player.status = 'waiting';
        }
        setTimeout(() => broadcastRouletteState(tableId), 3000);
    });

    // --- POKER LISTENERS (PHASE 2) ---
    socket.on('joinPoker', async (data) => {
        const tableId = (data.tableId && data.tableId.trim() !== "") ? data.tableId.trim() : "Texas-1";
        socket.join(tableId);

        // Initialize table memory if it doesn't exist
        if (!pokerRooms[tableId]) {
            pokerRooms[tableId] = { deck: createDeck(), communityCards: [], stage: 'waiting' };
            logActivity(`🃏 New Poker room opened: ${tableId}`);
        }

        try {
            let balance = await getUserBalance(data.username);
            socket.emit('updateBalance', balance);

            const player = { socketId: socket.id, username: data.username, tableId, hand: [], status: 'waiting', game: 'poker', handDesc: '' };
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            activePlayers.push(player);

            broadcastPokerState(tableId);
            io.emit('triggerChartUpdate');
        } catch (err) { console.error(err); }
    });

    // Dev Mode Step Function: Advances the state machine
    socket.on('devAdvancePokerStage', (tableId) => {
        let table = pokerRooms[tableId];
        let players = activePlayers.filter(p => p.tableId === tableId && p.game === 'poker');

        if (!table || players.length === 0) return;

        if (table.stage === 'waiting' || table.stage === 'showdown') {
            // New Game: Deal Hole Cards
            table.deck = createDeck();
            table.communityCards = [];
            players.forEach(p => {
                p.hand = [table.deck.pop(), table.deck.pop()];
                p.status = 'playing';
                p.handDesc = '';
                // Send specific hole cards to the specific socket securely
                io.to(p.socketId).emit('receiveHoleCards', p.hand);
            });
            table.stage = 'preflop';
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 Hole cards dealt.` });

        } else if (table.stage === 'preflop') {
            // The Flop: Burn 1, Deal 3
            table.deck.pop();
            table.communityCards.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
            table.stage = 'flop';
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 The Flop is dealt.` });

        } else if (table.stage === 'flop') {
            // The Turn: Burn 1, Deal 1
            table.deck.pop();
            table.communityCards.push(table.deck.pop());
            table.stage = 'turn';
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 The Turn is dealt.` });

        } else if (table.stage === 'turn') {
            // The River: Burn 1, Deal 1
            table.deck.pop();
            table.communityCards.push(table.deck.pop());
            table.stage = 'river';
            io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🃏 The River is dealt.` });

        } else if (table.stage === 'river') {
            // Showdown: Evaluate Winners
            table.stage = 'showdown';
            let communityFormatted = table.communityCards.map(toPokerFormat);

            let solvedHands = [];
            players.forEach(p => {
                if (p.status === 'playing') {
                    let fullHand = p.hand.map(toPokerFormat).concat(communityFormatted);
                    let solved = Hand.solve(fullHand);
                    solved.player = p; // Attach player object for reference later
                    p.handDesc = solved.descr;
                    solvedHands.push(solved);
                }
            });

            // Let the Math Engine figure out who actually won
            if (solvedHands.length > 0) {
                let winners = Hand.winners(solvedHands);
                winners.forEach(w => {
                    w.player.status = 'winner';
                    io.to(tableId).emit('receiveChat', { username: "SYSTEM", message: `🏆 ${w.player.username} wins with ${w.descr}!` });
                    logActivity(`🏆 ${w.player.username} won Poker at ${tableId} with ${w.descr}`);
                });
            }
        }

        broadcastPokerState(tableId);
    });

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎰 Casino Server is running on port ${PORT}`));