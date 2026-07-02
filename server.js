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

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`SELECT username, balance FROM users ORDER BY balance DESC LIMIT 10`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to load leaderboard" });
    }
});

// --- GAME STATE MEMORY ---
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
        console.log(`🎰 Spinning up new room: ${tableId}`);
        tableStates[tableId] = {
            deck: createDeck(),
            dealer: { hand: [], score: 0 }
        };
    }
}

function drawCard(tableId) {
    if (!tableStates[tableId] || tableStates[tableId].deck.length < 10) {
        if (!tableStates[tableId]) initTable(tableId); // Safety fallback
        tableStates[tableId].deck = createDeck();
    }
    return tableStates[tableId].deck.pop();
}

function broadcastTableState(tableId) {
    const playersAtTable = activePlayers.filter(p => p.tableId === tableId);
    io.to(tableId).emit('tableStateUpdate', playersAtTable);
}

// --- SYNCHRONIZED ROUND LOGIC ---
async function checkRoundEnd(tableId) {
    const tablePlayers = activePlayers.filter(p => p.tableId === tableId);
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
                let msg = "";
                let winAmount = 0;

                if (dealer.score > 21 || player.score > dealer.score) {
                    msg = "YOU WIN!";
                    winAmount = player.bet * 2;
                } else if (player.score === dealer.score) {
                    msg = "PUSH (Tie).";
                    winAmount = player.bet;
                } else {
                    msg = "DEALER WINS. You lose.";
                }

                io.to(player.socketId).emit('gameStatus', msg);

                if (winAmount > 0) {
                    try {
                        const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [player.username]);
                        if (res.rows.length > 0) {
                            const newBalance = res.rows[0].balance + winAmount;
                            await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, player.username]);
                            io.to(player.socketId).emit('updateBalance', newBalance);
                        }
                    } catch (err) { console.error("Payout Error:", err); }
                }
            }
        }
        
        tableStates[tableId].dealer = { hand: [], score: 0 };
        broadcastTableState(tableId);
    }
}

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    
    socket.on('joinTable', async (data) => {
        // Enforce strict fallback on the server just in case
        const tableId = (data.tableId && data.tableId.trim() !== "") ? data.tableId.trim() : "Public-1";
        const username = data.username;
        const betAmount = data.betAmount;
        
        console.log(`👤 ${username} is attempting to join ${tableId}`);
        
        socket.join(tableId);
        initTable(tableId); 

        try {
            const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [username]);
            let balance = 1000; 

            if (res.rows.length > 0) balance = res.rows[0].balance; 
            else await pool.query(`INSERT INTO users (username, balance) VALUES ($1, $2)`, [username, balance]);

            balance -= parseInt(betAmount);
            await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [balance, username]);
            socket.emit('updateBalance', balance);

            const player = {
                socketId: socket.id, username, tableId,
                bet: parseInt(betAmount), hand: [drawCard(tableId), drawCard(tableId)], status: 'playing'
            };
            player.score = calculateScore(player.hand);
            
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            activePlayers.push(player);

            if (tableStates[tableId].dealer.hand.length === 0) {
                tableStates[tableId].dealer.hand = [drawCard(tableId), drawCard(tableId)];
                tableStates[tableId].dealer.score = calculateScore(tableStates[tableId].dealer.hand);
            }

            socket.emit('dealCards', player);
            broadcastTableState(tableId);
        } catch (err) {
            console.error("🔥 Database/Join Error:", err);
            socket.emit('gameStatus', "Error connecting to vault. Check server logs.");
        }
    });

    socket.on('hit', (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id);
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
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player && player.status === 'playing') {
            player.status = 'stood';
            socket.emit('gameStatus', 'Waiting for other players...');
            broadcastTableState(tableId);
            checkRoundEnd(tableId); 
        }
    });

    socket.on('sendChat', (data) => {
        io.to(data.tableId).emit('receiveChat', { username: data.username, message: data.message });
    });

    socket.on('adminGetUsers', async () => {
        try {
            const res = await pool.query(`SELECT * FROM users ORDER BY balance DESC`);
            socket.emit('adminUserData', res.rows);
        } catch (err) {}
    });

    socket.on('adminAddChips', async (data) => {
        const { targetUser, amount } = data;
        try {
            const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [targetUser]);
            if (res.rows.length > 0) {
                const newBalance = res.rows[0].balance + parseInt(amount);
                await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, targetUser]);
                io.emit('godModeUpdate', { username: targetUser, newBalance: newBalance, added: parseInt(amount) });
            }
        } catch (err) {}
    });

    socket.on('disconnect', () => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player) {
            const tableId = player.tableId;
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            broadcastTableState(tableId); 
            checkRoundEnd(tableId); 
            
            if (activePlayers.filter(p => p.tableId === tableId).length === 0) {
                delete tableStates[tableId];
                console.log(`🧹 Cleaning up empty room: ${tableId}`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎰 Casino Server is running on port ${PORT}`);
});