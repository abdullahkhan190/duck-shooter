const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const DuckCore = require("./game-core");

const FILES = {
  "/index.html": "text/html; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/script.js": "text/javascript; charset=utf-8",
  "/game-core.js": "text/javascript; charset=utf-8",
};

const port = process.env.PORT !== undefined && process.env.PORT !== "" ? Number(process.env.PORT) : 3000;
const rooms = new Map();
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function lanIps() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const entry of list || []) {
      const family = entry.family;
      if ((family === "IPv4" || family === 4) && !entry.internal) ips.push(entry.address);
    }
  }
  return ips;
}

function makeCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return code;
}

function uniqueCode() {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  return code;
}

function cleanCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    obj.now = Date.now();
    ws.send(JSON.stringify(obj));
  } catch (err) {
    // The socket can close between the ready check and the write.
  }
}

function broadcast(room, obj) {
  for (const player of room.players) send(player.ws, obj);
}

function snapshot(match, now, you, duckSpeed) {
  return {
    type: "state",
    now: now,
    you: you,
    names: match.names,
    scores: match.scores.slice(),
    winner: match.winner,
    round: match.round,
    phase: match.phase,
    phaseStarted: match.phaseStarted,
    phaseUntil: Number.isFinite(match.phaseUntil) ? match.phaseUntil : null,
    banner: match.banner || "",
    bannerPlayer: match.bannerPlayer,
    duck: match.duck,
    prop: match.prop,
    cooldowns: match.cooldowns.slice(),
    ammo: match.ammo.slice(),
    duckSpeed: DuckCore.duckSpeedOf(duckSpeed != null ? duckSpeed : match.duckSpeed),
  };
}

function broadcastState(room) {
  if (!room.match) return;
  const now = Date.now();
  for (const player of room.players) send(player.ws, snapshot(room.match, now, player.index, room.duckSpeed));
}

function pump(room) {
  if (!room.match) return [];
  const events = DuckCore.update(room.match, Date.now());
  for (const event of events) broadcast(room, { type: "fx", fx: event });
  if (events.length) broadcastState(room);
  return events;
}

function begin(room) {
  if (room.players.length < 2) return;
  room.players.forEach((player, index) => {
    player.index = index;
  });
  room.match = DuckCore.createMatch(
    room.players.map((player) => player.name),
    Date.now(),
    { lagGrace: 120, seed: Math.floor(Math.random() * 0x7fffffff), duckSpeed: room.duckSpeed }
  );
  room.again = [false, false];
  broadcastState(room);
}

function lobbyPayload(room, you) {
  const actualPort = server.address() ? server.address().port : port;
  const hosts = [`http://localhost:${actualPort}`].concat(lanIps().map((ip) => `http://${ip}:${actualPort}`));
  return {
    type: "lobby",
    code: room.code,
    you: you,
    players: room.players.map((player) => ({ name: player.name, index: player.index })),
    hosts: hosts,
    duckSpeed: DuckCore.duckSpeedOf(room.duckSpeed),
  };
}

function sendLobby(room) {
  for (const player of room.players) send(player.ws, lobbyPayload(room, player.index));
}

const REJOIN_MS = 15000;

function playerIsOpen(player) {
  return !!(player.ws && player.ws.readyState === WebSocket.OPEN);
}

function expirePlayer(room, player) {
  if (!rooms.get(room.code) || playerIsOpen(player) || room.players.indexOf(player) === -1) return;
  console.log(`${player.name} left ${room.code}`);
  room.players = room.players.filter((entry) => entry !== player);
  room.again = [false, false];
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  const wasPlaying = room.match != null;
  room.match = null;
  room.players.forEach((entry, index) => {
    entry.index = index;
  });
  if (wasPlaying) broadcast(room, { type: "left", message: "The other hunter left the marsh." });
  sendLobby(room);
}

function detachPlayer(ws) {
  const room = ws.room;
  if (!room) return;
  const player = room.players.find((entry) => entry.ws === ws);
  ws.room = null;
  if (!player) return;
  player.ws = null;
  player.leftAt = Date.now();
  console.log(`${player.name} dropped from ${room.code}, holding the seat`);
  setTimeout(() => expirePlayer(room, player), REJOIN_MS);
}

function removePlayer(ws) {
  const room = ws.room;
  if (!room) return;
  const player = room.players.find((entry) => entry.ws === ws);
  ws.room = null;
  if (!player) return;
  player.ws = null;
  expirePlayer(room, player);
}

function seatPlayer(ws, msg) {
  if (ws.room) return;
  const name = DuckCore.cleanName(msg.name, "Hunter");
  const requested = String(msg.room || "").trim();
  let room = null;
  if (!requested) {
    if (rooms.size > 100) {
      send(ws, { type: "error", message: "The marsh is full. Try again in a minute." });
      return;
    }
    const code = uniqueCode();
    room = { code: code, players: [], match: null, again: [false, false], duckSpeed: DuckCore.duckSpeedOf(msg.duckSpeed) };
    rooms.set(code, room);
  } else {
    const code = cleanCode(requested);
    if (code.length !== 4) {
      send(ws, { type: "error", message: "Room codes are 4 letters or numbers." });
      return;
    }
    room = rooms.get(code);
    if (!room) {
      send(ws, { type: "error", message: "No room uses that code." });
      return;
    }
  }

  let player = room.players.find((entry) => entry.name === name);
  if (!player && room.players.length >= 2) {
    send(ws, { type: "error", message: "That room is already full." });
    return;
  }
  if (!player) {
    player = { ws: null, name: name, index: room.players.length, leftAt: 0 };
    room.players.push(player);
  } else if (player.ws && player.ws !== ws) {
    player.ws.room = null;
    try {
      player.ws.close();
    } catch (err) {
      // The old socket is already going away.
    }
  }
  player.ws = ws;
  player.leftAt = 0;
  ws.room = room;
  console.log(`${player.name} joined ${room.code} (${room.players.length}/2)`);
  if (room.match) {
    send(ws, snapshot(room.match, Date.now(), player.index, room.duckSpeed));
    return;
  }
  sendLobby(room);
  if (room.players.length === 2) begin(room);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }
  let urlPath = "/";
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
  } catch (err) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  const type = FILES[urlPath];
  if (!type) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  fs.readFile(path.join(__dirname, urlPath.slice(1)), (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else res.end(data);
  });
});

const wss = new WebSocketServer({ server: server, perMessageDeflate: false });

wss.on("connection", (ws) => {
  ws.on("error", (err) => {
    console.error("socket error:", err.message);
  });

  ws.on("message", (data) => {
    try {
      handleMessage(ws, data);
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", (code, reason) => {
    const why = Buffer.isBuffer(reason) ? reason.toString() : String(reason || "");
    console.log(`socket closed code=${code} reason=${why}`);
    detachPlayer(ws);
  });
});

function handleMessage(ws, data) {
    if (data.length > 2000) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch (err) {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "hello") {
      seatPlayer(ws, msg);
      return;
    }
    const room = ws.room;
    if (!room) return;
    const player = room.players.find((entry) => entry.ws === ws);
    if (!player) return;

    if (msg.type === "leave") {
      removePlayer(ws);
      return;
    }

    if (msg.type === "aim") {
      if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
      const now = Date.now();
      if (ws.lastAimAt && now - ws.lastAimAt < 40) return;
      ws.lastAimAt = now;
      const other = room.players.find((entry) => entry.ws && entry.ws !== ws);
      if (other) send(other.ws, { type: "aim", x: msg.x, y: msg.y, player: player.index });
      return;
    }

    if (msg.type === "shot") {
      if (!room.match || typeof msg.x !== "number" || typeof msg.y !== "number") return;
      const now = Date.now();
      const when = typeof msg.t === "number" ? msg.t : now;
      const events = DuckCore.offerShot(room.match, player.index, msg.x, msg.y, when, now);
      for (const event of events) {
        if (event.type === "blast") broadcast(room, { type: "fx", fx: event });
      }
      pump(room);
      return;
    }

    if (msg.type === "speed") {
      if (player.index !== 0) return;
      if (room.match && room.match.phase !== "win") return;
      room.duckSpeed = DuckCore.duckSpeedOf(msg.speed);
      if (room.match) broadcastState(room);
      else sendLobby(room);
      return;
    }

    if (msg.type === "again") {
      if (!room.match || room.match.phase !== "win") return;
      room.again[player.index] = true;
      if (room.again[0] && room.again[1]) begin(room);
      else send(ws, { type: "note", message: "Waiting for the other hunter…" });
    }
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.match) continue;
    try {
      pump(room);
      broadcastState(room);
    } catch (err) {
      console.error("tick error:", err);
    }
  }
}, 100);

setInterval(() => {
  for (const client of wss.clients) send(client, { type: "keepalive" });
}, 5000);

server.listen(port, "0.0.0.0", () => {
  const actual = server.address().port;
  console.log(`Duck Shooter at http://localhost:${actual}`);
  for (const ip of lanIps()) console.log(`  on your network: http://${ip}:${actual}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  }
  throw err;
});
