const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
let WORLD_SEED = crypto.randomBytes(4).readUInt32LE(0);
const CHUNK = 640;
const ROUND_MS = 120_000;
const players = new Map();
const nodes = new Map();
const drops = new Map();
let matchStartedAt = null;
let matchEndedAt = null;
let dropSequence = 0;
let lastTickAt = Date.now();

const BOT_DIFFICULTIES = {
  easy: { label: 'Easy', name: 'Sprout', speed: 150, thinkMs: 300, attackCooldownMs: 850, damageScale: 0.72, nodeBonus: 0, chaseRange: 0, strengthGoal: 12, retreatAt: 25 },
  medium: { label: 'Medium', name: 'Moss', speed: 190, thinkMs: 180, attackCooldownMs: 570, damageScale: 1, nodeBonus: 0, chaseRange: 380, strengthGoal: 8, retreatAt: 18 },
  hard: { label: 'Hard', name: 'Bramble', speed: 220, thinkMs: 100, attackCooldownMs: 440, damageScale: 1.1, nodeBonus: 1, chaseRange: 950, strengthGoal: 4, retreatAt: 0 },
};

const TYPES = {
  wood: { name: 'Wood', maxHp: 3 },
  stone: { name: 'Stone', maxHp: 4 },
  gold: { name: 'Gold', maxHp: 5 },
  diamond: { name: 'Diamond', maxHp: 6 },
};

function hash32(value) {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

function randomFor(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunkKey(cx, cy) { return `${cx},${cy}`; }

function ensureChunk(cx, cy) {
  const key = chunkKey(cx, cy);
  if (nodes.has(key)) return;
  const rng = randomFor(hash32(WORLD_SEED ^ Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)));
  const count = 14 + Math.floor(rng() * 8);
  const generated = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rng();
    const type = roll < 0.43 ? 'wood' : roll < 0.78 ? 'stone' : roll < 0.95 ? 'gold' : 'diamond';
    generated.push({
      id: `${key}:${i}`,
      type,
      x: cx * CHUNK + 32 + rng() * (CHUNK - 64),
      y: cy * CHUNK + 32 + rng() * (CHUNK - 64),
      hp: TYPES[type].maxHp,
      maxHp: TYPES[type].maxHp,
      gone: false,
    });
  }
  nodes.set(key, generated);
}

function chunksNear(x, y, radius = 900) {
  const minX = Math.floor((x - radius) / CHUNK);
  const maxX = Math.floor((x + radius) / CHUNK);
  const minY = Math.floor((y - radius) / CHUNK);
  const maxY = Math.floor((y + radius) / CHUNK);
  for (let cy = minY; cy <= maxY; cy += 1) {
    for (let cx = minX; cx <= maxX; cx += 1) ensureChunk(cx, cy);
  }
}

function activePlayers() {
  return [...players.values()].filter((p) => Date.now() - p.lastSeen < 20_000);
}

function closestSpawn() {
  const existing = activePlayers().filter((p) => p.alive);
  if (!existing.length) return { x: 0, y: 0 };
  const lead = existing[existing.length - 1];
  const angle = Math.random() * Math.PI * 2;
  const distance = 100 + Math.random() * 65;
  return { x: lead.x + Math.cos(angle) * distance, y: lead.y + Math.sin(angle) * distance };
}

function safeName(value) {
  return String(value || 'Wanderer').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Wanderer';
}

function findPlayer(id) {
  const p = players.get(String(id || ''));
  if (p) p.lastSeen = Date.now();
  return p;
}

function stateFor(id) {
  const self = players.get(id);
  if (!self) return null;
  chunksNear(self.x, self.y);
  const visibleNodes = [];
  for (const chunk of nodes.values()) {
    for (const n of chunk) {
      if (!n.gone && Math.abs(n.x - self.x) < 1050 && Math.abs(n.y - self.y) < 850) {
        visibleNodes.push({ id: n.id, type: n.type, x: n.x, y: n.y, hp: n.hp, maxHp: n.maxHp });
      }
    }
  }
  const visibleDrops = [...drops.values()]
    .filter((d) => d.expiresAt > Date.now() && Math.abs(d.x - self.x) < 1050 && Math.abs(d.y - self.y) < 850)
    .map((d) => ({ id: d.id, type: d.type, x: d.x, y: d.y, amount: d.amount }));
  const currentPlayers = activePlayers().map((p) => ({
    id: p.id, name: p.name, x: p.x, y: p.y, speed: p.speed, hp: p.hp, alive: p.alive,
    inventory: p.inventory, emote: p.emote && p.emote.expiresAt > Date.now() ? p.emote.text : null,
    emoteUntil: p.emote?.expiresAt || 0, respawnAt: p.respawnAt || 0,
    facing: p.facing, isBot: Boolean(p.isBot), difficulty: p.isBot ? p.difficulty : null,
  }));
  const roster = currentPlayers.map((p) => ({ ...p, isSelf: p.id === id }));
  const remain = matchStartedAt === null
    ? ROUND_MS
    : Math.max(0, ROUND_MS - (matchEndedAt ?? Date.now()) + matchStartedAt);
  if (matchStartedAt !== null && matchEndedAt === null && remain <= 0) matchEndedAt = Date.now();
  let winner = null;
  if (matchEndedAt !== null) {
    const sorted = [...currentPlayers].sort((a, b) => score(b.inventory) - score(a.inventory));
    winner = sorted.length < 2 || score(sorted[0].inventory) === score(sorted[1].inventory)
      ? { id: null, name: 'It’s a tie', score: sorted[0] ? score(sorted[0].inventory) : 0 }
      : { id: sorted[0].id, name: sorted[0].name, score: score(sorted[0].inventory) };
  }
  return {
    you: id,
    seed: WORLD_SEED,
    self,
    players: roster,
    nodes: visibleNodes,
    drops: visibleDrops,
    round: {
      started: matchStartedAt !== null,
      remainingMs: remain,
      winner,
    },
    messages: [...players.values()].filter((p) => p.message && p.message.expiresAt > Date.now())
      .map((p) => ({ id: p.id, name: p.name, text: p.message.text, at: p.message.at })),
  };
}

function score(inventory) { return inventory.gold + inventory.diamond; }

function dropResource(type, x, y, amount = 1) {
  if (!TYPES[type] || amount <= 0) return;
  const id = `drop-${++dropSequence}`;
  drops.set(id, { id, type, x: x + (Math.random() - 0.5) * 28, y: y + (Math.random() - 0.5) * 28, amount, expiresAt: Date.now() + 75_000 });
}

function inventoryTotal(inventory) {
  return Object.values(inventory).reduce((a, b) => a + b, 0);
}

function closestTarget(p, maxRange, predicate) {
  let best = null;
  for (const chunk of nodes.values()) {
    for (const n of chunk) {
      if (n.gone || !predicate(n)) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d <= maxRange && (!best || d < best.distance)) best = { target: n, distance: d };
    }
  }
  return best;
}

function say(p, text) {
  p.message = { text, at: Date.now(), expiresAt: Date.now() + 2300 };
}

function act(p, action) {
  if (!p.alive || matchEndedAt !== null) return;
  const now = Date.now();
  if (action === 'attack') {
    if (now - p.lastAttack < (p.attackCooldownMs || 430)) return;
    p.lastAttack = now;
    const enemy = activePlayers()
      .filter((other) => other.id !== p.id && other.alive)
      .map((other) => ({ target: other, distance: Math.hypot(other.x - p.x, other.y - p.y) }))
      .filter((item) => item.distance <= 72)
      .sort((a, b) => a.distance - b.distance)[0];
    const muscle = p.inventory.wood + p.inventory.stone;
    const damage = Math.max(1, Math.floor((16 + Math.floor(muscle / 4) * 4) * (p.damageScale || 1)));
    if (enemy) {
      const target = enemy.target;
      target.hp = Math.max(0, target.hp - damage);
      const carried = Object.keys(target.inventory).filter((type) => target.inventory[type] > 0);
      if (carried.length) {
        const stolen = carried[Math.floor(Math.random() * carried.length)];
        target.inventory[stolen] -= 1;
        dropResource(stolen, target.x, target.y, 1);
      }
      say(p, `Hit ${target.name} · ${damage} dmg`);
      say(target, 'Ouch! A resource spilled.');
      if (target.hp <= 0) {
        for (const [type, amount] of Object.entries(target.inventory)) dropResource(type, target.x, target.y, amount);
        target.inventory = { wood: 0, stone: 0, gold: 0, diamond: 0 };
        target.alive = false;
        target.respawnAt = now + 3000;
        target.input = { x: 0, y: 0 };
        target.x += (Math.random() - 0.5) * 16;
        target.y += (Math.random() - 0.5) * 16;
        say(target, 'Down! Respawning in 3…');
        say(p, `${target.name} down! Their pack is yours.`);
      }
      return;
    }
    const nearest = closestTarget(p, 78, () => true);
    if (!nearest) { say(p, 'Nothing in reach'); return; }
    const n = nearest.target;
    n.hp -= 1 + Math.floor(muscle / 8) + (p.isBot ? p.nodeBonus : 0);
    if (n.hp <= 0) {
      n.gone = true;
      dropResource(n.type, n.x, n.y, 1 + (n.type === 'wood' ? Math.floor(Math.random() * 2) : 0));
      say(p, `${TYPES[n.type].name} node broken · collect the drop`);
    } else {
      say(p, `${TYPES[n.type].name} · ${n.hp}/${n.maxHp}`);
    }
  } else if (action === 'collect') {
    const nearby = [...drops.values()]
      .filter((d) => d.expiresAt > now && Math.hypot(d.x - p.x, d.y - p.y) <= 74)
      .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    const drop = nearby[0];
    if (!drop) { say(p, 'No drops nearby'); return; }
    p.inventory[drop.type] += drop.amount;
    drops.delete(drop.id);
    say(p, `+${drop.amount} ${TYPES[drop.type].name}`);
  } else if (action === 'emote') {
    p.emoteIndex = (p.emoteIndex + 1) % 2;
    const text = p.emoteIndex === 0 ? 'Yeah!' : 'GG';
    p.emote = { text, expiresAt: now + 2300 };
    p.message = null;
  }
}

function createBot(difficulty, nearPlayer) {
  const settings = BOT_DIFFICULTIES[difficulty];
  const angle = Math.random() * Math.PI * 2;
  const distance = 115 + Math.random() * 35;
  const bot = {
    id: `bot-${crypto.randomBytes(10).toString('hex')}`,
    name: settings.name,
    x: nearPlayer.x + Math.cos(angle) * distance,
    y: nearPlayer.y + Math.sin(angle) * distance,
    vx: 0, vy: 0, speed: settings.speed,
    hp: 100, alive: true, inventory: { wood: 0, stone: 0, gold: 0, diamond: 0 },
    input: { x: 0, y: 0 }, facing: 0, lastSeen: Date.now(), lastAttack: 0,
    respawnAt: 0, emoteIndex: -1, emote: null, message: null,
    isBot: true, difficulty, attackCooldownMs: settings.attackCooldownMs,
    damageScale: settings.damageScale, nodeBonus: settings.nodeBonus,
    thinkMs: settings.thinkMs, nextThinkAt: 0, strengthGoal: settings.strengthGoal,
    chaseRange: settings.chaseRange, retreatAt: settings.retreatAt,
  };
  players.set(bot.id, bot);
  return bot;
}

function thinkBot(bot, now) {
  bot.lastSeen = now;
  if (!bot.alive || matchEndedAt !== null || now < bot.nextThinkAt) return;
  bot.nextThinkAt = now + bot.thinkMs;
  chunksNear(bot.x, bot.y, 520);

  const humans = activePlayers().filter((p) => !p.isBot && p.alive);
  const enemy = humans
    .map((p) => ({ target: p, distance: Math.hypot(p.x - bot.x, p.y - bot.y) }))
    .sort((a, b) => a.distance - b.distance)[0];
  const moveToward = (x, y) => {
    const dx = x - bot.x; const dy = y - bot.y;
    const length = Math.hypot(dx, dy) || 1;
    bot.input = { x: dx / length, y: dy / length };
    bot.facing = Math.atan2(dy, dx);
  };

  if (bot.hp <= bot.retreatAt && enemy && enemy.distance < 250) {
    moveToward(bot.x + (bot.x - enemy.target.x), bot.y + (bot.y - enemy.target.y));
    return;
  }

  if (enemy && enemy.distance <= 72) {
    bot.input = { x: 0, y: 0 };
    act(bot, 'attack');
    return;
  }

  const closeDrop = [...drops.values()]
    .filter((d) => d.expiresAt > now && Math.hypot(d.x - bot.x, d.y - bot.y) <= 520)
    .sort((a, b) => Math.hypot(a.x - bot.x, a.y - bot.y) - Math.hypot(b.x - bot.x, b.y - bot.y))[0];
  if (closeDrop) {
    const distance = Math.hypot(closeDrop.x - bot.x, closeDrop.y - bot.y);
    if (distance <= 74) {
      bot.input = { x: 0, y: 0 };
      act(bot, 'collect');
    } else {
      moveToward(closeDrop.x, closeDrop.y);
    }
    return;
  }
  if (enemy && bot.chaseRange > 0 && enemy.distance <= bot.chaseRange && bot.hp > bot.retreatAt) {
    moveToward(enemy.target.x, enemy.target.y);
    return;
  }

  const muscle = bot.inventory.wood + bot.inventory.stone;
  const wantsStrength = muscle < bot.strengthGoal;
  const preferred = wantsStrength ? ['wood', 'stone'] : ['gold', 'diamond'];
  let target = closestTarget(bot, 520, (node) => preferred.includes(node.type));
  if (!target) target = closestTarget(bot, 520, () => true);
  if (target) {
    if (target.distance <= 78) {
      bot.input = { x: 0, y: 0 };
      moveToward(target.target.x, target.target.y);
      if (target.distance <= 72) act(bot, 'attack');
    } else {
      moveToward(target.target.x, target.target.y);
    }
    return;
  }
  if (enemy) moveToward(enemy.target.x, enemy.target.y);
  else bot.input = { x: 0, y: 0 };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(status === 204 ? undefined : JSON.stringify(data));
}

function resetMatch() {
  players.clear();
  nodes.clear();
  drops.clear();
  WORLD_SEED = crypto.randomBytes(4).readUInt32LE(0);
  matchStartedAt = null;
  matchEndedAt = null;
  dropSequence = 0;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (part) => { body += part; if (body.length > 16_384) reject(new Error('too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('bad JSON')); }
    });
    req.on('error', reject);
  });
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  try {
    if (url.pathname === '/api/join' && req.method === 'POST') {
      const body = await readJson(req);
      const requestedId = String(body.id || '');
      let p = players.get(requestedId);
      let notice = '';
      if (!p) {
        const humans = activePlayers().filter((other) => !other.isBot);
        const pos = closestSpawn();
        const id = crypto.randomBytes(12).toString('hex');
        p = {
          id, name: safeName(body.name), x: pos.x, y: pos.y, vx: 0, vy: 0, speed: 225,
          hp: 100, alive: true, inventory: { wood: 0, stone: 0, gold: 0, diamond: 0 },
          input: { x: 0, y: 0 }, facing: 0, lastSeen: Date.now(), lastAttack: 0,
          respawnAt: 0, emoteIndex: -1, emote: null, message: null,
        };
        players.set(id, p);
        if (humans.length === 0 && BOT_DIFFICULTIES[body.botDifficulty]) {
          const bot = createBot(body.botDifficulty, p);
          notice = `${bot.name} (${BOT_DIFFICULTIES[body.botDifficulty].label}) is ready to play.`;
        } else if (humans.length > 0) {
          const bots = activePlayers().filter((other) => other.isBot);
          for (const bot of bots) players.delete(bot.id);
          if (bots.length) notice = 'Another wanderer joined, so the bot stepped aside.';
        }
      } else {
        p.name = safeName(body.name || p.name);
        p.lastSeen = Date.now();
      }
      if (matchStartedAt === null && activePlayers().length >= 2) matchStartedAt = Date.now();
      return sendJson(res, 200, { id: p.id, state: stateFor(p.id), lan: lanUrls(), notice });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const p = findPlayer(url.searchParams.get('id'));
      if (!p) return sendJson(res, 404, { error: 'Join the world first.' });
      if (matchStartedAt === null && activePlayers().length >= 2) matchStartedAt = Date.now();
      return sendJson(res, 200, stateFor(p.id));
    }
    if (url.pathname === '/api/input' && req.method === 'POST') {
      const body = await readJson(req);
      const p = findPlayer(body.id);
      if (!p) return sendJson(res, 404, { error: 'Join the world first.' });
      const x = Math.max(-1, Math.min(1, Number(body.x) || 0));
      const y = Math.max(-1, Math.min(1, Number(body.y) || 0));
      const length = Math.hypot(x, y) || 1;
      p.input = { x: x / Math.max(1, length), y: y / Math.max(1, length) };
      return sendJson(res, 204, {});
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const body = await readJson(req);
      const p = findPlayer(body.id);
      if (!p) return sendJson(res, 404, { error: 'Join the world first.' });
      act(p, body.action);
      return sendJson(res, 204, {});
    }
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      const body = await readJson(req);
      if (!players.has(String(body.id || ''))) return sendJson(res, 404, { error: 'The round is already reset.' });
      if (matchEndedAt === null) return sendJson(res, 409, { error: 'The current round is still running.' });
      resetMatch();
      return sendJson(res, 204, {});
    }
    if (url.pathname === '/api/leave' && req.method === 'POST') {
      const body = await readJson(req);
      const p = players.get(String(body.id || ''));
      if (p) { p.input = { x: 0, y: 0 }; p.lastSeen = 0; }
      return sendJson(res, 204, {});
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(ROOT, `.${relative}`);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
      res.writeHead(403); return res.end('Forbidden');
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Request failed.' });
  }
});

function lanUrls() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) {
        addresses.push(`http://${item.address}:${PORT}`);
      }
    }
  }
  return addresses;
}

setInterval(() => {
  const now = Date.now();
  const elapsedSeconds = Math.min(0.1, Math.max(0, now - lastTickAt) / 1000);
  lastTickAt = now;
  for (const p of players.values()) {
    if (now - p.lastSeen > 45_000) {
      players.delete(p.id);
      continue;
    }
    if (p.alive) {
      p.x += p.input.x * p.speed * elapsedSeconds;
      p.y += p.input.y * p.speed * elapsedSeconds;
      if (p.input.x || p.input.y) p.facing = Math.atan2(p.input.y, p.input.x);
    } else if (p.respawnAt && now >= p.respawnAt) {
      p.alive = true;
      p.hp = 100;
      p.respawnAt = 0;
      const angle = Math.random() * Math.PI * 2;
      const distance = 42 + Math.random() * 34;
      p.x += Math.cos(angle) * distance;
      p.y += Math.sin(angle) * distance;
      say(p, 'Back in the grove');
    }
    if (p.isBot) thinkBot(p, now);
  }
  for (const [id, d] of drops) if (d.expiresAt <= now) drops.delete(id);
  if (matchStartedAt !== null && matchEndedAt === null && now - matchStartedAt >= ROUND_MS) matchEndedAt = now;
}, 50).unref();

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other app using it, or set PORT to an available port before starting Mossbound.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mossbound is running at http://localhost:${PORT}`);
  const links = lanUrls();
  if (links.length) console.log(`Other devices on your Wi-Fi: ${links.join('  ')}`);
  console.log('Press Ctrl+C to stop the game host.');
});
