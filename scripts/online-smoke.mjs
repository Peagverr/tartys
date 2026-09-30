// Сквозная проверка онлайн-дуэли против локального сервера (npm run dev:worker).
// Запуск: node scripts/online-smoke.mjs [адрес], по умолчанию http://127.0.0.1:8787
const B = process.argv[2] ?? 'http://127.0.0.1:8787';
const WS = B.replace(/^http/, 'ws');
const post = (p, body, token) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = Math.random().toString(36).slice(2, 7);
const u1 = await post('/api/register', { name: 'Test' + rnd + 'a', password: 'pass1' });
const u2 = await post('/api/register', { name: 'Test' + rnd + 'b', password: 'pass2' });
console.log('users', u1.user?.name, u1.user?.rating, u2.user?.name);
const room = await post('/api/rooms', { mode: 'duel', matchSec: 45 }, u1.token);
console.log('room', room.code, room.config.maxPerSide);
function client(name, token, cid) {
  const ws = new WebSocket(`${WS}/ws/${room.code}`);
  const c = { ws, msgs: [], last: {}, snaps: 0 };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', cid, name, role: 'player', token }));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); c.last[m.t] = m; if (m.t === 'snap') c.snaps++; else c.msgs.push(m.t); };
  c.send = (m) => ws.send(JSON.stringify(m));
  return c;
}
const a = client('A', u1.token, 'cid-aaaaaaaa1');
const b = client('B', u2.token, 'cid-bbbbbbbb1');
await sleep(800);
console.log('welcome a', JSON.stringify(a.last.welcome), 'b side', b.last.welcome?.side);
const spy = client('C', null, 'cid-cccccccc1');
await sleep(500);
console.log('third ->', JSON.stringify(spy.last.welcome));
a.send({ t: 'ready', on: true }); b.send({ t: 'ready', on: true });
await sleep(500);
console.log('stage', a.last.lobby.room.stage);
// Ввод во время отсчёта не должен сработать
a.send({ t: 'cmd', kind: 'yank' });
await sleep(3300);
console.log('after countdown rope', a.last.snap.s.rope, 'ph', a.last.snap.s.ph, 'stA', a.last.snap.s.f[0].st);
// Спам 100 рывков — сервер должен отбросить лишнее
for (let i = 0; i < 100; i++) a.send({ t: 'cmd', kind: 'yank' });
await sleep(1500);
console.log('after spam rope', a.last.snap.s.rope, 'stA', a.last.snap.s.f[0].st, 'open?', a.ws.readyState);
// Попытка подделать поля
a.send({ t: 'cmd', kind: 'yank', mult: 99 });
await sleep(800);
console.log('after fake mult rope', a.last.snap.s.rope);
// B отключается — пауза, потом техническое поражение
b.ws.close();
await sleep(1000);
console.log('stage after disconnect', a.last.lobby.room.stage, 'waitMs', a.last.lobby.room.waitMs);
await sleep(15500);
console.log('over', JSON.stringify(a.last.over?.info.result), 'ratings', JSON.stringify(a.last.over?.info.ratings));
const hist = await fetch(B + '/api/history', { headers: { authorization: 'Bearer ' + u1.token } }).then(r => r.json());
console.log('history', hist.items.length, hist.items[0]?.outcome, hist.items[0]?.verified, hist.items[0]?.ratingDelta);
const lb = await fetch(B + '/api/leaderboard').then(r => r.json());
console.log('leaders', JSON.stringify(lb.leaders.slice(0, 2)));
a.ws.close(); spy.ws.close();
process.exit(0);
