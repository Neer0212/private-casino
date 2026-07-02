const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg'); 
const path = require('path');

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
        res.json({ totalWealth: wealthRes.rows[0].total || 0, blackjackPlayers: activePlayers.filter(p => p.game === 'blackjack').length, roulettePlayers: activePlayers.filter(p => p.game === 'roulette').length });
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
let tableStates = {}; 

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

function initTable(tableId) {
    if (!tableStates[tableId]) {
        tableStates[tableId] = { deck: createDeck(), dealer: { hand: [], score: 0 } };
        logActivity(`🟢 New room opened: ${tableId}`);
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

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    
    async function getUserBalance(username) {
        const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [username]);
        if (res.rows.length > 0) return res.rows[0].balance;
        await pool.query(`INSERT INTO users (username, balance) VALUES ($1, $2)`, [username, 1000]);
        return 1000;
    }

    async function updateBalance(username, newBalance) {
        await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, username]);
        
        // Find their active socket and send the update
        const player = activePlayers.find(p => p.username === username);
        if (player) io.to(player.socketId).emit('updateBalance', newBalance);
    }

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

    // ==========================================
    // SOCIAL FEATURES (TIPS & EMOJIS)
    // ==========================================
    
    // Peer-to-Peer Tipping Engine
    socket.on('tipPlayer', async (data) => {
        const { tableId, sender, receiver, amount } = data;
        const tipAmount = parseInt(amount);

        try {
            let senderBal = await getUserBalance(sender);
            if (senderBal >= tipAmount) {
                let receiverBal = await getUserBalance(receiver);
                
                // Execute DB Transaction
                await updateBalance(sender, senderBal - tipAmount);
                await updateBalance(receiver, receiverBal + tipAmount);
                
                // Broadcast to the room
                io.to(tableId).emit('receiveChat', { 
                    username: "SYSTEM", 
                    message: `💸 ${sender} tipped ${receiver} ₹${tipAmount}!` 
                });
                
                logActivity(`💸 ${sender} tipped ${receiver} ₹${tipAmount}`);
            } else {
                socket.emit('receiveChat', { username: "SYSTEM", message: `❌ You don't have enough chips to tip.` });
            }
        } catch (err) { console.error("Tipping error:", err); }
    });

    // Emoji Reactions
    socket.on('sendReaction', (data) => {
        // Broadcast the emoji and the sender's username to everyone at the table
        io.to(data.tableId).emit('triggerReaction', { username: data.username, emoji: data.emoji });
    });

    socket.on('sendChat', (data) => { io.to(data.tableId).emit('receiveChat', { username: data.username, message: data.message }); });

    socket.on('disconnect', () => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player) {
            const tableId = player.tableId;
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            if (player.game === 'blackjack') {
                broadcastTableState(tableId); checkRoundEnd(tableId); 
            }
            io.emit('triggerChartUpdate');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎰 Casino Server is running on port ${PORT}`));