const socket = io();
let username = "";
let currentTable = "";
let myRole = "";
let myNode = -1;
let gameState = null;

const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('mapContainer');

let transform = { x: 0, y: 0, scale: 0.5 };
let isDragging = false;
let dragStart = { x: 0, y: 0 };

let stations = {};
let edges = [];

const colors = {
    'taxi': '#f1c40f',
    'bus': '#1abc9c',
    'underground': '#e74c3c',
    'water': '#000000',
    'black': '#2c3e50'
};

async function loadMapData() {
    try {
        const stRes = await fetch('/data/stations.txt');
        const stText = await stRes.text();
        stText.split('\n').forEach(line => {
            let parts = line.trim().split(' ');
            if(parts.length >= 4) {
                stations[parts[0]] = {
                    x: parseInt(parts[1]) * 1.5, // scale up slightly for better spacing
                    y: parseInt(parts[2]) * 1.5,
                    types: parts[3].split(',')
                };
            }
        });

        const connRes = await fetch('/data/connections.txt');
        const connText = await connRes.text();
        connText.split('\n').forEach(line => {
            let parts = line.trim().split(' ');
            if(parts.length >= 3) {
                edges.push({
                    from: parts[0],
                    to: parts[1],
                    type: parts[2]
                });
            }
        });
        
        resizeCanvas();
        // center map approximately
        transform.x = canvas.width / 2 - 1000 * transform.scale;
        transform.y = canvas.height / 2 - 500 * transform.scale;
        drawMap();
    } catch (e) {
        console.error("Failed to load map data", e);
    }
}

function resizeCanvas() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    drawMap();
}
window.addEventListener('resize', resizeCanvas);

// Pan & Zoom logic
container.addEventListener('mousedown', e => {
    isDragging = true;
    dragStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
});
window.addEventListener('mouseup', () => isDragging = false);
window.addEventListener('mousemove', e => {
    if(!isDragging) return;
    transform.x = e.clientX - dragStart.x;
    transform.y = e.clientY - dragStart.y;
    drawMap();
});
container.addEventListener('wheel', e => {
    e.preventDefault();
    const zoomIntensity = 0.1;
    const wheel = e.deltaY < 0 ? 1 : -1;
    const zoom = Math.exp(wheel * zoomIntensity);
    
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    transform.x = mouseX - (mouseX - transform.x) * zoom;
    transform.y = mouseY - (mouseY - transform.y) * zoom;
    transform.scale *= zoom;
    
    drawMap();
});

function drawMap() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);
    
    // Draw edges
    edges.forEach(e => {
        const s1 = stations[e.from];
        const s2 = stations[e.to];
        if(!s1 || !s2) return;
        
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.strokeStyle = colors[e.type] || '#fff';
        ctx.lineWidth = 4;
        ctx.stroke();
    });
    
    // Draw stations
    Object.keys(stations).forEach(id => {
        const s = stations[id];
        ctx.beginPath();
        ctx.arc(s.x, s.y, 16, 0, Math.PI * 2);
        ctx.fillStyle = '#222';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.fillStyle = '#fff';
        ctx.font = '14px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(id, s.x, s.y);
    });

    // Draw players
    if (gameState && gameState.players) {
        gameState.players.forEach(p => {
            if(p.node === -1 || !stations[p.node]) return; // hidden or invalid
            const s = stations[p.node];
            
            // Draw highlight if it's their turn
            if(gameState.currentTurnUser === p.username) {
                ctx.beginPath();
                ctx.arc(s.x, s.y, 25, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(46, 204, 113, 0.5)';
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(s.x, s.y, 10, 0, Math.PI * 2);
            ctx.fillStyle = p.role === 'mrX' ? 'black' : '#2980b9';
            ctx.fill();
            ctx.strokeStyle = p.role === 'mrX' ? 'red' : 'white';
            ctx.lineWidth = 3;
            ctx.stroke();
            
            ctx.fillStyle = '#fff';
            ctx.font = '16px Arial';
            ctx.fillText(p.username, s.x, s.y - 25);
        });
    }

    ctx.restore();
}

// Map Click
canvas.addEventListener('click', e => {
    if(!gameState || gameState.stage !== 'playing') return;
    if(gameState.currentTurnUser !== username) {
        return logAction("Not your turn!");
    }

    const rect = container.getBoundingClientRect();
    const x = (e.clientX - rect.left - transform.x) / transform.scale;
    const y = (e.clientY - rect.top - transform.y) / transform.scale;
    
    let clickedNode = null;
    Object.keys(stations).forEach(id => {
        const s = stations[id];
        if(Math.hypot(s.x - x, s.y - y) < 20) clickedNode = id;
    });

    if(clickedNode) {
        // Find which tickets are valid to reach clickedNode from myNode
        let validTypes = edges.filter(e => 
            (e.from == myNode && e.to == clickedNode) || 
            (e.to == myNode && e.from == clickedNode)
        ).map(e => e.type);

        if(validTypes.length === 0) {
            return logAction("Invalid move: nodes not connected.");
        }
        
        let chosenTicket = validTypes[0]; // defaults to first available
        if(validTypes.length > 1) {
            // Very simple prompt, could be a custom UI modal
            const typeList = validTypes.join(', ');
            let input = prompt(`Multiple routes available (${typeList}). Enter ticket type to use:`);
            if(!input || !validTypes.includes(input.toLowerCase().trim())) {
                return logAction("Move cancelled or invalid ticket type entered.");
            }
            chosenTicket = input.toLowerCase().trim();
        }

        socket.emit('syMove', { tableId: currentTable, toNode: parseInt(clickedNode), ticketType: chosenTicket });
    }
});

function joinGame() {
    username = document.getElementById('usernameInput').value;
    currentTable = document.getElementById('roomInput').value;
    if(!username) return alert("Enter username");
    
    socket.emit('joinScotlandYard', { tableId: currentTable, username });
}

function startGame() {
    socket.emit('startSyGame', { tableId: currentTable });
}

function logAction(msg) {
    const log = document.getElementById('actionLog');
    const div = document.createElement('div');
    div.innerText = `> ${msg}`;
    div.style.marginBottom = "5px";
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

// Socket events
socket.on('syStateUpdate', (data) => {
    gameState = data;
    
    if (data.stage === 'waiting') {
        document.getElementById('setupPanel').style.display = 'block';
        document.getElementById('gameUI').style.display = 'none';
        
        let pList = data.players.map(p => p.username).join(', ');
        document.getElementById('lobbyStatus').innerText = `Players: ${pList}`;
        
        if (data.players.length >= 2 && data.players[0].username === username) {
            document.getElementById('btnStartGame').style.display = 'inline-block';
        }
    } else {
        document.getElementById('setupPanel').style.display = 'none';
        document.getElementById('gameUI').style.display = 'block';
        
        // Ensure canvas is sized correctly now that it's visible
        if (canvas.width === 0 || canvas.height === 0) {
            resizeCanvas();
        }
        
        document.getElementById('potAmount').innerText = `₹${data.pot}`;
        
        // Update Turn Indicator
        const ind = document.getElementById('turnIndicator');
        if (data.stage === 'finished') {
            ind.innerText = `GAME OVER - ${data.winner}`;
            ind.className = "text-gold";
        } else {
            if (data.currentTurnUser === username) {
                ind.innerText = "YOUR TURN";
                ind.className = "text-green";
            } else {
                ind.innerText = `Waiting for ${data.currentTurnUser}...`;
                ind.className = "text-muted";
            }
        }
        
        // Update Player List
        let phtml = "";
        data.players.forEach(p => {
            let color = p.role === 'mrX' ? '#e74c3c' : '#3498db';
            phtml += `<div style="color: ${color}; margin-bottom: 5px;">
                ${p.username} ${p.username === data.currentTurnUser ? '👈' : ''}
            </div>`;
            
            if (p.username === username) {
                myRole = p.role;
                myNode = p.node;
                
                document.getElementById('myRole').innerText = p.role === 'mrX' ? 'Mr. X' : 'Detective';
                document.getElementById('myRole').className = `role-badge ${p.role === 'mrX' ? 'role-mrx' : 'role-detective'}`;
                document.getElementById('currentNode').innerText = p.node === -1 ? 'Hidden' : p.node;
                
                // Render tickets
                let thtml = "";
                Object.keys(p.tickets).forEach(t => {
                    thtml += `<div class="ticket ${t}">${t.charAt(0).toUpperCase()}: ${p.tickets[t]}</div>`;
                });
                document.getElementById('myTickets').innerHTML = thtml;
            }
        });
        document.getElementById('playerList').innerHTML = phtml;

        // Render Mr X Travel Log
        let logHtml = "";
        for(let i=1; i<=24; i++) {
            let entry = data.mrXLog[i-1];
            let isReveal = [3, 8, 13, 18, 24].includes(i);
            let cssClass = `tracker-slot ${isReveal ? 'reveal' : ''}`;
            
            let content = i;
            if(entry) {
                content = `<div style="width: 15px; height: 15px; border-radius: 50%; background: ${colors[entry.ticket]};"></div>`;
                if(isReveal && entry.node !== -1) {
                    content += `<span style="font-size:10px; margin-left: 2px;">${entry.node}</span>`;
                }
            }
            logHtml += `<div class="${cssClass}" title="Turn ${i}">${content}</div>`;
        }
        document.getElementById('mrXTracker').innerHTML = logHtml;

        drawMap();
    }
});

socket.on('receiveChat', (data) => {
    logAction(data.message);
});

// Init
loadMapData();
