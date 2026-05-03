const socket = io();

const COLS = 15, ROWS = 13, CELL = 48;
const SCALE = 6;
const SPR = 8;

// ── 通常スプライト ────────────────────────────────────────────
const SPRITES = {
  down0: ['_HHHHHH_','_HSSSSH_','_HSESEH_','_HSSSSH_','_WWWWWW_','_WWGGWW_','PP____PP','BB____BB'],
  down1: ['_HHHHHH_','_HSSSSH_','_HSESEH_','_HSSSSH_','_WWWWWW_','_WWGGWW_','_PP__PP_','_BB__BB_'],
  up0:   ['_HHHHHH_','_HHHHHH_','_DDHHDD_','_HHHHHH_','_WWWWWW_','_WGGGGW_','PP____PP','BB____BB'],
  up1:   ['_HHHHHH_','_HHHHHH_','_DDHHDD_','_HHHHHH_','_WWWWWW_','_WGGGGW_','_PP__PP_','_BB__BB_'],
  left0: ['__HHHH__','__HSSH__','__HSEH__','__HSSH__','__WWWW__','__WGWW__','_PP_____','_BB_____'],
  left1: ['__HHHH__','__HSSH__','__HSEH__','__HSSH__','__WWWW__','__WGWW__','___PP___','___BB___'],
  right0:['__HHHH__','__HSSH__','__HESH__','__HSSH__','__WWWW__','__WWGW__','_____PP_','_____BB_'],
  right1:['__HHHH__','__HSSH__','__HESH__','__HSSH__','__WWWW__','__WWGW__','___PP___','___BB___'],
};

// ── ドクロスプライト（swordモード） ───────────────────────────
const SKULL = {
  down0: ['_HHHHHH_','_H____H_','_HE__EH_','_H____H_','_HSSSSH_','_HHHHHH_','PP____PP','BB____BB'],
  down1: ['_HHHHHH_','_H____H_','_HE__EH_','_H____H_','_HSSSSH_','_HHHHHH_','_PP__PP_','_BB__BB_'],
  up0:   ['_HHHHHH_','_H____H_','_H_DD_H_','_H____H_','_HHHHHH_','_HHHHHH_','PP____PP','BB____BB'],
  up1:   ['_HHHHHH_','_H____H_','_H_DD_H_','_H____H_','_HHHHHH_','_HHHHHH_','_PP__PP_','_BB__BB_'],
  left0: ['__HHHH__','__H__H__','__HE_H__','__H__H__','__HSSH__','__HHHH__','_PP_____','_BB_____'],
  left1: ['__HHHH__','__H__H__','__HE_H__','__H__H__','__HSSH__','__HHHH__','___PP___','___BB___'],
  right0:['__HHHH__','__H__H__','__H_EH__','__H__H__','__HSSH__','__HHHH__','_____PP_','_____BB_'],
  right1:['__HHHH__','__H__H__','__H_EH__','__H__H__','__HSSH__','__HHHH__','___PP___','___BB___'],
};

// ── localStorage カスタムスプライト読み込み ───────────────────
function loadCustomSprites() {
  try {
    const saved = localStorage.getItem('bombermanSprites');
    if (!saved) return;
    const parsed = JSON.parse(saved);
    for (const key of Object.keys(SPRITES)) {
      if (parsed[key]?.length === 8) SPRITES[key] = parsed[key];
    }
  } catch(e) {}
}
loadCustomSprites();
window.addEventListener('storage', e => { if (e.key === 'bombermanSprites') loadCustomSprites(); });

// ── ウォークサイクル ──────────────────────────────────────────
const walkFrame = {}, walkTimer = {};
function getFrame(p, now) {
  const id = p.id;
  if (walkTimer[id] === undefined) { walkTimer[id] = now; walkFrame[id] = 0; }
  if (p.moving) {
    if (now - walkTimer[id] > 180) { walkFrame[id] ^= 1; walkTimer[id] = now; }
  } else { walkFrame[id] = 0; }
  return walkFrame[id];
}

function darken(hex, f) {
  return `rgb(${[1,3,5].map(i => Math.round(parseInt(hex.slice(i,i+2),16)*f)).join(',')})`;
}

function drawSprite(p, px, py, isMe, now) {
  const sheet = p.sword ? SKULL : SPRITES;
  const key = `${p.dir || 'down'}${getFrame(p, now)}`;
  const spr = sheet[key] || sheet.down0;
  const sx = px - SPR * SCALE / 2;
  const sy = py - SPR * SCALE / 2;
  const dc = darken(p.color, 0.55);
  const pal = { H:p.color, D:darken(p.color,0.65), S:'#FFBB88', E:'#111111',
                W:'#EEEEEE', G:'#AAAAAA', P:'#222222', B:dc };

  for (let r = 0; r < SPR; r++) {
    const row = spr[r];
    for (let c = 0; c < SPR; c++) {
      const ch = row[c];
      if (ch === '_') continue;
      ctx.fillStyle = pal[ch] || '#FF00FF';
      ctx.fillRect(sx + c * SCALE, sy + r * SCALE, SCALE, SCALE);
    }
  }

  // ▽ 自分マーカー
  if (isMe) {
    const ty = sy - 10;
    ctx.fillStyle = p.sword ? '#ff4757' : '#ffffff';
    ctx.beginPath();
    ctx.moveTo(px - 7, ty);
    ctx.lineTo(px + 7, ty);
    ctx.lineTo(px, ty + 8);
    ctx.closePath();
    ctx.fill();
  }

  // swordモード: 赤いオーラ
  if (p.sword) {
    ctx.strokeStyle = `rgba(255,50,50,${0.5 + 0.3 * Math.sin(now / 120)})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(sx - 2, sy - 2, SPR * SCALE + 4, SPR * SCALE + 4);
  }
}

// ── 剣エフェクト ──────────────────────────────────────────────
const swordEffects = [];
socket.on('swordEffect', ({ cells, color }) => {
  swordEffects.push({ cells, color, expires: Date.now() + 280 });
});

// ── チートコード検出 ──────────────────────────────────────────
let typedBuf = '';
let swordMode = false;
let cheatMsg = null;

// ── ゲーム状態 ────────────────────────────────────────────────
const PU_ICON  = { bomb:'💣', radius:'🔥', speed:'⚡' };
const PU_COLOR = { bomb:'#ff4757', radius:'#ffd93d', speed:'#2ed573' };

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
canvas.width  = COLS * CELL;
canvas.height = ROWS * CELL;

let myIdx = -1, gameState = null;
let phase = 'lobby', gameOverData = null;

// ── 入力 ─────────────────────────────────────────────────────
const keys = { up:false, dn:false, lt:false, rt:false, bm:false };
const KEY_MAP = {
  ArrowUp:'up', w:'up', W:'up',
  ArrowDown:'dn', s:'dn', S:'dn',
  ArrowLeft:'lt', a:'lt', A:'lt',
  ArrowRight:'rt', d:'rt', D:'rt',
  ' ':'bm', Enter:'bm', z:'bm', Z:'bm',
};

document.addEventListener('keydown', e => {
  // チートコード検出
  if (e.key.length === 1) {
    typedBuf = (typedBuf + e.key.toLowerCase()).slice(-8);
    if (typedBuf.endsWith('sword') && phase === 'game') {
      socket.emit('cheat', 'sword');
      swordMode = true;
      cheatMsg = { text: '💀 SWORD MODE!', expires: Date.now() + 2500 };
      typedBuf = '';
    }
  }

  // 剣を振る（Eキー）
  if ((e.key === 'e' || e.key === 'E') && swordMode && phase === 'game') {
    socket.emit('swing');
    return;
  }

  const k = KEY_MAP[e.key];
  if (!k) return;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
  if (keys[k]) return;
  keys[k] = true;
  if (phase === 'game') socket.emit('keys', {...keys});
});
document.addEventListener('keyup', e => {
  const k = KEY_MAP[e.key];
  if (!k) return;
  keys[k] = false;
  if (phase === 'game') socket.emit('keys', {...keys});
});

// ── Socket ───────────────────────────────────────────────────
socket.on('joined', ({ idx, cnt, slots }) => { myIdx = idx; setLobbyStatus(cnt, slots); updateSlots(slots, idx); });
socket.on('lobby', ({ cnt, slots }) => { setLobbyStatus(cnt, slots); updateSlots(slots, myIdx); });
socket.on('countdown', n => {
  phase = 'countdown';
  showPhase('phase-countdown');
  const el = document.getElementById('countdown-num');
  el.textContent = n;
  el.style.animation = 'none'; el.offsetHeight; el.style.animation = '';
});
socket.on('cdCancelled', () => { phase = 'lobby'; showPhase('phase-lobby'); });
socket.on('gameStart', () => { phase = 'game'; document.getElementById('overlay').style.display = 'none'; });
socket.on('state', s => { gameState = s; });
socket.on('gameOver', data => {
  phase = 'over'; gameOverData = data;
  document.getElementById('overlay').style.display = 'flex';
  showPhase('phase-over');
  const el = document.getElementById('winner-text');
  if (data.winner) { el.style.color = data.color; el.textContent = `P${data.winner} の勝利！`; }
  else { el.style.color = '#aaa'; el.textContent = '引き分け！'; }
});
socket.on('full', () => alert('満員です。ページを更新してください。'));

let isReady = false;

function toggleReady() {
  socket.emit('ready');
}

function setLobbyStatus(cnt, slots) {
  const readyCnt = slots ? slots.filter(p => p.ready).length : 0;
  document.getElementById('lobby-status').textContent =
    `プレイヤー ${cnt}/4　準備完了 ${readyCnt}/${cnt}`;
  // ボタン表示更新
  const mySlot = slots?.find(p => p.idx === myIdx);
  isReady = mySlot?.ready || false;
  const btn = document.getElementById('ready-btn');
  if (btn) {
    btn.textContent = isReady ? '✓ 準備完了！' : '準備OK';
    btn.classList.toggle('ready', isReady);
  }
}

function updateSlots(slots, myI) {
  const c = document.getElementById('player-slots');
  c.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const player = slots?.find(p => p.idx === i);
    const s = document.createElement('div');
    s.className = 'slot' + (player ? ' filled' : '') + (player?.idx === myI ? ' me' : '');
    if (player) s.style.setProperty('--color', player.color);
    if (player) s.innerHTML = `P${i+1}${player.ready ? '<span class="ready-mark">✓</span>' : ''}`;
    c.appendChild(s);
  }
}
function showPhase(id) {
  for (const el of document.querySelectorAll('#overlay-content > div'))
    el.style.display = el.id === id ? '' : 'none';
}
socket.emit('join');

// ── レンダリング ──────────────────────────────────────────────
const FLOOR_A = '#1a222e', FLOOR_B = '#1e2836';
const HARD_T = '#505860', HARD_S = '#383e48';
const SOFT_T = '#7a5228', SOFT_S = '#5a3a18';

function drawBlock(x, y, top, side) {
  ctx.fillStyle = top;
  ctx.fillRect(x+1, y+1, CELL-2, CELL-2);
  ctx.fillStyle = side;
  ctx.fillRect(x+1, y+CELL-5, CELL-2, 4);
  ctx.fillRect(x+CELL-5, y+1, 4, CELL-6);
}

function render() {
  if (phase !== 'game' && phase !== 'over') {
    ctx.fillStyle = '#111820';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (!gameState) return;
  drawGame();
}

function drawGame() {
  const { map, players, bombs, explosions, powerups } = gameState;
  const now = Date.now();

  // マップ
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c*CELL, y = r*CELL, cell = map[r][c];
      if (cell === 2) {
        drawBlock(x, y, HARD_T, HARD_S);
      } else if (cell === 1) {
        drawBlock(x, y, SOFT_T, SOFT_S);
        ctx.strokeStyle = SOFT_S; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x+6,y+5); ctx.lineTo(x+22,y+17);
        ctx.moveTo(x+30,y+10); ctx.lineTo(x+18,y+28);
        ctx.stroke();
      } else {
        ctx.fillStyle = (r+c)%2===0 ? FLOOR_A : FLOOR_B;
        ctx.fillRect(x, y, CELL, CELL);
      }
    }
  }

  // 爆発
  for (const cell of explosions) {
    const x = cell.c*CELL, y = cell.r*CELL;
    const g = ctx.createRadialGradient(x+CELL/2,y+CELL/2,2,x+CELL/2,y+CELL/2,CELL*0.7);
    g.addColorStop(0,'rgba(255,255,180,0.98)');
    g.addColorStop(0.35,'rgba(255,130,0,0.92)');
    g.addColorStop(1,'rgba(200,0,0,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, CELL, CELL);
  }

  // 剣エフェクト
  for (let i = swordEffects.length - 1; i >= 0; i--) {
    const ef = swordEffects[i];
    if (ef.expires <= now) { swordEffects.splice(i, 1); continue; }
    const t = (ef.expires - now) / 280;
    for (const cell of ef.cells) {
      const x = cell.c*CELL, y = cell.r*CELL;
      ctx.fillStyle = ef.color + Math.round(t * 0xCC).toString(16).padStart(2,'0');
      ctx.fillRect(x, y, CELL, CELL);
      // 斬撃線
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3 * t;
      ctx.beginPath();
      ctx.moveTo(x+4, y+4); ctx.lineTo(x+CELL-4, y+CELL-4);
      ctx.moveTo(x+CELL-4, y+4); ctx.lineTo(x+4, y+CELL-4);
      ctx.stroke();
    }
  }

  // パワーアップ（明るく改善）
  for (const pu of powerups) {
    const x = pu.c*CELL, y = pu.r*CELL;
    // 背景
    ctx.fillStyle = PU_COLOR[pu.type];
    ctx.fillRect(x+2, y+2, CELL-4, CELL-4);
    // 光沢
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x+2, y+2, CELL-4, (CELL-4)/2);
    // アイコン
    const pulse = 0.88 + 0.12 * Math.sin(now / 350);
    ctx.font = `${CELL * 0.56 * pulse}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(PU_ICON[pu.type], x+CELL/2, y+CELL/2 + 1);
    // 枠
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x+2, y+2, CELL-4, CELL-4);
  }

  // ボム
  for (const bomb of bombs) {
    const cx = bomb.c*CELL+CELL/2, cy = bomb.r*CELL+CELL/2;
    const t = Math.max(0,(bomb.explodeAt-now)/3000);
    const pulse = 0.82+0.18*Math.sin(now/(180+220*t));
    const rad = CELL*0.33*pulse;
    ctx.fillStyle='rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(cx+2,cy+rad*0.6,rad*0.75,rad*0.28,0,0,Math.PI*2); ctx.fill();
    const bg = ctx.createRadialGradient(cx-rad*0.3,cy-rad*0.3,0,cx,cy,rad);
    bg.addColorStop(0,'#555'); bg.addColorStop(1,'#111');
    ctx.fillStyle=bg; ctx.beginPath(); ctx.arc(cx,cy,rad,0,Math.PI*2); ctx.fill();
    const sc = t>0.4?'#ff8c00':'#ff2200';
    ctx.fillStyle=sc; ctx.shadowBlur=8; ctx.shadowColor=sc;
    ctx.beginPath(); ctx.arc(cx+rad*0.35,cy-rad*0.75,3.5,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0;
    ctx.strokeStyle=t>0.35?'#ffd000':'#ff3300'; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.arc(cx,cy,rad+4,-Math.PI/2,-Math.PI/2+t*Math.PI*2); ctx.stroke();
  }

  // プレイヤー
  ctx.imageSmoothingEnabled = false;
  for (const p of players) {
    const px = p.x * CELL, py = p.y * CELL;
    if (!p.alive) {
      ctx.globalAlpha = 0.25;
      drawSprite(p, px, py, false, now);
      ctx.globalAlpha = 1;
    } else {
      drawSprite(p, px, py, p.idx === myIdx, now);
    }
  }

  updateHUD(players);

  // チートメッセージ
  if (cheatMsg && cheatMsg.expires > now) {
    const t = (cheatMsg.expires - now) / 2500;
    ctx.globalAlpha = Math.min(1, t * 5);
    ctx.fillStyle = '#ff4757';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.shadowBlur = 20; ctx.shadowColor = '#ff4757';
    ctx.fillText(cheatMsg.text, canvas.width/2, 12);
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
}

function updateHUD(players) {
  document.getElementById('hud').innerHTML = players.map(p => `
    <div class="hud-card${p.idx===myIdx?' me':''}${!p.alive?' dead':''}${p.sword?' sword':''}">
      <div class="hud-dot" style="background:${p.color}"></div>
      <span>P${p.idx+1}${p.idx===myIdx?' (あなた)':''}</span>
      <span class="hud-stat">💣 <span class="hud-val">${p.maxBombs}</span></span>
      <span class="hud-stat">🔥 <span class="hud-val">${p.bombRadius}</span></span>
      ${p.sword?'<span style="color:#ff4757">💀SWORD</span>':''}
      ${!p.alive?'<span style="color:#ff4757">DEAD</span>':''}
    </div>
  `).join('');
}

function loop() { render(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
