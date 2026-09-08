import os
with open("server.js", "r", encoding="utf-8") as f:
    content = f.read()

sy_logic = """
// ==========================================
// ??? SCOTLAND YARD ENGINE
// ==========================================
const fs = require("fs");
let syGraph = {};
try {
    const connData = fs.readFileSync("public/data/connections.txt", "utf8");
    connData.split("\\n").forEach(line => {
        let p = line.trim().split(" ");
        if(p.length >= 3) {
            let n1 = parseInt(p[0]), n2 = parseInt(p[1]), type = p[2];
            if(!syGraph[n1]) syGraph[n1] = [];
            if(!syGraph[n2]) syGraph[n2] = [];
            syGraph[n1].push({ to: n2, type });
            syGraph[n2].push({ to: n1, type });
        }
    });
} catch(e) { console.error("Scotland Yard Graph not loaded"); }

let syRooms = {};

function broadcastSyState(tableId) {
    let table = syRooms[tableId];
    if(!table) return;

    let safePlayers = table.players.map(p => ({
        username: p.username,
        role: p.role,
        node: (p.role === "mrX" && !p.isRevealed) ? -1 : p.node,
        tickets: p.tickets
    }));

    let currentTurnUser = table.players.length > 0 ? table.players[table.turnIndex].username : "";

    io.to(tableId).emit("syStateUpdate", {
        stage: table.stage,
        pot: table.pot,
        currentTurnUser,
        mrXLog: table.mrXLog,
        winner: table.winner,
        players: safePlayers
    });
}

io.on("connection", socket => {
    socket.on("joinScotlandYard", async (data) => {
        const { tableId, username } = data;
        socket.join(tableId);
        
        if(!syRooms[tableId]) {
            syRooms[tableId] = { stage: "waiting", pot: 0, players: [], turnIndex: 0, mrXLog: [], turnCount: 0, winner: null };
        }
        let table = syRooms[tableId];

        // Ensure user has balance
        try {
            let bal = await getUserBalance(username);
            if(bal < 5000) {
                return socket.emit("receiveChat", { username: "SYSTEM", message: `? You need ?5000 to join.`});
            }
            // Add if not already in
            if(!table.players.find(p => p.username === username)) {
                // Deduct buy-in
                await updateBalance(username, bal - 5000);
                table.pot += 5000;
                
                table.players.push({
                    username,
                    socketId: socket.id,
                    role: table.players.length === 0 ? "mrX" : "detective",
                    node: -1,
                    isRevealed: false,
                    tickets: table.players.length === 0 
                        ? { taxi: 100, bus: 100, underground: 100, black: 5 } // Mr X gets unlimited normal, 5 black
                        : { taxi: 10, bus: 8, underground: 4, black: 0 }
                });
                io.emit("triggerChartUpdate");
            } else {
                // Update socket id
                table.players.find(p => p.username === username).socketId = socket.id;
            }
            broadcastSyState(tableId);
        } catch(e){}
    });

    socket.on("startSyGame", (data) => {
        let table = syRooms[data.tableId];
        if(table && table.players.length >= 2 && table.stage === "waiting") {
            table.stage = "playing";
            // Assign random start nodes (simplification: 1 to 199, distinct)
            let usedNodes = new Set();
            table.players.forEach(p => {
                let r;
                do { r = Math.floor(Math.random() * 199) + 1; } while(usedNodes.has(r));
                usedNodes.add(r);
                p.node = r;
                if(p.role === "mrX") p.isRevealed = true; // Reveal at start is standard? No, Mr X is hidden at start.
                if(p.role === "mrX") p.isRevealed = false;
            });
            table.turnIndex = 0; // Mr X goes first
            broadcastSyState(data.tableId);
            io.to(data.tableId).emit("receiveChat", { username: "SYSTEM", message: `?? The hunt for Mr. X begins!`});
        }
    });

    socket.on("syMove", async (data) => {
        const { tableId, toNode, ticketType } = data;
        let table = syRooms[tableId];
        let pIndex = table.players.findIndex(p => p.socketId === socket.id);
        if(!table || pIndex === -1 || pIndex !== table.turnIndex) return;
        
        let p = table.players[pIndex];
        
        // Validate move
        let nodeGraph = syGraph[p.node];
        let validEdge = nodeGraph && nodeGraph.find(e => e.to === toNode && e.type === ticketType);
        
        // Black ticket can be used on any transport type
        let isBlackTicket = ticketType === "black";
        if(isBlackTicket) {
            validEdge = nodeGraph && nodeGraph.find(e => e.to === toNode);
        }

        if(validEdge && p.tickets[ticketType] > 0) {
            // Check if detective is moving to a node occupied by another detective
            if(p.role === "detective") {
                let occupied = table.players.find(other => other.role === "detective" && other.username !== p.username && other.node === toNode);
                if(occupied) return io.to(socket.id).emit("receiveChat", { username: "SYSTEM", message: `? Node occupied by another detective.`});
            }

            p.tickets[ticketType]--;
            p.node = toNode;

            if(p.role === "mrX") {
                table.turnCount++;
                let revealTurns = [3, 8, 13, 18, 24];
                p.isRevealed = revealTurns.includes(table.turnCount);
                
                table.mrXLog.push({ ticket: ticketType, node: p.isRevealed ? p.node : -1 });
                io.to(tableId).emit("receiveChat", { username: "SYSTEM", message: `?? Mr. X used a ${ticketType.toUpperCase()} ticket.`});
                if(p.isRevealed) io.to(tableId).emit("receiveChat", { username: "SYSTEM", message: `?? Mr. X revealed at node ${p.node}!`});
            } else {
                // Give used ticket to Mr X
                let mrX = table.players.find(x => x.role === "mrX");
                mrX.tickets[ticketType]++;
                io.to(tableId).emit("receiveChat", { username: "SYSTEM", message: `?? ${p.username} moved to ${toNode} via ${ticketType.toUpperCase()}.`});
            }

            // Check Win Condition: Detectives catch Mr X
            let mrX = table.players.find(x => x.role === "mrX");
            let caught = table.players.some(d => d.role === "detective" && d.node === mrX.node);
            
            if(caught) {
                table.stage = "finished";
                table.winner = "Detectives";
                io.to(tableId).emit("receiveChat", { username: "SYSTEM", message: `?? Mr. X CAUGHT! Detectives win ?${table.pot}!`});
                
                let detectives = table.players.filter(d => d.role === "detective");
                let split = Math.floor(table.pot / detectives.length);
                for(let d of detectives) {
                    try {
                        let bal = await getUserBalance(d.username);
                        await updateBalance(d.username, bal + split);
                    } catch(e){}
                }
                io.emit("triggerChartUpdate");
            } else if (table.turnCount >= 24 && table.turnIndex === table.players.length - 1) {
                // Mr X survived
                table.stage = "finished";
                table.winner = "Mr. X";
                io.to(tableId).emit("receiveChat", { username: "SYSTEM", message: `?? Mr. X EVADED CAPTURE! Mr. X wins ?${table.pot}!`});
                try {
                    let bal = await getUserBalance(mrX.username);
                    await updateBalance(mrX.username, bal + table.pot);
                    io.emit("triggerChartUpdate");
                } catch(e){}
            } else {
                // Next turn
                do {
                    table.turnIndex = (table.turnIndex + 1) % table.players.length;
                } while (table.players[table.turnIndex].role === "detective" && 
                         Object.values(table.players[table.turnIndex].tickets).reduce((a,b)=>a+b, 0) === 0);
            }

            broadcastSyState(tableId);
        } else {
            io.to(socket.id).emit("receiveChat", { username: "SYSTEM", message: `? Invalid move or out of tickets.`});
        }
    });
});

"""

content = content.replace("const PORT = process.env.PORT || 3000;", sy_logic + "\\nconst PORT = process.env.PORT || 3000;")

with open("server.js", "w", encoding="utf-8") as f:
    f.write(content)

