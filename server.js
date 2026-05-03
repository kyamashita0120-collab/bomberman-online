const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const PLAYER_COLORS = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502'];
const GAME_TYPES  = ['bomberman', 'tetris', 'airhockey', 'fps'];
const GAME_LABELS = ['ボンバーマン', 'テトリス', 'エアホッケー', '2D FPS'];

// ═══════════════════════════════ BOMBERMAN ══════════════════════
const BM_COLS = 15, BM_ROWS = 13;
const BOMB_TIMER = 3000, EXPL_DUR = 600;
const PU_TYPES = ['bomb', 'radius', 'speed'];
const BM_STARTS = [[0,0],[0,BM_COLS-1],[BM_ROWS-1,0],[BM_ROWS-1,BM_COLS-1]];

function makeMap() {
  const map = Array.from({length:BM_ROWS}, (_,r) =>
    Array.from({length:BM_COLS}, (_,c) => (r%2===1 && c%2===1 ? 2 : 0)));
  const safe = new Set();
  for (const [sr,sc] of BM_STARTS)
    for (let dr=-2;dr<=2;dr++) for (let dc=-2;dc<=2;dc++)
      if (Math.abs(dr)+Math.abs(dc)<=2) safe.add(`${sr+dr},${sc+dc}`);
  for (let r=0;r<BM_ROWS;r++) for (let c=0;c<BM_COLS;c++)
    if (map[r][c]===0 && !safe.has(`${r},${c}`) && Math.random()<0.65) map[r][c]=1;
  return map;
}

class BombermanGame {
  constructor(room) {
    this.room = room;
    this.map = makeMap();
    this.bombs = []; this.explosions = []; this.powerups = [];
    this.bombId = 0; this._tickTimer = null; this._last = 0;
    this.ps = {};
    Object.keys(room.players).forEach((sid,i) => {
      const [sr,sc] = BM_STARTS[i];
      this.ps[sid] = { x:sc+0.5, y:sr+0.5, alive:true,
        speed:4, maxBombs:1, bombRadius:2, activeBombs:0,
        keys:{up:false,dn:false,lt:false,rt:false,bm:false},
        bmPressed:false, dir:'down', moving:false,
        sword:false, invincible:false, swordCooldown:0 };
    });
  }
  start() { this._last=Date.now(); this._tickTimer=setInterval(()=>this._tick(),50); }
  stop()  { clearInterval(this._tickTimer); }
  onKeys(sid,k)  { if(this.ps[sid]) this.ps[sid].keys=k; }
  onCheat(sid,c) { if(this.ps[sid]&&c==='sword'){this.ps[sid].sword=true;this.ps[sid].invincible=true;} }
  onSwing(sid)   { const p=this.ps[sid]; if(p?.alive) this._swing(sid,p,Date.now()); }

  _tick() {
    const now=Date.now(), dt=Math.min((now-this._last)/1000,0.1); this._last=now;
    this._move(dt); this._bombs(now); this._clearEx(now); this._kill(); this._win();
    io.to(this.room.id).emit('state', this._ser());
  }
  _move(dt) {
    for (const [sid,p] of Object.entries(this.ps)) {
      if (!p.alive) continue;
      const {keys:k}=p; let dx=0,dy=0;
      if(k.up)dy-=1; if(k.dn)dy+=1; if(k.lt)dx-=1; if(k.rt)dx+=1;
      if(dx&&dy){dx*=0.707;dy*=0.707;}
      if(dy<0)p.dir='up'; else if(dy>0)p.dir='down';
      else if(dx<0)p.dir='left'; else if(dx>0)p.dir='right';
      p.moving=!!(dx||dy);
      const s=p.speed*dt;
      this._mv(p,dx*s,0,sid); this._mv(p,0,dy*s,sid);
      if(dx&&!dy){const c=Math.floor(p.y)+0.5,d=c-p.y;if(Math.abs(d)>0.001)this._mv(p,0,Math.sign(d)*Math.min(Math.abs(d),s*2),sid);}
      if(dy&&!dx){const c=Math.floor(p.x)+0.5,d=c-p.x;if(Math.abs(d)>0.001)this._mv(p,Math.sign(d)*Math.min(Math.abs(d),s*2),0,sid);}
      if(k.bm&&!p.bmPressed){this._bomb(sid,p);p.bmPressed=true;}
      if(!k.bm)p.bmPressed=false;
      this._pu(p);
    }
  }
  _mv(p,dx,dy,sid) {
    if(!dx&&!dy)return; const R=0.3,nx=p.x+dx,ny=p.y+dy,ch=[];
    if(dx>0)ch.push([ny-R,nx+R],[ny+R,nx+R]);else if(dx<0)ch.push([ny-R,nx-R],[ny+R,nx-R]);
    if(dy>0)ch.push([ny+R,nx-R],[ny+R,nx+R]);else if(dy<0)ch.push([ny-R,nx-R],[ny-R,nx+R]);
    for(const[cy,cx]of ch)if(this._solid(Math.floor(cy),Math.floor(cx),sid))return;
    p.x=Math.max(R,Math.min(BM_COLS-R,nx)); p.y=Math.max(R,Math.min(BM_ROWS-R,ny));
  }
  _solid(r,c,sid) {
    if(r<0||r>=BM_ROWS||c<0||c>=BM_COLS)return true;
    if(this.map[r][c]!==0)return true;
    for(const b of this.bombs)if(b.r===r&&b.c===c)return!(b.by===sid&&b.pass);
    return false;
  }
  _bomb(sid,p) {
    if(p.activeBombs>=p.maxBombs)return;
    const r=Math.floor(p.y),c=Math.floor(p.x);
    if(this.bombs.some(b=>b.r===r&&b.c===c))return;
    const b={id:this.bombId++,r,c,by:sid,rad:p.bombRadius,at:Date.now()+BOMB_TIMER,pass:true};
    this.bombs.push(b); p.activeBombs++;
    setTimeout(()=>{b.pass=false;},600);
  }
  _bombs(now) {
    const q=this.bombs.filter(b=>b.at<=now); let i=0;
    while(i<q.length){
      const b=q[i++],ix=this.bombs.findIndex(x=>x.id===b.id);
      if(ix===-1)continue;
      this.bombs.splice(ix,1);
      const cells=this._exCells(b);
      this.explosions.push({cells,exp:now+EXPL_DUR});
      const p=this.ps[b.by]; if(p)p.activeBombs=Math.max(0,p.activeBombs-1);
      for(const nb of this.bombs)if(cells.some(c=>c.r===nb.r&&c.c===nb.c)&&!q.some(x=>x.id===nb.id))q.push(nb);
    }
  }
  _exCells(b) {
    const cells=[{r:b.r,c:b.c}];
    for(const[dr,dc]of[[0,1],[0,-1],[1,0],[-1,0]]){
      for(let i=1;i<=b.rad;i++){
        const nr=b.r+dr*i,nc=b.c+dc*i;
        if(nr<0||nr>=BM_ROWS||nc<0||nc>=BM_COLS)break;
        if(this.map[nr][nc]===2)break;
        cells.push({r:nr,c:nc});
        if(this.map[nr][nc]===1){
          this.map[nr][nc]=0;
          if(Math.random()<0.35)this.powerups.push({r:nr,c:nc,type:PU_TYPES[Math.floor(Math.random()*3)]});
          break;
        }
      }
    }
    return cells;
  }
  _clearEx(now){this.explosions=this.explosions.filter(e=>e.exp>now);}
  _kill(){
    for(const p of Object.values(this.ps)){
      if(!p.alive)continue;
      const r=Math.floor(p.y),c=Math.floor(p.x);
      for(const e of this.explosions)if(!p.invincible&&e.cells.some(x=>x.r===r&&x.c===c)){p.alive=false;break;}
    }
  }
  _pu(p){
    const r=Math.floor(p.y),c=Math.floor(p.x),i=this.powerups.findIndex(u=>u.r===r&&u.c===c);
    if(i===-1)return;
    const[pu]=this.powerups.splice(i,1);
    if(pu.type==='bomb')p.maxBombs=Math.min(5,p.maxBombs+1);
    else if(pu.type==='radius')p.bombRadius=Math.min(7,p.bombRadius+1);
    else if(pu.type==='speed')p.speed=Math.min(7,p.speed+0.8);
  }
  _swingCells(r,c,dir){
    if(dir==='down') return[{r:r+1,c:c-1},{r:r+1,c},{r:r+1,c:c+1}];
    if(dir==='up')   return[{r:r-1,c:c-1},{r:r-1,c},{r:r-1,c:c+1}];
    if(dir==='left') return[{r:r-1,c:c-1},{r,c:c-1},{r:r+1,c:c-1}];
    return[{r:r-1,c:c+1},{r,c:c+1},{r:r+1,c:c+1}];
  }
  _swing(sid,p,now){
    if(!p.sword||now-p.swordCooldown<500)return;
    p.swordCooldown=now;
    const cells=this._swingCells(Math.floor(p.y),Math.floor(p.x),p.dir);
    for(const{r:nr,c:nc}of cells){
      if(nr<0||nr>=BM_ROWS||nc<0||nc>=BM_COLS)continue;
      if(this.map[nr][nc]===1)this.map[nr][nc]=0;
      for(const[osid,op]of Object.entries(this.ps))
        if(op.alive&&osid!==sid&&!op.invincible&&Math.floor(op.y)===nr&&Math.floor(op.x)===nc)op.alive=false;
    }
    io.to(this.room.id).emit('swordEffect',{cells,color:this.room.players[sid].color});
  }
  _win(){
    const alive=Object.entries(this.ps).filter(([,p])=>p.alive);
    if(alive.length>1)return;
    const w=alive[0],wp=w?this.room.players[w[0]]:null;
    this.room.endGame({winner:wp?wp.idx+1:null,color:wp?wp.color:null});
  }
  _ser(){
    return{type:'bomberman',map:this.map,
      players:Object.entries(this.ps).map(([sid,p])=>{
        const pl=this.room.players[sid];
        return{id:sid,idx:pl.idx,color:pl.color,x:p.x,y:p.y,alive:p.alive,
          maxBombs:p.maxBombs,activeBombs:p.activeBombs,bombRadius:p.bombRadius,
          dir:p.dir,moving:p.moving,sword:p.sword};
      }),
      bombs:this.bombs.map(b=>({r:b.r,c:b.c,at:b.at})),
      explosions:this.explosions.flatMap(e=>e.cells),
      powerups:this.powerups};
  }
}

// ═══════════════════════════════ TETRIS ═════════════════════════
const TW=10,TH=20;
// Pieces: cells as [row,col] offsets
const TPIECES=[
  [[0,0],[0,1],[0,2],[0,3]], // I
  [[0,0],[0,1],[1,0],[1,1]], // O
  [[0,1],[1,0],[1,1],[1,2]], // T
  [[0,1],[0,2],[1,0],[1,1]], // S
  [[0,0],[0,1],[1,1],[1,2]], // Z
  [[0,0],[1,0],[1,1],[1,2]], // J
  [[0,2],[1,0],[1,1],[1,2]], // L
];
// Colors indexed 1-7; 0=empty, 8=garbage
const TCOLORS=['','#00f0f0','#f0f000','#a000f0','#00f000','#f00000','#0000f0','#f0a000','#888888'];

function rotCW(cells){
  const maxR=Math.max(...cells.map(c=>c[0]));
  const r=cells.map(([r,c])=>[c,maxR-r]);
  const minR=Math.min(...r.map(c=>c[0])),minC=Math.min(...r.map(c=>c[1]));
  return r.map(([r,c])=>[r-minR,c-minC]);
}

class TetrisGame {
  constructor(room){
    this.room=room; this._tick=null; this._emit=null; this._last=0;
    this.ps={};
    for(const sid of Object.keys(room.players)) this.ps[sid]=this._newPs();
  }
  _newPs(){
    return{board:Array.from({length:TH},()=>new Array(TW).fill(0)),
      type:this._rand(),next:this._rand(),cells:null,px:3,py:0,
      score:0,lines:0,alive:true,grav:0};
  }
  _rand(){return Math.floor(Math.random()*7);}
  _initPiece(ps){ps.cells=TPIECES[ps.type].map(c=>[...c]);ps.px=3;ps.py=0;ps.grav=0;}

  start(){
    for(const ps of Object.values(this.ps))this._initPiece(ps);
    this._last=Date.now();
    this._tick=setInterval(()=>this._update(),50);
    this._emit=setInterval(()=>io.to(this.room.id).emit('state',this._ser()),100);
  }
  stop(){clearInterval(this._tick);clearInterval(this._emit);}
  onKeys(){}
  onTetMove(sid,m){
    const ps=this.ps[sid]; if(!ps||!ps.alive)return;
    if(m==='left')this._mh(ps,-1);
    else if(m==='right')this._mh(ps,1);
    else if(m==='rotCW')this._rot(ps,1);
    else if(m==='rotCCW')this._rot(ps,-1);
    else if(m==='softDrop'){if(this._can(ps,ps.cells,ps.px,ps.py+1)){ps.py++;ps.grav=0;}}
    else if(m==='hardDrop'){while(this._can(ps,ps.cells,ps.px,ps.py+1))ps.py++;this._lock(ps,sid);}
  }
  _update(){
    const now=Date.now(),dt=(now-this._last)/1000; this._last=now;
    for(const[sid,ps]of Object.entries(this.ps)){
      if(!ps.alive)continue;
      ps.grav+=dt;
      const iv=Math.max(0.08,0.8-ps.lines*0.015);
      if(ps.grav>=iv){ps.grav=0;this._gravity(ps,sid);}
    }
    this._checkWin();
  }
  _can(ps,cells,px,py){
    for(const[r,c]of cells){const ar=r+py,ac=c+px;if(ar<0||ar>=TH||ac<0||ac>=TW||ps.board[ar][ac]!==0)return false;}
    return true;
  }
  _mh(ps,dx){if(this._can(ps,ps.cells,ps.px+dx,ps.py))ps.px+=dx;}
  _rot(ps,dir){
    let nc=rotCW(ps.cells);
    if(dir===-1)nc=rotCW(rotCW(rotCW(ps.cells)));
    if(this._can(ps,nc,ps.px,ps.py)){ps.cells=nc;return;}
    for(const ox of[-1,1,-2,2])if(this._can(ps,nc,ps.px+ox,ps.py)){ps.cells=nc;ps.px+=ox;return;}
  }
  _gravity(ps,sid){
    if(this._can(ps,ps.cells,ps.px,ps.py+1))ps.py++;
    else this._lock(ps,sid);
  }
  _lock(ps,sid){
    const abs=ps.cells.map(([r,c])=>[r+ps.py,c+ps.px]);
    if(abs.some(([r])=>r<0)){ps.alive=false;return;}
    const ci=ps.type+1;
    for(const[r,c]of abs)ps.board[r][c]=ci;
    const cleared=this._clear(ps);
    ps.score+=[0,100,300,500,800][cleared]||0; ps.lines+=cleared;
    if(cleared>1){
      const g=cleared-1;
      for(const[osid,ops]of Object.entries(this.ps))
        if(osid!==sid&&ops.alive)this._garbage(ops,g);
    }
    ps.type=ps.next; ps.next=this._rand();
    this._initPiece(ps);
    if(!this._can(ps,ps.cells,ps.px,ps.py))ps.alive=false;
  }
  _clear(ps){
    let n=0;
    for(let r=TH-1;r>=0;r--){
      if(ps.board[r].every(c=>c!==0)){
        ps.board.splice(r,1); ps.board.unshift(new Array(TW).fill(0));
        n++; r++;
      }
    }
    return n;
  }
  _garbage(ps,n){
    const gap=Math.floor(Math.random()*TW);
    for(let i=0;i<n;i++){
      ps.board.shift();
      const row=new Array(TW).fill(8); row[gap]=0;
      ps.board.push(row);
    }
  }
  _checkWin(){
    const alive=Object.entries(this.ps).filter(([,p])=>p.alive);
    if(Object.keys(this.ps).length<2||alive.length>1)return;
    const w=alive[0],wp=w?this.room.players[w[0]]:null;
    this.room.endGame({winner:wp?wp.idx+1:null,color:wp?wp.color:null});
  }
  _ser(){
    return{type:'tetris',players:Object.entries(this.ps).map(([sid,ps])=>{
      const pl=this.room.players[sid];
      return{id:sid,idx:pl.idx,color:pl.color,alive:ps.alive,
        board:ps.board,
        piece:{cells:ps.cells,px:ps.px,py:ps.py,ci:ps.type+1},
        next:ps.next+1,score:ps.score,lines:ps.lines};
    })};
  }
}

// ═══════════════════════════════ AIR HOCKEY ═════════════════════
const AH_W=720,AH_H=480,PAD_R=26,PUCK_R=16,GOAL_HALF=60;

class AirHockeyGame {
  constructor(room){
    this.room=room; this._tick=null; this._last=0;
    const angle=Math.random()*Math.PI*2;
    this.puck={x:AH_W/2,y:AH_H/2,vx:Math.cos(angle)*220,vy:Math.sin(angle)*220};
    this.ps={};
    const starts=[[PAD_R+60,AH_H/2],[AH_W-PAD_R-60,AH_H/2],[AH_W/2,PAD_R+60],[AH_W/2,AH_H-PAD_R-60]];
    Object.keys(room.players).forEach((sid,i)=>{
      this.ps[sid]={x:starts[i][0],y:starts[i][1],vx:0,vy:0,hp:3,
        keys:{up:false,dn:false,lt:false,rt:false}};
    });
    this._lastEmit=0;
  }
  start(){this._last=Date.now();this._tick=setInterval(()=>this._update(),16);}
  stop(){clearInterval(this._tick);}
  onKeys(sid,k){if(this.ps[sid])this.ps[sid].keys=k;}

  _respawn(){
    const a=Math.random()*Math.PI*2;
    this.puck={x:AH_W/2,y:AH_H/2,vx:Math.cos(a)*220,vy:Math.sin(a)*220};
  }

  _update(){
    const now=Date.now(),dt=Math.min((now-this._last)/1000,0.05); this._last=now;
    const SPD=300;
    for(const[,ps]of Object.entries(this.ps)){
      if(ps.hp<=0)continue;
      const{keys:k}=ps; let dx=0,dy=0;
      if(k.lt)dx-=1; if(k.rt)dx+=1; if(k.up)dy-=1; if(k.dn)dy+=1;
      if(dx&&dy){dx*=0.707;dy*=0.707;}
      ps.vx=dx*SPD; ps.vy=dy*SPD;
      ps.x=Math.max(PAD_R,Math.min(AH_W-PAD_R,ps.x+ps.vx*dt));
      ps.y=Math.max(PAD_R,Math.min(AH_H-PAD_R,ps.y+ps.vy*dt));
    }
    this.puck.x+=this.puck.vx*dt; this.puck.y+=this.puck.vy*dt;
    this.puck.vx*=Math.pow(0.992,dt*60); this.puck.vy*=Math.pow(0.992,dt*60);

    // Paddle-puck collision
    for(const[,ps]of Object.entries(this.ps)){
      if(ps.hp<=0)continue;
      const dx=this.puck.x-ps.x,dy=this.puck.y-ps.y,dist=Math.sqrt(dx*dx+dy*dy);
      const md=PAD_R+PUCK_R;
      if(dist<md&&dist>0){
        const nx=dx/dist,ny=dy/dist;
        this.puck.x=ps.x+nx*md; this.puck.y=ps.y+ny*md;
        const rel=this.puck.vx*nx+this.puck.vy*ny-(ps.vx*nx+ps.vy*ny);
        if(rel<0){
          this.puck.vx-=rel*nx*1.6+ps.vx*0.4;
          this.puck.vy-=rel*ny*1.6+ps.vy*0.4;
          const spd=Math.sqrt(this.puck.vx**2+this.puck.vy**2);
          if(spd>900){this.puck.vx*=900/spd;this.puck.vy*=900/spd;}
        }
      }
    }

    // Wall / goal handling
    const numP=Object.keys(this.ps).length;
    // left wall/goal (defends idx=0)
    if(this.puck.x-PUCK_R<=0){
      if(Math.abs(this.puck.y-AH_H/2)<=GOAL_HALF){
        this._score(0); this._respawn();
      } else { this.puck.x=PUCK_R; this.puck.vx=Math.abs(this.puck.vx)*0.85; }
    }
    // right wall/goal (defends idx=1)
    if(this.puck.x+PUCK_R>=AH_W){
      if(Math.abs(this.puck.y-AH_H/2)<=GOAL_HALF){
        this._score(1); this._respawn();
      } else { this.puck.x=AH_W-PUCK_R; this.puck.vx=-Math.abs(this.puck.vx)*0.85; }
    }
    // top wall/goal (defends idx=2, only if 3+ players)
    if(this.puck.y-PUCK_R<=0){
      if(numP>=3&&Math.abs(this.puck.x-AH_W/2)<=GOAL_HALF){
        this._score(2); this._respawn();
      } else { this.puck.y=PUCK_R; this.puck.vy=Math.abs(this.puck.vy)*0.85; }
    }
    // bottom wall/goal (defends idx=3, only if 4 players)
    if(this.puck.y+PUCK_R>=AH_H){
      if(numP>=4&&Math.abs(this.puck.x-AH_W/2)<=GOAL_HALF){
        this._score(3); this._respawn();
      } else { this.puck.y=AH_H-PUCK_R; this.puck.vy=-Math.abs(this.puck.vy)*0.85; }
    }

    this._checkWin();
    if(now-this._lastEmit>=50){
      this._lastEmit=now;
      io.to(this.room.id).emit('state',this._ser());
    }
  }
  _score(defendIdx){
    const sid=Object.entries(this.room.players).find(([,p])=>p.idx===defendIdx)?.[0];
    if(sid&&this.ps[sid])this.ps[sid].hp=Math.max(0,this.ps[sid].hp-1);
  }
  _checkWin(){
    const alive=Object.entries(this.ps).filter(([,p])=>p.hp>0);
    if(alive.length>1)return;
    const w=alive[0],wp=w?this.room.players[w[0]]:null;
    this.room.endGame({winner:wp?wp.idx+1:null,color:wp?wp.color:null});
  }
  _ser(){
    return{type:'airhockey',
      puck:{x:this.puck.x,y:this.puck.y},
      players:Object.entries(this.ps).map(([sid,ps])=>{
        const pl=this.room.players[sid];
        return{id:sid,idx:pl.idx,color:pl.color,x:ps.x,y:ps.y,hp:ps.hp};
      })};
  }
}

// ═══════════════════════════════ FPS ════════════════════════════
const FPS_COLS=15,FPS_ROWS=13;
const FPS_MAP_RAW=[
  '###############',
  '#.............#',
  '#.###...###..#',
  '#.............#',
  '#...#.#.#....#',
  '#.............#',
  '#.#.......#..#',
  '#.............#',
  '#...#.#.#....#',
  '#.............#',
  '#.###...###..#',
  '#.............#',
  '###############',
];
const FPS_MAP_BASE=FPS_MAP_RAW.map(r=>r.split('').map(c=>c==='#'?1:0));
const FPS_STARTS=[[1.5,1.5],[13.5,1.5],[1.5,11.5],[13.5,11.5]];

class FPSGame {
  constructor(room){
    this.room=room; this._tick=null; this._last=0;
    this.bullets=[]; this.bulletId=0;
    this.ps={};
    Object.keys(room.players).forEach((sid,i)=>{
      const[x,y]=FPS_STARTS[i];
      this.ps[sid]={x,y,angle:Math.PI/2,hp:5,alive:true,speed:5,
        keys:{up:false,dn:false,lt:false,rt:false,bm:false},
        shootCd:0};
    });
  }
  start(){this._last=Date.now();this._tick=setInterval(()=>this._update(),50);}
  stop(){clearInterval(this._tick);}
  onKeys(sid,k){if(this.ps[sid])this.ps[sid].keys=k;}

  _update(){
    const now=Date.now(),dt=Math.min((now-this._last)/1000,0.1); this._last=now;
    for(const[sid,p]of Object.entries(this.ps)){
      if(!p.alive)continue;
      const{keys:k}=p;
      if(k.lt)p.angle-=3.0*dt; if(k.rt)p.angle+=3.0*dt;
      let dx=0,dy=0;
      if(k.up){dx+=Math.cos(p.angle)*p.speed*dt;dy+=Math.sin(p.angle)*p.speed*dt;}
      if(k.dn){dx-=Math.cos(p.angle)*p.speed*dt;dy-=Math.sin(p.angle)*p.speed*dt;}
      this._mv(p,dx,0); this._mv(p,0,dy);
      if(k.bm&&now-p.shootCd>400){
        p.shootCd=now;
        this.bullets.push({id:this.bulletId++,owner:sid,
          x:p.x+Math.cos(p.angle)*0.4,y:p.y+Math.sin(p.angle)*0.4,
          vx:Math.cos(p.angle)*18,vy:Math.sin(p.angle)*18,
          dist:0,max:14});
      }
    }
    for(let i=this.bullets.length-1;i>=0;i--){
      const b=this.bullets[i];
      b.x+=b.vx*dt; b.y+=b.vy*dt;
      b.dist+=Math.sqrt(b.vx**2+b.vy**2)*dt;
      const br=Math.floor(b.y),bc=Math.floor(b.x);
      if(br<0||br>=FPS_ROWS||bc<0||bc>=FPS_COLS||FPS_MAP_BASE[br][bc]===1){this.bullets.splice(i,1);continue;}
      if(b.dist>=b.max){this.bullets.splice(i,1);continue;}
      let hit=false;
      for(const[sid,p]of Object.entries(this.ps)){
        if(!p.alive||sid===b.owner)continue;
        const dx=b.x-p.x,dy=b.y-p.y;
        if(dx*dx+dy*dy<0.3*0.3){
          p.hp--; if(p.hp<=0)p.alive=false;
          this.bullets.splice(i,1); hit=true; break;
        }
      }
      if(hit)continue;
    }
    this._checkWin();
    io.to(this.room.id).emit('state',this._ser());
  }
  _mv(p,dx,dy){
    if(!dx&&!dy)return; const R=0.28,nx=p.x+dx,ny=p.y+dy;
    const corners=[[ny-R,nx-R],[ny-R,nx+R],[ny+R,nx-R],[ny+R,nx+R]];
    for(const[cy,cx]of corners){
      const r=Math.floor(cy),c=Math.floor(cx);
      if(r<0||r>=FPS_ROWS||c<0||c>=FPS_COLS||FPS_MAP_BASE[r][c]===1)return;
    }
    p.x=Math.max(R,Math.min(FPS_COLS-R,nx));
    p.y=Math.max(R,Math.min(FPS_ROWS-R,ny));
  }
  _checkWin(){
    const alive=Object.entries(this.ps).filter(([,p])=>p.alive);
    if(alive.length>1)return;
    const w=alive[0],wp=w?this.room.players[w[0]]:null;
    this.room.endGame({winner:wp?wp.idx+1:null,color:wp?wp.color:null});
  }
  _ser(){
    return{type:'fps',map:FPS_MAP_BASE,
      players:Object.entries(this.ps).map(([sid,p])=>{
        const pl=this.room.players[sid];
        return{id:sid,idx:pl.idx,color:pl.color,x:p.x,y:p.y,angle:p.angle,hp:p.hp,alive:p.alive};
      }),
      bullets:this.bullets.map(b=>({id:b.id,x:b.x,y:b.y,owner:b.owner}))};
  }
}

// ═══════════════════════════════ ROOM ═══════════════════════════
class Room {
  constructor(id){
    this.id=id; this.matchNumber=0;
    this.players={}; this.game=null;
    this.started=false; this._cdTimer=null;
  }
  get gameType(){return GAME_TYPES[this.matchNumber%4];}
  get gameLabel(){return GAME_LABELS[this.matchNumber%4];}
  playerCount(){return Object.keys(this.players).length;}
  addPlayer(sid){
    const idx=this.playerCount(); if(idx>=4)return false;
    this.players[sid]={id:sid,idx,color:PLAYER_COLORS[idx],ready:false};
    return true;
  }
  removePlayer(sid){delete this.players[sid];}
  startGame(){
    this.started=true;
    if(this.gameType==='bomberman') this.game=new BombermanGame(this);
    else if(this.gameType==='tetris') this.game=new TetrisGame(this);
    else if(this.gameType==='airhockey') this.game=new AirHockeyGame(this);
    else this.game=new FPSGame(this);
    this.game.start();
  }
  endGame(data){
    if(this.game){this.game.stop();this.game=null;}
    this.started=false;
    for(const p of Object.values(this.players))p.ready=false;
    this.matchNumber++;
    io.to(this.id).emit('gameOver',{...data,matchNumber:this.matchNumber,
      nextGame:this.gameType,nextLabel:this.gameLabel});
    setTimeout(()=>{
      io.to(this.id).emit('returnToLobby',{matchNumber:this.matchNumber,
        nextGame:this.gameType,nextLabel:this.gameLabel});
      emitLobby(this);
    },4000);
  }
}

// ═══════════════════════════════ SOCKET ═════════════════════════
const rooms=new Map();
function findRoom(){
  for(const r of rooms.values())if(!r.started&&r.playerCount()<4)return r;
  const id='room_'+Date.now(),r=new Room(id);
  rooms.set(id,r); return r;
}
function lobbySlots(room){
  return Object.values(room.players).map(p=>({idx:p.idx,color:p.color,ready:p.ready}));
}
function emitLobby(room){
  io.to(room.id).emit('lobby',{cnt:room.playerCount(),slots:lobbySlots(room),
    gameType:room.gameType,gameLabel:room.gameLabel,matchNumber:room.matchNumber});
}
function tryStartCD(room){
  const pl=Object.values(room.players);
  if(pl.length<2||!pl.every(p=>p.ready)||room._cdTimer||room.started)return;
  const gt=room.gameType,gl=room.gameLabel;
  let n=3; io.to(room.id).emit('countdown',n);
  room._cdTimer=setInterval(()=>{
    n--;
    if(n<=0){
      clearInterval(room._cdTimer);room._cdTimer=null;
      room.startGame();
      io.to(room.id).emit('gameStart',{gameType:gt,gameLabel:gl});
    } else io.to(room.id).emit('countdown',n);
  },1000);
}
function cancelCD(room){
  if(!room._cdTimer)return;
  clearInterval(room._cdTimer);room._cdTimer=null;
  io.to(room.id).emit('cdCancelled');
}

io.on('connection',socket=>{
  let room=null;
  socket.on('join',()=>{
    room=findRoom();
    if(!room.addPlayer(socket.id)){socket.emit('full');return;}
    socket.join(room.id);
    const p=room.players[socket.id];
    socket.emit('joined',{idx:p.idx,cnt:room.playerCount(),slots:lobbySlots(room),
      gameType:room.gameType,gameLabel:room.gameLabel,matchNumber:room.matchNumber});
    emitLobby(room);
  });
  socket.on('ready',()=>{
    const p=room?.players[socket.id]; if(!p||room.started)return;
    p.ready=!p.ready; emitLobby(room);
    if(p.ready)tryStartCD(room); else cancelCD(room);
  });
  socket.on('keys',k=>{if(room?.game)room.game.onKeys(socket.id,k);});
  socket.on('cheat',c=>{if(room?.game?.onCheat&&room.started)room.game.onCheat(socket.id,c);});
  socket.on('swing',()=>{if(room?.game?.onSwing)room.game.onSwing(socket.id);});
  socket.on('tetMove',m=>{if(room?.game?.onTetMove)room.game.onTetMove(socket.id,m);});
  socket.on('disconnect',()=>{
    if(!room)return;
    room.removePlayer(socket.id);
    if(room.playerCount()===0){if(room.game)room.game.stop();rooms.delete(room.id);}
    else{emitLobby(room);cancelCD(room);}
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Arcade on http://localhost:${PORT}`));
