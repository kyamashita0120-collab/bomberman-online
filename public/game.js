const socket = io();

const COLS=15,ROWS=13,CELL=48,SCALE=6,SPR=8;

// ── Sprites ───────────────────────────────────────────────────
const SPRITES={
  down0:['_HHHHHH_','_HSSSSH_','_HSESEH_','_HSSSSH_','_WWWWWW_','_WWGGWW_','PP____PP','BB____BB'],
  down1:['_HHHHHH_','_HSSSSH_','_HSESEH_','_HSSSSH_','_WWWWWW_','_WWGGWW_','_PP__PP_','_BB__BB_'],
  up0:  ['_HHHHHH_','_HHHHHH_','_DDHHDD_','_HHHHHH_','_WWWWWW_','_WGGGGW_','PP____PP','BB____BB'],
  up1:  ['_HHHHHH_','_HHHHHH_','_DDHHDD_','_HHHHHH_','_WWWWWW_','_WGGGGW_','_PP__PP_','_BB__BB_'],
  left0:['__HHHH__','__HSSH__','__HSEH__','__HSSH__','__WWWW__','__WGWW__','_PP_____','_BB_____'],
  left1:['__HHHH__','__HSSH__','__HSEH__','__HSSH__','__WWWW__','__WGWW__','___PP___','___BB___'],
  right0:['__HHHH__','__HSSH__','__HESH__','__HSSH__','__WWWW__','__WWGW__','_____PP_','_____BB_'],
  right1:['__HHHH__','__HSSH__','__HESH__','__HSSH__','__WWWW__','__WWGW__','___PP___','___BB___'],
};
const SKULL={
  down0:['_HHHHHH_','_H____H_','_HE__EH_','_H____H_','_HSSSSH_','_HHHHHH_','PP____PP','BB____BB'],
  down1:['_HHHHHH_','_H____H_','_HE__EH_','_H____H_','_HSSSSH_','_HHHHHH_','_PP__PP_','_BB__BB_'],
  up0:  ['_HHHHHH_','_H____H_','_H_DD_H_','_H____H_','_HHHHHH_','_HHHHHH_','PP____PP','BB____BB'],
  up1:  ['_HHHHHH_','_H____H_','_H_DD_H_','_H____H_','_HHHHHH_','_HHHHHH_','_PP__PP_','_BB__BB_'],
  left0:['__HHHH__','__H__H__','__HE_H__','__H__H__','__HSSH__','__HHHH__','_PP_____','_BB_____'],
  left1:['__HHHH__','__H__H__','__HE_H__','__H__H__','__HSSH__','__HHHH__','___PP___','___BB___'],
  right0:['__HHHH__','__H__H__','__H_EH__','__H__H__','__HSSH__','__HHHH__','_____PP_','_____BB_'],
  right1:['__HHHH__','__H__H__','__H_EH__','__H__H__','__HSSH__','__HHHH__','___PP___','___BB___'],
};
function loadCustomSprites(){
  try{const s=localStorage.getItem('bombermanSprites');if(!s)return;
    const p=JSON.parse(s);for(const k of Object.keys(SPRITES))if(p[k]?.length===8)SPRITES[k]=p[k];}
  catch(e){}
}
loadCustomSprites();
window.addEventListener('storage',e=>{if(e.key==='bombermanSprites')loadCustomSprites();});

const walkFrame={},walkTimer={};
function getFrame(p,now){
  if(walkTimer[p.id]===undefined){walkTimer[p.id]=now;walkFrame[p.id]=0;}
  if(p.moving){if(now-walkTimer[p.id]>180){walkFrame[p.id]^=1;walkTimer[p.id]=now;}}
  else walkFrame[p.id]=0;
  return walkFrame[p.id];
}
function darken(hex,f){return `rgb(${[1,3,5].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*f)).join(',')})`;}

function drawSprite(p,px,py,isMe,now){
  const sheet=p.sword?SKULL:SPRITES;
  const key=`${p.dir||'down'}${getFrame(p,now)}`;
  const spr=sheet[key]||sheet.down0;
  const sx=px-SPR*SCALE/2,sy=py-SPR*SCALE/2;
  const dc=darken(p.color,0.55);
  const pal={H:p.color,D:darken(p.color,0.65),S:'#FFBB88',E:'#111111',W:'#EEEEEE',G:'#AAAAAA',P:'#222222',B:dc};
  for(let r=0;r<SPR;r++){const row=spr[r];for(let c=0;c<SPR;c++){const ch=row[c];if(ch==='_')continue;ctx.fillStyle=pal[ch]||'#FF00FF';ctx.fillRect(sx+c*SCALE,sy+r*SCALE,SCALE,SCALE);}}
  if(isMe){const ty=sy-10;ctx.fillStyle=p.sword?'#ff4757':'#ffffff';ctx.beginPath();ctx.moveTo(px-7,ty);ctx.lineTo(px+7,ty);ctx.lineTo(px,ty+8);ctx.closePath();ctx.fill();}
  if(p.sword){ctx.strokeStyle=`rgba(255,50,50,${0.5+0.3*Math.sin(now/120)})`;ctx.lineWidth=2;ctx.strokeRect(sx-2,sy-2,SPR*SCALE+4,SPR*SCALE+4);}
}

// ── Canvas setup ──────────────────────────────────────────────
const canvas=document.getElementById('canvas');
const ctx=canvas.getContext('2d');
canvas.width=COLS*CELL; canvas.height=ROWS*CELL;

// ── State ─────────────────────────────────────────────────────
let myIdx=-1, gameState=null, phase='lobby', gameOverData=null;
let currentGameType='bomberman';
const swordEffects=[];
let typedBuf='',swordMode=false,cheatMsg=null;

// ── Input ─────────────────────────────────────────────────────
const keys={up:false,dn:false,lt:false,rt:false,bm:false};
const KEY_MAP={
  ArrowUp:'up',w:'up',W:'up',ArrowDown:'dn',s:'dn',S:'dn',
  ArrowLeft:'lt',a:'lt',A:'lt',ArrowRight:'rt',d:'rt',D:'rt',
  ' ':'bm',Enter:'bm',z:'bm',Z:'bm',
};

// Tetris DAS
let dasTid=null,dasIid=null;
function startDAS(move){
  clearTimeout(dasTid);clearInterval(dasIid);
  socket.emit('tetMove',move);
  dasTid=setTimeout(()=>{dasIid=setInterval(()=>socket.emit('tetMove',move),55);},170);
}
function stopDAS(){clearTimeout(dasTid);clearInterval(dasIid);}

document.addEventListener('keydown',e=>{
  // Cheat code detection
  if(e.key.length===1){
    typedBuf=(typedBuf+e.key.toLowerCase()).slice(-8);
    if(typedBuf.endsWith('sword')&&phase==='game'&&currentGameType==='bomberman'){
      socket.emit('cheat','sword'); swordMode=true;
      cheatMsg={text:'💀 SWORD MODE!',expires:Date.now()+2500}; typedBuf='';
    }
  }
  if((e.key==='e'||e.key==='E')&&swordMode&&phase==='game'&&currentGameType==='bomberman'){
    socket.emit('swing'); return;
  }

  // Tetris input
  if(phase==='game'&&currentGameType==='tetris'){
    if(e.key==='ArrowLeft'||e.key==='a'||e.key==='A'){e.preventDefault();startDAS('left');}
    else if(e.key==='ArrowRight'||e.key==='d'||e.key==='D'){e.preventDefault();startDAS('right');}
    else if(e.key==='ArrowDown'||e.key==='s'||e.key==='S'){e.preventDefault();startDAS('softDrop');}
    else if(e.key==='ArrowUp'||e.key==='w'||e.key==='W'){e.preventDefault();socket.emit('tetMove','rotCW');}
    else if(e.key==='z'||e.key==='Z'){socket.emit('tetMove','rotCCW');}
    else if(e.key===' '||e.key==='Enter'){e.preventDefault();socket.emit('tetMove','hardDrop');}
    return;
  }

  const k=KEY_MAP[e.key];
  if(!k)return;
  if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key))e.preventDefault();
  if(keys[k])return;
  keys[k]=true;
  if(phase==='game')socket.emit('keys',{...keys});
});

document.addEventListener('keyup',e=>{
  if(phase==='game'&&currentGameType==='tetris'){
    const tetKeys=['ArrowLeft','ArrowRight','ArrowDown','a','A','d','D','s','S'];
    if(tetKeys.includes(e.key))stopDAS();
    return;
  }
  const k=KEY_MAP[e.key]; if(!k)return;
  keys[k]=false;
  if(phase==='game')socket.emit('keys',{...keys});
});

// ── Socket events ─────────────────────────────────────────────
socket.on('joined',({idx,cnt,slots,gameType,gameLabel,matchNumber})=>{
  myIdx=idx; currentGameType=gameType||'bomberman';
  setLobbyStatus(cnt,slots,gameLabel,matchNumber);
  updateSlots(slots,idx);
});
socket.on('lobby',({cnt,slots,gameType,gameLabel,matchNumber})=>{
  currentGameType=gameType||'bomberman';
  setLobbyStatus(cnt,slots,gameLabel,matchNumber);
  updateSlots(slots,myIdx);
});
socket.on('countdown',n=>{
  phase='countdown'; showPhase('phase-countdown');
  const el=document.getElementById('countdown-num');
  el.textContent=n; el.style.animation='none'; el.offsetHeight; el.style.animation='';
});
socket.on('cdCancelled',()=>{phase='lobby';showPhase('phase-lobby');});
socket.on('gameStart',({gameType,gameLabel})=>{
  currentGameType=gameType||'bomberman';
  swordMode=false;
  // Resize canvas for game type
  if(gameType==='airhockey'){canvas.width=720;canvas.height=480;}
  else{canvas.width=COLS*CELL;canvas.height=ROWS*CELL;}
  phase='game';
  document.getElementById('overlay').style.display='none';
  document.getElementById('hud').innerHTML='';
  document.getElementById('game-label').textContent=gameLabel||'';
});
socket.on('state',s=>{gameState=s;});
socket.on('swordEffect',({cells,color})=>{swordEffects.push({cells,color,expires:Date.now()+280});});
socket.on('gameOver',data=>{
  phase='over'; gameOverData=data;
  document.getElementById('overlay').style.display='flex';
  showPhase('phase-over');
  const el=document.getElementById('winner-text');
  if(data.winner){el.style.color=data.color;el.textContent=`P${data.winner} の勝利！`;}
  else{el.style.color='#aaa';el.textContent='引き分け！';}
  const nl=document.getElementById('next-game-label');
  if(nl)nl.textContent=`次のゲーム: ${data.nextLabel||''}`;
});
socket.on('returnToLobby',({matchNumber,nextGame,nextLabel})=>{
  currentGameType=nextGame||'bomberman';
  phase='lobby';
  canvas.width=COLS*CELL; canvas.height=ROWS*CELL;
  document.getElementById('overlay').style.display='flex';
  showPhase('phase-lobby');
});
socket.on('full',()=>alert('満員です。ページを更新してください。'));

let isReady=false;
function toggleReady(){socket.emit('ready');}
function setLobbyStatus(cnt,slots,gameLabel,matchNumber){
  const readyCnt=slots?slots.filter(p=>p.ready).length:0;
  document.getElementById('lobby-status').textContent=
    `プレイヤー ${cnt}/4　準備完了 ${readyCnt}/${cnt}`;
  const glEl=document.getElementById('lobby-game-label');
  if(glEl)glEl.textContent=`マッチ ${(matchNumber||0)+1}: ${gameLabel||'ボンバーマン'}`;
  const mySlot=slots?.find(p=>p.idx===myIdx);
  isReady=mySlot?.ready||false;
  const btn=document.getElementById('ready-btn');
  if(btn){btn.textContent=isReady?'✓ 準備完了！':'準備OK';btn.classList.toggle('ready',isReady);}
}
function updateSlots(slots,myI){
  const c=document.getElementById('player-slots'); c.innerHTML='';
  for(let i=0;i<4;i++){
    const player=slots?.find(p=>p.idx===i);
    const s=document.createElement('div');
    s.className='slot'+(player?' filled':'')+(player?.idx===myI?' me':'');
    if(player)s.style.setProperty('--color',player.color);
    if(player)s.innerHTML=`P${i+1}${player.ready?'<span class="ready-mark">✓</span>':''}`;
    c.appendChild(s);
  }
}
function showPhase(id){
  for(const el of document.querySelectorAll('#overlay-content > div'))
    el.style.display=el.id===id?'':'none';
}
socket.emit('join');

// ══════════════════════════════════════════════════════════════
// RENDERERS
// ══════════════════════════════════════════════════════════════

// ── Bomberman renderer ────────────────────────────────────────
const FLOOR_A='#1a222e',FLOOR_B='#1e2836';
const HARD_T='#505860',HARD_S='#383e48';
const SOFT_T='#7a5228',SOFT_S='#5a3a18';
const PU_ICON={bomb:'💣',radius:'🔥',speed:'⚡'};
const PU_COLOR={bomb:'#ff4757',radius:'#ffd93d',speed:'#2ed573'};

function drawBlock(x,y,top,side){
  ctx.fillStyle=top; ctx.fillRect(x+1,y+1,CELL-2,CELL-2);
  ctx.fillStyle=side; ctx.fillRect(x+1,y+CELL-5,CELL-2,4); ctx.fillRect(x+CELL-5,y+1,4,CELL-6);
}

function drawBomberman(){
  const{map,players,bombs,explosions,powerups}=gameState;
  const now=Date.now();
  // Map
  for(let r=0;r<ROWS;r++){for(let c=0;c<COLS;c++){
    const x=c*CELL,y=r*CELL,cell=map[r][c];
    if(cell===2)drawBlock(x,y,HARD_T,HARD_S);
    else if(cell===1){
      drawBlock(x,y,SOFT_T,SOFT_S);
      ctx.strokeStyle=SOFT_S;ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(x+6,y+5);ctx.lineTo(x+22,y+17);
      ctx.moveTo(x+30,y+10);ctx.lineTo(x+18,y+28);ctx.stroke();
    } else {ctx.fillStyle=(r+c)%2===0?FLOOR_A:FLOOR_B;ctx.fillRect(x,y,CELL,CELL);}
  }}
  // Explosions
  for(const cell of explosions){
    const x=cell.c*CELL,y=cell.r*CELL;
    const g=ctx.createRadialGradient(x+CELL/2,y+CELL/2,2,x+CELL/2,y+CELL/2,CELL*0.7);
    g.addColorStop(0,'rgba(255,255,180,0.98)');g.addColorStop(0.35,'rgba(255,130,0,0.92)');g.addColorStop(1,'rgba(200,0,0,0.5)');
    ctx.fillStyle=g;ctx.fillRect(x,y,CELL,CELL);
  }
  // Sword effects
  for(let i=swordEffects.length-1;i>=0;i--){
    const ef=swordEffects[i];if(ef.expires<=now){swordEffects.splice(i,1);continue;}
    const t=(ef.expires-now)/280;
    for(const cell of ef.cells){
      const x=cell.c*CELL,y=cell.r*CELL;
      ctx.fillStyle=ef.color+Math.round(t*0xCC).toString(16).padStart(2,'0');
      ctx.fillRect(x,y,CELL,CELL);
      ctx.strokeStyle='#fff';ctx.lineWidth=3*t;ctx.beginPath();
      ctx.moveTo(x+4,y+4);ctx.lineTo(x+CELL-4,y+CELL-4);
      ctx.moveTo(x+CELL-4,y+4);ctx.lineTo(x+4,y+CELL-4);ctx.stroke();
    }
  }
  // Power-ups
  for(const pu of powerups){
    const x=pu.c*CELL,y=pu.r*CELL;
    ctx.fillStyle=PU_COLOR[pu.type];ctx.fillRect(x+2,y+2,CELL-4,CELL-4);
    ctx.fillStyle='rgba(255,255,255,0.25)';ctx.fillRect(x+2,y+2,CELL-4,(CELL-4)/2);
    const pulse=0.88+0.12*Math.sin(now/350);
    ctx.font=`${CELL*0.56*pulse}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(PU_ICON[pu.type],x+CELL/2,y+CELL/2+1);
    ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=1.5;ctx.strokeRect(x+2,y+2,CELL-4,CELL-4);
  }
  // Bombs
  for(const bomb of bombs){
    const cx=bomb.c*CELL+CELL/2,cy=bomb.r*CELL+CELL/2;
    const t=Math.max(0,(bomb.at-now)/3000),pulse=0.82+0.18*Math.sin(now/(180+220*t)),rad=CELL*0.33*pulse;
    ctx.fillStyle='rgba(0,0,0,0.4)';ctx.beginPath();ctx.ellipse(cx+2,cy+rad*0.6,rad*0.75,rad*0.28,0,0,Math.PI*2);ctx.fill();
    const bg=ctx.createRadialGradient(cx-rad*0.3,cy-rad*0.3,0,cx,cy,rad);
    bg.addColorStop(0,'#555');bg.addColorStop(1,'#111');
    ctx.fillStyle=bg;ctx.beginPath();ctx.arc(cx,cy,rad,0,Math.PI*2);ctx.fill();
    const sc=t>0.4?'#ff8c00':'#ff2200';
    ctx.fillStyle=sc;ctx.shadowBlur=8;ctx.shadowColor=sc;
    ctx.beginPath();ctx.arc(cx+rad*0.35,cy-rad*0.75,3.5,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    ctx.strokeStyle=t>0.35?'#ffd000':'#ff3300';ctx.lineWidth=2.5;
    ctx.beginPath();ctx.arc(cx,cy,rad+4,-Math.PI/2,-Math.PI/2+t*Math.PI*2);ctx.stroke();
  }
  // Players
  ctx.imageSmoothingEnabled=false;
  for(const p of players){
    const px=p.x*CELL,py=p.y*CELL;
    if(!p.alive){ctx.globalAlpha=0.25;drawSprite(p,px,py,false,now);ctx.globalAlpha=1;}
    else drawSprite(p,px,py,p.idx===myIdx,now);
  }
  // Cheat msg
  if(cheatMsg&&cheatMsg.expires>now){
    const t=(cheatMsg.expires-now)/2500;
    ctx.globalAlpha=Math.min(1,t*5);ctx.fillStyle='#ff4757';ctx.font='bold 28px sans-serif';
    ctx.textAlign='center';ctx.textBaseline='top';ctx.shadowBlur=20;ctx.shadowColor='#ff4757';
    ctx.fillText(cheatMsg.text,canvas.width/2,12);ctx.shadowBlur=0;ctx.globalAlpha=1;
  }
  // HUD
  document.getElementById('hud').innerHTML=players.map(p=>`
    <div class="hud-card${p.idx===myIdx?' me':''}${!p.alive?' dead':''}">
      <div class="hud-dot" style="background:${p.color}"></div>
      <span>P${p.idx+1}${p.idx===myIdx?' (あなた)':''}</span>
      <span class="hud-stat">💣<span class="hud-val">${p.maxBombs}</span></span>
      <span class="hud-stat">🔥<span class="hud-val">${p.bombRadius}</span></span>
      ${p.sword?'<span style="color:#ff4757">💀</span>':''}
      ${!p.alive?'<span style="color:#ff4757">DEAD</span>':''}
    </div>`).join('');
}

// ── Tetris renderer ───────────────────────────────────────────
const TC=16; // cell px
const TCOLORS_CLI=['','#00f0f0','#f0f000','#a000f0','#00f000','#f00000','#0000f0','#f0a000','#555566'];

function drawTetris(){
  const{players}=gameState;
  const n=players.length;
  ctx.fillStyle='#0d0d1a'; ctx.fillRect(0,0,canvas.width,canvas.height);

  // Layout: up to 2 per row
  const cols=Math.min(n,2), rows=Math.ceil(n/cols);
  const panelW=Math.floor(canvas.width/cols), panelH=Math.floor(canvas.height/rows);
  const boardW=TC*10, boardH=TC*20;

  players.forEach((p,i)=>{
    const col=i%cols, row=Math.floor(i/cols);
    const ox=col*panelW, oy=row*panelH;
    const bx=ox+(panelW-boardW)/2, by=oy+(panelH-boardH)/2;

    // Panel bg
    ctx.fillStyle= p.idx===myIdx?'rgba(255,165,2,0.07)':'rgba(255,255,255,0.03)';
    ctx.fillRect(ox,oy,panelW,panelH);

    // Player label
    ctx.font='bold 13px sans-serif'; ctx.fillStyle=p.color;
    ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillText(`P${p.idx+1}${p.idx===myIdx?' (あなた)':''}${!p.alive?' DEAD':''}`,ox+panelW/2,oy+4);

    // Board border
    ctx.strokeStyle=p.alive?(p.idx===myIdx?'#ffa502':'#444'):'#333';
    ctx.lineWidth=2; ctx.strokeRect(bx-1,by-1,boardW+2,boardH+2);

    // Board cells
    for(let r=0;r<20;r++){
      for(let c=0;c<10;c++){
        const v=p.board[r][c];
        if(v===0){ctx.fillStyle='#0a0a14';ctx.fillRect(bx+c*TC,by+r*TC,TC-1,TC-1);}
        else{
          ctx.fillStyle=TCOLORS_CLI[v]||'#888';
          ctx.fillRect(bx+c*TC,by+r*TC,TC-1,TC-1);
          ctx.fillStyle='rgba(255,255,255,0.25)';
          ctx.fillRect(bx+c*TC,by+r*TC,TC-1,3);
        }
      }
    }

    // Current piece
    if(p.piece&&p.alive){
      const pcolor=TCOLORS_CLI[p.piece.ci]||'#fff';
      // Ghost piece
      let ghostY=p.piece.py;
      while(true){
        const next=ghostY+1;
        let ok=true;
        for(const[r,c]of p.piece.cells){
          const ar=r+next,ac=c+p.piece.px;
          if(ar>=20||ac<0||ac>=10||(ar>=0&&p.board[ar][ac]!==0)){ok=false;break;}
        }
        if(!ok)break; ghostY=next;
      }
      for(const[r,c]of p.piece.cells){
        const gr=r+ghostY,gc=c+p.piece.px;
        if(gr>=0&&gr<20){ctx.fillStyle='rgba(255,255,255,0.15)';ctx.fillRect(bx+gc*TC,by+gr*TC,TC-1,TC-1);}
      }
      for(const[r,c]of p.piece.cells){
        const ar=r+p.piece.py,ac=c+p.piece.px;
        if(ar>=0&&ar<20){
          ctx.fillStyle=pcolor;ctx.fillRect(bx+ac*TC,by+ar*TC,TC-1,TC-1);
          ctx.fillStyle='rgba(255,255,255,0.3)';ctx.fillRect(bx+ac*TC,by+ar*TC,TC-1,3);
        }
      }
    }

    // Score
    ctx.font='11px sans-serif'; ctx.fillStyle='#aaa'; ctx.textAlign='center';
    ctx.fillText(`score:${p.score} lines:${p.lines}`, ox+panelW/2, oy+panelH-14);
  });

  // HUD
  document.getElementById('hud').innerHTML=players.map(p=>`
    <div class="hud-card${p.idx===myIdx?' me':''}${!p.alive?' dead':''}">
      <div class="hud-dot" style="background:${p.color}"></div>
      <span>P${p.idx+1}</span>
      <span class="hud-stat">Lines:<span class="hud-val">${p.lines}</span></span>
      ${!p.alive?'<span style="color:#ff4757">OUT</span>':''}
    </div>`).join('');
}

// ── Air Hockey renderer ───────────────────────────────────────
const AH_W=720,AH_H=480,PAD_R=26,PUCK_R=16,GOAL_H=60;

function drawAirHockey(){
  const{puck,players}=gameState;
  const now=Date.now();

  // Background (rink)
  ctx.fillStyle='#082018'; ctx.fillRect(0,0,AH_W,AH_H);

  // Rink lines
  ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(AH_W/2,0); ctx.lineTo(AH_W/2,AH_H); ctx.stroke();
  ctx.beginPath(); ctx.arc(AH_W/2,AH_H/2,80,0,Math.PI*2); ctx.stroke();

  // Goal openings
  const numP=players.length;
  function drawGoal(x,y,w,h,color){
    ctx.fillStyle=color+'44'; ctx.fillRect(x,y,w,h);
    ctx.strokeStyle=color; ctx.lineWidth=3; ctx.strokeRect(x,y,w,h);
  }
  // Left goal (P idx=0)
  drawGoal(-6, AH_H/2-GOAL_H, 6, GOAL_H*2, players.find(p=>p.idx===0)?.color||'#ff4757');
  // Right goal (P idx=1)
  drawGoal(AH_W, AH_H/2-GOAL_H, 6, GOAL_H*2, players.find(p=>p.idx===1)?.color||'#2ed573');
  if(numP>=3) drawGoal(AH_W/2-GOAL_H,-6,GOAL_H*2,6, players.find(p=>p.idx===2)?.color||'#1e90ff');
  if(numP>=4) drawGoal(AH_W/2-GOAL_H,AH_H,GOAL_H*2,6, players.find(p=>p.idx===3)?.color||'#ffa502');

  // Paddles
  for(const p of players){
    if(p.hp<=0){ctx.globalAlpha=0.3;}
    ctx.beginPath(); ctx.arc(p.x,p.y,PAD_R,0,Math.PI*2);
    ctx.fillStyle=p.color; ctx.fill();
    ctx.strokeStyle=p.idx===myIdx?'#fff':'rgba(255,255,255,0.4)';
    ctx.lineWidth=p.idx===myIdx?3:1.5; ctx.stroke();
    if(p.idx===myIdx){
      const ty=p.y-PAD_R-10;
      ctx.fillStyle='#fff'; ctx.beginPath();
      ctx.moveTo(p.x-7,ty); ctx.lineTo(p.x+7,ty); ctx.lineTo(p.x,ty+8); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha=1;
    // HP dots
    for(let i=0;i<3;i++){
      ctx.beginPath(); ctx.arc(p.x-14+i*14,p.y+PAD_R+10,5,0,Math.PI*2);
      ctx.fillStyle=i<p.hp?p.color:'#333'; ctx.fill();
    }
  }

  // Puck
  const pg=ctx.createRadialGradient(puck.x-PUCK_R*0.3,puck.y-PUCK_R*0.3,0,puck.x,puck.y,PUCK_R);
  pg.addColorStop(0,'#eee'); pg.addColorStop(1,'#555');
  ctx.beginPath(); ctx.arc(puck.x,puck.y,PUCK_R,0,Math.PI*2);
  ctx.fillStyle=pg; ctx.fill();
  ctx.strokeStyle='#222'; ctx.lineWidth=1; ctx.stroke();

  // HUD
  document.getElementById('hud').innerHTML=players.map(p=>`
    <div class="hud-card${p.idx===myIdx?' me':''}${p.hp<=0?' dead':''}">
      <div class="hud-dot" style="background:${p.color}"></div>
      <span>P${p.idx+1}</span>
      <span class="hud-stat">HP:<span class="hud-val">${p.hp}</span></span>
      ${p.hp<=0?'<span style="color:#ff4757">OUT</span>':''}
    </div>`).join('');
}

// ── FPS (top-down) renderer ───────────────────────────────────
const FC=48; // same cell size as bomberman

function drawFPS(){
  const{map,players,bullets}=gameState;
  const now=Date.now();
  const fRows=map.length, fCols=map[0].length;

  // Floor
  for(let r=0;r<fRows;r++){
    for(let c=0;c<fCols;c++){
      const x=c*FC,y=r*FC;
      if(map[r][c]===1){
        ctx.fillStyle='#2a3040'; ctx.fillRect(x,y,FC,FC);
        ctx.fillStyle='#1e2530'; ctx.fillRect(x+2,y+2,FC-4,FC-4);
      } else {
        ctx.fillStyle=(r+c)%2===0?'#0e1520':'#111825';
        ctx.fillRect(x,y,FC,FC);
      }
    }
  }

  // Bullets
  for(const b of bullets){
    const owner=players.find(p=>p.id===b.owner);
    ctx.beginPath(); ctx.arc(b.x*FC,b.y*FC,5,0,Math.PI*2);
    ctx.fillStyle=owner?owner.color:'#fff'; ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=1; ctx.stroke();
  }

  // Players
  for(const p of players){
    const px=p.x*FC, py=p.y*FC;
    if(!p.alive){ctx.globalAlpha=0.25;}
    // Body
    ctx.beginPath(); ctx.arc(px,py,FC*0.32,0,Math.PI*2);
    ctx.fillStyle=p.color; ctx.fill();
    ctx.strokeStyle=p.idx===myIdx?'#fff':'rgba(255,255,255,0.4)';
    ctx.lineWidth=p.idx===myIdx?2.5:1.5; ctx.stroke();
    // Direction indicator
    const dx=Math.cos(p.angle),dy=Math.sin(p.angle);
    ctx.strokeStyle=p.idx===myIdx?'#fff':p.color;
    ctx.lineWidth=3; ctx.beginPath();
    ctx.moveTo(px,py); ctx.lineTo(px+dx*FC*0.45,py+dy*FC*0.45); ctx.stroke();
    // Gun tip
    ctx.beginPath(); ctx.arc(px+dx*FC*0.45,py+dy*FC*0.45,4,0,Math.PI*2);
    ctx.fillStyle='#ccc'; ctx.fill();
    // Self marker ▽
    if(p.idx===myIdx){
      const ty=py-FC*0.45;
      ctx.fillStyle='#fff'; ctx.beginPath();
      ctx.moveTo(px-8,ty); ctx.lineTo(px+8,ty); ctx.lineTo(px,ty+9); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha=1;
    // HP bar
    const bw=FC*0.7,bx=px-bw/2,by2=py+FC*0.38;
    ctx.fillStyle='#333'; ctx.fillRect(bx,by2,bw,5);
    ctx.fillStyle=p.hp>2?'#2ed573':p.hp>1?'#ffa502':'#ff4757';
    ctx.fillRect(bx,by2,bw*p.hp/5,5);
  }

  // Controls hint (FPS)
  ctx.fillStyle='rgba(255,255,255,0.35)'; ctx.font='12px sans-serif';
  ctx.textAlign='left'; ctx.textBaseline='bottom';
  ctx.fillText('W/S:前後  A/D:回転  Space:射撃',8,canvas.height-8);

  // HUD
  document.getElementById('hud').innerHTML=players.map(p=>`
    <div class="hud-card${p.idx===myIdx?' me':''}${!p.alive?' dead':''}">
      <div class="hud-dot" style="background:${p.color}"></div>
      <span>P${p.idx+1}</span>
      <span class="hud-stat">HP:<span class="hud-val">${p.hp}</span></span>
      ${!p.alive?'<span style="color:#ff4757">DEAD</span>':''}
    </div>`).join('');
}

// ── Main render loop ──────────────────────────────────────────
function render(){
  if(phase!=='game'&&phase!=='over'){
    ctx.fillStyle='#111820'; ctx.fillRect(0,0,canvas.width,canvas.height);
    return;
  }
  if(!gameState)return;
  ctx.fillStyle='#0a0a14'; ctx.fillRect(0,0,canvas.width,canvas.height);
  const t=gameState.type||currentGameType;
  if(t==='bomberman')drawBomberman();
  else if(t==='tetris')drawTetris();
  else if(t==='airhockey')drawAirHockey();
  else if(t==='fps')drawFPS();
}

function loop(){render();requestAnimationFrame(loop);}
requestAnimationFrame(loop);
