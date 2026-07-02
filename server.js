const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg'); // Changed from sqlite3
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- API ROUTES ---
// This endpoint fetches the top 10 richest players in the database
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`SELECT username, balance FROM users ORDER BY balance DESC LIMIT 10`);
        res.json(result.rows);
    } catch (err) {
        console.error("Leaderboard Fetch Error:", err);
        res.status(500).json({ error: "Failed to load leaderboard" });
    }
});

// --- CLOUD DATABASE SETUP ---
// This tells the server to use the URL from Render, or a local one if testing
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for cloud databases
});

// Create the table in the cloud
pool.query(`CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(255) UNIQUE,
    balance INTEGER
)`).then(() => console.log("☁️ Connected to the Permanent Cloud Database!"))
  .catch(err => console.error("Database connection error:", err));


// --- GAME STATE MEMORY ---
let activePlayers = []; 
let dealerState = { hand: [], score: 0 };
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

let currentDeck = createDeck();
function drawCard() {
    if (currentDeck.length < 10) currentDeck = createDeck();
    return currentDeck.pop();
}

function broadcastTableState(tableId) {
    const playersAtTable = activePlayers.filter(p => p.tableId === tableId);
    io.to(tableId).emit('tableStateUpdate', playersAtTable);
}

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    
    // 1. PLAYER JOINS TABLE (Async/Await used for Cloud DB)
    socket.on('joinTable', async (data) => {
        const { tableId, username, betAmount } = data;
        socket.join(tableId);

        try {
            // Check cloud database for user ($1 is Postgres syntax for variables)
            const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [username]);
            let balance = 1000; 

            if (res.rows.length > 0) {
                balance = res.rows[0].balance; // Existing user
            } else {
                // New user
                await pool.query(`INSERT INTO users (username, balance) VALUES ($1, $2)`, [username, balance]);
            }

            // Deduct bet
            balance -= parseInt(betAmount);
            await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [balance, username]);
            socket.emit('updateBalance', balance);

            // Create Player Profile
            const player = {
                socketId: socket.id, username, tableId,
                bet: parseInt(betAmount), hand: [drawCard(), drawCard()], status: 'playing'
            };
            player.score = calculateScore(player.hand);
            
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            activePlayers.push(player);

            if (dealerState.hand.length === 0) {
                dealerState.hand = [drawCard(), drawCard()];
                dealerState.score = calculateScore(dealerState.hand);
            }

            socket.emit('dealCards', player);
            broadcastTableState(tableId);
        } catch (err) {
            console.error("Join Table Error:", err);
        }
    });

    // 2. PLAYER HITS
    socket.on('hit', (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player && player.status === 'playing') {
            player.hand.push(drawCard());
            player.score = calculateScore(player.hand);
            
            socket.emit('dealCards', player);
            broadcastTableState(tableId);

            if (player.score > 21) {
                player.status = 'bust';
                socket.emit('gameStatus', 'BUST! You lose.');
                broadcastTableState(tableId);
            }
        }
    });

    // 3. PLAYER STANDS
    socket.on('stand', async (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player && player.status === 'playing') {
            player.status = 'stood';
            
            while (dealerState.score < 17) {
                dealerState.hand.push(drawCard());
                dealerState.score = calculateScore(dealerState.hand);
            }

            io.to(tableId).emit('dealerPlayed', dealerState);

            let msg = "";
            let winAmount = 0;

            if (dealerState.score > 21 || player.score > dealerState.score) {
                msg = "YOU WIN!";
                winAmount = player.bet * 2;
            } else if (player.score === dealerState.score) {
                msg = "PUSH (Tie).";
                winAmount = player.bet;
            } else {
                msg = "DEALER WINS. You lose.";
            }

            socket.emit('gameStatus', msg);

            // Pay the winner in the Cloud DB
            if (winAmount > 0) {
                try {
                    const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [player.username]);
                    if (res.rows.length > 0) {
                        const newBalance = res.rows[0].balance + winAmount;
                        await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, player.username]);
                        socket.emit('updateBalance', newBalance);
                    }
                } catch (err) { console.error("Payout Error:", err); }
            }
            
            dealerState.hand = []; 
            broadcastTableState(tableId);
        }
    });

    // --- LIVE CHAT ---
    socket.on('sendChat', (data) => {
        io.to(data.tableId).emit('receiveChat', { username: data.username, message: data.message });
    });

    // --- GOD MODE ADMIN ---
    socket.on('adminGetUsers', async () => {
        try {
            const res = await pool.query(`SELECT * FROM users ORDER BY balance DESC`);
            socket.emit('adminUserData', res.rows);
        } catch (err) { console.error(err); }
    });

    socket.on('adminAddChips', async (data) => {
        const { targetUser, amount } = data;
        const numAmount = parseInt(amount);

        try {
            const res = await pool.query(`SELECT balance FROM users WHERE username = $1`, [targetUser]);
            if (res.rows.length > 0) {
                const newBalance = res.rows[0].balance + numAmount;
                await pool.query(`UPDATE users SET balance = $1 WHERE username = $2`, [newBalance, targetUser]);
                io.emit('godModeUpdate', { username: targetUser, newBalance: newBalance, added: numAmount });
                
                const allUsers = await pool.query(`SELECT * FROM users ORDER BY balance DESC`);
                socket.emit('adminUserData', allUsers.rows);
            }
        } catch (err) { console.error(err); }
    });

    socket.on('disconnect', () => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player) {
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            broadcastTableState(player.tableId); 
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎰 Casino Server is running on port ${PORT}`);
});