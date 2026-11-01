const { spawn } = require("child_process");
const { WebSocket } = require("ws");
const core = require("./game-core");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function waitFor(bag, pred, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for " + pred)), timeout || 8000);
    const iv = setInterval(() => {
      const found = bag.find(pred);
      if (!found) return;
      clearInterval(iv);
      clearTimeout(timer);
      resolve(found);
    }, 20);
  });
}

function connect(url) {
  const bag = [];
  const ws = new WebSocket(url);
  ws.on("message", (data) => bag.push(JSON.parse(String(data))));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws: ws, bag: bag }));
    ws.on("error", reject);
  });
}

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: "0" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start\n" + log)), 8000);
      const take = (chunk) => {
        log += chunk.toString();
        const found = log.match(/http:\/\/localhost:(\d+)/);
        if (!found) return;
        clearTimeout(timer);
        resolve("ws://127.0.0.1:" + found[1]);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", (chunk) => {
        log += chunk.toString();
      });
    });

    const ada = await connect(url);
    const bo = await connect(url);
    const cy = await connect(url);
    ada.ws.send(JSON.stringify({ type: "hello", name: "Ada", room: "" }));
    const lobby = await waitFor(ada.bag, (msg) => msg.type === "lobby" && msg.code);
    assert(lobby.code.length === 4, "room code should be 4 characters");
    bo.ws.send(JSON.stringify({ type: "hello", name: "Bo", room: lobby.code }));
    const waiting = await waitFor(ada.bag, (msg) => msg.type === "lobby" && msg.players && msg.players.length === 2);
    assert(waiting.players.length === 2, "two hunters wait for a third");
    assert(!ada.bag.some((msg) => msg.type === "state"), "the duck waits for the third hunter");
    cy.ws.send(JSON.stringify({ type: "hello", name: "Cy", room: lobby.code }));

    const onScreen = (msg) => {
      if (msg.type !== "state" || msg.phase !== "fly" || !msg.duck) return false;
      const sample = core.sampleDuck(msg.duck, msg.now);
      return sample.x > 90 && sample.x < core.WIDTH - 90;
    };
    const sight = await waitFor(ada.bag, onScreen, 8000);
    assert(sight.you === 0, "the host is seat 0");
    const boSight = await waitFor(bo.bag, (msg) => msg.type === "state" && msg.you === 1, 2000);
    assert(boSight.you === 1, "the guest is seat 1");

    const sample = core.sampleDuck(sight.duck, sight.now);
    ada.ws.send(JSON.stringify({ type: "shot", x: sample.x, y: sample.y, t: sight.now }));
    const scored = await waitFor(ada.bag, (msg) => msg.type === "state" && msg.scores && msg.scores[0] === 1, 2000);
    assert(scored.scores[1] === 0, "only the first hunter scores");
    const seenByBo = await waitFor(bo.bag, (msg) => msg.type === "state" && msg.scores && msg.scores[0] === 1, 2000);
    assert(seenByBo.names.length === 3 && seenByBo.names[2] === "Cy", "three screens share the match");
    const cySight = await waitFor(cy.bag, (msg) => msg.type === "state" && msg.you === 2, 2000);
    assert(cySight.you === 2, "the third hunter is seat 2");

    ada.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const adaAgain = await connect(url);
    adaAgain.ws.send(JSON.stringify({ type: "hello", name: "Ada", room: lobby.code }));
    const resumed = await waitFor(
      adaAgain.bag,
      (msg) => msg.type === "state" && msg.you === 0 && msg.scores && msg.scores[0] === 1,
      2000
    );
    assert(resumed.scores[0] === 1, "rejoining keeps the point");
    assert(!bo.bag.some((msg) => msg.type === "left"), "a short drop does not end the match");
    adaAgain.ws.close();
    bo.ws.close();
    cy.ws.close();
    console.log("online ok");
  } finally {
    child.kill();
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
