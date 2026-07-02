const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose(); 

// --- DATABASE SETUP ---
const db = new sqlite3.Database('./casino.db', (err) => {
    if (err) console.error(err.message);
    console.log('💰 Connected to the casino database.');
});

// Create the Users table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    balance INTEGER
)`);

// --- THE GAME ENGINE ---
class Deck {
    constructor() {
        this.cards = [];
        const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
        const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

        for (let suit of suits) {
            for (let value of values) {
                this.cards.push({ suit, value });
            }
        }
    }

    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    draw() {
        return this.cards.pop();
    }
}

// --- STATE MANAGEMENT ---
const tableDecks = {};
const playerHands = {};
const playerBets = {};       
const playerUsernames = {};  

// --- GAME LOGIC ---
function calculateScore(hand) {
    let score = 0;
    let aces = 0;

    for (let card of hand) {
        if (['J', 'Q', 'K'].includes(card.value)) {
            score += 10;
        } else if (card.value === 'A') {
            score += 11;
            aces += 1;
        } else {
            score += parseInt(card.value);
        }
    }

    while (score > 21 && aces > 0) {
        score -= 10;
        aces -= 1;
    }

    return score;
}

// --- APP & WEBSOCKET SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    console.log(`🟢 Player connected: ${socket.id}`);

    // 1. JOIN TABLE & PLACE BET
    socket.on('joinTable', (data) => {
        const { tableId, username, betAmount } = data;
        const bet = parseInt(betAmount);

        // Check if user exists in the database
        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
            
            if (err) {
                console.error("Database Error:", err.message);
                socket.emit('gameStatus', "⚠️ Database error! Check terminal.");
                return;
            }

            let currentBalance = 0;

            if (!row) {
                currentBalance = 1000 - bet;
                db.run(`INSERT INTO users (username, balance) VALUES (?, ?)`, [username, currentBalance]);
                socket.emit('tableMessage', `Welcome ${username}! You got a $1000 sign-up bonus.`);
            } else {
                if (row.balance < bet) {
                    socket.emit('gameStatus', "❌ Not enough chips!");
                    return;
                }
                currentBalance = row.balance - bet;
                db.run(`UPDATE users SET balance = ? WHERE username = ?`, [currentBalance, username]);
            }

            socket.join(tableId);
            playerUsernames[socket.id] = username;
            playerBets[socket.id] = bet;

            socket.emit('updateBalance', currentBalance);

            if (!tableDecks[tableId]) {
                tableDecks[tableId] = new Deck();
                tableDecks[tableId].shuffle();
            }
            playerHands[socket.id] = [tableDecks[tableId].draw(), tableDecks[tableId].draw()];

            const score = calculateScore(playerHands[socket.id]);
            socket.emit('dealCards', { hand: playerHands[socket.id], score: score });
        });
    });

    // 2. HIT LOGIC
    socket.on('hit', (tableId) => {
        
        // 🕵️ NEW: Print exactly what the server sees to the terminal
        console.log(`Player ${socket.id} clicked HIT on ${tableId}`);
        console.log(`Does the table exist?`, !!tableDecks[tableId]);
        console.log(`Does the player have cards?`, !!playerHands[socket.id]);

        if (!tableDecks[tableId] || !playerHands[socket.id]) {
            socket.emit('gameStatus', "⚠️ Please place a bet to start a game!");
            return; 
        }

        const newCard = tableDecks[tableId].draw();

        if (!newCard) {
            socket.emit('gameStatus', "⚠️ The deck is out of cards! Please start a new hand.");
            return;
        }

        playerHands[socket.id].push(newCard);
        const currentScore = calculateScore(playerHands[socket.id]);
        socket.emit('dealCards', { hand: playerHands[socket.id], score: currentScore });

        if (currentScore > 21) {
            socket.emit('gameStatus', "💥 BUST! You lose your bet.");
            delete playerHands[socket.id]; 
        }
    });

    // 3. STAND & PAYOUT LOGIC
    socket.on('stand', (tableId) => {
        if (!tableDecks[tableId] || !playerHands[socket.id]) {
            socket.emit('gameStatus', "⚠️ Please place a bet to start a game!");
            return;
        }

        const playerScore = calculateScore(playerHands[socket.id]);
        if (playerScore > 21) return; 

        const dealerHand = [tableDecks[tableId].draw(), tableDecks[tableId].draw()];
        let dealerScore = calculateScore(dealerHand);

        while (dealerScore < 17) {
            const nextCard = tableDecks[tableId].draw();
            if (nextCard) {
                dealerHand.push(nextCard);
                dealerScore = calculateScore(dealerHand);
            } else {
                break; 
            }
        }

        socket.emit('dealerPlayed', { hand: dealerHand, score: dealerScore });

        const username = playerUsernames[socket.id];
        const bet = playerBets[socket.id];
        let payout = 0;
        let message = "";

        if (dealerScore > 21 || playerScore > dealerScore) {
            payout = bet * 2;
            message = `🎉 YOU WIN $${bet}!`;
        } else if (dealerScore > playerScore) {
            payout = 0;
            message = `💸 Dealer Wins. You lost $${bet}.`;
        } else {
            payout = bet;
            message = "🤝 PUSH. Your bet was returned.";
        }

        socket.emit('gameStatus', message);

        if (payout > 0) {
            db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
                const newBalance = row.balance + payout;
                db.run(`UPDATE users SET balance = ? WHERE username = ?`, [newBalance, username]);
                socket.emit('updateBalance', newBalance);
            });
        }

        delete playerHands[socket.id];
    });

    // --- GOD MODE ADMIN LOGIC ---
    
    // 1. Send all users to the admin dashboard
    socket.on('adminGetUsers', () => {
        db.all(`SELECT * FROM users ORDER BY balance DESC`, [], (err, rows) => {
            if (!err) {
                socket.emit('adminUserData', rows);
            }
        });
    });

    // 2. Inject chips into a specific user's account
    socket.on('adminAddChips', (data) => {
        const { targetUser, amount } = data;
        const numAmount = parseInt(amount);

        db.get(`SELECT balance FROM users WHERE username = ?`, [targetUser], (err, row) => {
            if (row) {
                const newBalance = row.balance + numAmount;
                db.run(`UPDATE users SET balance = ? WHERE username = ?`, [newBalance, targetUser]);
                
                // Blast a message to EVERYONE connected to update that specific player's screen
                io.emit('godModeUpdate', { username: targetUser, newBalance: newBalance, added: numAmount });
                
                // Refresh the admin's user list
                db.all(`SELECT * FROM users ORDER BY balance DESC`, [], (err, rows) => {
                    if (!err) socket.emit('adminUserData', rows);
                });
            }
        });
    });


    // --- LIVE CHAT LOGIC ---
    socket.on('sendChat', (data) => {
        const { tableId, username, message } = data;
        
        // io.to().emit broadcasts the message to everyone in that specific room
        io.to(tableId).emit('receiveChat', { username, message });
    });

    // 4. DISCONNECT LOGIC
    socket.on('disconnect', () => {
        console.log(`🔴 Player disconnected: ${socket.id}`);
        delete playerHands[socket.id];
        delete playerBets[socket.id];
        delete playerUsernames[socket.id];
    });
});

// --- START THE SERVER --- 
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🎰 Casino Server is running on http://localhost:${PORT}`);
});