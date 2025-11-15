/* game.js - Cyber Runner (simple prototype)
   FILE: game.js
   Ubah VIEW_MODE = "blank" untuk tampilan kosong (logic tetap berjalan)
   Aktifkan DEBUG = true untuk overlay debug teks
*/

/* =========================
   Configuration / Constants
   ========================= */
const VIEW_MODE = "full"; // "full" or "blank"
let DEBUG = false;        // set true untuk overlay debug

// Canvas & rendering
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// DPR scaling
let dpr = Math.max(1, window.devicePixelRatio || 1);

// Game state
const state = {
  running: false,
  paused: false,
  lastTimestamp: 0,
  score: 0,
  bestScore: 0,
  coins: 0,
  speed: 220, // px/s baseline
  distance: 0,
  player: null,
  obstacles: [],
  powerups: [],
  spawnTimer: 0,
  spawnInterval: 1000, // ms
  gravity: 1800, // px/s^2
  viewport: { w: 0, h: 0 }
};

// Player definition
function createPlayer() {
  return {
    x: 80,
    y: 0,
    w: 36,
    h: 56,
    vy: 0,
    onGround: false,
    jumping: false,
    sliding: false,
    slideTimer: 0,
    slideDuration: 400, // ms
    collider: function() {
      if(this.sliding) return { x: this.x, y: this.y + this.h/2, w: this.w, h: this.h/2 };
      return { x: this.x, y: this.y, w: this.w, h: this.h };
    }
  };
}

/* =========================
   Persistence
   ========================= */
const STORAGE_KEY = 'cyberrunner_best_v1';
function loadStorage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if(stored) state.bestScore = Number(stored) || 0;
  } catch(e) { /* ignore */ }
}
function saveBest() {
  try {
    localStorage.setItem(STORAGE_KEY, String(state.bestScore));
  } catch(e) {}
}

/* =========================
   Resize & init
   ========================= */
function resizeCanvas() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(320, window.innerWidth);
  const h = Math.max(320, window.innerHeight);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // work in CSS pixels
  state.viewport.w = w;
  state.viewport.h = h;
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => {
  // keep state; just resize
  setTimeout(resizeCanvas, 60);
});

/* =========================
   Input Handling (touch + mouse + keyboard)
   ========================= */
let lastTap = 0;
let touchStartY = null;
let touchStartX = null;
let touchMoved = false;

// Setup DOM touch zones
const zoneLeft = document.getElementById('touch-left');
const zoneRight = document.getElementById('touch-right');
const zoneBottom = document.getElementById('touch-bottom');

// Prevent overscroll
document.addEventListener('touchmove', function(e){ e.preventDefault(); }, { passive: false });

function onJump() {
  if(state.player.sliding) return; // cannot jump while sliding
  if(state.player.onGround || !state.player.jumping) {
    state.player.vy = -720; // jump impulse
    state.player.onGround = false;
    state.player.jumping = true;
  }
}

function onSlide() {
  if(!state.player.sliding && state.player.onGround) {
    state.player.sliding = true;
    state.player.slideTimer = state.player.slideDuration;
  }
}

function onPower() {
  // simple example: perform a short speed boost (internal only)
  state.speed += 80;
  setTimeout(()=> { state.speed = Math.max(220, state.speed - 80); }, 900);
}

// Detect taps and swipes in zones
function handleTouchStart(e) {
  touchMoved = false;
  const t = e.changedTouches ? e.changedTouches[0] : e;
  touchStartY = t.clientY;
  touchStartX = t.clientX;
}
function handleTouchEnd(e, zone='left') {
  const t = e.changedTouches ? e.changedTouches[0] : e;
  const dy = t.clientY - (touchStartY || t.clientY);
  const dx = t.clientX - (touchStartX || t.clientX);
  const absDy = Math.abs(dy);
  const now = Date.now();
  if(absDy > 50 && dy > 30) {
    // swipe down -> slide
    onSlide();
    return;
  }
  // double-tap detection for right zone or double-tap anywhere
  if(now - lastTap < 300) {
    onPower();
  } else {
    // single tap => jump
    onJump();
  }
  lastTap = now;
}

// attach touch listeners for zones
['touchstart','mousedown'].forEach(evt => {
  zoneLeft.addEventListener(evt, (e) => { handleTouchStart(e); }, {passive:false});
  zoneRight.addEventListener(evt, (e) => { handleTouchStart(e); }, {passive:false});
  zoneBottom.addEventListener(evt, (e) => { handleTouchStart(e); }, {passive:false});
});
['touchend','mouseup'].forEach(evt => {
  zoneLeft.addEventListener(evt, (e) => { handleTouchEnd(e, 'left'); }, {passive:false});
  zoneRight.addEventListener(evt, (e) => { handleTouchEnd(e, 'right'); }, {passive:false});
  zoneBottom.addEventListener(evt, (e) => { handleTouchEnd(e, 'bottom'); }, {passive:false});
});

// Keyboard fallback
window.addEventListener('keydown', (e) => {
  if(e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); onJump(); }
  if(e.code === 'ArrowDown') { e.preventDefault(); onSlide(); }
  if(e.key.toLowerCase() === 'k') { onPower(); }
  if(e.code === 'KeyP') togglePause();
});

/* =========================
   Game objects: obstacles
   ========================= */
function spawnObstacle() {
  const hMin = 28, hMax = 80;
  const wMin = 18, wMax = 60;
  const rtype = Math.random();
  const gapFromRight = 10; // spawn offscreen
  const w = Math.round(wMin + Math.random() * (wMax - wMin));
  const h = Math.round(hMin + Math.random() * (hMax - hMin));
  const y = state.viewport.h - h - 24; // ground offset 24
  const obs = {
    x: state.viewport.w + gapFromRight,
    y: y,
    w: w,
    h: h,
    vx: - (state.speed / 1000) * 1000, // updated by game loop
    passed: false
  };
  state.obstacles.push(obs);
}

/* Collision AABB */
function intersect(a, b) {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

/* =========================
   Physics & Update Loop
   ========================= */
function updatePlayer(dt) {
  const p = state.player;
  // gravity
  p.vy += state.gravity * dt;
  p.y += p.vy * dt;
  // ground collision
  const groundY = state.viewport.h - 24 - p.h;
  if(p.y >= groundY) {
    p.y = groundY;
    p.vy = 0;
    p.onGround = true;
    p.jumping = false;
  } else {
    p.onGround = false;
  }
  // sliding timer
  if(p.sliding) {
    p.slideTimer -= dt * 1000;
    if(p.slideTimer <= 0) {
      p.sliding = false;
    }
  }
}

function updateObstacles(dt) {
  const vx = -state.speed; // pixels per second to left
  for(let i = state.obstacles.length -1; i >= 0; i--) {
    const o = state.obstacles[i];
    o.x += vx * dt;
    if(!o.passed && o.x + o.w < state.player.x) {
      o.passed = true;
      state.score += 5; // bonus for passing
    }
    if(o.x + o.w < -50) {
      state.obstacles.splice(i,1);
    }
  }
}

function checkCollisions() {
  const pCol = state.player.collider();
  for(const o of state.obstacles) {
    const oCol = { x: o.x, y: o.y, w: o.w, h: o.h };
    if(intersect(pCol, oCol)) {
      gameOver();
      return;
    }
  }
}

/* Spawn manager */
function spawnManager(dt) {
  state.spawnTimer += dt * 1000;
  // reduce interval slowly as distance increases
  const interval = Math.max(520, state.spawnInterval - Math.floor(state.distance / 200) * 10);
  if(state.spawnTimer >= interval) {
    state.spawnTimer = 0;
    spawnObstacle();
  }
}

/* =========================
   Game state transitions
   ========================= */
function startGame() {
  state.running = true;
  state.paused = false;
  state.score = 0;
  state.distance = 0;
  state.coins = 0;
  state.speed = 220;
  state.obstacles = [];
  state.player = createPlayer();
  // set player ground position
  state.player.y = state.viewport.h - 24 - state.player.h;
  state.lastTimestamp = performance.now();
  requestAnimationFrame(loop);
}

function pauseGame() {
  state.paused = true;
}
function resumeGame() {
  state.paused = false;
  state.lastTimestamp = performance.now();
  requestAnimationFrame(loop);
}
function togglePause() {
  state.paused = !state.paused;
  if(!state.paused) resumeGame();
}

function gameOver() {
  state.running = false;
  if(state.score > state.bestScore) {
    state.bestScore = state.score;
    saveBest();
  }
  // show minimal UI; in blank mode UI will be hidden by renderer
}

/* =========================
   Rendering
   ========================= */
function clear() {
  // background
  if(VIEW_MODE === "full") {
    // gradient neon-ish
    const g = ctx.createLinearGradient(0,0,0,state.viewport.h);
    g.addColorStop(0, '#001016');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = '#000';
  }
  ctx.fillRect(0,0,state.viewport.w, state.viewport.h);
}

function renderPlayer() {
  const p = state.player;
  if(VIEW_MODE === "blank") return; // invisible
  // body
  ctx.save();
  if(p.sliding) {
    ctx.fillStyle = '#7446ff';
    ctx.fillRect(p.x, p.y + p.h/2, p.w, p.h/2);
  } else {
    // draw neon rectangle with glow
    ctx.shadowColor = '#0ff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#00ffd5';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

function renderObstacles() {
  for(const o of state.obstacles) {
    if(VIEW_MODE === "blank") continue;
    ctx.save();
    ctx.fillStyle = '#ff3b3b';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.restore();
  }
}

function renderHUD() {
  // in full mode update DOM UI
  const ui = document.getElementById('ui-overlay');
  const scoreEl = document.getElementById('score');
  const coinEl = document.getElementById('coins');
  if(VIEW_MODE === "full") {
    ui.style.display = 'flex';
    scoreEl.textContent = `Score: ${Math.floor(state.score)}`;
    coinEl.textContent = `Best: ${state.bestScore}`;
    document.getElementById('btn-restart').style.display = 'inline-block';
    document.getElementById('btn-pause').style.display = 'inline-block';
  } else {
    ui.style.display = 'none';
  }
}

/* Debug overlay */
function renderDebug(dt, fps) {
  if(!DEBUG) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(6,6,220,88);
  ctx.fillStyle = '#0ff';
  ctx.font = '12px monospace';
  ctx.fillText(`FPS: ${Math.round(fps)}`, 12, 22);
  ctx.fillText(`Speed: ${Math.round(state.speed)}`, 12, 38);
  ctx.fillText(`Score: ${Math.floor(state.score)}`, 12, 54);
  ctx.fillText(`Obstacles: ${state.obstacles.length}`, 12, 70);
  ctx.fillText(`Running: ${state.running} Paused:${state.paused}`, 12, 86);
  ctx.restore();
}

/* =========================
   Main loop
   ========================= */
let fpsCounter = { last: performance.now(), frames: 0, fps: 60 };

function loop(ts) {
  if(!state.running || state.paused) {
    // still render one frame for paused state if full mode
    if(!state.running) renderFrame(0, 60);
    return;
  }
  const dt = Math.min(0.05, (ts - state.lastTimestamp) / 1000);
  state.lastTimestamp = ts;

  // update fps
  fpsCounter.frames++;
  const now = performance.now();
  if(now - fpsCounter.last >= 500) {
    fpsCounter.fps = Math.round((fpsCounter.frames * 1000) / (now - fpsCounter.last));
    fpsCounter.last = now;
    fpsCounter.frames = 0;
  }

  // update distance and score (distance increments with speed)
  state.distance += state.speed * dt;
  state.score += (state.speed * dt) * 0.02; // scale to nicer number

  // speed ramps slowly
  state.speed += 0.5 * dt; // slight ramp

  // update player/obstacles
  updatePlayer(dt);
  updateObstacles(dt);
  spawnManager(dt);
  checkCollisions();

  // render
  renderFrame(dt, fpsCounter.fps);

  // continue loop
  if(state.running && !state.paused) requestAnimationFrame(loop);
}

function renderFrame(dt, fps) {
  clear();
  renderObstacles();
  renderPlayer();
  renderHUD();
  renderDebug(dt, fps);
}

/* =========================
   UI Buttons
   ========================= */
document.getElementById('btn-restart').addEventListener('click', () => {
  startGame();
});
document.getElementById('btn-pause').addEventListener('click', () => {
  togglePause();
});

/* =========================
   Visibility & lifecycle
   ========================= */
document.addEventListener('visibilitychange', () => {
  if(document.hidden) {
    // pause updates to save battery
    state.paused = true;
  } else {
    if(state.running) {
      state.paused = false;
      state.lastTimestamp = performance.now();
      requestAnimationFrame(loop);
    }
  }
});

/* =========================
   Initialization
   ========================= */
function init() {
  resizeCanvas();
  loadStorage();
  // default player
  state.player = createPlayer();
  state.player.y = state.viewport.h - 24 - state.player.h;

  // start automatically (simple prototype)
  startGame();

  // accessibility: allow clicking canvas for jump (fallback)
  canvas.addEventListener('click', () => onJump());

  // small touch area listener to prevent scrolling on iOS Safari and help gestures
  // Note: touchmove is prevented globally earlier
}
init();