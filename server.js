const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const duration = { answer: 20, reveal: 5, vote: 15, results: 5 };
const banks = require('./prompts');
const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => codeChars[Math.floor(Math.random() * codeChars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function roomFor(code) { return rooms.get(String(code || '').toUpperCase()); }
function socketPlayer(room, socketId) { return room?.players.find(p => p.socketId === socketId); }
function publicRoom(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  const hiddenPrompt = room.phase === 'answer' && room.imposterId === playerId ? room.imposterPrompt : room.prompt;
  const answers = room.phase === 'reveal' || room.phase === 'vote' || room.phase === 'results' || room.phase === 'finished'
    ? room.players.filter(p => p.answer !== null).map(p => ({ id: p.id, name: p.name, answer: p.answer, group: p.group })) : [];
  return {
    code: room.code, pack: room.pack, phase: room.phase, round: room.round, totalRounds: 8,
    hostId: room.hostId, you: playerId, isHost: room.hostId === playerId,
    isImposter: room.phase === 'answer' && room.imposterId === playerId,
    playerPrompt: hiddenPrompt, prompt: room.phase === 'answer' && room.imposterId === playerId ? null : room.prompt,
    endsAt: room.endsAt, players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, waiting: p.waiting })),
    submitted: room.players.filter(p => p.answer !== null).length, votesIn: Object.keys(room.votes).length,
    answers, voteOptions: room.players.filter(p => p.connected && p.id !== playerId).map(p => ({ id: p.id, name: p.name })),
    tally: room.phase === 'results' || room.phase === 'finished' ? room.lastTally : null,
    lastRound: room.phase === 'results' || room.phase === 'finished' ? room.lastRound : null,
    awards: room.phase === 'finished' ? awards(room) : null,
    winner: room.phase === 'finished' ? winner(room) : null
  };
}
function broadcast(room) { for (const p of room.players) if (p.connected) io.to(p.socketId).emit('state', publicRoom(room, p.id)); }
function normalize(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); }
function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { let diagonal = prev[0]; prev[0] = i; for (let j = 1; j <= b.length; j++) { const old = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = old; } }
  return prev[b.length];
}
function groupAnswers(players) {
  const groups = [];
  for (const p of players.filter(x => x.answer !== null)) {
    const key = normalize(p.answer);
    let group = groups.find(g => g.keys.some(k => Math.min(key.length, k.length) >= 4 && distance(key, k) <= (Math.min(key.length, k.length) > 7 ? 2 : 1)));
    if (!group) { group = { id: String(groups.length), keys: [], count: 0 }; groups.push(group); }
    group.keys.push(key); group.count++; p.group = group.id;
  }
  return groups;
}
function startRound(room) {
  room.round++;
  if (room.round > 8) { room.phase = 'finished'; room.endsAt = null; broadcast(room); return; }
  room.players.forEach(p => { p.group = null; p.vote = null; });
  room.players.filter(p => p.connected).forEach(p => { p.waiting = false; p.answer = null; });
  room.players.filter(p => !p.connected).forEach(p => { p.waiting = true; p.answer = null; p.vote = null; });
  const pack = banks[room.pack];
  room.usedPrompts ||= [];
  const available = pack.map((q, i) => i).filter(i => !room.usedPrompts.includes(i));
  const promptIndex = available[Math.floor(Math.random() * available.length)];
  room.usedPrompts.push(promptIndex);
  const q = pack[promptIndex];
  room.prompt = q.prompt; room.imposterPrompt = q.imposter;
  const activePlayers = room.players.filter(p => p.connected && !p.waiting);
  room.imposterId = activePlayers.length && room.imposterRounds.includes(room.round) ? activePlayers[Math.floor(Math.random() * activePlayers.length)].id : null;
  room.votes = {}; room.phase = 'answer'; room.lastTally = null; room.lastRound = null;
  room.endsAt = Date.now() + duration.answer * 1000;
  clearTimeout(room.timer); room.timer = setTimeout(() => endAnswers(room), duration.answer * 1000);
  broadcast(room);
}
function endAnswers(room) {
  if (!room || room.phase !== 'answer') return;
  clearTimeout(room.timer); groupAnswers(room.players); room.phase = 'reveal'; room.endsAt = Date.now() + duration.reveal * 1000;
  room.timer = setTimeout(() => startVoting(room), duration.reveal * 1000); broadcast(room);
}
function startVoting(room) {
  if (!room || room.phase !== 'reveal') return;
  room.phase = 'vote'; room.votes = {}; room.endsAt = Date.now() + duration.vote * 1000;
  room.timer = setTimeout(() => finishVote(room), duration.vote * 1000); broadcast(room);
}
function finishVote(room) {
  if (!room || room.phase !== 'vote') return;
  clearTimeout(room.timer);
  const submittedPlayers = room.players.filter(p => p.answer !== null);
  const groups = groupAnswers(submittedPlayers);
  const top = Math.max(0, ...groups.map(g => g.count));
  for (const p of room.players) { const count = groups.find(g => g.id === p.group)?.count || 0; if (count === 1) p.unique = (p.unique || 0) + 1; if (count > 1) p.matches = (p.matches || 0) + count - 1; }
  for (const g of groups.filter(g => g.count === top)) for (const p of submittedPlayers.filter(x => x.group === g.id)) p.score++;
  const voteCounts = {};
  Object.values(room.votes).forEach(id => { voteCounts[id] = (voteCounts[id] || 0) + 1; });
  const maxVote = Math.max(0, ...Object.values(voteCounts));
  const accused = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVote && maxVote > 0);
  const caught = room.imposterId ? accused.includes(room.imposterId) : accused.includes('none');
  let correctVoters = 0;
  for (const [voterId, choice] of Object.entries(room.votes)) {
    if ((room.imposterId && choice === room.imposterId) || (!room.imposterId && choice === 'none')) {
      const voter = room.players.find(p => p.id === voterId); if (voter) { voter.score++; correctVoters++; }
    }
  }
  if (room.imposterId && !caught) { const p = room.players.find(x => x.id === room.imposterId); if (p) p.score += 2; }
  if (room.imposterId && !caught) { const p = room.players.find(x => x.id === room.imposterId); if (p) p.bluff = (p.bluff || 0) + 1; }
  room.lastRound = { imposterId: room.imposterId, imposterName: room.players.find(p => p.id === room.imposterId)?.name || null, prompt: room.prompt, imposterPrompt: room.imposterPrompt, votes: voteCounts, caught, correctVoters, noImposter: !room.imposterId };
  room.lastTally = { answerGroups: groups.map(g => ({ id: g.id, count: g.count, answer: submittedPlayers.find(p => p.group === g.id)?.answer })), topCount: top };
  room.phase = 'results'; room.endsAt = Date.now() + duration.results * 1000;
  room.timer = setTimeout(() => startRound(room), duration.results * 1000); broadcast(room);
}
function winner(room) { const hi = Math.max(...room.players.map(p => p.score)); return room.players.filter(p => p.score === hi).map(p => p.name); }
function awards(room) {
  const stats = room.players.map(p => ({ p, unique: p.unique || 0, matches: p.matches || 0, bluff: p.bluff || 0 }));
  const make = (key) => { const hi = Math.max(0, ...stats.map(s => s[key])); return hi ? stats.filter(s => s[key] === hi).map(s => s.p.name) : []; };
  return { oddOneOut: make('unique'), hiveMind: make('matches'), masterBluffer: make('bluff') };
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, pack }, done = () => {}) => {
    const code = makeCode(), id = socket.id;
    const room = { code, pack: pack === 'desi' ? 'desi' : 'global', hostId: id, players: [{ id, name: String(name || 'Player').slice(0, 18), score: 0, socketId: socket.id, connected: true, waiting: false, answer: null }], round: 0, phase: 'lobby', prompt: '', imposterPrompt: '', imposterId: null, votes: {}, endsAt: null };
    rooms.set(code, room); socket.join(code); done({ ok: true, code, playerId: id }); broadcast(room);
  });
  socket.on('joinRoom', ({ code, name, playerId }, done = () => {}) => {
    const room = roomFor(code); if (!room) return done({ ok: false, error: 'Room not found. Check the code and try again.' });
    let p = room.players.find(x => x.id === playerId);
    if (room.phase === 'finished') return done({ ok: false, error: 'This game has finished. Start a fresh room!' });
    if (p) { p.socketId = socket.id; p.connected = true; p.name = String(name || p.name).slice(0, 18); }
    else {
      if (room.players.length >= 8) return done({ ok: false, error: 'This room is full (8 players max).' });
      const active = room.phase !== 'lobby' && room.phase !== 'finished';
      p = { id: socket.id, name: String(name || 'Player').slice(0, 18), score: 0, socketId: socket.id, connected: true, waiting: active, answer: active ? null : null };
      room.players.push(p);
    }
    socket.join(room.code); done({ ok: true, code: room.code, playerId: p.id }); broadcast(room);
  });
  socket.on('startGame', code => { const r = roomFor(code); if (r && socketPlayer(r, socket.id)?.id === r.hostId && r.phase === 'lobby' && r.players.length >= 3) { r.imposterRounds = Array.from({ length: 8 }, (_, i) => i + 1).sort(() => Math.random() - .5).slice(0, 3); startRound(r); } });
  socket.on('submitAnswer', ({ code, answer }) => { const r = roomFor(code), p = r?.players.find(x => x.socketId === socket.id); if (!r || r.phase !== 'answer' || !p || p.waiting || p.answer !== null) return; p.answer = String(answer || '').trim().slice(0, 72); broadcast(r); if (r.players.filter(x => x.connected && !x.waiting).every(x => x.answer !== null)) endAnswers(r); });
  socket.on('castVote', ({ code, target }) => { const r = roomFor(code), p = r?.players.find(x => x.socketId === socket.id); if (!r || r.phase !== 'vote' || !p || p.waiting || r.votes[p.id]) return; if (target !== 'none' && !r.players.some(x => x.id === target && x.connected)) return; r.votes[p.id] = target; broadcast(r); if (r.players.filter(x => x.connected && !x.waiting).every(x => r.votes[x.id])) finishVote(r); });
  socket.on('nextRound', code => { const r = roomFor(code); if (r && socketPlayer(r, socket.id)?.id === r.hostId && r.phase === 'results') { clearTimeout(r.timer); startRound(r); } });
  socket.on('disconnect', () => {
    for (const r of rooms.values()) {
      const p = r.players.find(x => x.socketId === socket.id); if (!p) continue;
      p.connected = false;
      if (r.hostId === p.id) { const next = r.players.find(x => x.connected); if (next) r.hostId = next.id; }
      broadcast(r);
      setTimeout(() => { if (!p.connected) { r.players = r.players.filter(x => x.id !== p.id); if (!r.players.length) { clearTimeout(r.timer); rooms.delete(r.code); } else broadcast(r); } }, 30000);
    }
  });
});
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Sync or Sink listening on ${port}`));

