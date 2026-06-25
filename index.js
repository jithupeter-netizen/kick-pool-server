const { WebSocketServer } = require('ws');
const http = require('http');

// ─────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kick Pool WebSocket Server v2.1 — Custom Physics Active (no external deps).\n');
});

const wss = new WebSocketServer({ server });

// ─────────────────────────────────────────────────────────────────
// Physics constants — exactly matching Flutter's Forge2D values
// ─────────────────────────────────────────────────────────────────
const BALL_RADIUS     = 1.5;
const STRIKER_RADIUS  = 3.0;
const BALL_DAMPING    = 0.55;   // per-second linear damping
const WALL_RESTITUTION = 0.95;
const BALL_RESTITUTION = 0.95;
const STRIKER_RESTITUTION = 1.2;

// Pitch boundaries (matching Flutter exactly)
const LEFT_X   = -21.0;
const RIGHT_X  =  21.0;
const TOP_Y    = -36.5;
const BOTTOM_Y =  36.5;
const GOAL_LEFT  = -8.0;
const GOAL_RIGHT =  8.0;
const GOAL_TOP_NET_Y    = -39.9; // back of top goal
const GOAL_BOTTOM_NET_Y =  39.9; // back of bottom goal

const TICK_RATE  = 60;           // Hz — physics update rate
const TICK_DT    = 1.0 / TICK_RATE;
const GOAL_RESET_MS   = 3000;   // celebration time before reset
const DEAD_BALL_MS    = 5000;   // ms before dead ball reset
const DEAD_BALL_SPEED = 0.1;    // speed below which ball is "stopped"
const DEAD_BALL_ZONE  = 23.5;   // |y| < this = unreachable middle

// ─────────────────────────────────────────────────────────────────
// Simple custom 2D physics (no external library required)
// ─────────────────────────────────────────────────────────────────

function clampBallToWalls(ball) {
  // Side walls (always solid)
  if (ball.x - BALL_RADIUS < LEFT_X) {
    ball.x = LEFT_X + BALL_RADIUS;
    if (ball.vx < 0) ball.vx *= -WALL_RESTITUTION;
  }
  if (ball.x + BALL_RADIUS > RIGHT_X) {
    ball.x = RIGHT_X - BALL_RADIUS;
    if (ball.vx > 0) ball.vx *= -WALL_RESTITUTION;
  }

  // Top wall — solid outside goal opening, goal inside
  if (ball.y - BALL_RADIUS < TOP_Y) {
    const inGoal = ball.x > GOAL_LEFT && ball.x < GOAL_RIGHT;
    if (!inGoal) {
      // Hit solid top wall
      ball.y = TOP_Y + BALL_RADIUS;
      if (ball.vy < 0) ball.vy *= -WALL_RESTITUTION;
    }
  }

  // Bottom wall — solid outside goal opening, goal inside
  if (ball.y + BALL_RADIUS > BOTTOM_Y) {
    const inGoal = ball.x > GOAL_LEFT && ball.x < GOAL_RIGHT;
    if (!inGoal) {
      ball.y = BOTTOM_Y - BALL_RADIUS;
      if (ball.vy > 0) ball.vy *= -WALL_RESTITUTION;
    }
  }

  // Goal net back walls (if ball entered the goal)
  if (ball.y < GOAL_TOP_NET_Y) {
    ball.y = GOAL_TOP_NET_Y + BALL_RADIUS;
    if (ball.vy < 0) ball.vy *= -WALL_RESTITUTION;
  }
  if (ball.y > GOAL_BOTTOM_NET_Y) {
    ball.y = GOAL_BOTTOM_NET_Y - BALL_RADIUS;
    if (ball.vy > 0) ball.vy *= -WALL_RESTITUTION;
  }

  // Goal side posts (left and right edges of goal mouth)
  for (const gx of [GOAL_LEFT, GOAL_RIGHT]) {
    // Top goal post
    if (ball.y < TOP_Y) {
      const dx = ball.x - gx;
      const dy = ball.y - TOP_Y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < BALL_RADIUS && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        ball.x += nx * (BALL_RADIUS - dist);
        ball.y += ny * (BALL_RADIUS - dist);
        const dot = ball.vx * nx + ball.vy * ny;
        if (dot < 0) {
          ball.vx -= (1 + WALL_RESTITUTION) * dot * nx;
          ball.vy -= (1 + WALL_RESTITUTION) * dot * ny;
        }
      }
    }
    // Bottom goal post
    if (ball.y > BOTTOM_Y) {
      const dx = ball.x - gx;
      const dy = ball.y - BOTTOM_Y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < BALL_RADIUS && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        ball.x += nx * (BALL_RADIUS - dist);
        ball.y += ny * (BALL_RADIUS - dist);
        const dot = ball.vx * nx + ball.vy * ny;
        if (dot < 0) {
          ball.vx -= (1 + WALL_RESTITUTION) * dot * nx;
          ball.vy -= (1 + WALL_RESTITUTION) * dot * ny;
        }
      }
    }
  }
}

function resolveStrikerBall(striker, ball) {
  const dx  = ball.x - striker.x;
  const dy  = ball.y - striker.y;
  const distSq = dx * dx + dy * dy;
  const minDist = BALL_RADIUS + STRIKER_RADIUS;

  if (distSq >= minDist * minDist || distSq === 0) return;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;

  // Relative velocity of ball w.r.t. striker
  const rvx = ball.vx - striker.vx;
  const rvy = ball.vy - striker.vy;
  const relVelAlongNormal = rvx * nx + rvy * ny;

  // Only resolve if objects are approaching
  if (relVelAlongNormal > 0) return;

  // Impulse scalar (striker treated as infinite mass / kinematic)
  const e = STRIKER_RESTITUTION;
  const j = -(1 + e) * relVelAlongNormal;

  // Apply impulse to ball only
  ball.vx += j * nx;
  ball.vy += j * ny;

  // Positional correction — push ball out of striker
  const overlap = minDist - dist;
  ball.x += nx * overlap;
  ball.y += ny * overlap;
}

// ─────────────────────────────────────────────────────────────────
// PhysicsRoom — one per active match
// ─────────────────────────────────────────────────────────────────
class PhysicsRoom {
  constructor(roomId, hostWs, guestWs, isTactics) {
    this.roomId   = roomId;
    this.host     = hostWs;
    this.guest    = guestWs;
    this.isTactics = isTactics;

    this.p1Score = 0;
    this.p2Score = 0;
    this.paused  = false;
    this.deadBallMs = 0;

    this.isP1Kickoff = Math.random() > 0.5;
    this._initBallAndStrikers();

    this._interval = setInterval(() => this._tick(), 1000 / TICK_RATE);
    console.log(`[Room ${roomId}] Physics started. Kickoff: P${this.isP1Kickoff ? 1 : 2}`);
  }

  _initBallAndStrikers() {
    const kickY = this.isP1Kickoff ? 30.0 : -30.0;

    // Ball state
    this.ball = { x: 0, y: kickY, vx: 0, vy: 0 };

    // Striker state: { x, y, vx, vy (velocity for impulse calculation) }
    if (this.isTactics) {
      this.p1Strikers = [
        { x:    0, y: 32.0,  vx: 0, vy: 0 },
        { x: -12,  y: 27.0,  vx: 0, vy: 0 },
        { x:  12,  y: 27.0,  vx: 0, vy: 0 },
      ];
      this.p2Strikers = [
        { x:    0, y: -32.0, vx: 0, vy: 0 },
        { x: -12,  y: -27.0, vx: 0, vy: 0 },
        { x:  12,  y: -27.0, vx: 0, vy: 0 },
      ];
    } else {
      this.p1Strikers = [{ x: 0, y:  32.0, vx: 0, vy: 0 }];
      this.p2Strikers = [{ x: 0, y: -32.0, vx: 0, vy: 0 }];
    }

    // Previous positions (for velocity derivation)
    this.p1Prev = this.p1Strikers.map(s => ({ x: s.x, y: s.y }));
    this.p2Prev = this.p2Strikers.map(s => ({ x: s.x, y: s.y }));
  }

  // Called when client sends striker_pos
  updateStriker(role, idx, x, y) {
    const strikers = (role === 'host') ? this.p1Strikers : this.p2Strikers;
    const prev     = (role === 'host') ? this.p1Prev     : this.p2Prev;
    if (idx < 0 || idx >= strikers.length) return;

    // Derive velocity from position delta (used for collision impulse)
    strikers[idx].vx = (x - prev[idx].x) / TICK_DT;
    strikers[idx].vy = (y - prev[idx].y) / TICK_DT;
    strikers[idx].x  = x;
    strikers[idx].y  = y;
    prev[idx].x = x;
    prev[idx].y = y;
  }

  _tick() {
    if (this.paused) return;

    // ── Integrate ball velocity (apply linear damping) ────────────
    const dampFactor = Math.pow(1 - BALL_DAMPING, TICK_DT);
    this.ball.vx *= dampFactor;
    this.ball.vy *= dampFactor;

    // ── Move ball ─────────────────────────────────────────────────
    this.ball.x += this.ball.vx * TICK_DT;
    this.ball.y += this.ball.vy * TICK_DT;

    // ── Striker-ball collision ────────────────────────────────────
    for (const s of [...this.p1Strikers, ...this.p2Strikers]) {
      resolveStrikerBall(s, this.ball);
    }

    // ── Wall collisions ───────────────────────────────────────────
    clampBallToWalls(this.ball);

    // ── Goal detection ────────────────────────────────────────────
    const inGoalX = this.ball.x > GOAL_LEFT && this.ball.x < GOAL_RIGHT;

    if (this.ball.y < GOAL_TOP_NET_Y && inGoalX) {
      this.p1Score++;
      this._onGoal(true);
      return;
    }
    if (this.ball.y > GOAL_BOTTOM_NET_Y && inGoalX) {
      this.p2Score++;
      this._onGoal(false);
      return;
    }

    // ── Dead ball detection ───────────────────────────────────────
    const speed = Math.sqrt(this.ball.vx ** 2 + this.ball.vy ** 2);
    const inMiddle = Math.abs(this.ball.y) < DEAD_BALL_ZONE;
    if (speed < DEAD_BALL_SPEED && inMiddle) {
      this.deadBallMs += 1000 / TICK_RATE;
      if (this.deadBallMs >= DEAD_BALL_MS) {
        this._onDeadBall();
        this.deadBallMs = 0;
      }
    } else {
      this.deadBallMs = 0;
    }

    // ── Broadcast state ───────────────────────────────────────────
    this._broadcastState();
  }

  _onGoal(isTopGoal) {
    this.paused = true;
    this.deadBallMs = 0;
    console.log(`[Room ${this.roomId}] GOAL! top=${isTopGoal} score=${this.p1Score}-${this.p2Score}`);

    this._broadcast({ type: 'goal_scored', isTopGoal, p1Score: this.p1Score, p2Score: this.p2Score });

    setTimeout(() => {
      this.isP1Kickoff = !isTopGoal; // conceding team kicks off
      this._resetAll();
      this.paused = false;
    }, GOAL_RESET_MS);
  }

  _onDeadBall() {
    this.paused = true;
    const isP1Side = this.ball.y > 0;
    this.isP1Kickoff = isP1Side;
    console.log(`[Room ${this.roomId}] Dead ball. Kickoff: P${isP1Side ? 1 : 2}`);

    this._broadcast({ type: 'dead_ball', isP1Kickoff: isP1Side });

    setTimeout(() => {
      this._resetAll();
      this.paused = false;
    }, 2000);
  }

  _resetAll() {
    const kickY = this.isP1Kickoff ? 30.0 : -30.0;

    this.ball = { x: 0, y: kickY, vx: 0, vy: 0 };

    const p1Reset = [{ x: 0, y: 32.0 }, { x: -12, y: 27 }, { x: 12, y: 27 }];
    const p2Reset = [{ x: 0, y: -32.0 }, { x: -12, y: -27 }, { x: 12, y: -27 }];

    this.p1Strikers.forEach((s, i) => {
      const r = p1Reset[i] || p1Reset[0];
      Object.assign(s, { x: r.x, y: r.y, vx: 0, vy: 0 });
      this.p1Prev[i] = { x: r.x, y: r.y };
    });
    this.p2Strikers.forEach((s, i) => {
      const r = p2Reset[i] || p2Reset[0];
      Object.assign(s, { x: r.x, y: r.y, vx: 0, vy: 0 });
      this.p2Prev[i] = { x: r.x, y: r.y };
    });

    this.deadBallMs = 0;
    this._broadcast({ type: 'game_reset', ballPos: [0, kickY], isP1Kickoff: this.isP1Kickoff });
  }

  _broadcastState() {
    const p1p = this.p1Strikers[0];
    const p2p = this.p2Strikers[0];
    this._broadcast({
      type:    'server_state',
      ballPos: [this.ball.x, this.ball.y],
      ballVel: [this.ball.vx, this.ball.vy],
      ballAng: 0,
      p1Pos:   [p1p.x, p1p.y],
      p2Pos:   [p2p.x, p2p.y],
    });
  }

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    if (this.host  && this.host.readyState  === 1) this.host.send(msg);
    if (this.guest && this.guest.readyState === 1) this.guest.send(msg);
  }

  destroy() {
    clearInterval(this._interval);
    console.log(`[Room ${this.roomId}] Destroyed.`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Room management
// ─────────────────────────────────────────────────────────────────
const rooms        = new Map();
const privateRooms = new Map();
const physicsRooms = new Map();
let matchmakingQueue1v1 = [];
let matchmakingQueue3v3 = [];

function generateRoomId()   { return Math.random().toString(36).substring(2, 9); }
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function startPhysicsRoom(roomId, hostWs, guestWs, isTactics) {
  const pr = new PhysicsRoom(roomId, hostWs, guestWs, isTactics);
  physicsRooms.set(roomId, pr);
  // Small delay so both clients finish setup before physics broadcasts begin
  pr.paused = true;
  setTimeout(() => { pr.paused = false; }, 800);
}

function cleanupRoom(roomId) {
  if (physicsRooms.has(roomId)) {
    physicsRooms.get(roomId).destroy();
    physicsRooms.delete(roomId);
  }
  rooms.delete(roomId);
}

// ─────────────────────────────────────────────────────────────────
// WebSocket connection handler
// ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.roomId = null;
  ws.role   = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      switch (data.type) {

        case 'join_queue': {
          matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
          matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);
          const isTactics = data.isTacticsMode === true;
          console.log(`Join queue: ${isTactics ? '3v3' : '1v1'}, team=${data.team}`);
          if (isTactics) {
            matchmakingQueue3v3.push({ ws, team: data.team });
            ws.send(JSON.stringify({ type: 'queue_joined', mode: '3v3' }));
            checkAndMatch(matchmakingQueue3v3, true);
          } else {
            matchmakingQueue1v1.push({ ws, team: data.team });
            ws.send(JSON.stringify({ type: 'queue_joined', mode: '1v1' }));
            checkAndMatch(matchmakingQueue1v1, false);
          }
          break;
        }

        case 'leave_queue':
          matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
          matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);
          break;

        case 'create_room': {
          const code = generateRoomCode();
          ws.roomId = code; ws.role = 'host';
          privateRooms.set(code, { host: ws, hostTeam: data.team, gameMode: data.gameMode || '1v1' });
          console.log(`Private room created: ${code}`);
          ws.send(JSON.stringify({ type: 'room_created', roomCode: code }));
          break;
        }

        case 'join_room': {
          const code = (data.roomCode || '').toUpperCase().trim();
          if (privateRooms.has(code)) {
            const info = privateRooms.get(code);
            ws.roomId = code; ws.role = 'guest';
            rooms.set(code, { host: info.host, guest: ws, hostTeam: info.hostTeam, guestTeam: data.team });
            const isTactics = info.gameMode === '3v3';
            console.log(`Private match: ${code}  ${info.hostTeam} vs ${data.team}`);
            info.host.send(JSON.stringify({ type: 'match_found', role: 'host', roomId: code, opponentTeam: data.team, isTacticsMode: isTactics }));
            ws.send(JSON.stringify({ type: 'match_found', role: 'guest', roomId: code, opponentTeam: info.hostTeam, isTacticsMode: isTactics }));
            privateRooms.delete(code);
            startPhysicsRoom(code, info.host, ws, isTactics);
          } else {
            ws.send(JSON.stringify({ type: 'room_error', message: 'Room not found or full' }));
          }
          break;
        }

        case 'striker_pos': {
          if (ws.roomId && physicsRooms.has(ws.roomId)) {
            physicsRooms.get(ws.roomId).updateStriker(ws.role, data.idx ?? 0, data.x, data.y);
          }
          break;
        }

        case 'celebration':
        case 'match_over': {
          if (ws.roomId && rooms.has(ws.roomId)) {
            const room = rooms.get(ws.roomId);
            const opp  = ws.role === 'host' ? room.guest : room.host;
            if (opp && opp.readyState === 1) opp.send(JSON.stringify(data));
          }
          break;
        }

        // Legacy / silently ignored (server now handles these)
        case 'game_state':
        case 'goal_scored':
        case 'reset_positions':
        case 'dead_ball':
          break;

        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (e) {
      console.error('Message error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
    matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);
    for (const [c, r] of privateRooms.entries()) {
      if (r.host === ws) privateRooms.delete(c);
    }
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      const opp  = ws.role === 'host' ? room.guest : room.host;
      if (opp && opp.readyState === 1) opp.send(JSON.stringify({ type: 'opponent_disconnected' }));
      cleanupRoom(ws.roomId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Matchmaking
// ─────────────────────────────────────────────────────────────────
function checkAndMatch(queue, isTactics) {
  if (queue.length < 2) return;
  const p1 = queue.shift();
  const p2 = queue.shift();
  const roomId = generateRoomId();

  p1.ws.roomId = roomId; p1.ws.role = 'host';
  p2.ws.roomId = roomId; p2.ws.role = 'guest';
  rooms.set(roomId, { host: p1.ws, guest: p2.ws, hostTeam: p1.team, guestTeam: p2.team });

  console.log(`Match! ${isTactics ? '3v3' : '1v1'} Room: ${roomId}`);
  p1.ws.send(JSON.stringify({ type: 'match_found', role: 'host', roomId, opponentTeam: p2.team, isTacticsMode: isTactics }));
  p2.ws.send(JSON.stringify({ type: 'match_found', role: 'guest', roomId, opponentTeam: p1.team, isTacticsMode: isTactics }));
  startPhysicsRoom(roomId, p1.ws, p2.ws, isTactics);
}

// ─────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Kick Pool Server v2.1 on port ${PORT} — Custom physics, no external deps.`);
});
