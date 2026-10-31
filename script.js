const WIDTH = DuckCore.WIDTH;
const HEIGHT = DuckCore.HEIGHT;
const COLORS = ["#ff7a45", "#49c6ff"];

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const menu = document.getElementById("menu");
const lobby = document.getElementById("lobby");
const endCard = document.getElementById("end");
const joinForm = document.getElementById("join-form");
const roomInfo = document.getElementById("room-info");
const menuError = document.getElementById("menu-error");
const lobbyError = document.getElementById("lobby-error");
const endTitle = document.getElementById("end-title");
const endScore = document.getElementById("end-score");
const endNote = document.getElementById("end-note");
const againBtn = document.getElementById("btn-again");
const muteBtn = document.getElementById("btn-mute");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const showHitbox = new URLSearchParams(location.search).has("hitbox");

const aim = { x: WIDTH * 0.38, y: HEIGHT * 0.4 };
const p2 = { x: WIDTH * 0.62, y: HEIGHT * 0.46 };
const keys = {};
const particles = [];
const rings = [];
const floats = [];
const reeds = Array.from({ length: 46 }, (_, i) => ({
  x: (i * 139) % WIDTH,
  h: 78 + ((i * 53) % 110),
  w: 5 + (i % 3) * 2,
  shade: i % 2,
}));
const clouds = [
  { x: 140, y: 110, s: 1, v: 14 },
  { x: 560, y: 70, s: 0.72, v: 9 },
  { x: 900, y: 140, s: 1.2, v: 11 },
];

let pixelRatio = 1;
let mode = "menu";
let match = null;
let demo = null;
let nextQuack = Date.now() + 2200;
let p2Moved = false;
let shake = 0;
let endShown = false;
let flashUntil = [0, 0];
let lastFrame = performance.now();
let socket = null;
let socketOnPurpose = false;
let clockOffset = 0;
let lastAimSent = 0;
let localBlastAt = 0;
const net = { view: null, opponent: null };

const audio = {
  ctx: null,
  muted: false,
  noiseBuffer: null,
  ensure() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) this.ctx = new AC();
    if (this.ctx.state === "suspended") this.ctx.resume();
  },
  env(duration, peak) {
    if (!this.ctx || this.muted) return null;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.connect(this.ctx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    return { g: g, t: t };
  },
  tone(freq, duration, type, peak, slideTo) {
    const env = this.env(duration, peak);
    if (!env) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, env.t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), env.t + duration);
    osc.connect(env.g);
    osc.start(env.t);
    osc.stop(env.t + duration + 0.02);
  },
  noise(duration, peak, from, to) {
    const env = this.env(duration, peak);
    if (!env) return;
    if (!this.noiseBuffer) {
      const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(from, env.t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), env.t + duration);
    src.connect(filter);
    filter.connect(env.g);
    src.start(env.t);
    src.stop(env.t + duration);
  },
  shoot() {
    this.noise(0.12, 0.18, 1700, 180);
    this.tone(130, 0.08, "sine", 0.1, 55);
  },
  quack() {
    this.tone(680, 0.09, "sawtooth", 0.035, 390);
    setTimeout(() => this.tone(620, 0.1, "sawtooth", 0.03, 340), 100);
  },
  score() {
    this.tone(523, 0.08, "triangle", 0.08);
    setTimeout(() => this.tone(784, 0.14, "triangle", 0.08), 80);
  },
  miss() {
    this.tone(320, 0.18, "sine", 0.05, 140);
  },
  whistle() {
    this.tone(520, 0.16, "sine", 0.04, 860);
  },
  win() {
    [523, 659, 784, 1046].forEach((freq, i) => {
      setTimeout(() => this.tone(freq, 0.18, "triangle", 0.07), i * 120);
    });
  },
};

document.getElementById("rule").textContent = "First to " + DuckCore.WIN_SCORE + " wins.";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fit() {
  pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  const scale = Math.min(window.innerWidth / WIDTH, window.innerHeight / HEIGHT);
  canvas.style.width = Math.max(1, Math.floor(WIDTH * scale)) + "px";
  canvas.style.height = Math.max(1, Math.floor(HEIGHT * scale)) + "px";
  canvas.width = Math.floor(WIDTH * pixelRatio);
  canvas.height = Math.floor(HEIGHT * pixelRatio);
}

function aimFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  aim.x = clamp(((event.clientX - rect.left) / rect.width) * WIDTH, 0, WIDTH);
  aim.y = clamp(((event.clientY - rect.top) / rect.height) * HEIGHT, 0, HEIGHT);
}

function noteServerTime(now) {
  if (typeof now !== "number") return;
  const sample = now - Date.now();
  clockOffset = clockOffset ? clockOffset * 0.85 + sample * 0.15 : sample;
}

function serverNow() {
  return Date.now() + clockOffset;
}

function currentView() {
  if (mode === "local") return match;
  if (mode === "online") return net.view;
  return null;
}

function viewTime(view) {
  return mode === "online" && view ? serverNow() : Date.now();
}

function show(el) {
  el.classList.remove("hidden");
}

function hide(el) {
  el.classList.add("hidden");
}

function syncChrome() {
  canvas.classList.toggle("aim", mode === "local" || mode === "online");
}

function resetPads() {
  aim.x = WIDTH * 0.38;
  aim.y = HEIGHT * 0.4;
  p2.x = WIDTH * 0.62;
  p2.y = HEIGHT * 0.46;
  p2Moved = false;
}

function toggleMute() {
  audio.ensure();
  audio.muted = !audio.muted;
  muteBtn.textContent = audio.muted ? "Sound off" : "Sound on";
}

function closeSocket() {
  socketOnPurpose = true;
  if (!socket) return;
  try {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "leave" }));
  } catch (err) {
    // Already closing.
  }
  socket.close();
  socket = null;
}

function quitToMenu() {
  closeSocket();
  mode = "menu";
  match = null;
  net.view = null;
  net.opponent = null;
  endShown = false;
  menuError.textContent = "";
  hide(endCard);
  hide(lobby);
  show(menu);
  syncChrome();
}

function startLocal() {
  audio.ensure();
  if (document.activeElement) document.activeElement.blur();
  const seed = Math.floor(Math.random() * 0x7fffffff);
  match = DuckCore.createMatch(
    [document.getElementById("name1").value, document.getElementById("name2").value],
    Date.now(),
    { lagGrace: 0, seed: seed }
  );
  resetPads();
  mode = "local";
  endShown = false;
  hide(menu);
  hide(endCard);
  syncChrome();
}

function openLobby() {
  audio.ensure();
  menuError.textContent = "";
  lobbyError.textContent = "";
  document.getElementById("online-name").value = document.getElementById("name1").value || "Ada";
  hide(roomInfo);
  show(joinForm);
  mode = "lobby";
  hide(menu);
  show(lobby);
  syncChrome();
}

function showLobbyRoom(msg) {
  hide(joinForm);
  show(roomInfo);
  document.getElementById("room-code-out").textContent = msg.code;
  const hosts = msg.hosts || [];
  const other = hosts.filter((host) => host.indexOf(location.host) === -1);
  const share = document.getElementById("share-url");
  share.textContent = other.length
    ? "On the other computer, open " + other[0] + " and enter this code."
    : "Open this page in another window and enter the code.";
  const list = document.getElementById("player-list");
  list.replaceChildren();
  for (const player of msg.players) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch s" + player.index;
    item.append(swatch, document.createTextNode(player.name + (player.index === msg.you ? " · you" : "")));
    list.append(item);
  }
  document.getElementById("wait").textContent =
    msg.players.length < 2 ? "Waiting for the other hunter…" : "Both hunters are in the blind.";
}

function connectAndHello() {
  if (location.protocol === "file:") {
    lobbyError.textContent = "Online play needs the server. Run npm install, then npm start, and open the address it prints.";
    return;
  }
  lobbyError.textContent = "";
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendHello();
    return;
  }
  socketOnPurpose = false;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let opened = false;
  socket = new WebSocket(proto + "//" + location.host);
  socket.onopen = () => {
    opened = true;
    sendHello();
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    onNet(msg);
  };
  socket.onclose = () => {
    if (socketOnPurpose) return;
    socket = null;
    net.view = null;
    mode = "lobby";
    endShown = false;
    hide(endCard);
    show(lobby);
    show(joinForm);
    hide(roomInfo);
    lobbyError.textContent = opened
      ? "Disconnected from the server."
      : "Could not connect. Run npm install and npm start, then open the printed address.";
    syncChrome();
  };
}

function sendHello() {
  socket.send(JSON.stringify({
    type: "hello",
    name: document.getElementById("online-name").value,
    room: document.getElementById("room-code").value.trim().toUpperCase(),
  }));
}

function onNet(msg) {
  noteServerTime(msg.now);
  if (msg.type === "error") {
    lobbyError.textContent = msg.message || "Could not join.";
    show(joinForm);
    hide(roomInfo);
    return;
  }
  if (msg.type === "lobby") {
    if (mode !== "online") {
      mode = "lobby";
      show(lobby);
      showLobbyRoom(msg);
    }
    return;
  }
  if (msg.type === "left") {
    mode = "lobby";
    net.view = null;
    endShown = false;
    hide(endCard);
    show(lobby);
    lobbyError.textContent = msg.message || "The other hunter left.";
    syncChrome();
    return;
  }
  if (msg.type === "state") {
    net.view = msg;
    mode = "online";
    hide(menu);
    hide(lobby);
    syncChrome();
    if (msg.phase === "win") syncEnd();
    return;
  }
  if (msg.type === "fx" && msg.fx) playFx(msg.fx);
  if (msg.type === "aim") {
    net.opponent = { x: msg.x, y: msg.y, player: msg.player, at: Date.now() };
  }
  if (msg.type === "note") endNote.textContent = msg.message || "";
}

function sendAim() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !net.view) return;
  const now = Date.now();
  if (now - lastAimSent < 50) return;
  lastAimSent = now;
  socket.send(JSON.stringify({ type: "aim", x: aim.x, y: aim.y }));
}

function moveP2(dt) {
  let mx = 0;
  let my = 0;
  if (keys.arrowleft || keys.a) mx -= 1;
  if (keys.arrowright || keys.d) mx += 1;
  if (keys.arrowup || keys.w) my -= 1;
  if (keys.arrowdown || keys.s) my += 1;
  if (!mx && !my) return;
  p2Moved = true;
  const len = Math.hypot(mx, my);
  p2.x = clamp(p2.x + (mx / len) * 680 * dt, 18, WIDTH - 18);
  p2.y = clamp(p2.y + (my / len) * 680 * dt, 18, HEIGHT - 18);
}

function fire(player) {
  if (!match || match.phase !== "fly") return;
  const now = Date.now();
  const x = player === 0 ? aim.x : p2.x;
  const y = player === 0 ? aim.y : p2.y;
  audio.ensure();
  const shotEvents = DuckCore.offerShot(match, player, x, y, now, now);
  if (shotEvents.some((event) => event.type === "blast")) audio.shoot();
  const stepEvents = DuckCore.update(match, now);
  shotEvents.forEach(playFx);
  stepEvents.forEach(playFx);
}

function fireOnline() {
  if (!net.view || net.view.phase !== "fly" || !socket || socket.readyState !== WebSocket.OPEN) return;
  const time = serverNow();
  const seat = net.view.you;
  if (time < ((net.view.cooldowns && net.view.cooldowns[seat]) || 0)) return;
  audio.ensure();
  audio.shoot();
  addRing(aim.x, aim.y, COLORS[seat] || "#fff");
  localBlastAt = Date.now();
  if (net.view.cooldowns) net.view.cooldowns[seat] = time + DuckCore.SHOT_COOLDOWN;
  socket.send(JSON.stringify({ type: "shot", x: aim.x, y: aim.y, t: time }));
}

function burst(x, y) {
  const colors = ["#f4f1ea", "#e7d7b1", "#e0893a", "#1f6b45", "#fff"];
  for (let i = 0; i < 16; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 80 + Math.random() * 220;
    particles.push({
      x: x,
      y: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40,
      grav: 280,
      rot: Math.random() * 6,
      w: 5 + Math.random() * 7,
      h: 2 + Math.random() * 3,
      color: colors[i % colors.length],
      age: 0,
      life: 0.55 + Math.random() * 0.4,
    });
  }
  if (particles.length > 240) particles.splice(0, particles.length - 240);
}

function addPuff(x, y) {
  rings.push({ x: x, y: y, r: 8, a: 0.45, color: "rgba(70,70,70,0.8)", grow: 70 });
}

function addRing(x, y, color) {
  rings.push({ x: x, y: y, r: 8, a: 0.95, color: color, grow: 110 });
}

function addFloat(x, y, text, color) {
  floats.push({ x: x, y: y, text: text, color: color, age: 0, life: 0.85 });
}

function addShake(amount) {
  if (reduceMotion) return;
  shake = Math.min(1.2, shake + amount);
}

function playFx(fx) {
  if (!fx) return;
  if (fx.type === "blast") {
    const mine = mode === "online" && net.view && fx.player === net.view.you && Date.now() - localBlastAt < 450;
    if (!mine) {
      addRing(fx.x, fx.y, COLORS[fx.player] || "#fff");
      if (mode === "online" && net.view && fx.player !== net.view.you) audio.shoot();
    }
    if (fx.hit) {
      burst(fx.x, fx.y);
      addShake(0.35);
    } else addPuff(fx.x, fx.y);
    return;
  }
  if (fx.type === "score") {
    burst(fx.x, fx.y);
    addFloat(fx.x, fx.y - 36, "+1", COLORS[fx.player] || "#fff");
    addShake(0.75);
    audio.score();
    flashUntil[fx.player] = Date.now() + 700;
    return;
  }
  if (fx.type === "quack") audio.quack();
  if (fx.type === "escape" || fx.type === "tie") audio.miss();
  if (fx.type === "spawn") audio.whistle();
  if (fx.type === "win") {
    audio.win();
    burst(WIDTH * 0.35, 180);
    burst(WIDTH * 0.65, 180);
  }
}

function updateFx(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    p.vy += p.grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += dt * 5;
    if (p.age >= p.life) particles.splice(i, 1);
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const ring = rings[i];
    ring.r += ring.grow * dt;
    ring.a -= dt * 1.7;
    if (ring.a <= 0) rings.splice(i, 1);
  }
  for (let i = floats.length - 1; i >= 0; i--) {
    const item = floats[i];
    item.age += dt;
    item.y -= 36 * dt;
    if (item.age >= item.life) floats.splice(i, 1);
  }
  shake *= Math.exp(-3.2 * dt);
}

function makeDemo(now) {
  const dir = Math.random() < 0.5 ? 1 : -1;
  return {
    born: now,
    dir: dir,
    speed: 170,
    x0: dir === 1 ? -120 : WIDTH + 120,
    baseY: 180 + Math.random() * 70,
    amp: 26,
    freq: 1.2,
    phase: Math.random() * 6,
    falling: false,
    alive: true,
  };
}

function tendDemo(now) {
  if (mode === "local" || mode === "online") return;
  if (!demo) demo = makeDemo(now);
  const sample = DuckCore.sampleDuck(demo, now);
  const gone = demo.dir === 1 ? sample.x > WIDTH + 160 : sample.x < -160;
  if (gone) demo = makeDemo(now);
  if (now > nextQuack) {
    nextQuack = now + 2600 + Math.random() * 2200;
    audio.quack();
  }
}

function roundRect(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function paintText(text, x, y, fill, size, align) {
  if (!text) return;
  ctx.font = size + 'px "Lilita One", "Arial Black", Impact, sans-serif';
  ctx.textAlign = align || "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(12, 10, 8, 0.88)";
  ctx.lineWidth = Math.max(3, size / 10);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function drawCloud(x, y, s) {
  ctx.fillStyle = "rgba(255, 248, 236, 0.88)";
  ctx.beginPath();
  ctx.ellipse(x, y, 46 * s, 20 * s, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 34 * s, y + 6 * s, 30 * s, 16 * s, 0, 0, Math.PI * 2);
  ctx.ellipse(x - 32 * s, y + 8 * s, 26 * s, 14 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawMarsh(time) {
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  sky.addColorStop(0, "#1d3768");
  sky.addColorStop(0.38, "#e36a45");
  sky.addColorStop(0.58, "#f2c56a");
  sky.addColorStop(0.72, "#6ea15a");
  sky.addColorStop(1, "#10281c");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(940, 400, 16, 940, 400, 150);
  glow.addColorStop(0, "rgba(255, 236, 186, 0.95)");
  glow.addColorStop(1, "rgba(255, 214, 140, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(940, 400, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff1c2";
  ctx.beginPath();
  ctx.arc(940, 392, 42, 0, Math.PI * 2);
  ctx.fill();

  const drift = reduceMotion ? 0 : time;
  for (const cloud of clouds) {
    const x = ((cloud.x + (drift * cloud.v) / 1000) % (WIDTH + 240)) - 120;
    drawCloud(x, cloud.y, cloud.s);
  }

  ctx.strokeStyle = "rgba(48, 32, 28, 0.28)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const x = ((time * 0.03 + i * 220) % (WIDTH + 80)) - 40;
    const y = 64 + i * 16;
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x, y + 4);
    ctx.lineTo(x + 8, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#7d9b5c";
  ctx.beginPath();
  ctx.moveTo(0, 500);
  ctx.lineTo(0, 450);
  ctx.quadraticCurveTo(180, 350, 390, 445);
  ctx.quadraticCurveTo(590, 520, 800, 400);
  ctx.quadraticCurveTo(1040, 300, WIDTH, 430);
  ctx.lineTo(WIDTH, 500);
  ctx.fill();

  ctx.fillStyle = "#4e7c44";
  ctx.beginPath();
  ctx.moveTo(0, 530);
  ctx.lineTo(0, 478);
  ctx.quadraticCurveTo(240, 430, 480, 500);
  ctx.quadraticCurveTo(760, 560, 1020, 470);
  ctx.quadraticCurveTo(1160, 430, WIDTH, 490);
  ctx.lineTo(WIDTH, 530);
  ctx.fill();

  const water = ctx.createLinearGradient(0, 500, 0, 650);
  water.addColorStop(0, "#3f9aa0");
  water.addColorStop(1, "#173f48");
  ctx.fillStyle = water;
  ctx.fillRect(0, 505, WIDTH, 150);

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const y = 528 + i * 16;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= WIDTH; x += 48) {
      ctx.lineTo(x, y + Math.sin(time / 420 + x / 90 + i) * 2);
    }
    ctx.stroke();
  }

  ctx.fillStyle = "#10281c";
  ctx.fillRect(0, 630, WIDTH, HEIGHT - 630);
}

function drawReeds(time) {
  for (const reed of reeds) {
    const sway = reduceMotion ? 0 : Math.sin(time / 520 + reed.x * 0.01) * 10;
    ctx.fillStyle = reed.shade ? "#143c28" : "#1f5c38";
    ctx.beginPath();
    ctx.moveTo(reed.x, HEIGHT);
    ctx.quadraticCurveTo(reed.x + sway, HEIGHT - reed.h * 0.55, reed.x + sway * 1.3, HEIGHT - reed.h);
    ctx.lineTo(reed.x + reed.w + sway * 1.3, HEIGHT - reed.h + 8);
    ctx.quadraticCurveTo(reed.x + reed.w + sway, HEIGHT - reed.h * 0.45, reed.x + reed.w, HEIGHT);
    ctx.fill();
  }
}

function drawDuck(x, y, dir, wing, rot, scale) {
  const s = scale || 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot || 0);
  ctx.scale((dir < 0 ? -1 : 1) * s, s);
  const flap = Math.sin(wing || 0);

  ctx.save();
  ctx.translate(-6, -4);
  ctx.rotate(-0.25 - Math.max(0, flap) * 1.05);
  ctx.fillStyle = "#8a6844";
  ctx.beginPath();
  ctx.ellipse(0, -20, 15, 28, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2d6fd6";
  ctx.fillRect(-10, -10, 18, 6);
  ctx.restore();

  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.moveTo(-34, 0);
  ctx.lineTo(-56, -14);
  ctx.lineTo(-46, 2);
  ctx.lineTo(-56, 12);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#e7e1d4";
  ctx.beginPath();
  ctx.ellipse(-2, 2, 40, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(-6, -4, 22, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#7a4632";
  ctx.beginPath();
  ctx.ellipse(20, 4, 16, 14, 0.3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1f6b45";
  ctx.beginPath();
  ctx.ellipse(34, -12, 14, 13, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#f7f3ea";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(24, -2, 9, 0.2, 2.4);
  ctx.stroke();

  ctx.fillStyle = "#f0b429";
  ctx.beginPath();
  ctx.moveTo(46, -12);
  ctx.lineTo(66, -8);
  ctx.lineTo(46, -4);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(38, -16, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a120c";
  ctx.beginPath();
  ctx.arc(39.2, -16, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDog(x, emerge, hasDuck) {
  const y = 700 - emerge * 168;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#8a5a2b";
  ctx.fillRect(-28, 18, 56, 90);
  ctx.fillStyle = "#c4491d";
  ctx.fillRect(-22, 22, 44, 8);
  ctx.fillStyle = "#5a3714";
  ctx.beginPath();
  ctx.ellipse(-32, -18, 14, 26, -0.35, 0, Math.PI * 2);
  ctx.ellipse(32, -18, 14, 26, 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8a5a2b";
  ctx.beginPath();
  ctx.ellipse(0, 0, 36, 32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c4894f";
  ctx.beginPath();
  ctx.ellipse(0, 14, 16, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1d140e";
  ctx.beginPath();
  ctx.ellipse(0, 8, 6, 4.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-12, -8, 3.4, 0, Math.PI * 2);
  ctx.arc(12, -8, 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(-11, -9, 1.2, 0, Math.PI * 2);
  ctx.arc(13, -9, 1.2, 0, Math.PI * 2);
  ctx.fill();
  if (hasDuck) drawDuck(8, -6, 1, 0, -0.7, 0.34);
  else {
    ctx.strokeStyle = "#3a2012";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 16, 8, 0.15, Math.PI - 0.15);
    ctx.stroke();
  }
  ctx.restore();
}

function progressOf(view, time) {
  const until = view.phaseUntil == null || !Number.isFinite(view.phaseUntil) ? Infinity : view.phaseUntil;
  const dur = until - view.phaseStarted;
  if (!Number.isFinite(dur) || dur <= 0) return 1;
  return clamp((time - view.phaseStarted) / dur, 0, 1);
}

function dogEmerge(phase, progress) {
  if (phase === "win") return 1;
  if (phase !== "retrieve" && phase !== "taunt") return 0;
  if (progress < 0.22) return progress / 0.22;
  if (progress > 0.78) return Math.max(0, (1 - progress) / 0.22);
  return 1;
}

function drawCrosshair(x, y, color, label, hint, cooling) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.globalAlpha = cooling ? 0.55 : 1;
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  const gap = 7;
  const len = 16;
  ctx.moveTo(0, -gap - len);
  ctx.lineTo(0, -gap);
  ctx.moveTo(0, gap);
  ctx.lineTo(0, gap + len);
  ctx.moveTo(-gap - len, 0);
  ctx.lineTo(-gap, 0);
  ctx.moveTo(gap, 0);
  ctx.lineTo(gap + len, 0);
  ctx.stroke();
  ctx.font = '800 16px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.strokeText(label, 0, 40);
  ctx.fillText(label, 0, 40);
  if (hint) {
    ctx.font = '700 13px Nunito, "Segoe UI", sans-serif';
    ctx.strokeText(hint, 0, 58);
    ctx.fillText(hint, 0, 58);
  }
  ctx.restore();
}

function drawHud(view, time) {
  const hot0 = Date.now() < flashUntil[0];
  const hot1 = Date.now() < flashUntil[1];
  drawPlate(24, 18, view.names[0], view.scores[0], COLORS[0], false, hot0, view.you === 0);
  drawPlate(WIDTH - 24, 18, view.names[1], view.scores[1], COLORS[1], true, hot1, view.you === 1);
  ctx.fillStyle = "rgba(16, 14, 12, 0.9)";
  roundRect(WIDTH / 2 - 86, 14, 172, 62, 14);
  ctx.fill();
  paintText("PASS " + view.round, WIDTH / 2, 34, "#fffaf0", 26, "center");
  paintText("FIRST TO " + DuckCore.WIN_SCORE, WIDTH / 2, 60, "#ffe08a", 15, "center");

  const banner = DuckCore.currentBanner(view, time);
  if (banner && view.phase !== "win") {
    const size = view.phase === "countdown" ? 108 : 64;
    const y = view.phase === "countdown" ? 158 : 168;
    const color = view.bannerPlayer != null && view.phase !== "countdown" ? COLORS[view.bannerPlayer] : "#fffaf0";
    paintText(banner, WIDTH / 2, y, color, size, "center");
    if (view.phase === "countdown") {
      ctx.font = '800 22px Nunito, "Segoe UI", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fffaf0";
      ctx.strokeStyle = "rgba(12, 10, 8, 0.75)";
      ctx.lineWidth = 4;
      const hint = mode === "local"
        ? "Mouse clicks    ·    arrows or WASD, then Space"
        : "Click the duck before the other hunter";
      ctx.strokeText(hint, WIDTH / 2, 248);
      ctx.fillText(hint, WIDTH / 2, 248);
    }
  }

  ctx.font = '700 15px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255, 250, 240, 0.78)";
  ctx.fillText(audio.muted ? "M sound off  ·  Esc quits" : "M mute  ·  Esc quits", WIDTH / 2, 704);
}

function drawPlate(anchorX, y, name, score, color, alignRight, hot, you) {
  const w = 250;
  const h = 74;
  const x = alignRight ? anchorX - w : anchorX;
  ctx.fillStyle = hot ? "rgba(255, 244, 220, 0.96)" : "rgba(20, 16, 14, 0.94)";
  roundRect(x, y, w, h, 16);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(alignRight ? x + w - 10 : x, y, 10, h, 6);
  ctx.fill();
  ctx.fillStyle = hot ? "#24170f" : "#fffaf0";
  ctx.font = '800 20px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(name, x + 22, you ? y + 24 : y + h / 2);
  if (you) {
    ctx.font = '800 12px Nunito, "Segoe UI", sans-serif';
    ctx.fillStyle = color;
    ctx.fillText("YOU", x + 22, y + 48);
  }
  paintText(String(score), x + w - 28, y + h / 2, color, 40, "right");
}

function drawSample(sample) {
  if (!sample) return;
  if (!sample.falling) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#10241c";
    ctx.beginPath();
    ctx.ellipse(sample.x, 552, 34, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const tilt = sample.falling ? sample.rot : clamp(sample.vy / 380, -0.35, 0.35);
  drawDuck(sample.x, sample.y, sample.dir, sample.wing, tilt, 1);
  if (showHitbox && !sample.falling) {
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(sample.x, sample.y, DuckCore.HIT_RX, DuckCore.HIT_RY, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function cooling(view, player, time) {
  return !!(view && view.cooldowns && time < view.cooldowns[player]);
}

function render() {
  const now = Date.now();
  const view = currentView();
  const time = view ? viewTime(view) : now;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.save();
  if (shake > 0.02) ctx.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12);

  drawMarsh(now);
  let sample = null;
  if (view && view.duck) sample = DuckCore.sampleDuck(view.duck, time);
  else if (!view && demo) sample = DuckCore.sampleDuck(demo, now);

  if (sample && !sample.falling) drawSample(sample);
  if (sample && sample.falling) drawDuck(sample.x, sample.y, sample.dir, 0, sample.rot, 1);
  drawReeds(now);

  if (view && view.prop) {
    const emerge = dogEmerge(view.phase, progressOf(view, time));
    if (emerge > 0) drawDog(view.prop.x, emerge, view.prop.hasDuck);
  }

  const vignette = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 260, WIDTH / 2, HEIGHT / 2, 760);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.w, p.h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const ring of rings) {
    ctx.beginPath();
    ctx.strokeStyle = ring.color;
    ctx.globalAlpha = Math.max(0, ring.a);
    ctx.lineWidth = 3;
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const item of floats) {
    ctx.globalAlpha = Math.max(0, 1 - item.age / item.life);
    paintText(item.text, item.x, item.y, item.color, 28, "center");
    ctx.globalAlpha = 1;
  }

  if (mode === "local" && match) {
    drawCrosshair(aim.x, aim.y, COLORS[0], match.names[0], "", cooling(match, 0, time));
    const keyboardHint = p2Moved || match.phase === "countdown" ? "" : "WASD or arrows";
    drawCrosshair(p2.x, p2.y, COLORS[1], match.names[1], keyboardHint, cooling(match, 1, time));
    drawHud(match, time);
    announce(match, time);
  } else if (mode === "online" && net.view) {
    const seat = net.view.you;
    if (net.opponent && Date.now() - net.opponent.at < 400) {
      const other = net.opponent.player;
      drawCrosshair(net.opponent.x, net.opponent.y, COLORS[other] || "#fff", net.view.names[other] || "", "", false);
    }
    drawCrosshair(aim.x, aim.y, COLORS[seat] || "#fff", net.view.names[seat] || "You", "", cooling(net.view, seat, time));
    drawHud(net.view, time);
    announce(net.view, time);
  }

  ctx.restore();
}

let lastStatus = "";

function announce(view, time) {
  const status = document.getElementById("status");
  if (!status || !view) return;
  const banner = DuckCore.currentBanner(view, time);
  const text = view.names[0] + " " + view.scores[0] + ", " + view.names[1] + " " + view.scores[1] + (banner ? ". " + banner : "");
  if (text === lastStatus) return;
  lastStatus = text;
  status.textContent = text;
}

function syncEnd() {
  const view = currentView();
  if (view && view.phase === "win") {
    if (!endShown) {
      endShown = true;
      endTitle.textContent = view.names[view.winner] + " wins";
      endScore.textContent = view.names[0] + "  " + view.scores[0] + "    ·    " + view.names[1] + "  " + view.scores[1];
      endNote.textContent = mode === "online" ? "Both players press Fly again for a rematch." : "Same marsh, new ducks.";
      againBtn.textContent = "Fly again";
      show(endCard);
    }
  } else if (endShown) {
    endShown = false;
    hide(endCard);
  }
}

function frame(nowMs) {
  const dt = Math.min(0.05, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  const clock = Date.now();
  if (mode === "local" && match) {
    if (match.phase !== "win") moveP2(dt);
    const events = DuckCore.update(match, clock);
    events.forEach(playFx);
  } else if (mode === "online") {
    sendAim();
  } else {
    tendDemo(clock);
  }
  updateFx(dt);
  render();
  syncEnd();
  requestAnimationFrame(frame);
}

document.getElementById("btn-local").addEventListener("click", startLocal);
document.getElementById("btn-online").addEventListener("click", openLobby);
document.getElementById("btn-back").addEventListener("click", quitToMenu);
document.getElementById("btn-lobby-back").addEventListener("click", quitToMenu);
document.getElementById("btn-menu").addEventListener("click", quitToMenu);
muteBtn.addEventListener("click", toggleMute);

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  audio.ensure();
  connectAndHello();
});

document.getElementById("btn-copy").addEventListener("click", async () => {
  const code = document.getElementById("room-code-out").textContent;
  try {
    await navigator.clipboard.writeText(code);
    document.getElementById("btn-copy").textContent = "Copied";
  } catch (err) {
    document.getElementById("btn-copy").textContent = code;
  }
});

againBtn.addEventListener("click", () => {
  audio.ensure();
  if (mode === "local" && match) {
    match = DuckCore.createMatch(match.names.slice(), Date.now(), {
      lagGrace: 0,
      seed: Math.floor(Math.random() * 0x7fffffff),
    });
    resetPads();
    endShown = false;
    hide(endCard);
    return;
  }
  if (mode === "online" && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "again" }));
    againBtn.textContent = "Waiting…";
    endNote.textContent = "Waiting for the other hunter…";
  }
});

canvas.addEventListener("pointermove", aimFromEvent);
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  aimFromEvent(event);
  if (mode === "local") fire(0);
  else if (mode === "online") fireOnline();
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  const typing = document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA");
  if (typing) return;
  if (event.repeat) return;
  keys[event.key.toLowerCase()] = true;
  if (event.key === "Escape") {
    quitToMenu();
    return;
  }
  if (event.key.toLowerCase() === "m") {
    toggleMute();
    return;
  }
  if (mode === "local" && match && match.phase === "fly") {
    if (event.key.startsWith("Arrow")) event.preventDefault();
    if (event.code === "Space" || event.code === "Enter" || event.code === "KeyF") {
      event.preventDefault();
      fire(1);
    }
  }
  if (mode === "online" && net.view && net.view.phase === "fly" && (event.code === "Space" || event.code === "Enter")) {
    event.preventDefault();
    fireOnline();
  }
});

window.addEventListener("keyup", (event) => {
  keys[event.key.toLowerCase()] = false;
});
window.addEventListener("blur", () => {
  for (const key of Object.keys(keys)) keys[key] = false;
});
window.addEventListener("resize", fit);

fit();
requestAnimationFrame(frame);
