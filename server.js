const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

console.log("WebSocket server started on port 8080");

const clients = new Map(); 
let nextPlayerId = 1; 
const playerPositions = {}; // Stores last known positions { playerId: { x, y, map_id, hp, hp_max, daggers: [] } }

const MAX_PLAYERS_PER_LOBBY = 2;
const MULTIPLAYER_MAP_ID = "map19";
const lobbies = {}; // { "mapId": { players: [ws.id, ...], state: "waiting" | "starting" | "running", readyPlayers: Set() } }

function broadcastToLobby(lobbyId, message) {
    if (lobbies[lobbyId]) {
        lobbies[lobbyId].players.forEach(playerId => {
            const client = clients.get(playerId);
            if (client && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
}

function broadcastToMap(mapId, message, excludePlayerId = null) {
    clients.forEach((client, id) => {
        if (client.currentMap === mapId && client.readyState === WebSocket.OPEN) {
            if (excludePlayerId && id === excludePlayerId) {
                return;
            }
            client.send(JSON.stringify(message));
        }
    });
}


wss.on('connection', function connection(ws) {
    console.log("A new client connected (pending ID assignment).");
    ws.playerData = { x: 100, y: 100, hp: 100, hp_max: 100, daggers: [] }; // Initialize with daggers array
    ws.lastHitTimestamps = {}; // For player-specific hit cooldowns, key: attackerId, value: timestamp


    ws.on('message', function incoming(messageText) {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(messageText);
        } catch (e) {
            console.error("Failed to parse message as JSON:", messageText);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message format.' }));
            return;
        }
        
        console.log('Received from %s: %s', ws.id || '(unidentified)', parsedMessage.type);


        if (parsedMessage.type === 'join_map' && parsedMessage.map_id) {
            let assignedPlayerId = ws.id; // Preserve ID if client is already known (e.g. rejoining same map)
            
            if (!assignedPlayerId) { // If client doesn't have an ID yet (new connection or new map join)
                if (parsedMessage.requestedPlayerId) {
                    const reqId = parsedMessage.requestedPlayerId;
                    if (clients.has(reqId)) {
                        const existingClient = clients.get(reqId);
                        // Check if the existing client is the same WebSocket connection or if it's stale
                        if (existingClient === ws) { // Same client, perhaps re-joining or sending join_map again
                            assignedPlayerId = reqId;
                            console.log(`Client ${reqId} (existing connection) re-confirmed ID.`);
                        } else if (existingClient.readyState !== WebSocket.OPEN) {
                            console.log(`Reclaiming ID ${reqId} from stale connection (readyState: ${existingClient.readyState}). Removing old client.`);
                            clients.delete(reqId); // Remove stale client
                            assignedPlayerId = reqId;
                        } else {
                            console.log(`Requested ID ${reqId} is actively in use by another client. Assigning new ID.`);
                            assignedPlayerId = `player_${nextPlayerId++}`;
                        }
                    } else {
                        assignedPlayerId = reqId;
                        console.log(`Using requested (new or available) ID ${assignedPlayerId}.`);
                    }
                } else {
                    assignedPlayerId = `player_${nextPlayerId++}`;
                    console.log(`No requested ID. Assigned new ID ${assignedPlayerId}.`);
                }
            }
            
            ws.id = assignedPlayerId;
            clients.set(ws.id, ws); // Add or update client in the map

            console.log(`Client ${ws.id} is joining map: ${parsedMessage.map_id}`);
            ws.currentMap = parsedMessage.map_id;
            
            if (parsedMessage.initialX !== undefined) ws.playerData.x = parsedMessage.initialX;
            if (parsedMessage.initialY !== undefined) ws.playerData.y = parsedMessage.initialY;
            // hp and hp_max are part of ws.playerData initialization
            if (parsedMessage.daggers && Array.isArray(parsedMessage.daggers)) {
                ws.playerData.daggers = parsedMessage.daggers; // Store dagger configuration
            }
            // Update playerPositions with the latest data, including daggers
            playerPositions[ws.id] = { ...ws.playerData, id: ws.id, map_id: ws.currentMap };


            const playersOnMap = [];
            clients.forEach((client, id) => {
                // Only include other clients on the same map
                if (client.currentMap === ws.currentMap && id !== ws.id && playerPositions[id]) {
                    playersOnMap.push({ playerId: id, playerData: playerPositions[id] });
                }
            });

            if (ws.currentMap === MULTIPLAYER_MAP_ID) {
                if (!lobbies[MULTIPLAYER_MAP_ID]) {
                    lobbies[MULTIPLAYER_MAP_ID] = { players: [], state: "waiting", readyPlayers: new Set() };
                }
                const lobby = lobbies[MULTIPLAYER_MAP_ID];

                if (lobby.state === "waiting" && lobby.players.length < MAX_PLAYERS_PER_LOBBY) {
                    if (!lobby.players.includes(ws.id)) {
                        lobby.players.push(ws.id);
                    }
                    ws.send(JSON.stringify({
                        type: "map_joined_ack",
                        status: "success",
                        map_id: ws.currentMap,
                        yourId: ws.id,
                        existingPlayers: playersOnMap, 
                        lobbyPlayerCount: lobby.players.length,
                        lobbyMaxPlayers: MAX_PLAYERS_PER_LOBBY
                    }));

                    broadcastToLobby(MULTIPLAYER_MAP_ID, {
                        type: "lobby_update",
                        playerCount: lobby.players.length,
                        maxPlayers: MAX_PLAYERS_PER_LOBBY
                    });
                    
                    // Inform existing players in lobby about the new joiner
                    // This ensures new player appears for those already in lobby
                    lobby.players.forEach(pid => {
                        if (pid !== ws.id) {
                            const pClient = clients.get(pid);
                            if (pClient) {
                                pClient.send(JSON.stringify({
                                    type: "player_joined",
                                    playerId: ws.id,
                                    mapId: ws.currentMap, // Ensure mapId is included
                                    playerData: playerPositions[ws.id] // Send full data of new player
                                }));
                            }
                        }
                    });


                    if (lobby.players.length === MAX_PLAYERS_PER_LOBBY) {
                        lobby.state = "starting";
                        console.log(`Lobby ${MULTIPLAYER_MAP_ID} is full. Instructing clients to load match.`);
                        const lobbyPlayersData = lobby.players.map(pid => ({playerId: pid, playerData: playerPositions[pid]}));
                        broadcastToLobby(MULTIPLAYER_MAP_ID, {
                            type: "load_match",
                            map_id: MULTIPLAYER_MAP_ID,
                            existingPlayers: lobbyPlayersData
                        });
                    }
                } else {
                    ws.send(JSON.stringify({ type: "error", message: "Lobby is full or game already started." }));
                }
            } else { // Single player map or non-lobby multiplayer map
                ws.send(JSON.stringify({
                    type: 'map_joined_ack',
                    map_id: parsedMessage.map_id,
                    status: 'success',
                    yourId: ws.id,
                    existingPlayers: playersOnMap
                }));
                // Inform other players on the same non-lobby map about this new player
                broadcastToMap(ws.currentMap, {
                    type: 'player_joined',
                    playerId: ws.id,
                    mapId: ws.currentMap,
                    playerData: playerPositions[ws.id]
                }, ws.id); // Exclude self
            }
            
            // No separate "welcome" message needed here as map_joined_ack serves that purpose

        } else if (parsedMessage.type === 'player_update') {
            if (!ws.id) {
                console.warn("Player update received from client without an ID (hasn't joined map yet). Ignoring.");
                return;
            }
            // Update server's record of player's state
            if (parsedMessage.data) {
                for (const key in parsedMessage.data) {
                    if (ws.playerData.hasOwnProperty(key) || ['x', 'y', 'hp', 'hp_max', 'daggers'].includes(key)) {
                        ws.playerData[key] = parsedMessage.data[key];
                    }
                }
                // Update playerPositions as well
                if (playerPositions[ws.id]) {
                    Object.assign(playerPositions[ws.id], ws.playerData);
                } else {
                     playerPositions[ws.id] = { ...ws.playerData, id: ws.id, map_id: ws.currentMap };
                }
            }

            // Broadcast this update to other relevant clients
            clients.forEach(function each(otherClient) {
                if (otherClient.id !== ws.id && otherClient.readyState === WebSocket.OPEN && otherClient.currentMap === ws.currentMap) {
                    // Send only necessary data for game_state_update
                    const updateData = { id: ws.id, x: ws.playerData.x, y: ws.playerData.y, hp: ws.playerData.hp, hp_max: ws.playerData.hp_max };
                    // If daggers can change mid-game and need sync, include them. For now, position and HP.
                    // if (ws.playerData.daggers) updateData.daggers = ws.playerData.daggers; 
                    otherClient.send(JSON.stringify({ type: 'game_state_update', playerData: updateData }));
                }
            });
        } else if (parsedMessage.type === 'hit_player') {
            if (!ws.id || !ws.currentMap) {
                console.warn("hit_player from unidentified or mapless client.");
                return;
            }
            const targetId = parsedMessage.targetId;
            const damage = parsedMessage.damage;

            if (!targetId || damage === undefined) {
                console.warn("Malformed hit_player message:", parsedMessage);
                return;
            }

            const targetClient = clients.get(targetId);
            if (!targetClient || targetClient.currentMap !== ws.currentMap || !targetClient.playerData || targetClient.playerData.hp <= 0) {
                return; 
            }

            const now = Date.now();
            if (!targetClient.lastHitBy) targetClient.lastHitBy = {};
            if (targetClient.lastHitBy[ws.id] && (now - targetClient.lastHitBy[ws.id] < 800)) { 
                return; 
            }
            targetClient.lastHitBy[ws.id] = now;

            targetClient.playerData.hp -= damage;
            let targetDied = false;
            if (targetClient.playerData.hp <= 0) {
                targetClient.playerData.hp = 0;
                targetDied = true;
                console.log(`Player ${targetId} killed by ${ws.id}`);
            }
            // Update playerPositions for the target
             if (playerPositions[targetId]) {
                playerPositions[targetId].hp = targetClient.playerData.hp;
            }


            console.log(`Player ${ws.id} hit ${targetId} for ${damage} damage. ${targetId} HP: ${targetClient.playerData.hp}`);

            const hpUpdateMessage = {
                type: 'hp_update',
                playerId: targetId,
                hp: targetClient.playerData.hp,
                hp_max: targetClient.playerData.hp_max, 
                attackerId: ws.id
            };
            broadcastToMap(ws.currentMap, hpUpdateMessage);

            if (targetDied) {
                const deathMessage = { type: 'player_died', playerId: targetId, killerId: ws.id };
                broadcastToMap(ws.currentMap, deathMessage);
            }
        } else if (parsedMessage.type === 'action_spin_change') {
            if (!ws.id || !ws.playerData.daggers || !ws.playerData.daggers[parsedMessage.daggerIndex]) {
                console.warn("Invalid action_spin_change message:", parsedMessage, "from client:", ws.id);
                return;
            }
            ws.playerData.daggers[parsedMessage.daggerIndex].spin = parsedMessage.newSpin;
            if(playerPositions[ws.id]) { // Also update in playerPositions
                playerPositions[ws.id].daggers = ws.playerData.daggers;
            }
            
            const spinUpdateMessage = {
                type: 'dagger_spin_update',
                playerId: ws.id,
                daggerIndex: parsedMessage.daggerIndex,
                newSpin: parsedMessage.newSpin
            };
            broadcastToMap(ws.currentMap, spinUpdateMessage, ws.id); // Exclude self
        } else if (parsedMessage.type === 'match_assets_ready') {
            if (ws.currentMap === MULTIPLAYER_MAP_ID && lobbies[MULTIPLAYER_MAP_ID] && lobbies[MULTIPLAYER_MAP_ID].state === "starting") {
                const lobby = lobbies[MULTIPLAYER_MAP_ID];
                lobby.readyPlayers.add(ws.id);
                console.log(`Player ${ws.id} is ready for match on ${MULTIPLAYER_MAP_ID}. Total ready: ${lobby.readyPlayers.size}/${lobby.players.length}`);

                if (lobby.readyPlayers.size === lobby.players.length) {
                    console.log(`All players ready for match ${MULTIPLAYER_MAP_ID}. Starting simulation.`);
                    lobby.state = "running";
                    broadcastToLobby(MULTIPLAYER_MAP_ID, { type: "start_match_simulation" });
                }
            } else {
                console.warn(`Received match_assets_ready from ${ws.id} but not in a starting lobby for ${MULTIPLAYER_MAP_ID}. Current lobby:`, lobbies[MULTIPLAYER_MAP_ID]);
            }
        }
    });

    ws.on('close', () => {
        const playerId = ws.id;
        if (playerId) {
            console.log(`Client ${playerId} disconnected.`);
            const disconnectedPlayerMap = ws.currentMap; // Store map before modifying ws
            clients.delete(playerId);
            delete playerPositions[playerId];

            if (disconnectedPlayerMap === MULTIPLAYER_MAP_ID && lobbies[MULTIPLAYER_MAP_ID]) {
                const lobby = lobbies[MULTIPLAYER_MAP_ID];
                const playerIndex = lobby.players.indexOf(playerId);
                if (playerIndex > -1) {
                    lobby.players.splice(playerIndex, 1);
                    lobby.readyPlayers.delete(playerId);

                    if (lobby.state === "waiting" || lobby.state === "starting") {
                         broadcastToLobby(MULTIPLAYER_MAP_ID, {
                            type: "lobby_update",
                            playerCount: lobby.players.length,
                            maxPlayers: MAX_PLAYERS_PER_LOBBY
                        });
                        // Inform remaining lobby members that a player left
                        broadcastToLobby(MULTIPLAYER_MAP_ID, { type: "player_left", playerId: playerId });


                        if (lobby.players.length === 0 && lobby.state !== "running") {
                            console.log(`Lobby ${MULTIPLAYER_MAP_ID} is now empty. Deleting lobby.`);
                            delete lobbies[MULTIPLAYER_MAP_ID];
                        } else if (lobby.state === "starting" && lobby.players.length < MAX_PLAYERS_PER_LOBBY) {
                            console.log(`Player left during 'starting' phase of lobby ${MULTIPLAYER_MAP_ID}. Reverting to 'waiting'.`);
                            lobby.state = "waiting";
                            lobby.readyPlayers.clear(); 
                             broadcastToLobby(MULTIPLAYER_MAP_ID, {
                                type: "lobby_update", 
                                playerCount: lobby.players.length,
                                maxPlayers: MAX_PLAYERS_PER_LOBBY,
                                statusText: "A player left, waiting for more..." 
                            });
                        }
                    } else if (lobby.state === "running") {
                        broadcastToMap(disconnectedPlayerMap, { type: "player_left", playerId: playerId });
                    }
                }
                 if (lobby.players.length === 0) { 
                    delete lobbies[MULTIPLAYER_MAP_ID];
                    console.log(`Lobby ${MULTIPLAYER_MAP_ID} is empty and has been removed.`);
                }
            } else if (disconnectedPlayerMap) { 
                 broadcastToMap(disconnectedPlayerMap, { type: 'player_left', playerId: playerId });
            }
        } else {
            console.log("An un-identified client disconnected.");
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error on client ${ws.id || 'unidentified'}:`, error);
        if (ws.id && clients.has(ws.id)) {
            const erroredClient = clients.get(ws.id);
            if (erroredClient === ws) { 
                const erroredPlayerId = ws.id;
                const erroredPlayerMap = ws.currentMap;
                clients.delete(ws.id);
                clients.forEach(function each(otherClient) {
                    if (otherClient.readyState === WebSocket.OPEN && otherClient.currentMap === erroredPlayerMap) {
                        otherClient.send(JSON.stringify({ type: 'player_left', playerId: erroredPlayerId, reason: 'error' }));
                    }
                });
            } else {
                console.log(`Error event for ID ${ws.id}, but the ws object in clients map is different. Stale error?`);
            }
        }
    });
});

console.log("WebSocket server setup complete. Waiting for connections...");

// To run this server:
// 1. Make sure you have Node.js installed.
// 2. Save this file as server.js in your project directory.
// 3. Open a terminal in that directory.
// 4. Run `npm init -y` (if you haven't already, to create a package.json).
// 5. Run `npm install ws` (and `npm install uuid` if you use it).
// 6. Run `node server.js`.
