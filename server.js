const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const COLS = 15, ROWS = 13;
const BOMB_TIMER = 3000;
const EXPLOSION_DURATION = 600;
const POWERUP_TYPES = ['bomb', 'radius', 'speed'];
const PLAYER_COLORS = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502'];
const STARTS = [[0, 0], [0, COLS - 1], [ROWS - 1, 0], [ROWS - 1, COLS - 1]];

function makeMap() {
  const map = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: COLS }, (_, c) => (r % 2 === 1 && c % 2 === 1 ? 2 : 0))
  );
  // Safe L-shaped zones around each corner
  const safe = new Set();
  for (const [sr, sc] of STARTS) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (Math.abs(dr) + Math.abs(dc) <= 2) {
          safe.add(`${sr + dr},${sc + dc}`);
        }
      }
    }
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (map[r][c] === 0 && !safe.has(`${r},${c}`) && Math.random() < 0.65) {
        map[r][c] = 1;
      }
    }
  }
  return map;
}

class Game {
  constructor(id) {
    this.id = id;
    this.map = makeMap();
    this.players = {};
    this.bombs = [];
    this.explosions = [];
    this.powerups = [];
    this.bombId = 0;
    this.started = false;
    this.over = false;
    this._tickTimer = null;
    this._cdTimer = null;
    this._last = 0;
  }

  playerCount() { return Object.keys(this.players).length; }

  addPlayer(sid) {
    const idx = this.playerCount();
    if (idx >= 4) return false;
    const [sr, sc] = STARTS[idx];
    this.players[sid] = {
      id: sid, idx, color: PLAYER_COLORS[idx],
      x: sc + 0.5, y: sr + 0.5,
      alive: true,
      speed: 4, maxBombs: 1, bombRadius: 2, activeBombs: 0,
      keys: { up: false, dn: false, lt: false, rt: false, bm: false },
      bmPressed: false, dir: 'down', moving: false,
      sword: false, invincible: false, swordCooldown: 0,
    };
    return true;
  }

  removePlayer(sid) { delete this.players[sid]; }

  start() {
    this.started = true;
    this._last = Date.now();
    this._tickTimer = setInterval(() => this._update(), 50);
  }

  stop() {
    clearInterval(this._tickTimer); this._tickTimer = null;
    clearInterval(this._cdTimer); this._cdTimer = null;
  }

  _update() {
    const now = Date.now();
    const dt = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    this._movePlayers(dt);
    this._processBombs(now);
    this._clearExplosions(now);
    this._killPlayers();
    this._checkWin();
    io.to(this.id).emit('state', this._serialize());
  }

  _movePlayers(dt) {
    for (const p of Object.values(this.players)) {
      if (!p.alive) continue;
      let dx = 0, dy = 0;
      if (p.keys.up) dy -= 1;
      if (p.keys.dn) dy += 1;
      if (p.keys.lt) dx -= 1;
      if (p.keys.rt) dx += 1;
      if (dx && dy) { dx *= 0.707; dy *= 0.707; }
      if (dy < 0) p.dir = 'up';
      else if (dy > 0) p.dir = 'down';
      else if (dx < 0) p.dir = 'left';
      else if (dx > 0) p.dir = 'right';
      p.moving = !!(dx || dy);
      const s = p.speed * dt;
      this._tryMove(p, dx * s, 0);
      this._tryMove(p, 0, dy * s);

      // 一軸移動中は通路の中心に自動で吸い寄せる（角抜け補助）
      if (dx !== 0 && dy === 0) {
        const center = Math.floor(p.y) + 0.5;
        const diff = center - p.y;
        if (Math.abs(diff) > 0.001) {
          this._tryMove(p, 0, Math.sign(diff) * Math.min(Math.abs(diff), s * 2));
        }
      }
      if (dy !== 0 && dx === 0) {
        const center = Math.floor(p.x) + 0.5;
        const diff = center - p.x;
        if (Math.abs(diff) > 0.001) {
          this._tryMove(p, Math.sign(diff) * Math.min(Math.abs(diff), s * 2), 0);
        }
      }

      if (p.keys.bm && !p.bmPressed) { this._placeBomb(p); p.bmPressed = true; }
      if (!p.keys.bm) p.bmPressed = false;
      this._collectPowerup(p);
    }
  }

  _tryMove(p, dx, dy) {
    if (!dx && !dy) return;
    const R = 0.3;
    const nx = p.x + dx, ny = p.y + dy;
    const checks = [];
    if (dx > 0) checks.push([ny - R, nx + R], [ny + R, nx + R]);
    else if (dx < 0) checks.push([ny - R, nx - R], [ny + R, nx - R]);
    if (dy > 0) checks.push([ny + R, nx - R], [ny + R, nx + R]);
    else if (dy < 0) checks.push([ny - R, nx - R], [ny - R, nx + R]);
    for (const [cy, cx] of checks) {
      if (this._isSolid(Math.floor(cy), Math.floor(cx), p.id)) return;
    }
    p.x = Math.max(R, Math.min(COLS - R, nx));
    p.y = Math.max(R, Math.min(ROWS - R, ny));
  }

  _isSolid(r, c, sid) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
    if (this.map[r][c] !== 0) return true;
    for (const b of this.bombs) {
      if (b.r === r && b.c === c) return !(b.placedBy === sid && b.passable);
    }
    return false;
  }

  _placeBomb(p) {
    if (p.activeBombs >= p.maxBombs) return;
    const r = Math.floor(p.y), c = Math.floor(p.x);
    if (this.bombs.some(b => b.r === r && b.c === c)) return;
    const bomb = {
      id: this.bombId++, r, c,
      placedBy: p.id, radius: p.bombRadius,
      explodeAt: Date.now() + BOMB_TIMER, passable: true,
    };
    this.bombs.push(bomb);
    p.activeBombs++;
    setTimeout(() => { bomb.passable = false; }, 600);
  }

  _processBombs(now) {
    const queue = this.bombs.filter(b => b.explodeAt <= now);
    let qi = 0;
    while (qi < queue.length) {
      const bomb = queue[qi++];
      const idx = this.bombs.findIndex(b => b.id === bomb.id);
      if (idx === -1) continue;
      this.bombs.splice(idx, 1);
      const cells = this._calcExplosion(bomb);
      this.explosions.push({ cells, expires: now + EXPLOSION_DURATION });
      const owner = this.players[bomb.placedBy];
      if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);
      // Chain explosions
      for (const b of this.bombs) {
        if (cells.some(cell => cell.r === b.r && cell.c === b.c)
          && !queue.some(q => q.id === b.id)) {
          queue.push(b);
        }
      }
    }
  }

  _calcExplosion(bomb) {
    const cells = [{ r: bomb.r, c: bomb.c }];
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      for (let i = 1; i <= bomb.radius; i++) {
        const nr = bomb.r + dr * i, nc = bomb.c + dc * i;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
        if (this.map[nr][nc] === 2) break;
        cells.push({ r: nr, c: nc });
        if (this.map[nr][nc] === 1) {
          this.map[nr][nc] = 0;
          if (Math.random() < 0.35) {
            this.powerups.push({
              r: nr, c: nc,
              type: POWERUP_TYPES[Math.floor(Math.random() * 3)],
            });
          }
          break;
        }
      }
    }
    return cells;
  }

  _clearExplosions(now) {
    this.explosions = this.explosions.filter(e => e.expires > now);
  }

  _killPlayers() {
    for (const p of Object.values(this.players)) {
      if (!p.alive) continue;
      const pr = Math.floor(p.y), pc = Math.floor(p.x);
      for (const e of this.explosions) {
        if (!p.invincible && e.cells.some(c => c.r === pr && c.c === pc)) { p.alive = false; break; }
      }
    }
  }

  _collectPowerup(p) {
    const pr = Math.floor(p.y), pc = Math.floor(p.x);
    const i = this.powerups.findIndex(u => u.r === pr && u.c === pc);
    if (i === -1) return;
    const [pu] = this.powerups.splice(i, 1);
    if (pu.type === 'bomb') p.maxBombs = Math.min(5, p.maxBombs + 1);
    else if (pu.type === 'radius') p.bombRadius = Math.min(7, p.bombRadius + 1);
    else if (pu.type === 'speed') p.speed = Math.min(7, p.speed + 0.8);
  }

  _swordCells(r, c, dir) {
    if (dir === 'down')  return [{r:r+1,c:c-1},{r:r+1,c},{r:r+1,c:c+1}];
    if (dir === 'up')    return [{r:r-1,c:c-1},{r:r-1,c},{r:r-1,c:c+1}];
    if (dir === 'left')  return [{r:r-1,c:c-1},{r,c:c-1},{r:r+1,c:c-1}];
    if (dir === 'right') return [{r:r-1,c:c+1},{r,c:c+1},{r:r+1,c:c+1}];
    return [];
  }

  _swordSwing(player, now) {
    if (!player.sword || now - player.swordCooldown < 500) return;
    player.swordCooldown = now;
    const r = Math.floor(player.y), c = Math.floor(player.x);
    const cells = this._swordCells(r, c, player.dir);
    for (const { r: nr, c: nc } of cells) {
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      if (this.map[nr][nc] === 1) this.map[nr][nc] = 0;
      for (const p of Object.values(this.players)) {
        if (!p.alive || p.id === player.id || p.invincible) continue;
        if (Math.floor(p.y) === nr && Math.floor(p.x) === nc) p.alive = false;
      }
    }
    io.to(this.id).emit('swordEffect', { cells, color: player.color });
  }

  _checkWin() {
    if (this.over) return;
    const alive = Object.values(this.players).filter(p => p.alive);
    if (alive.length > 1) return;
    this.over = true;
    const winner = alive[0] || null;
    io.to(this.id).emit('gameOver', {
      winner: winner ? winner.idx + 1 : null,
      color: winner ? winner.color : null,
    });
    this.stop();
  }

  _serialize() {
    return {
      map: this.map,
      players: Object.values(this.players).map(p => ({
        id: p.id, idx: p.idx, color: p.color,
        x: p.x, y: p.y, alive: p.alive,
        maxBombs: p.maxBombs, activeBombs: p.activeBombs, bombRadius: p.bombRadius,
        dir: p.dir, moving: p.moving, sword: p.sword,
      })),
      bombs: this.bombs.map(b => ({ r: b.r, c: b.c, explodeAt: b.explodeAt })),
      explosions: this.explosions.flatMap(e => e.cells),
      powerups: this.powerups,
    };
  }
}

const rooms = new Map();

function findRoom() {
  for (const r of rooms.values()) {
    if (!r.started && r.playerCount() < 4) return r;
  }
  const id = 'room_' + Date.now();
  const r = new Game(id);
  rooms.set(id, r);
  return r;
}

io.on('connection', socket => {
  let room = null;

  socket.on('join', () => {
    room = findRoom();
    if (!room.addPlayer(socket.id)) {
      socket.emit('full');
      return;
    }
    socket.join(room.id);
    const cnt = room.playerCount();
    socket.emit('joined', { idx: room.players[socket.id].idx, cnt });
    io.to(room.id).emit('lobby', { cnt });

    if (cnt >= 2 && !room.started && !room._cdTimer) {
      let n = 5;
      io.to(room.id).emit('countdown', n);
      room._cdTimer = setInterval(() => {
        n--;
        if (n <= 0) {
          clearInterval(room._cdTimer);
          room._cdTimer = null;
          room.start();
          io.to(room.id).emit('gameStart');
        } else {
          io.to(room.id).emit('countdown', n);
        }
      }, 1000);
    }
  });

  socket.on('keys', keys => {
    if (room?.players[socket.id]) room.players[socket.id].keys = keys;
  });

  socket.on('cheat', code => {
    const p = room?.players[socket.id];
    if (!p || !room.started) return;
    if (code === 'sword') { p.sword = true; p.invincible = true; }
  });

  socket.on('swing', () => {
    const p = room?.players[socket.id];
    if (p?.alive) room._swordSwing(p, Date.now());
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.removePlayer(socket.id);
    const cnt = room.playerCount();
    if (cnt === 0) {
      room.stop();
      rooms.delete(room.id);
    } else {
      io.to(room.id).emit('lobby', { cnt });
      if (cnt < 2 && !room.started && room._cdTimer) {
        clearInterval(room._cdTimer);
        room._cdTimer = null;
        io.to(room.id).emit('cdCancelled');
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bomberman on http://localhost:${PORT}`));
