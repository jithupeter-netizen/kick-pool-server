const { WebSocketServer } = require('ws');
const http = require('http');
const planck = require('planck');

// ─────────────────────────────────────────────────────────────────
// HTTP server (required for Railway + WebSocket upgrade)
// ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kick Pool WebSocket Server v2.0 — Server-Side Physics Active.\n');
});

const wss = new WebSocketServer({ server });

// ─────────────────────────────────────────────────────────────────
// Room management maps
// ─────────────────────────────────────────────────────────────────
const rooms        = new Map(); // roomId -> { host, guest, hostTeam, guestTeam }
const privateRooms = new Map(); // roomCode -> { host, hostTeam, gameMode }
const physicsRooms = new Map(); // roomId -> PhysicsRoom instance
let matchmakingQueue1v1 = [];
let matchmakingQueue3v3 = [];

// ─────────────────────────────────────────────────────────────────
// Physics constants — MUST match Flutter's Forge2D configuration
//   pitchWidth = 45.0, pitchHeight = 80.0
//   halfW = 22.5, halfH = 40.0
//   walls: leftX=-21, rightX=21, topY=-36.5, bottomY=36.5
//   goals: x=[-8..8], topNet y=-39.9, bottomNet y=39.9
// ─────────────────────────────────────────────────────────────────
const P = {
  ballRadius:         1.5,
  ballLinearDamping:  0.55,
  ballAngularDamping: 0.55,
  ballDensity:        1.0,
  ballFriction:       0.01,
  ballRestitution:    0.95,

  strikerRadius:      3.0,
  strikerDensity:     20.0,
  strikerFriction:    0.05,
  strikerRestitution: 1.2,

  wallFriction:       0.0,
  wallRestitution:    0.95,

  leftX:     -21.0,
  rightX:     21.0,
  topY:      -36.5,
  bottomY:    36.5,
  goalLeftX:  -8.0,
  goalRightX:  8.0,
  goalTopY:   -39.9,   // Inside top net (back wall)
  goalBottomY: 39.9,   // Inside bottom net (back wall)

  p1StartY:   32.0,    // P1 (Host) striker initial Y
  p2StartY:  -32.0,    // P2 (Guest) striker initial Y

  tickRate:   30,      // Hz — physics ticks per second
  goalResetDelay: 3000, // ms before ball resets after goal
  deadBallTicks:  150,  // 5 seconds at 30Hz before dead ball reset
  deadBallZone:  23.5,  // |y| < this = unreachable middle zone
  deadBallSpeed:  0.1,  // speed below which ball is "stopped"
};

// ─────────────────────────────────────────────────────────────────
// PhysicsRoom — one per active match
// ─────────────────────────────────────────────────────────────────
class PhysicsRoom {
  constructor(roomId, hostWs, guestWs, isTacticsMode) {
    this.roomId       = roomId;
    this.host         = hostWs;
    this.guest        = guestWs;
    this.isTactics    = isTacticsMode;

    // Kick-off alternates; start random
    this.isP1Kickoff  = Math.random() > 0.5;

    // Scores
    this.p1Score = 0;
    this.p2Score = 0;

    // State guards
    this.paused        = false;
    this.deadBallCount = 0;

    // Striker targets (updated by client striker_pos messages)
    this.p1Targets = [{ x: 0, y: P.p1StartY }];
    this.p2Targets = [{ x: 0, y: P.p2StartY }];
    if (isTacticsMode) {
      this.p1Targets = [
        { x:    0, y: P.p1StartY },
        { x: -12, y: 27 },
        { x:  12, y: 27 },
      ];
      this.p2Targets = [
        { x:    0, y: P.p2StartY },
        { x: -12, y: -27 },
        { x:  12, y: -27 },
      ];
    }
    // Previous positions for velocity calculation
    this.p1Prev = this.p1Targets.map(t => ({ ...t }));
    this.p2Prev = this.p2Targets.map(t => ({ ...t }));

    this._buildWorld();

    // Start game loop
    this._tickDt  = 1.0 / P.tickRate;
    this._interval = setInterval(() => this._tick(), 1000 / P.tickRate);

    console.log(`[PhysicsRoom ${roomId}] Created. Kickoff: P${this.isP1Kickoff ? 1 : 2}`);
  }

  // ── World Setup ──────────────────────────────────────────────
  _buildWorld() {
    this.world = planck.World(planck.Vec2(0, 0)); // no gravity

    // Static boundary body
    const ground = this.world.createBody({ type: 'static' });
    const wallFix = { friction: P.wallFriction, restitution: P.wallRestitution };

    const edge = (x1, y1, x2, y2) =>
      ground.createFixture(planck.Edge(planck.Vec2(x1, y1), planck.Vec2(x2, y2)), wallFix);

    // Side walls
    edge(P.leftX,  P.topY,    P.leftX,  P.bottomY);
    edge(P.rightX, P.topY,    P.rightX, P.bottomY);

    // Top walls (goal gap between goalLeftX and goalRightX)
    edge(P.leftX,      P.topY, P.goalLeftX,  P.topY);
    edge(P.goalRightX, P.topY, P.rightX,     P.topY);

    // Bottom walls
    edge(P.leftX,      P.bottomY, P.goalLeftX,  P.bottomY);
    edge(P.goalRightX, P.bottomY, P.rightX,     P.bottomY);

    // Top goal net (3 sides)
    edge(P.goalLeftX,  P.topY,    P.goalLeftX,  P.goalTopY);
    edge(P.goalRightX, P.topY,    P.goalRightX, P.goalTopY);
    edge(P.goalLeftX,  P.goalTopY, P.goalRightX, P.goalTopY);

    // Bottom goal net (3 sides)
    edge(P.goalLeftX,  P.bottomY,    P.goalLeftX,  P.goalBottomY);
    edge(P.goalRightX, P.bottomY,    P.goalRightX, P.goalBottomY);
    edge(P.goalLeftX,  P.goalBottomY, P.goalRightX, P.goalBottomY);

    // Ball — dynamic, CCD enabled for fast speeds
    const kickY = this.isP1Kickoff ? 30.0 : -30.0;
    this.ball = this.world.createBody({
      type: 'dynamic',
      position: planck.Vec2(0, kickY),
      linearDamping:  P.ballLinearDamping,
      angularDamping: P.ballAngularDamping,
      bullet: true,
    });
    this.ball.createFixture(planck.Circle(P.ballRadius), {
      density:     P.ballDensity,
      friction:    P.ballFriction,
      restitution: P.ballRestitution,
    });

    // Strikers — kinematic (velocity-driven for correct collision impulse)
    this.p1Bodies = this.p1Targets.map(t => this._makeStriker(t.x, t.y));
    this.p2Bodies = this.p2Targets.map(t => this._makeStriker(t.x, t.y));
  }

  _makeStriker(x, y) {
    const body = this.world.createBody({
      type: 'kinematic',
      position: planck.Vec2(x, y),
    });
    body.createFixture(planck.Circle(P.strikerRadius), {
      density:     P.strikerDensity,
      friction:    P.strikerFriction,
      restitution: P.strikerRestitution,
    });
    return body;
  }

  // ── Client input ─────────────────────────────────────────────
  updateStriker(role, idx, x, y) {
    const targets = (role === 'host') ? this.p1Targets : this.p2Targets;
    if (idx >= 0 && idx < targets.length) {
      targets[idx].x = x;
      targets[idx].y = y;
    }
  }

  // ── Game loop ────────────────────────────────────────────────
  _tick() {
    if (this.paused) return;

    // Move each striker kinematically toward client target
    this._driveStrikers(this.p1Bodies, this.p1Targets, this.p1Prev);
    this._driveStrikers(this.p2Bodies, this.p2Targets, this.p2Prev);

    // Advance physics
    this.world.step(this._tickDt, 8, 3);

    // ── Goal detection ───────────────────────────────────────
    const bp = this.ball.getPosition();

    if (bp.y < P.goalTopY &&
        bp.x > P.goalLeftX && bp.x < P.goalRightX) {
      // Ball in top goal → P1 scores
      this.p1Score++;
      this._onGoal(true);
      return;
    }

    if (bp.y > P.goalBottomY &&
        bp.x > P.goalLeftX && bp.x < P.goalRightX) {
      // Ball in bottom goal → P2 scores
      this.p2Score++;
      this._onGoal(false);
      return;
    }

    // ── Dead-ball detection ──────────────────────────────────
    const bv = this.ball.getLinearVelocity();
    const speedSq = bv.x * bv.x + bv.y * bv.y;
    const inMiddle = Math.abs(bp.y) < P.deadBallZone;

    if (speedSq < P.deadBallSpeed * P.deadBallSpeed && inMiddle) {
      this.deadBallCount++;
      if (this.deadBallCount >= P.deadBallTicks) {
        this._onDeadBall();
        this.deadBallCount = 0;
      }
    } else {
      this.deadBallCount = 0;
    }

    // ── Broadcast state ──────────────────────────────────────
    this._broadcastState();
  }

  _driveStrikers(bodies, targets, prev) {
    const dt = this._tickDt;
    for (let i = 0; i < bodies.length; i++) {
      const body   = bodies[i];
      const target = targets[i];
      const last   = prev[i];
      const curPos = body.getPosition();

      const dist = Math.hypot(target.x - curPos.x, target.y - curPos.y);

      if (dist > 8.0) {
        // Lag spike / reconnect — teleport and zero velocity
        body.setPosition(planck.Vec2(target.x, target.y));
        body.setLinearVelocity(planck.Vec2(0, 0));
      } else {
        // Set velocity so the body reaches target in one tick
        // This also encodes the drag speed into the collision impulse
        const vx = (target.x - last.x) / dt;
        const vy = (target.y - last.y) / dt;
        body.setLinearVelocity(planck.Vec2(vx, vy));
      }

      prev[i] = { x: target.x, y: target.y };
    }
  }

  // ── Goal ────────────────────────────────────────────────────
  _onGoal(isTopGoal) {
    this.paused = true;
    this.deadBallCount = 0;

    console.log(`[PhysicsRoom ${this.roomId}] GOAL! isTop=${isTopGoal}  ${this.p1Score}-${this.p2Score}`);

    this._broadcast({
      type: 'goal_scored',
      isTopGoal,
      p1Score: this.p1Score,
      p2Score: this.p2Score,
    });

    // Reset after celebration time
    setTimeout(() => {
      this.isP1Kickoff = !isTopGoal; // team that conceded kicks off
      this._resetAll();
      this.paused = false;
    }, P.goalResetDelay);
  }

  // ── Dead ball ────────────────────────────────────────────────
  _onDeadBall() {
    this.paused = true;
    // Award kick-off to whichever side the ball is on
    const bp = this.ball.getPosition();
    this.isP1Kickoff = bp.y > 0;

    this._broadcast({
      type: 'dead_ball',
      isP1Kickoff: this.isP1Kickoff,
    });

    setTimeout(() => {
      this._resetAll();
      this.paused = false;
    }, 2000);
  }

  // ── Reset ────────────────────────────────────────────────────
  _resetAll() {
    const kickY = this.isP1Kickoff ? 30.0 : -30.0;

    // Reset ball
    this.ball.setPosition(planck.Vec2(0, kickY));
    this.ball.setLinearVelocity(planck.Vec2(0, 0));
    this.ball.setAngularVelocity(0);

    // Reset P1 strikers
    const p1Starts = [
      { x: 0, y: P.p1StartY }, { x: -12, y: 27 }, { x: 12, y: 27 },
    ];
    this.p1Bodies.forEach((b, i) => {
      const s = p1Starts[i] || p1Starts[0];
      b.setPosition(planck.Vec2(s.x, s.y));
      b.setLinearVelocity(planck.Vec2(0, 0));
      this.p1Targets[i] = { x: s.x, y: s.y };
      this.p1Prev[i]    = { x: s.x, y: s.y };
    });

    // Reset P2 strikers
    const p2Starts = [
      { x: 0, y: P.p2StartY }, { x: -12, y: -27 }, { x: 12, y: -27 },
    ];
    this.p2Bodies.forEach((b, i) => {
      const s = p2Starts[i] || p2Starts[0];
      b.setPosition(planck.Vec2(s.x, s.y));
      b.setLinearVelocity(planck.Vec2(0, 0));
      this.p2Targets[i] = { x: s.x, y: s.y };
      this.p2Prev[i]    = { x: s.x, y: s.y };
    });

    this._broadcast({
      type: 'game_reset',
      ballPos: [0, kickY],
      isP1Kickoff: this.isP1Kickoff,
    });
  }

  // ── Broadcast helpers ────────────────────────────────────────
  _broadcastState() {
    const bp  = this.ball.getPosition();
    const bv  = this.ball.getLinearVelocity();
    const p1p = this.p1Bodies[0].getPosition();
    const p2p = this.p2Bodies[0].getPosition();

    this._broadcast({
      type:    'server_state',
      ballPos: [bp.x, bp.y],
      ballVel: [bv.x, bv.y],
      ballAng: this.ball.getAngle(),
      p1Pos:   [p1p.x, p1p.y],
      p2Pos:   [p2p.x, p2p.y],
    });
  }

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    if (this.host  && this.host.readyState  === 1) this.host.send(msg);
    if (this.guest && this.guest.readyState === 1) this.guest.send(msg);
  }

  // ── Cleanup ──────────────────────────────────────────────────
  destroy() {
    clearInterval(this._interval);
    console.log(`[PhysicsRoom ${this.roomId}] Destroyed.`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────
function generateRoomId()   { return Math.random().toString(36).substring(2, 9); }
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function startPhysicsRoom(roomId, hostWs, guestWs, isTacticsMode) {
  const pr = new PhysicsRoom(roomId, hostWs, guestWs, isTacticsMode);
  physicsRooms.set(roomId, pr);
  // Brief delay so both clients can set up before physics starts broadcasting
  pr.paused = true;
  setTimeout(() => { pr.paused = false; }, 500);
}

function cleanupRoom(roomId) {
  if (physicsRooms.has(roomId)) {
    physicsRooms.get(roomId).destroy();
    physicsRooms.delete(roomId);
  }
  rooms.delete(roomId);
}

// ─────────────────────────────────────────────────────────────────
// WebSocket message handler
// ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.roomId = null;
  ws.role   = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {

        // ── Matchmaking ────────────────────────────────────────
        case 'join_queue': {
          matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
          matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);

          const isTactics = data.isTacticsMode === true;
          console.log(`Player joining ${isTactics ? '3v3' : '1v1'} queue, team: ${data.team}`);

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

        // ── Private rooms ──────────────────────────────────────
        case 'create_room': {
          const code = generateRoomCode();
          ws.roomId = code;
          ws.role   = 'host';
          privateRooms.set(code, {
            host: ws, hostTeam: data.team, gameMode: data.gameMode || '1v1',
          });
          console.log(`Private Room created: ${code}`);
          ws.send(JSON.stringify({ type: 'room_created', roomCode: code }));
          break;
        }

        case 'join_room': {
          const joinCode = (data.roomCode || '').toUpperCase().trim();
          if (privateRooms.has(joinCode)) {
            const roomInfo = privateRooms.get(joinCode);
            ws.roomId = joinCode;
            ws.role   = 'guest';

            rooms.set(joinCode, {
              host:      roomInfo.host,
              guest:     ws,
              hostTeam:  roomInfo.hostTeam,
              guestTeam: data.team,
            });

            const isTactics = roomInfo.gameMode === '3v3';
            console.log(`Private match: ${joinCode}  ${roomInfo.hostTeam} vs ${data.team}`);

            roomInfo.host.send(JSON.stringify({
              type: 'match_found', role: 'host', roomId: joinCode,
              opponentTeam: data.team, isTacticsMode: isTactics,
            }));
            ws.send(JSON.stringify({
              type: 'match_found', role: 'guest', roomId: joinCode,
              opponentTeam: roomInfo.hostTeam, isTacticsMode: isTactics,
            }));

            privateRooms.delete(joinCode);
            startPhysicsRoom(joinCode, roomInfo.host, ws, isTactics);
          } else {
            ws.send(JSON.stringify({ type: 'room_error', message: 'Room not found or full' }));
          }
          break;
        }

        // ── In-game: striker position from client ──────────────
        case 'striker_pos': {
          if (ws.roomId && physicsRooms.has(ws.roomId)) {
            const pr  = physicsRooms.get(ws.roomId);
            const idx = data.idx ?? 0;
            pr.updateStriker(ws.role, idx, data.x, data.y);
          }
          break;
        }

        // ── In-game relay: celebration, match_over, etc. ───────
        case 'celebration':
        case 'match_over': {
          if (ws.roomId && rooms.has(ws.roomId)) {
            const room     = rooms.get(ws.roomId);
            const opponent = ws.role === 'host' ? room.guest : room.host;
            if (opponent && opponent.readyState === 1) opponent.send(JSON.stringify(data));
          }
          break;
        }

        // ── Legacy relay (kept for backward-compat) ────────────
        case 'game_state':
        case 'goal_scored':
        case 'reset_positions':
        case 'dead_ball': {
          // Silently ignored now — server physics handles these
          break;
        }

        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (e) {
      console.error('Error handling message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    matchmakingQueue1v1 = matchmakingQueue1v1.filter(p => p.ws !== ws);
    matchmakingQueue3v3 = matchmakingQueue3v3.filter(p => p.ws !== ws);

    // Clean up waiting private rooms
    for (const [code, r] of privateRooms.entries()) {
      if (r.host === ws) { privateRooms.delete(code); }
    }

    // Notify opponent and clean up active room
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room     = rooms.get(ws.roomId);
      const opponent = ws.role === 'host' ? room.guest : room.host;
      if (opponent && opponent.readyState === 1) {
        opponent.send(JSON.stringify({ type: 'opponent_disconnected' }));
      }
      cleanupRoom(ws.roomId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Matchmaking
// ─────────────────────────────────────────────────────────────────
function checkAndMatch(queue, isTactics) {
  if (queue.length < 2) return;

  const p1     = queue.shift();
  const p2     = queue.shift();
  const roomId = generateRoomId();

  p1.ws.roomId = roomId; p1.ws.role = 'host';
  p2.ws.roomId = roomId; p2.ws.role = 'guest';

  rooms.set(roomId, {
    host: p1.ws, guest: p2.ws, hostTeam: p1.team, guestTeam: p2.team,
  });

  console.log(`Match created! ${isTactics ? '3v3' : '1v1'} Room: ${roomId}`);

  p1.ws.send(JSON.stringify({
    type: 'match_found', role: 'host', roomId,
    opponentTeam: p2.team, isTacticsMode: isTactics,
  }));
  p2.ws.send(JSON.stringify({
    type: 'match_found', role: 'guest', roomId,
    opponentTeam: p1.team, isTacticsMode: isTactics,
  }));

  startPhysicsRoom(roomId, p1.ws, p2.ws, isTactics);
}

// ─────────────────────────────────────────────────────────────────
// Start HTTP + WebSocket server
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Kick Pool Server v2.0 listening on port ${PORT}`);
  console.log(`Server-side physics: ACTIVE (planck.js at ${P.tickRate}Hz)`);
});
