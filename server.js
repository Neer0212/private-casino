const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE SETUP ---
const db = new sqlite3.Database('./casino.db', (err) => {
    if (err) console.error("Database error:", err.message);
    else console.log("Connected to the SQLite database.");
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT UNIQUE,
    balance INTEGER
)`);

// --- GAME STATE MEMORY ---
let activePlayers = []; // Tracks everyone currently sitting at a table
let dealerState = { hand: [], score: 0 };
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// --- ENGINE HELPER FUNCTIONS ---
function createDeck() {
    let deck = [];
    for (let suit of suits) {
        for (let value of values) deck.push({ suit, value });
    }
    return deck.sort(() => Math.random() - 0.5); // Shuffle
}

function calculateScore(hand) {
    let score = 0;
    let aces = 0;
    for (let card of hand) {
        if (['J', 'Q', 'K'].includes(card.value)) score += 10;
        else if (card.value === 'A') { score += 11; aces += 1; }
        else score += parseInt(card.value);
    }
    while (score > 21 && aces > 0) { // Handle dynamic Aces
        score -= 10;
        aces -= 1;
    }
    return score;
}

let currentDeck = createDeck();
function drawCard() {
    if (currentDeck.length < 10) currentDeck = createDeck();
    return currentDeck.pop();
}

// THE MULTIPLAYER BROADCAST
function broadcastTableState(tableId) {
    const playersAtTable = activePlayers.filter(p => p.tableId === tableId);
    io.to(tableId).emit('tableStateUpdate', playersAtTable);
}

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    
    // 1. PLAYER JOINS TABLE
    socket.on('joinTable', (data) => {
        const { tableId, username, betAmount } = data;
        socket.join(tableId);

        // Handle Database Economy
        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
            let balance = 1000; // New user starting balance
            if (row) balance = row.balance;
            else db.run(`INSERT INTO users (username, balance) VALUES (?, ?)`, [username, balance]);

            // Deduct bet
            balance -= parseInt(betAmount);
            db.run(`UPDATE users SET balance = ? WHERE username = ?`, [balance, username]);
            socket.emit('updateBalance', balance);

            // Create Player Profile
            const player = {
                socketId: socket.id,
                username,
                tableId,
                bet: parseInt(betAmount),
                hand: [drawCard(), drawCard()],
                status: 'playing'
            };
            player.score = calculateScore(player.hand);
            
            // Remove old instance if they reconnected, add new one
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            activePlayers.push(player);

            // Initialize Dealer if needed
            if (dealerState.hand.length === 0) {
                dealerState.hand = [drawCard(), drawCard()];
                dealerState.score = calculateScore(dealerState.hand);
            }

            // Send cards to the player, and broadcast the table to everyone
            socket.emit('dealCards', player);
            broadcastTableState(tableId);
        });
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

    // 3. PLAYER STANDS (Dealer plays out)
    socket.on('stand', (tableId) => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player && player.status === 'playing') {
            player.status = 'stood';
            
            // Dealer AI logic
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

            // Pay the winner
            if (winAmount > 0) {
                db.get(`SELECT balance FROM users WHERE username = ?`, [player.username], (err, row) => {
                    if (row) {
                        const newBalance = row.balance + winAmount;
                        db.run(`UPDATE users SET balance = ? WHERE username = ?`, [newBalance, player.username]);
                        socket.emit('updateBalance', newBalance);
                    }
                });
            }
            
            dealerState.hand = []; // Reset dealer for next round
            broadcastTableState(tableId);
        }
    });

    // --- LIVE CHAT LOGIC ---
    socket.on('sendChat', (data) => {
        const { tableId, username, message } = data;
        io.to(tableId).emit('receiveChat', { username, message });
    });

    // --- GOD MODE ADMIN LOGIC ---
    socket.on('adminGetUsers', () => {
        db.all(`SELECT * FROM users ORDER BY balance DESC`, [], (err, rows) => {
            if (!err) socket.emit('adminUserData', rows);
        });
    });

    socket.on('adminAddChips', (data) => {
        const { targetUser, amount } = data;
        const numAmount = parseInt(amount);

        db.get(`SELECT balance FROM users WHERE username = ?`, [targetUser], (err, row) => {
            if (row) {
                const newBalance = row.balance + numAmount;
                db.run(`UPDATE users SET balance = ? WHERE username = ?`, [newBalance, targetUser]);
                io.emit('godModeUpdate', { username: targetUser, newBalance: newBalance, added: numAmount });
                db.all(`SELECT * FROM users ORDER BY balance DESC`, [], (err, rows) => {
                    if (!err) socket.emit('adminUserData', rows);
                });
            }
        });
    });

    // --- CLEANUP DISCONNECTS ---
    socket.on('disconnect', () => {
        let player = activePlayers.find(p => p.socketId === socket.id);
        if (player) {
            const tableId = player.tableId;
            activePlayers = activePlayers.filter(p => p.socketId !== socket.id);
            broadcastTableState(tableId); // Update table so friend disappears when they leave
        }
    });
});

// --- CLOUD PORT SETUP ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎰 Casino Server is running on port ${PORT}`);
});