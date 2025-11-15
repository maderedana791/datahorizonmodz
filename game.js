/* game.js - Cyber Runner Enhanced Prototype
   - Files: index.html, style.css, game.js
   - Default VIEW_MODE = "full"
   - DEBUG = false by default
   - Semua grafik dan tekstur di-generate lewat kode (no external assets)
*/

/* =======================
   CONFIG & GLOBALS
   ======================= */
const VIEW_MODE = "full"; // "full" or "blank"
let DEBUG = false;        // set true untuk overlay debug

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let dpr = Math.max(1, window.devicePixelRatio || 1);
const STORAGE_KEY = 'cyberrunner_enh_v1';

const config = {
  baseSpeed: 260,
  gravity: 2000,
  jumpImpulse: 780,
  slideDuration: 420,
  spawnBase: 1200, // ms
  groundHeight: 24,
  coinChance: 0.25,
  particleLimit: 200
};

const state = {
  running: false,
  paused: false,
  lastTS: 0,
  score: 0,
  best: 0,
  coins: 0,
  speed: config.baseSpeed,
  distance: 0,
  player: null,
  obstacles: [],
  coinsList: [],
  particles: [],
  spawnTimer: 0,
  viewport: { w: 0, h: 0 }
};

/* =======================
   utils: rand, clamp, lerp
   ======================= */
const rnd = (a=0,b=1) => a + Math.random()*(b-a);
const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
const lerp = (a,b,t) => a + (b-a)*t;

/* =======================
   Simple value-noise (1D) for subtle texture
   ======================= */
function makeValueNoise(seed=0) {
  const perm = new Uint8Array(256);
  for(let i=0;i<256;i++) perm[i] = i;
  for(let i=255;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    const t = perm[i]; perm[i]=perm[j]; perm[j]=t;
  }
  return function(x) {
    const xi = Math.floor(x) & 255;
    const xf = x - Math.floor(x);
    const a = perm[xi];
    const b = perm[(xi+1)&255];
    const u = xf*xf*(3-2*xf); // smoothstep
    return lerp(a/255, b/255, u);
  };
}
const noise1 = makeValueNoise();

/* =======================
   Offscreen patterns (ground texture and grid)
   ======================= */
let groundPattern = null;
function buildPatterns() {
  // ground: horizontal stripes with subtle noise
  const gW = 200, gH = 48;
  const oc = document.createElement('canvas');
  oc.width = gW; oc.height = gH;
  const octx = oc.getContext('2d');

  // base
  octx.fillStyle = '#071219';
  octx.fillRect(0,0,gW,gH);

  // stripes
  for(let x=0;x<gW;x+=6) {
    const a = 0.03 + 0.08*noise1(x*0.12);
    octx.fillStyle = `rgba(255,255,255,${a})`;
    octx.fillRect(x, 0, 2, gH);
  }

  // subtle gradient overlay
  const g = octx.createLinearGradient(0,0,0,gH);
  g.addColorStop(0,'rgba(255,255,255,0.015)');
  g.addColorStop(1,'rgba(0,0,0,0.08)');
  octx.fillStyle = g;
  octx.fillRect(0,0,gW,gH);

  groundPattern = ctx.createPattern(oc, 'repeat');
}

/* =======================
   Resize canvas & DPR
   ======================= */
function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(320, window.innerWidth);
  const h = Math.max(320, window.innerHeight);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  state.viewport.w = w; state.viewport.h = h;
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', ()=> setTimeout(resize, 60));

/* =======================
   Persistence
   ======================= */
function loadBest() {
  try { const v = localStorage.getItem(STORAGE_KEY); if(v) state.best = Number(v) || 0; } catch(e){}
}
function saveBest() {
  try { localStorage.setItem(STORAGE_KEY, String(state.best)); } catch(e){}
}

/* =======================
   Player & objects
   ======================= */
function makePlayer() {
  const w = Math.round(40);
  const h = Math.round(56);
  return {
    x: 84,
    y: 0,
    w, h,
    vy: 0,
    onGround: true,
    sliding: false,
    slideTimer: 0,
    trailTimer: 0
  };
}

function spawnObstacle() {
  const width = Math.round(rnd(28,84));
  const height = Math.round(rnd(28,110));
  const y = state.viewport.h - config.groundHeight - height;
  state.obstacles.push({
    x: state.viewport.w + 12,
    y, w: width, h: height,
    vx: -state.speed,
    passed: false,
    hue: rnd(0,360)
  });
  // sometimes spawn a coin above obstacle
  if(Math.random() < config.coinChance) {
    state.coinsList.push({
      x: state.viewport.w + 24 + rnd(0,60), y: y - rnd(42,90), r: 10,
      vy: 0, collected: false, wob: rnd(0,Math.PI*2)
    });
  }
}

/* =======================
   Particles
   ======================= */
function createParticle(x,y,opts={}) {
  if(state.particles.length > config.particleLimit) return;
  state.particles.push({
    x, y,
    vx: rnd(-120,120),
    vy: rnd(-260,-40),
    life: rnd(400,900),
    age: 0,
    r: rnd(1,4),
    color: opts.color || 'rgba(0,255,213,0.9)'
  });
}

/* =======================
   Collision helpers
   ======================= */
function aabb(a,b) {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

/* =======================
   Input handling (touch + mouse + keyboard)
   ======================= */
const zoneLeft = document.getElementById('touch-left');
const zoneRight = document.getElementById('touch-right');
const zoneBottom = document.getElementById('touch-bottom');

// prevent overscroll
document.addEventListener('touchmove', e => { e.preventDefault(); }, { passive:false });

let lastTap = 0;
let touchStartY = null;

function jump() {
  const p = state.player;
  if(p.sliding) return;
  if(p.onGround) {
    p.vy = -config.jumpImpulse;
    p.onGround = false;
    // audio
    audioBeep(200,0.02,0.09);
  }
}
function slide() {
  const p = state.player;
  if(!p.sliding && p.onGround) {
    p.sliding = true; p.slideTimer = config.slideDuration;
    // small crouch: reduce height visually by code
  }
}
function power() {
  // small boost: create burst particles and brief speed
  state.speed += 100;
  for(let i=0;i<20;i++) createParticle(state.player.x + state.player.w/2, state.player.y + state.player.h/2, {color:'rgba(255,128,0,0.9)'});
  setTimeout(()=> { state.speed = Math.max(config.baseSpeed, state.speed - 100); }, 900);
  audioBeep(520,0.03,0.06);
}

// touch detection (tap, double-tap, swipe down)
function tStart(e){ const t=e.changedTouches?e.changedTouches[0]:e; touchStartY=t.clientY; }
function tEnd(e,zone){ const t=e.changedTouches?e.changedTouches[0]:e; const dy = t.clientY - (touchStartY||t.clientY);
  const now=Date.now();
  if(dy>50){ slide(); return; }
  if(now - lastTap < 300) { power(); } else { jump(); }
  lastTap = now;
}

['touchstart','mousedown'].forEach(ev=>{
  zoneLeft.addEventListener(ev, tStart, {passive:false});
  zoneRight.addEventListener(ev, tStart, {passive:false});
  zoneBottom.addEventListener(ev, tStart, {passive:false});
});
['touchend','mouseup'].forEach(ev=>{
  zoneLeft.addEventListener(ev, (e)=>tEnd(e,'left'), {passive:false});
  zoneRight.addEventListener(ev, (e)=>tEnd(e,'right'), {passive:false});
  zoneBottom.addEventListener(ev, (e)=>tEnd(e,'bottom'), {passive:false});
});

// keyboard fallback
window.addEventListener('keydown', (e)=>{
  if(e.code==='Space' || e.code==='ArrowUp'){ e.preventDefault(); jump(); }
  if(e.code==='ArrowDown'){ e.preventDefault(); slide(); }
  if(e.key.toLowerCase()==='k'){ power(); }
  if(e.code==='KeyP'){ togglePause(); }
});

/* =======================
   Basic WebAudio for tiny SFX
   ======================= */
let audioCtx = null;
function ensureAudio() {
  if(audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){ audioCtx = null; }
}
function audioBeep(freq=440, gain=0.02, duration=0.08) {
  ensureAudio();
  if(!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.value = gain;
  o.connect(g); g.connect(audioCtx.destination);
  o.start();
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  setTimeout(()=> { try{ o.stop(); }catch(e){} }, duration*1000 + 30);
}

/* =======================
   Update loop (physics + spawn)
   ======================= */
function update(dt) {
  // distance & scoring
  state.distance += state.speed * dt;
  state.score += (state.speed * dt) * 0.02;

  // tiny speed ramp
  state.speed += 0.4 * dt;

  // player physics
  const p = state.player;
  p.vy += config.gravity * dt;
  p.y += p.vy * dt;
  const groundY = state.viewport.h - config.groundHeight - p.h;
  if(p.y >= groundY) { p.y = groundY; p.vy = 0; p.onGround = true; p.jumping=false; } else p.onGround=false;

  if(p.sliding) {
    p.slideTimer -= dt*1000;
    if(p.slideTimer <= 0) p.sliding = false;
  }

  // obstacles move
  for(let i=state.obstacles.length-1;i>=0;i--) {
    const o = state.obstacles[i];
    o.x -= state.speed * dt;
    if(!o.passed && o.x + o.w < p.x) { o.passed = true; state.score += 6; }
    if(o.x + o.w < -60) state.obstacles.splice(i,1);
  }

  // coins move and wobble
  for(let i=state.coinsList.length-1;i>=0;i--){
    const c = state.coinsList[i];
    c.wob += dt*6;
    // check collect
    const cbox = {x:c.x-c.r, y:c.y-c.r, w:c.r*2, h:c.r*2};
    const pbox = getPlayerBox();
    if(!c.collected && aabb(cbox, pbox)) {
      c.collected=true; state.coins++; state.score+=12;
      // particle burst
      for(let k=0;k<18;k++) createParticle(c.x, c.y, {color:'rgba(255,230,80,0.95)'});
      audioBeep(880 + Math.random()*220, 0.02, 0.08);
      // remove after small delay
      setTimeout(()=> {
        const idx = state.coinsList.indexOf(c);
        if(idx>=0) state.coinsList.splice(idx,1);
      }, 60);
    }
    // remove offscreen
    if(c.x < -40) state.coinsList.splice(i,1);
    // move left with speed
    c.x -= state.speed * dt;
  }

  // collisions
  for(const o of state.obstacles) {
    if(aabb(getPlayerBox(), o)) {
      // hit -> game over
      endGame();
      return;
    }
  }

  // spawn manager
  state.spawnTimer += dt*1000;
  const interval = Math.max(420, config.spawnBase - Math.floor(state.distance/300)*8);
  if(state.spawnTimer > interval) { state.spawnTimer = 0; spawnObstacle(); }

  // particles update
  for(let i=state.particles.length-1;i>=0;i--) {
    const pr = state.particles[i];
    pr.age += dt*1000;
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.vy += 800 * dt; // gravity
    if(pr.age >= pr.life) state.particles.splice(i,1);
  }
}

/* =======================
   Player hitbox (consider sliding)
   ======================= */
function getPlayerBox() {
  const p = state.player;
  if(p.sliding) return { x:p.x, y:p.y + p.h*0.45, w:p.w, h:p.h*0.5 };
  return { x:p.x, y:p.y, w:p.w, h:p.h };
}

/* =======================
   Render: background, parallax, ground, player, obstacles, coins, particles, HUD
   ======================= */
function clear() {
  if(VIEW_MODE === 'blank') {
    ctx.fillStyle = '#000'; ctx.fillRect(0,0,state.viewport.w, state.viewport.h); return;
  }
  // colorful gradient sky
  const g = ctx.createLinearGradient(0,0,0,state.viewport.h);
  g.addColorStop(0, '#0b1220');
  g.addColorStop(0.4, '#06131a');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g; ctx.fillRect(0,0,state.viewport.w, state.viewport.h);
  // subtle noise overlay
  ctx.globalAlpha = 0.06;
  drawNoiseLayer();
  ctx.globalAlpha = 1;
}

/* background parallax (simple rectangles as buildings) */
function renderParallax() {
  if(VIEW_MODE === 'blank') return;
  const w = state.viewport.w, h = state.viewport.h;
  // layer 1 - distant buildings
  ctx.save();
  const t = state.distance * 0.02;
  for(let i=0;i<8;i++){
    const bx = ((i*300) - (t*40)) % (w+300) - 200;
    const bw = 140 + (i%3)*40;
    const bh = 0.28*h + (i%2)*40;
    const x = bx;
    const y = h - bh - 160;
    const g = ctx.createLinearGradient(x,y,x,y+bh);
    g.addColorStop(0, '#081223'); g.addColorStop(1, '#031118');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, bw, bh, 6); ctx.fill();
  }
  ctx.restore();

  // layer 2 - neon strip
  ctx.save();
  const t2 = state.distance * 0.05;
  for(let x=-200; x < w+200; x += 120) {
    const sx = (x - (t2%120));
    const sy = h - 120;
    ctx.fillStyle = `rgba(0,255,213,0.04)`;
    ctx.fillRect(sx, sy, 80, 8);
    // neon glow tiny
    ctx.fillStyle = `rgba(0,200,255,0.02)`;
    ctx.fillRect(sx, sy-6, 80, 4);
  }
  ctx.restore();
}

/* draw ground with pattern */
function renderGround() {
  const h = state.viewport.h, gH = config.groundHeight;
  ctx.save();
  ctx.fillStyle = groundPattern || '#061016';
  ctx.fillRect(0, h - gH, state.viewport.w, gH);
  // subtle divider line
  ctx.fillStyle = '#082025';
  ctx.fillRect(0, h - gH - 6, state.viewport.w, 4);
  ctx.restore();
}

/* player */
function renderPlayer() {
  const p = state.player;
  if(VIEW_MODE === 'blank') return;
  // trail (particles)
  if(p.onGround === false) {
    // emit small trail
    if(Math.random() < 0.6) createParticle(p.x + p.w*0.2, p.y + p.h, {color:'rgba(0,200,255,0.12)'});
  }
  // body
  ctx.save();
  // glow
  ctx.shadowColor = 'rgba(0,255,213,0.9)';
  ctx.shadowBlur = 18;
  // sliding adjustments
  const drawH = p.sliding ? p.h * 0.55 : p.h;
  const drawY = p.sliding ? p.y + p.h*0.45 : p.y;
  // body fill
  const grad = ctx.createLinearGradient(p.x, drawY, p.x, drawY + drawH);
  grad.addColorStop(0, '#00ffd5'); grad.addColorStop(1, '#00a3ff');
  roundRect(ctx, p.x, drawY, p.w, drawH, 8);
  ctx.fillStyle = grad; ctx.fill();
  // inner stroke
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.stroke();
  ctx.restore();
}

/* obstacles */
function renderObstacles() {
  for(const o of state.obstacles) {
    if(VIEW_MODE === 'blank') continue;
    ctx.save();
    // shadow
    ctx.shadowBlur = 18; ctx.shadowColor = `rgba(0,0,0,0.55)`;
    // body
    const hue = (o.hue || 200);
    ctx.fillStyle = `hsl(${hue} 70% 55% / 0.95)`;
    roundRect(ctx, o.x, o.y, o.w, o.h, 6);
    ctx.fill();
    // inner dark stroke
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.restore();
  }
}

/* coins */
function renderCoins() {
  for(const c of state.coinsList) {
    if(VIEW_MODE === 'blank') continue;
    ctx.save();
    const glow = 12 + 6*Math.sin(c.wob);
    ctx.shadowColor = 'rgba(255,200,60,0.9)'; ctx.shadowBlur = glow;
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255,200,60,0.98)';
    ctx.arc(c.x, c.y + Math.sin(c.wob)*4, c.r, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
}

/* particles */
function renderParticles() {
  if(VIEW_MODE === 'blank') return;
  for(const p of state.particles) {
    ctx.save();
    ctx.globalAlpha = clamp(1 - p.age/p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

/* HUD (update DOM) */
function renderHUD() {
  const ui = document.getElementById('ui-overlay');
  const scoreEl = document.getElementById('score');
  const coinEl = document.getElementById('coins');
  const statusEl = document.getElementById('status');
  if(VIEW_MODE === 'full') {
    ui.style.display = 'flex';
    scoreEl.textContent = `Score: ${Math.floor(state.score)}`;
    coinEl.textContent = `Best: ${state.best}`;
    statusEl.textContent = state.running ? (state.paused ? 'PAUSE' : 'RUN') : 'STOP';
  } else {
    ui.style.display = 'none';
  }
}

/* small noise layer drawing */
function drawNoiseLayer() {
  // draw faint horizontal noise lines
  const h = state.viewport.h, w = state.viewport.w;
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#fff';
  for(let i=0;i<80;i++){
    const x = Math.floor((i*37 + (state.distance*0.02)) % w);
    ctx.fillRect(x, Math.floor(i*(h/80)), 1, 1);
  }
  ctx.restore();
}

/* helper roundRect */
function roundRect(ctx,x,y,w,h,r){
  if(r<0) r=0;
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

/* Debug overlay DOM */
let debugDOM = null;
function updateDebug(fps){
  if(!DEBUG) { if(debugDOM){ debugDOM.remove(); debugDOM=null; } return; }
  if(!debugDOM){
    debugDOM = document.createElement('div'); debugDOM.id='debugOverlay'; document.body.appendChild(debugDOM);
  }
  debugDOM.innerText = `FPS:${Math.round(fps)}\nSpeed:${Math.round(state.speed)}\nScore:${Math.floor(state.score)}\nObs:${state.obstacles.length}\nParticles:${state.particles.length}`;
}

/* =======================
   Game loop
   ======================= */
let fpsCounter = { last: performance.now(), frames: 0, fps: 60 };

function loop(ts) {
  if(!state.running || state.paused) {
    renderFrame(0, fpsCounter.fps);
    return;
  }
  const dt = Math.min(0.05, (ts - state.lastTS)/1000);
  state.lastTS = ts;

  fpsCounter.frames++;
  const now = performance.now();
  if(now - fpsCounter.last >= 500) {
    fpsCounter.fps = Math.round((fpsCounter.frames*1000)/(now-fpsCounter.last));
    fpsCounter.last = now; fpsCounter.frames = 0;
  }

  update(dt);
  renderFrame(dt, fpsCounter.fps);

  if(state.running && !state.paused) requestAnimationFrame(loop);
}

function renderFrame(dt, fps) {
  clear();
  renderParallax();
  renderGround();
  renderObstacles();
  renderCoins();
  renderPlayer();
  renderParticles();
  renderHUD();
  updateDebug(fps);
}

/* =======================
   Game controls / state
   ======================= */
function startGame() {
  state.running = true; state.paused=false;
  state.score=0; state.distance=0; state.speed=config.baseSpeed;
  state.obstacles=[]; state.coinsList=[]; state.particles=[];
  state.player = makePlayer(); state.player.y = state.viewport.h - config.groundHeight - state.player.h;
  state.lastTS = performance.now(); requestAnimationFrame(loop);
}
function endGame() {
  state.running = false;
  if(state.score > state.best) { state.best = Math.floor(state.score); saveBest(); }
  // small flash of particles
  for(let i=0;i<30;i++) createParticle(state.player.x + state.player.w/2, state.player.y + state.player.h/2, {color:'rgba(255,40,40,0.95)'});
}
function togglePause(){ state.paused = !state.paused; if(!state.paused){ state.lastTS = performance.now(); requestAnimationFrame(loop);} }

/* Buttons */
document.getElementById('btn-restart').addEventListener('click', ()=> startGame());
document.getElementById('btn-pause').addEventListener('click', ()=> togglePause());

/* Visibility change */
document.addEventListener('visibilitychange', () => {
  if(document.hidden) state.paused = true;
  else if(state.running) { state.paused = false; state.lastTS = performance.now(); requestAnimationFrame(loop); }
});

/* =======================
   Init
   ======================= */
function init() {
  resize();
  buildPatterns();
  loadBest();
  state.player = makePlayer();
  state.player.y = state.viewport.h - config.groundHeight - state.player.h;

  // start auto
  startGame();
}

/* start */
init();
