// Shared rules for Duck Shooter.
// Both players see one duck. A shot is judged at the moment it was fired.
// If both shots hit, the earlier one scores. The same instant is a tie.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DuckCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WIDTH = 1280;
  const HEIGHT = 720;
  const WIN_SCORE = 7;
  const SHOT_COOLDOWN = 340;
  const BULLETS = 3;
  const MAX_REWIND = 170;
  const COUNTDOWN_MS = 2400;
  const FALL_MS = 900;
  const RETRIEVE_MS = 1500;
  const TAUNT_MS = 1200;
  const GAP_MS = 450;
  const HIT_RX = 62;
  const HIT_RY = 36;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function cleanName(value, fallback) {
    const text = String(value ?? "")
      .replace(/[^\w \-']/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12);
    return text || fallback;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createMatch(names, now, opts) {
    const options = opts || {};
    let first = cleanName(names && names[0], "Hunter 1");
    let second = cleanName(names && names[1], "Hunter 2");
    if (first === second) second = second.slice(0, 10) + " 2";
    return {
      names: [first, second],
      scores: [0, 0],
      winner: null,
      round: 1,
      phase: "countdown",
      phaseStarted: now,
      phaseUntil: now + COUNTDOWN_MS,
      banner: "",
      bannerPlayer: null,
      duck: null,
      prop: null,
      best: null,
      resolveAt: 0,
      cooldowns: [0, 0],
      ammo: [BULLETS, BULLETS],
      lastQuack: now,
      lagGrace: options.lagGrace || 0,
      rng: mulberry32(options.seed != null ? options.seed : now >>> 0),
    };
  }

  function sampleDuck(duck, now) {
    if (!duck) return null;
    if (duck.falling) {
      const ft = Math.max(0, (now - duck.fallStart) / 1000);
      return {
        x: duck.fallX + duck.dir * 40 * ft,
        y: duck.fallY + 280 * ft + 700 * ft * ft,
        vx: duck.dir * 40,
        vy: 280 + 1400 * ft,
        dir: duck.dir,
        falling: true,
        rot: ft * 7,
        wing: 0,
      };
    }
    const t = (now - duck.born) / 1000;
    const angle = t * duck.freq + duck.phase;
    return {
      x: duck.x0 + duck.dir * duck.speed * t,
      y: duck.baseY + Math.sin(angle) * duck.amp,
      vx: duck.dir * duck.speed,
      vy: Math.cos(angle) * duck.amp * duck.freq,
      dir: duck.dir,
      falling: false,
      rot: 0,
      wing: t * 16,
    };
  }

  function hits(sample, x, y) {
    const dx = x - sample.x;
    const dy = y - sample.y;
    return (dx * dx) / (HIT_RX * HIT_RX) + (dy * dy) / (HIT_RY * HIT_RY) <= 1;
  }

  function spawnDuck(match, now) {
    const dir = match.rng() < 0.5 ? 1 : -1;
    const speed = Math.min(560, 230 + (match.round - 1) * 16 + match.rng() * 50);
    match.duck = {
      born: now,
      dir: dir,
      speed: speed,
      x0: dir === 1 ? -90 : WIDTH + 90,
      baseY: 165 + match.rng() * 175,
      amp: 16 + match.rng() * 28,
      freq: 1.15 + match.rng() * 1.35,
      phase: match.rng() * Math.PI * 2,
      falling: false,
      alive: true,
    };
    match.best = null;
    match.resolveAt = 0;
    match.lastQuack = now;
    match.banner = "";
    match.bannerPlayer = null;
    match.phase = "fly";
    match.phaseStarted = now;
    match.phaseUntil = Infinity;
    match.ammo = [BULLETS, BULLETS];
  }

  function startTaunt(match, now, x, banner, events, type) {
    match.prop = { x: clamp(x, 110, WIDTH - 110), hasDuck: false };
    match.duck = null;
    match.best = null;
    match.banner = banner;
    match.bannerPlayer = null;
    match.phase = "taunt";
    match.phaseStarted = now;
    match.phaseUntil = now + TAUNT_MS;
    events.push({ type: type, x: match.prop.x });
  }

  function resolveBest(match, now, events) {
    if (!match.duck || !match.best) return;
    if (match.best.tie) {
      const sample = sampleDuck(match.duck, match.best.t);
      startTaunt(match, now, sample ? sample.x : WIDTH / 2, "TOO CLOSE", events, "tie");
      return;
    }
    const sample = sampleDuck(match.duck, match.best.t);
    const player = match.best.player;
    match.duck.fallX = sample.x;
    match.duck.fallY = sample.y;
    match.duck.fallStart = now;
    match.duck.falling = true;
    match.duck.alive = false;
    match.scores[player] += 1;
    match.prop = { x: clamp(sample.x, 110, WIDTH - 110), hasDuck: true };
    match.banner = match.names[player] + " +1";
    match.bannerPlayer = player;
    match.phase = "fall";
    match.phaseStarted = now;
    match.phaseUntil = now + FALL_MS;
    match.best = null;
    if (match.scores[player] >= WIN_SCORE) match.winner = player;
    events.push({ type: "score", player: player, x: sample.x, y: sample.y });
  }

  function beginGap(match, now) {
    match.phase = "gap";
    match.phaseStarted = now;
    match.phaseUntil = now + GAP_MS;
    match.banner = "";
    match.bannerPlayer = null;
    match.duck = null;
    match.best = null;
  }

  function update(match, now) {
    const events = [];
    if (match.phase === "countdown" && now >= match.phaseUntil) {
      spawnDuck(match, now);
      events.push({ type: "spawn", round: match.round });
    }

    if (match.phase === "fly" && match.duck) {
      if (match.best && now >= match.resolveAt) {
        resolveBest(match, now, events);
      } else if (!match.best) {
        const sample = sampleDuck(match.duck, now);
        if (sample.x < -140 || sample.x > WIDTH + 140) {
          startTaunt(match, now, sample.x, "FLEW AWAY", events, "escape");
        } else if (now - match.duck.born > 500 && now - match.lastQuack > 1700) {
          match.lastQuack = now;
          if (match.rng() < 0.62) events.push({ type: "quack" });
        }
      }
    }

    if (match.phase === "fall" && now >= match.phaseUntil) {
      if (match.winner != null) {
        match.phase = "win";
        match.phaseStarted = now;
        match.phaseUntil = Infinity;
        events.push({ type: "win", player: match.winner });
      } else {
        match.phase = "retrieve";
        match.phaseStarted = now;
        match.phaseUntil = now + RETRIEVE_MS;
      }
    } else if ((match.phase === "retrieve" || match.phase === "taunt") && now >= match.phaseUntil) {
      beginGap(match, now);
    } else if (match.phase === "gap" && now >= match.phaseUntil) {
      match.round += 1;
      spawnDuck(match, now);
      events.push({ type: "spawn", round: match.round });
    }

    return events;
  }

  function offerShot(match, player, x, y, t, now) {
    const events = [];
    if (match.phase !== "fly" || !match.duck || !match.duck.alive || (player !== 0 && player !== 1)) {
      events.push({ type: "reject" });
      return events;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t) || !Number.isFinite(now)) {
      events.push({ type: "reject" });
      return events;
    }
    if (!match.ammo || match.ammo[player] <= 0) {
      events.push({ type: "empty" });
      return events;
    }
    if (now < match.cooldowns[player]) {
      events.push({ type: "cooldown" });
      return events;
    }

    let when = t;
    if (when > now + 40) when = now;
    if (when < now - MAX_REWIND) when = now - MAX_REWIND;
    if (when < match.duck.born) when = match.duck.born;

    const aimX = clamp(x, 0, WIDTH);
    const aimY = clamp(y, 0, HEIGHT);
    match.cooldowns[player] = now + SHOT_COOLDOWN;
    match.ammo[player] -= 1;

    const sample = sampleDuck(match.duck, when);
    const hit = hits(sample, aimX, aimY);
    events.push({ type: "blast", player: player, x: aimX, y: aimY, hit: hit, t: when });
    if (!hit) return events;

    if (!match.best) {
      match.best = { t: when, player: player, x: aimX, y: aimY, tie: false };
      match.resolveAt = now + match.lagGrace;
    } else if (!match.best.tie && when === match.best.t && player !== match.best.player) {
      match.best = { t: when, tie: true };
    } else if (!match.best.tie && when < match.best.t) {
      match.best = { t: when, player: player, x: aimX, y: aimY, tie: false };
    }
    return events;
  }

  function currentBanner(match, now) {
    if (!match) return "";
    if (match.phase === "countdown") {
      const left = match.phaseUntil - now;
      const third = COUNTDOWN_MS / 3;
      if (left > third * 2) return "3";
      if (left > third) return "2";
      return "1";
    }
    if (match.phase === "win" && match.winner != null) return match.names[match.winner] + " wins";
    return match.banner || "";
  }

  return {
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    WIN_SCORE: WIN_SCORE,
    SHOT_COOLDOWN: SHOT_COOLDOWN,
    BULLETS: BULLETS,
    HIT_RX: HIT_RX,
    HIT_RY: HIT_RY,
    cleanName: cleanName,
    createMatch: createMatch,
    update: update,
    offerShot: offerShot,
    sampleDuck: sampleDuck,
    currentBanner: currentBanner,
  };
});
