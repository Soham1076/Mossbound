(() => {
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const pressed = new Set();
  const keyMap = {
    KeyW: 'up', ArrowUp: 'up', KeyA: 'left', ArrowLeft: 'left',
    KeyS: 'down', ArrowDown: 'down', KeyD: 'right', ArrowRight: 'right',
  };
  const moveKeys = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' };
  let state = null;
  let playerId = localStorage.getItem('mossbound.playerId') || '';
  let playerName = localStorage.getItem('mossbound.playerName') || '';
  let worldSeed = 1;
  let lastSelfMessage = '';
  let lastStateAt = performance.now();
  let lastState = null;
  let toastTimer = 0;
  let timerValue = -1;
  let lastInputSent = '';
  let disconnected = false;

  $('playerName').value = playerName || 'Wanderer';
  const rand = (n) => {
    let x = n | 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const hashCoord = (x, y, salt = 0) => rand(Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(worldSeed | 0, 1274126177) ^ salt);
  const post = (path, data, keepalive = false) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive,
  });

  async function join(name, botDifficulty = 'friend') {
    const response = await post('/api/join', { id: playerId, name, botDifficulty });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not enter the world');
    playerId = data.id;
    playerName = name;
    localStorage.setItem('mossbound.playerId', playerId);
    localStorage.setItem('mossbound.playerName', playerName);
    $('joinScreen').classList.add('hidden');
    setConnection(true);
    if (data.lan?.length) {
      $('lanText').textContent = data.lan.join('  ·  ');
    } else {
      $('lanText').textContent = 'Open localhost:8080 on this device.';
    }
    applyState(data.state);
    showToast(data.notice || 'Welcome to the Fernwild');
    poll();
  }

  $('joinForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('playerName').value.trim().slice(0, 16) || 'Wanderer';
    const botDifficulty = $('opponentChoice').value;
    $('playerName').value = name;
    const button = document.querySelector('#joinForm button');
    button.disabled = true;
    button.textContent = 'Finding your place…';
    try {
      playerId = '';
      await join(name, botDifficulty);
    } catch (error) {
      button.disabled = false;
      button.innerHTML = 'Try again <span>↗</span>';
      showToast(error.message || 'Could not reach the world host');
      setConnection(false);
    }
  });

  $('restartButton').addEventListener('click', async () => {
    const button = $('restartButton');
    button.disabled = true;
    button.textContent = 'Resetting the grove…';
    try {
      const response = await post('/api/restart', { id: playerId });
      if (!response.ok) throw new Error('Restart failed');
      returnToMenu();
    } catch {
      button.disabled = false;
      button.innerHTML = 'Restart game <span>↻</span>';
      showToast('Could not restart the round');
    }
  });

  async function poll() {
    if (!playerId) return;
    try {
      const response = await fetch(`/api/state?id=${encodeURIComponent(playerId)}`, { cache: 'no-store' });
      if (response.status === 404) {
        returnToMenu();
        return;
      }
      if (!response.ok) throw new Error('offline');
      applyState(await response.json());
      setConnection(true);
      disconnected = false;
    } catch {
      setConnection(false);
      disconnected = true;
    } finally {
      if (playerId) window.setTimeout(poll, 110);
    }
  }

  function applyState(next) {
    if (!next) return;
    state = next;
    lastState = next;
    lastStateAt = performance.now();
    worldSeed = next.seed || 1;
    $('seedText').textContent = worldSeed.toString(16).toUpperCase().padStart(6, '0');
    const self = next.players.find((p) => p.id === next.you);
    if (self) {
      $('coordinates').textContent = `${Math.round(self.x)}, ${Math.round(self.y)}`;
      $('woodCount').textContent = self.inventory.wood;
      $('stoneCount').textContent = self.inventory.stone;
      $('goldCount').textContent = self.inventory.gold;
      $('diamondCount').textContent = self.inventory.diamond;
      const score = self.inventory.gold + self.inventory.diamond;
      $('scoreCount').textContent = score;
      $('packWeight').textContent = `${Object.values(self.inventory).reduce((a, b) => a + b, 0)} carried`;
      const power = Math.min(8, 1 + Math.floor((self.inventory.wood + self.inventory.stone) / 4));
      $('powerLevel').textContent = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][power - 1];
      [...$('powerMeter').children].forEach((bar, index) => bar.classList.toggle('on', index < power));
      $('powerCaption').textContent = power === 1 ? 'Pick up wood & stone to hit harder' : `Your pack adds ${Math.floor((self.inventory.wood + self.inventory.stone) / 4) * 4} damage per hit`;
      syncDeadBanner(self);
    }
    const eligible = next.players.length;
    $('playerCount').textContent = `${eligible} / 2`;
    $('playerList').innerHTML = next.players.map((p) => {
      const total = p.inventory.gold + p.inventory.diamond;
      const initial = escapeHtml(p.name.slice(0, 1).toUpperCase());
      const selfTag = p.isSelf ? '<small>YOU</small>' : '';
      const botTag = p.isBot ? `<small>${escapeHtml(`${p.difficulty[0].toUpperCase()}${p.difficulty.slice(1)}`)} BOT</small>` : '';
      const opacity = p.alive ? '' : ' style="opacity:.52"';
      return `<div class="player-row"${opacity}><div class="player-avatar ${p.isSelf ? 'self' : ''}">${initial}</div><div><div class="player-row-name">${escapeHtml(p.name)}${selfTag}${botTag}</div><div class="player-hp"><i style="width:${p.alive ? p.hp : 0}%"></i></div></div><div class="player-row-score">✦ ${total}</div></div>`;
    }).join('') || '<div class="round-note">The grove is quiet…</div>';
    const remaining = Math.ceil(next.round.remainingMs / 1000);
    if (remaining !== timerValue) {
      timerValue = remaining;
      $('timer').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    }
    $('timerFill').style.width = `${Math.max(0, Math.min(100, (next.round.remainingMs / 120000) * 100))}%`;
    const bot = next.players.find((p) => p.isBot);
    const botDifficulty = bot ? `${bot.difficulty[0].toUpperCase()}${bot.difficulty.slice(1)}` : '';
    $('roundNote').textContent = next.round.started
      ? (bot ? `Playing vs. ${botDifficulty} bot` : 'A little friendly competition')
      : 'Waiting for a second player';
    $('footerMessage').textContent = next.round.started
      ? (bot ? `Outplay ${bot.name} and claim the grove.` : 'The grove is yours to explore.')
      : 'A friend can join on the same Wi-Fi.';
    $('location').textContent = 'The Fernwild';
    for (const item of next.messages || []) {
      if (item.id === playerId) {
        const key = `${item.at}:${item.text}`;
        if (key !== lastSelfMessage) { lastSelfMessage = key; showToast(item.text); }
      }
    }
    if (next.round.winner) {
      $('gameOver').classList.remove('hidden');
      $('winnerText').textContent = next.round.winner.name === 'It’s a tie' ? 'The grove is evenly matched.' : `${next.round.winner.name} takes the grove.`;
      $('winnerScore').textContent = `${next.round.winner.score} ✦ collected`;
    }
  }

  function returnToMenu() {
    playerId = '';
    localStorage.removeItem('mossbound.playerId');
    state = null;
    lastState = null;
    lastSelfMessage = '';
    timerValue = 120;
    lastInputSent = '';
    pressed.clear();
    $('joinScreen').classList.remove('hidden');
    $('gameOver').classList.add('hidden');
    $('timer').textContent = '02:00';
    $('timerFill').style.width = '100%';
    $('roundNote').textContent = 'Waiting for a second player';
    $('footerMessage').textContent = 'A friend can join on the same Wi-Fi.';
    $('playerCount').textContent = '0 / 2';
    $('playerList').innerHTML = '';
    $('coordinates').textContent = '0, 0';
    $('seedText').textContent = '—';
    $('woodCount').textContent = '0';
    $('stoneCount').textContent = '0';
    $('goldCount').textContent = '0';
    $('diamondCount').textContent = '0';
    $('scoreCount').textContent = '0';
    $('packWeight').textContent = '0 carried';
    $('powerLevel').textContent = 'I';
    [...$('powerMeter').children].forEach((bar, index) => bar.classList.toggle('on', index === 0));
    $('powerCaption').textContent = 'Pick up wood & stone to hit harder';
    $('playerName').value = playerName || 'Wanderer';
    $('opponentChoice').value = 'friend';
    const joinButton = document.querySelector('#joinForm button');
    joinButton.disabled = false;
    joinButton.innerHTML = 'Enter the world <span>↗</span>';
    document.querySelector('.dead-banner')?.remove();
    $('toast').classList.remove('show');
    disconnected = false;
    setReady();
  }

  function syncDeadBanner(self) {
    let banner = document.querySelector('.dead-banner');
    if (!self.alive) {
      if (!banner) {
        banner = document.createElement('div');
        banner.className = 'dead-banner';
        $('canvasWrap').appendChild(banner);
      }
      const seconds = Math.max(1, Math.ceil((self.respawnAt - Date.now()) / 1000));
      banner.textContent = `The grove will return you in ${seconds}…`;
    } else if (banner) banner.remove();
  }

  function setConnection(online) {
    $('connectionText').textContent = online ? (disconnected ? 'Reconnecting' : 'Connected') : 'Reconnecting';
    document.querySelector('.connection').classList.toggle('offline', !online);
  }

  function setReady() {
    $('connectionText').textContent = 'Ready';
    document.querySelector('.connection').classList.remove('offline');
  }

  function showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('show'), 1450);
  }

  function action(name) {
    if (!playerId) return;
    post('/api/action', { id: playerId, action: name }).catch(() => setConnection(false));
  }

  window.addEventListener('keydown', (event) => {
    const key = event.code;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (keyMap[key]) {
      pressed.add(keyMap[key]);
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    if (key === 'KeyI') { action('attack'); event.preventDefault(); }
    if (key === 'KeyO') { action('collect'); event.preventDefault(); }
    if (key === 'KeyP') { action('emote'); event.preventDefault(); }
  });
  window.addEventListener('keyup', (event) => { if (keyMap[event.code]) pressed.delete(keyMap[event.code]); });
  window.addEventListener('blur', () => pressed.clear());

  document.querySelectorAll('[data-move]').forEach((button) => {
    const direction = button.dataset.move;
    const key = moveKeys[direction];
    button.addEventListener('pointerdown', (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); pressed.add(direction); });
    const release = () => pressed.delete(direction);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    button.dataset.key = key;
  });
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => { event.preventDefault(); action(button.dataset.action); });
  });

  window.setInterval(() => {
    if (!playerId) return;
    let x = Number(pressed.has('right')) - Number(pressed.has('left'));
    let y = Number(pressed.has('down')) - Number(pressed.has('up'));
    const signature = `${x},${y}`;
    if (signature === lastInputSent) return;
    lastInputSent = signature;
    post('/api/input', { id: playerId, x, y }).catch(() => setConnection(false));
  }, 55);

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { width: rect.width, height: rect.height };
  }

  function draw() {
    const { width, height } = resizeCanvas();
    const self = state?.players.find((p) => p.id === state.you);
    const camX = self?.x || 0;
    const camY = self?.y || 0;
    const left = camX - width / 2;
    const top = camY - height / 2;
    drawGround(left, top, width, height);
    if (state) {
      for (const node of state.nodes) drawNode(node, left, top);
      for (const drop of state.drops) drawDrop(drop, left, top);
      for (const p of state.players) drawPlayer(p, left, top);
      drawVignette(width, height);
    }
    requestAnimationFrame(draw);
  }

  function drawGround(left, top, width, height) {
    ctx.fillStyle = '#355038'; ctx.fillRect(0, 0, width, height);
    const size = 52;
    const sx = Math.floor(left / size) - 1; const ex = Math.ceil((left + width) / size) + 1;
    const sy = Math.floor(top / size) - 1; const ey = Math.ceil((top + height) / size) + 1;
    for (let gy = sy; gy <= ey; gy += 1) {
      for (let gx = sx; gx <= ex; gx += 1) {
        const r = hashCoord(gx, gy, 0x531);
        const x = gx * size - left; const y = gy * size - top;
        const shade = Math.floor(r * 17);
        ctx.fillStyle = `rgb(${48 + shade},${75 + shade},${51 + Math.floor(shade * .55)})`;
        ctx.fillRect(x, y, size + 1, size + 1);
        for (let j = 0; j < 2; j += 1) {
          const d = hashCoord(gx * 3 + j, gy * 5 - j, 0x112);
          if (d > .36) {
            ctx.fillStyle = d > .78 ? '#a1aa7040' : '#15251a22';
            ctx.beginPath();
            ctx.ellipse(x + 5 + hashCoord(gx, gy, j + 22) * 42, y + 5 + hashCoord(gx, gy, j + 41) * 42, 1 + d * 2, .7 + d, d * 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    // Soft clearings give the otherwise endless tile field a little shape.
    const patch = 380;
    const px = Math.floor(left / patch); const qx = Math.ceil((left + width) / patch);
    const py = Math.floor(top / patch); const qy = Math.ceil((top + height) / patch);
    for (let gy = py; gy <= qy; gy += 1) for (let gx = px; gx <= qx; gx += 1) {
      const r = hashCoord(gx, gy, 0x992);
      if (r < .52) continue;
      const x = gx * patch + r * 100 - left; const y = gy * patch + hashCoord(gx, gy, 33) * 100 - top;
      ctx.fillStyle = '#b7b67b0b';
      ctx.beginPath(); ctx.ellipse(x, y, 75 + r * 60, 44 + r * 38, r * Math.PI, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawNode(n, left, top) {
    const x = n.x - left; const y = n.y - top;
    if (x < -50 || y < -60 || x > canvas.clientWidth + 50 || y > canvas.clientHeight + 60) return;
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = '#10211855'; ctx.beginPath(); ctx.ellipse(2, 13, 22, 9, 0, 0, Math.PI * 2); ctx.fill();
    if (n.type === 'wood') {
      ctx.fillStyle = '#705339'; ctx.fillRect(-4, 1, 8, 15);
      ctx.fillStyle = '#466e43'; ctx.beginPath(); ctx.arc(-1, -7, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#62894d'; ctx.beginPath(); ctx.arc(-8, -10, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7e9d59'; ctx.beginPath(); ctx.arc(6, -13, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a6bb74'; ctx.beginPath(); ctx.arc(-3, -15, 3, 0, Math.PI * 2); ctx.fill();
    } else if (n.type === 'stone') {
      ctx.fillStyle = '#89918b'; ctx.beginPath(); ctx.moveTo(-15, 6); ctx.lineTo(-12, -6); ctx.lineTo(-3, -14); ctx.lineTo(11, -10); ctx.lineTo(16, 4); ctx.lineTo(8, 11); ctx.lineTo(-9, 12); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#b6c0b5'; ctx.beginPath(); ctx.moveTo(-9, -6); ctx.lineTo(-2, -12); ctx.lineTo(5, -9); ctx.lineTo(-1, -5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#68736b'; ctx.beginPath(); ctx.moveTo(5, -2); ctx.lineTo(14, 2); ctx.lineTo(8, 9); ctx.closePath(); ctx.fill();
    } else if (n.type === 'gold') {
      ctx.fillStyle = '#747a69'; ctx.beginPath(); ctx.moveTo(-15, 5); ctx.lineTo(-12, -6); ctx.lineTo(0, -13); ctx.lineTo(13, -8); ctx.lineTo(15, 5); ctx.lineTo(7, 12); ctx.lineTo(-9, 10); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f0c957'; ctx.beginPath(); ctx.moveTo(-8, 2); ctx.lineTo(-5, -7); ctx.lineTo(1, -4); ctx.lineTo(5, -9); ctx.lineTo(9, -1); ctx.lineTo(5, 7); ctx.lineTo(-3, 8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffe99b'; ctx.fillRect(-2, -5, 4, 3);
    } else {
      ctx.fillStyle = '#617d78'; ctx.beginPath(); ctx.moveTo(-14, 3); ctx.lineTo(-7, -9); ctx.lineTo(0, -14); ctx.lineTo(13, -7); ctx.lineTo(13, 5); ctx.lineTo(1, 12); ctx.lineTo(-11, 9); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#72d7ce'; ctx.beginPath(); ctx.moveTo(-5, 1); ctx.lineTo(-2, -7); ctx.lineTo(3, -9); ctx.lineTo(8, -4); ctx.lineTo(7, 3); ctx.lineTo(1, 7); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c6fff4'; ctx.beginPath(); ctx.moveTo(-2, -6); ctx.lineTo(2, -8); ctx.lineTo(2, -2); ctx.closePath(); ctx.fill();
    }
    if (n.hp < n.maxHp) {
      ctx.fillStyle = '#17231b'; ctx.fillRect(-13, 18, 26, 3);
      ctx.fillStyle = '#e8cd79'; ctx.fillRect(-13, 18, 26 * (n.hp / n.maxHp), 3);
    }
    ctx.restore();
  }

  function drawDrop(d, left, top) {
    const x = d.x - left; const y = d.y - top;
    if (x < -20 || y < -20 || x > canvas.clientWidth + 20 || y > canvas.clientHeight + 20) return;
    const colors = { wood: '#d5a56c', stone: '#c5cfc0', gold: '#ffe276', diamond: '#a1f6ec' };
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = '#14201877'; ctx.beginPath(); ctx.ellipse(0, 8, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = colors[d.type]; ctx.shadowBlur = 9; ctx.fillStyle = colors[d.type];
    if (d.type === 'wood') { ctx.rotate(-.6); ctx.fillRect(-7, -2, 14, 5); ctx.fillRect(-5, 2, 10, 3); }
    else if (d.type === 'stone') { ctx.beginPath(); ctx.moveTo(-6, 2); ctx.lineTo(-3, -5); ctx.lineTo(5, -4); ctx.lineTo(7, 2); ctx.closePath(); ctx.fill(); }
    else if (d.type === 'gold') { ctx.beginPath(); ctx.arc(0, -1, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff5b8'; ctx.fillRect(-1, -4, 2, 5); }
    else { ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(6, -1); ctx.lineTo(0, 6); ctx.lineTo(-6, -1); ctx.closePath(); ctx.fill(); }
    ctx.shadowBlur = 0;
    if (d.amount > 1) { ctx.fillStyle = '#f1f4e8'; ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'center'; ctx.fillText(String(d.amount), 8, -5); }
    ctx.restore();
  }

  function drawPlayer(p, left, top) {
    const x = p.x - left; const y = p.y - top;
    if (x < -50 || y < -60 || x > canvas.clientWidth + 50 || y > canvas.clientHeight + 60) return;
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = '#14201877'; ctx.beginPath(); ctx.ellipse(0, 11, 11, 6, 0, 0, Math.PI * 2); ctx.fill();
    if (!p.alive) {
      ctx.strokeStyle = '#d78b69'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#d78b69'; ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'center'; ctx.fillText('✕', 0, 3);
      ctx.restore(); return;
    }
    const self = p.id === state.you;
    ctx.fillStyle = self ? '#5e844e' : '#a77850';
    ctx.beginPath(); ctx.arc(0, 0, 10.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = self ? '#c2e299' : '#f0c38f'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#eee8d6'; ctx.beginPath(); ctx.arc(0, -2, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = self ? '#46663b' : '#765233'; ctx.beginPath(); ctx.arc(0, -5, 6, Math.PI, Math.PI * 2); ctx.lineTo(6, -2); ctx.lineTo(-5, -2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#293b2b'; ctx.beginPath(); ctx.arc(2, -2, 1, 0, Math.PI * 2); ctx.fill();
    const total = p.inventory.gold + p.inventory.diamond;
    if (total > 0) { ctx.fillStyle = '#f2d064'; ctx.font = '8px DM Mono, monospace'; ctx.textAlign = 'center'; ctx.fillText(`✦${total}`, 0, -18); }
    ctx.fillStyle = '#0d1710c9'; ctx.fillRect(-19, -31, 38, 12);
    ctx.fillStyle = self ? '#c7dfa5' : '#f0d6ae'; ctx.font = '8px DM Sans, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.name.length > 11 ? `${p.name.slice(0, 10)}…` : p.name, 0, -25);
    ctx.fillStyle = '#26362a'; ctx.fillRect(-11, 14, 22, 3); ctx.fillStyle = '#94cd72'; ctx.fillRect(-11, 14, 22 * Math.max(0, p.hp / 100), 3);
    if (p.emote) {
      const wobble = Math.sin(performance.now() / 90) * 1.5;
      ctx.fillStyle = '#f4f0dd'; ctx.beginPath(); ctx.roundRect(-24, -52 + wobble, 48, 19, 8); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-3, -34 + wobble); ctx.lineTo(2, -34 + wobble); ctx.lineTo(-1, -29 + wobble); ctx.fill();
      ctx.fillStyle = '#30422e'; ctx.font = 'italic 10px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.emote, 0, -43 + wobble);
    }
    ctx.restore();
  }

  function drawVignette(width, height) {
    const grad = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * .25, width / 2, height / 2, Math.max(width, height) * .72);
    grad.addColorStop(0, '#07120b00'); grad.addColorStop(1, '#07120b54');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, width, height);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function unload() {
    if (playerId) navigator.sendBeacon('/api/leave', new Blob([JSON.stringify({ id: playerId })], { type: 'application/json' }));
  }
  window.addEventListener('pagehide', unload);
  window.addEventListener('beforeunload', unload);

  requestAnimationFrame(draw);
  if (playerId) {
    join(playerName || 'Wanderer').catch(() => {
      playerId = '';
      setConnection(false);
      $('joinScreen').classList.remove('hidden');
    });
  } else {
    setReady();
  }
})();
