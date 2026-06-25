const { WebSocketServer } = require('ws');
const http = require('http');

// Simple HTTP server to bind to
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kick Pool WebSocket Relay Server is running.\n');
});

const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomId -> { host: ws, guest: ws, hostTeam, guestTeam }
const privateRooms = new Map(); // roomCode -> { host: ws, hostTeam, gameMode }
let matchmakingQueue1v1 = []; // Array of { ws, team }
let matchmakingQueue3v3 = []; // Array of { ws, team }

// Helper to generate simple room IDs
function generateRoomId() {
  return Math.random().toString(36).substring(2, 9);
}

// Helper to generate 6-character private room codes
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.roomId = null;
  ws.role = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'join_queue':
          // Avoid duplicate entries
          matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
          matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);
          
          const isTactics = data.isTacticsMode === true;
          console.log(`Player joining ${isTactics ? '3v3' : '1v1'} queue with team: ${data.team}`);
          
          if (isTactics) {
            matchmakingQueue3v3.push({ ws, team: data.team });
            // Bug Fix 3: Confirm to client that they are registered in the queue
            ws.send(JSON.stringify({ type: 'queue_joined', mode: '3v3' }));
            checkAndMatchPlayers(matchmakingQueue3v3, true);
          } else {
            matchmakingQueue1v1.push({ ws, team: data.team });
            // Bug Fix 3: Confirm to client that they are registered in the queue
            ws.send(JSON.stringify({ type: 'queue_joined', mode: '1v1' }));
            checkAndMatchPlayers(matchmakingQueue1v1, false);
          }
          break;

        case 'leave_queue':
          matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
          matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);
          console.log('Player left queue');
          break;

        case 'create_room':
          const code = generateRoomCode();
          ws.roomId = code;
          ws.role = 'host';
          privateRooms.set(code, {
            host: ws,
            hostTeam: data.team,
            gameMode: data.gameMode || '1v1'
          });
          console.log(`Private Room created: ${code} (${data.gameMode || '1v1'})`);
          ws.send(JSON.stringify({
            type: 'room_created',
            roomCode: code
          }));
          break;

        case 'join_room':
          const joinCode = data.roomCode ? data.roomCode.toUpperCase().trim() : '';
          if (privateRooms.has(joinCode)) {
            const roomInfo = privateRooms.get(joinCode);
            ws.roomId = joinCode;
            ws.role = 'guest';
            
            // Move into active rooms list
            rooms.set(joinCode, {
              host: roomInfo.host,
              guest: ws,
              hostTeam: roomInfo.hostTeam,
              guestTeam: data.team
            });

            console.log(`Private match matched! Room: ${joinCode}. Host: ${roomInfo.hostTeam} vs Guest: ${data.team}`);

            // Notify P1 (Host)
            roomInfo.host.send(JSON.stringify({
              type: 'match_found',
              role: 'host',
              roomId: joinCode,
              opponentTeam: data.team,
              isTacticsMode: roomInfo.gameMode === '3v3'
            }));

            // Notify P2 (Guest)
            ws.send(JSON.stringify({
              type: 'match_found',
              role: 'guest',
              roomId: joinCode,
              opponentTeam: roomInfo.hostTeam,
              isTacticsMode: roomInfo.gameMode === '3v3'
            }));

            // Clear from pending private list
            privateRooms.delete(joinCode);
          } else {
            ws.send(JSON.stringify({
              type: 'room_error',
              message: 'Room not found or full'
            }));
          }
          break;

        case 'game_state':
        case 'goal_scored':
        case 'celebration':
        case 'reset_positions':
        case 'dead_ball':
          // Relay game events to the other client in the same room
          if (ws.roomId && rooms.has(ws.roomId)) {
            const room = rooms.get(ws.roomId);
            const opponent = ws.role === 'host' ? room.guest : room.host;
            if (opponent && opponent.readyState === 1) { // OPEN
              opponent.send(JSON.stringify(data));
            }
          }
          break;

        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    // Remove from queues if waiting
    matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
    matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);

    // Clean up private room hosts
    for (const [code, r] of privateRooms.entries()) {
      if (r.host === ws) {
        privateRooms.delete(code);
        console.log(`Waiting Private Room deleted: ${code}`);
      }
    }

    // Notify opponent if inside a room
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      const opponent = ws.role === 'host' ? room.guest : room.host;
      if (opponent && opponent.readyState === 1) {
        opponent.send(JSON.stringify({ type: 'opponent_disconnected' }));
      }
      rooms.delete(ws.roomId);
    }
  });
});

function checkAndMatchPlayers(queue, isTactics) {
  if (queue.length >= 2) {
    const player1 = queue.shift();
    const player2 = queue.shift();

    const roomId = generateRoomId();
    
    player1.ws.roomId = roomId;
    player1.ws.role = 'host';
    
    player2.ws.roomId = roomId;
    player2.ws.role = 'guest';

    rooms.set(roomId, {
      host: player1.ws,
      guest: player2.ws,
      hostTeam: player1.team,
      guestTeam: player2.team
    });

    console.log(`Match created! Mode: ${isTactics ? '3v3' : '1v1'}, Room ID: ${roomId}`);

    player1.ws.send(JSON.stringify({
      type: 'match_found',
      role: 'host',
      roomId: roomId,
      opponentTeam: player2.team,
      isTacticsMode: isTactics
    }));

    player2.ws.send(JSON.stringify({
      type: 'match_found',
      role: 'guest',
      roomId: roomId,
      opponentTeam: player1.team,
      isTacticsMode: isTactics
    }));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
