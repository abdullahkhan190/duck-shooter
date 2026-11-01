const core = require("./game-core");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function flyMatch(seed, lagGrace) {
  let now = 1_000_000;
  const match = core.createMatch(["Ada", "Bo"], now, { seed: seed, lagGrace: lagGrace || 0 });
  now = match.phaseUntil;
  core.update(match, now);
  assert(match.phase === "fly", "countdown should release a duck");
  return { match: match, now: now };
}

function testHitScores() {
  const { match } = flyMatch(7, 0);
  const t = match.duck.born + 400;
  const sample = core.sampleDuck(match.duck, t);
  const events = core.offerShot(match, 1, sample.x, sample.y, t, t);
  assert(events.some((event) => event.type === "blast" && event.hit), "center shot hits");
  core.update(match, t);
  assert(match.scores[1] === 1 && match.scores[0] === 0, "the shooter scores");
  assert(match.phase === "fall", "a hit drops the duck");
}

function testMissAndCooldown() {
  const { match } = flyMatch(3, 0);
  const t = match.duck.born + 500;
  const miss = core.offerShot(match, 0, 8, 8, t, t);
  assert(miss.some((event) => event.type === "blast" && event.hit === false), "corner shot misses");
  assert(match.scores[0] === 0 && match.phase === "fly", "a miss leaves the duck flying");
  const blocked = core.offerShot(match, 0, 8, 8, t + 20, t + 20);
  assert(blocked[0].type === "cooldown", "the gun needs a moment");
}

function testEarlierShotWins() {
  const { match } = flyMatch(11, 250);
  const earlyT = match.duck.born + 300;
  const lateT = match.duck.born + 460;
  const early = core.sampleDuck(match.duck, earlyT);
  const late = core.sampleDuck(match.duck, lateT);
  core.offerShot(match, 0, late.x, late.y, lateT, lateT + 20);
  core.offerShot(match, 1, early.x, early.y, earlyT, lateT + 40);
  core.update(match, lateT + 20 + 250);
  assert(match.scores[1] === 1 && match.scores[0] === 0, "the earlier hit scores even if it arrives second");
  assert(match.phase === "fall", "the winning hit ends the flight");
}

function testTie() {
  const { match } = flyMatch(5, 0);
  const t = match.duck.born + 450;
  const sample = core.sampleDuck(match.duck, t);
  core.offerShot(match, 0, sample.x, sample.y, t, t);
  core.offerShot(match, 1, sample.x, sample.y, t, t);
  core.update(match, t);
  assert(match.scores[0] === 0 && match.scores[1] === 0, "a dead heat scores nothing");
  assert(match.phase === "taunt" && match.banner === "TOO CLOSE", "a tie is called");
}

function testEscapeAndCountdownLock() {
  const now = 2_000_000;
  const match = core.createMatch(["A", "B"], now, { seed: 2, lagGrace: 0 });
  const rejected = core.offerShot(match, 0, 400, 200, now, now);
  assert(rejected[0].type === "reject", "nobody can shoot during the countdown");
  core.update(match, match.phaseUntil);
  core.update(match, match.duck.born + 20000);
  assert(match.phase === "taunt" && match.banner === "FLEW AWAY", "a missed duck flies off");
  assert(match.scores[0] === 0 && match.scores[1] === 0, "an escape scores nothing");
}

function testFirstToSeven() {
  const { match } = flyMatch(9, 0);
  match.scores[0] = core.WIN_SCORE - 1;
  const t = match.duck.born + 350;
  const sample = core.sampleDuck(match.duck, t);
  core.offerShot(match, 0, sample.x, sample.y, t, t);
  core.update(match, t);
  assert(match.scores[0] === core.WIN_SCORE && match.winner === 0, "the seventh duck wins");
  core.update(match, match.phaseUntil);
  assert(match.phase === "win", "the match ends on the winning fall");
  const late = core.offerShot(match, 1, sample.x, sample.y, t, match.phaseUntil);
  assert(late[0].type === "reject", "the win locks the guns");
}

function testAmmo() {
  const { match } = flyMatch(4, 0);
  const t = match.duck.born + 500;
  assert(match.ammo[0] === core.BULLETS && match.ammo[1] === core.BULLETS, "each hunter starts with a full gun");
  for (let i = 0; i < core.BULLETS; i++) {
    const when = t + i * 400;
    const shot = core.offerShot(match, 0, 8, 8, when, when);
    assert(shot.some((event) => event.type === "blast"), "a loaded gun fires");
  }
  assert(match.ammo[0] === 0, "three shots empty the gun");
  const dry = core.offerShot(match, 0, 8, 8, t + 2000, t + 2000);
  assert(dry[0].type === "empty", "there is no fourth shot");
  const sample = core.sampleDuck(match.duck, t + 2000);
  core.offerShot(match, 1, sample.x, sample.y, t + 2000, t + 2000);
  core.update(match, t + 2000);
  assert(match.scores[1] === 1, "the other hunter can still score");
}

function testReload() {
  const { match } = flyMatch(8, 0);
  const t = match.duck.born + 400;
  for (let i = 0; i < core.BULLETS; i++) core.offerShot(match, 0, 8, 8, t + i * 400, t + i * 400);
  core.update(match, match.duck.born + 20000);
  assert(match.phase === "taunt", "an unhit duck still flies away");
  core.update(match, match.phaseUntil);
  core.update(match, match.phaseUntil);
  assert(match.phase === "fly" && match.ammo[0] === core.BULLETS, "the next duck refills the gun");
}

function testNames() {
  const match = core.createMatch(["<b>Ada</b>", "   "], 0, { seed: 1 });
  assert(match.names[0] === "bAdab", "markup is stripped");
  assert(match.names[1] === "Hunter 2", "blank names get a seat name");
}

testHitScores();
testMissAndCooldown();
testEarlierShotWins();
testTie();
testEscapeAndCountdownLock();
testFirstToSeven();
testAmmo();
testReload();
testNames();
console.log("core ok");
