import QRCode from 'qrcode';
import './styles.css';
import { Bot, BOT_PROFILES, type Difficulty } from './engine/bot';
import {
  createMatch,
  isFinalStretch,
  isGuarding,
  timeLeftSec,
  type Command,
  type Fighter,
  type FighterStats,
  type GameEvent,
  type MatchState,
  type Side,
} from './engine/match';
import { RULES } from './engine/rules';
import { Sound } from './game/audio';
import { Input } from './game/input';
import { Renderer } from './game/renderer';
import { Runner, type Driver } from './game/runner';
import { Tutorial, TUTORIAL_STEPS } from './game/tutorial';
import { api, ApiError, auth, guestName } from './net/api';
import { RoomClient } from './net/client';
import { FREE_CROWD_PER_SIDE, PRO_CROWD_PER_SIDE, ROOM_CODE_RE, type LobbyInfo, type OverInfo } from './net/protocol';
import { CHALLENGES, evaluate, loadDone, type Challenge } from './store/challenges';
import { addRecord, clearHistory, loadHistory, loadSettings, saveSettings, summarize, type MatchRecord } from './store/storage';
import { accountChip, onUserChange, proBadge, requireAuth } from './ui/account';
import { $, beforeRoute, esc, fmtSec, go, hideScreen, route, screen, showScreen } from './ui/dom';

type Mode =
  | { kind: 'bot'; difficulty: Difficulty }
  | { kind: 'local' }
  | { kind: 'tutorial' }
  | { kind: 'demo' }
  | { kind: 'online'; code: string; crowd: boolean };

/** Откуда берётся матч: локальный движок или сервер комнаты. */
interface Source {
  state: MatchState;
  prevRope: number;
  command(cmd: Command): void;
  advance(dt: number): number;
}

const canvas = $<HTMLCanvasElement>('#scene');
const hud = $('#hud');
const pads = $('.pads', hud);
const tutBox = $('.tut', hud);
const banner = $('.banner', hud);
const cornerQr = $('.corner-qr', hud);
const sideEls = ([0, 1] as const).map((i) => ({
  name: $(`.s${i} .name`, hud),
  state: $(`.s${i} .state`, hud),
  fill: $(`.s${i} .fill`, hud),
  meta: $(`.s${i} .meta`, hud),
}));
const timeEl = $('.clock .time', hud);
const seriesEl = $('.clock .series', hud);
const pauseBtn = $('.pause-btn', hud);

const settings = loadSettings();
const sound = new Sound();
sound.enabled = settings.sound;
const renderer = new Renderer(canvas);

let mode: Mode = { kind: 'demo' };
let source: Source;
let tutorial: Tutorial | null = null;
let room: RoomClient | null = null;
let resultTimer = 0;
let demoTimer = 0;
type View = 'play' | 'menu' | 'screen' | 'result' | 'pause' | 'lobby' | 'wait-result';
let view: View = 'menu';
/** Счёт серии реваншей за текущий визит. */
const series = new Map<string, [number, number]>();
let lastOver: OverInfo | null = null;
let lobbyAt = 0;
let connNote = '';
/** Испытания, выполненные в последнем матче. */
let freshChallenges: Challenge[] = [];

const input = new Input((cmd) => source?.command(cmd));
input.attachKeyboard();
input.attachPad($('.pad0', hud), 0);
input.attachPad($('.pad1', hud), 1);

const isLocalPlay = () => mode.kind === 'bot' || mode.kind === 'local' || mode.kind === 'tutorial';
const sideName = (x: Side) => (x === 0 ? 'синих' : 'красных');

function applyLooks(): void {
  const u = auth.user;
  const pro = !!u?.pro.player;
  renderer.arena = pro && u ? u.arena : 'steppe';
  const skin = pro && u ? u.skin : 'classic';
  const mine: Side = mode.kind === 'online' ? (room?.side ?? 0) : 0;
  renderer.skins = mine === 0 ? [skin, 'classic'] : ['classic', skin];
}
onUserChange(applyLooks);

function seriesKey(m: Mode): string {
  if (m.kind === 'bot') return `bot:${m.difficulty}`;
  if (m.kind === 'online') return `online:${m.code}`;
  return m.kind;
}

function names(): [string, string] {
  switch (mode.kind) {
    case 'bot': {
      const p = BOT_PROFILES[mode.difficulty];
      return ['Ты', `${p.name} · ${p.title}`];
    }
    case 'tutorial':
      return ['Ты', 'Учебный соперник'];
    case 'online': {
      const L = room?.lobby;
      if (!L) return ['Синие', 'Красные'];
      if (L.mode === 'crowd') return L.branding?.teams ?? ['Синие', 'Красные'];
      return ([0, 1] as const).map((side) => {
        const p = L.players.find((x) => x.side === side);
        if (!p) return 'ждём…';
        return p.id === room!.cid ? `${p.name} (ты)` : p.name;
      }) as [string, string];
    }
    default:
      return ['Синие', 'Красные'];
  }
}

function configureHud(): void {
  const online = mode.kind === 'online';
  hud.hidden = mode.kind === 'demo' || (online && view !== 'play');
  const watching = online && room?.role === 'screen';
  hud.classList.toggle('solo', mode.kind !== 'local');
  hud.classList.toggle('watch', watching);
  hud.classList.toggle('red', online && room?.side === 1);
  tutBox.hidden = mode.kind !== 'tutorial';
  pauseBtn.hidden = online;
  const [n0, n1] = names();
  sideEls[0].name.textContent = n0;
  sideEls[1].name.textContent = n1;
  const touch = matchMedia('(pointer: coarse)').matches;
  $('.k0b', hud).textContent = touch ? 'держать' : mode.kind === 'local' ? 'держать S' : 'держать S / Shift';
  $('.k0y', hud).textContent = touch ? 'нажать' : mode.kind === 'local' ? 'W' : 'W / Пробел';
  const sc = series.get(seriesKey(mode));
  seriesEl.textContent = sc && mode.kind !== 'tutorial' ? `серия ${sc[0]} : ${sc[1]}` : '';
  cornerQr.hidden = !(watching && room?.lobby?.mode === 'crowd');
  if (!cornerQr.hidden && room) {
    const url = roomUrl(room.code);
    void qr(url).then((src) => (cornerQr.innerHTML = `<img src="${src}" alt="QR" />Присоединиться`));
  }
  applyLooks();
  layout();
}

// ---------- Локальный матч ----------

function leaveRoom(): void {
  if (room) {
    room.close();
    room = null;
    history.replaceState(null, '', location.pathname);
  }
}

function begin(m: Mode): void {
  clearTimeout(resultTimer);
  clearTimeout(demoTimer);
  if (m.kind !== 'online') leaveRoom();
  mode = m;
  tutorial = null;
  lastOver = null;
  freshChallenges = [];
  const drivers: Driver[] = [];
  let opts = {};
  const seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  switch (m.kind) {
    case 'bot':
      drivers.push(new Bot(1, BOT_PROFILES[m.difficulty], seed));
      opts = { matchSec: settings.matchSec };
      break;
    case 'local':
      opts = { matchSec: settings.matchSec };
      break;
    case 'tutorial':
      tutorial = new Tutorial(renderTutorial);
      drivers.push(tutorial);
      opts = { countdownSec: 0, matchSec: Infinity, winLine: Infinity };
      break;
    case 'demo':
      drivers.push(new Bot(0, BOT_PROFILES.hard, seed), new Bot(1, BOT_PROFILES.medium, seed + 1));
      opts = { countdownSec: 0 };
      break;
    case 'online':
      return;
  }
  source = new Runner(createMatch(opts), drivers, onEvent);
  renderer.reset();
  if (m.kind !== 'demo') {
    view = 'play';
    hideScreen();
    input.start(m.kind === 'local');
  } else input.stop();
  configureHud();
  if (tutorial) renderTutorial();
}

function playSound(e: GameEvent): void {
  switch (e.type) {
    case 'countdown':
      sound.countdown();
      break;
    case 'start':
      sound.start();
      break;
    case 'windup':
      sound.windup();
      break;
    case 'yank':
      if (e.outcome === 'blocked') sound.blocked();
      else if (e.outcome === 'clash') sound.clash();
      else sound.landed(Math.min(1.5, e.distance / RULES.yankDistance));
      break;
    case 'stun':
      sound.stun();
      break;
    case 'exhausted':
      sound.exhausted();
      break;
    case 'nostamina':
      sound.denied();
      break;
    case 'final':
      sound.final();
      break;
    default:
      break;
  }
}

function onEvent(e: GameEvent, s: MatchState): void {
  renderer.onEvent(e, s, performance.now() / 1000);
  tutorial?.onEvent(e, s);
  if (mode.kind === 'demo') {
    if (e.type === 'over') demoTimer = window.setTimeout(() => mode.kind === 'demo' && begin({ kind: 'demo' }), 1800);
    return;
  }
  playSound(e);
  if (e.type === 'over' && mode.kind !== 'online') onLocalOver(s);
}

function onLocalOver(s: MatchState): void {
  const r = s.result!;
  input.stop();
  if (mode.kind === 'bot' || mode.kind === 'local') {
    const record: MatchRecord = {
      at: Date.now(),
      mode: mode.kind,
      difficulty: mode.kind === 'bot' ? mode.difficulty : undefined,
      winner: r.winner,
      reason: r.reason,
      durationSec: r.durationSec,
      stats: [{ ...s.fighters[0].stats }, { ...s.fighters[1].stats }],
    };
    addRecord(record);
    freshChallenges = evaluate(record, loadHistory());
    if (auth.user) {
      const outcome = r.winner === null ? 'draw' : r.winner === 0 ? 'win' : 'loss';
      void api
        .saveMatch({
          mode: mode.kind,
          opponent: mode.kind === 'bot' ? BOT_PROFILES[mode.difficulty].name : 'Вдвоём',
          outcome,
          reason: r.reason,
          duration: r.durationSec,
          stats: s.fighters[0].stats,
        })
        .catch(() => undefined);
    }
    bumpSeries(r.winner);
  }
  if (mode.kind === 'bot' && r.winner === 1) sound.lose();
  else sound.win();
  view = 'wait-result';
  resultTimer = window.setTimeout(() => showResult(s), 1100);
}

function bumpSeries(winner: Side | null): void {
  const key = seriesKey(mode);
  const sc = series.get(key) ?? [0, 0];
  if (winner !== null) sc[winner]++;
  series.set(key, sc);
}

// ---------- Онлайн ----------

const qrCache = new Map<string, Promise<string>>();
function qr(text: string): Promise<string> {
  let p = qrCache.get(text);
  if (!p) {
    p = QRCode.toDataURL(text, { margin: 1, width: 360, color: { dark: '#0e1328', light: '#ffffff' } });
    qrCache.set(text, p);
  }
  return p;
}

const roomUrl = (code: string) => `${location.origin}${location.pathname}?room=${code}`;

function playerName(): string {
  return auth.user?.name ?? guestName.get();
}

function joinRoom(code: string, role: 'player' | 'screen'): void {
  clearTimeout(resultTimer);
  clearTimeout(demoTimer);
  leaveRoom();
  input.stop();
  tutorial = null;
  lastOver = null;
  connNote = '';
  mode = { kind: 'online', code, crowd: false };
  history.replaceState(null, '', `${location.pathname}?room=${code}${role === 'screen' ? '&screen=1' : ''}`);
  renderer.reset();
  room = new RoomClient(code, role, playerName() || 'Игрок', {
    onWelcome: (_role, _side, note) => {
      connNote = note ?? '';
      configureHud();
    },
    onLobby: (L) => onLobby(L),
    onEvent: (e, s) => {
      renderer.onEvent(e, s, performance.now() / 1000);
      playSound(e);
      if (e.type === 'yank' && e.side === room?.side && e.outcome !== 'blocked') navigator.vibrate?.(e.sync ? [30, 30, 60] : 25);
    },
    onOver: (info) => onOnlineOver(info),
    onStatus: (st, msg) => {
      if (st === 'closed' && msg) showRoomError(msg);
    },
  });
  source = room;
  view = 'lobby';
  hud.hidden = true;
  showScreen('<div class="card"><h2>Подключаемся…</h2><p class="hint-line">Комната ' + esc(code) + '</p></div>');
}

function onLobby(L: LobbyInfo): void {
  if (mode.kind !== 'online' || !room) return;
  mode.crowd = L.mode === 'crowd';
  lobbyAt = performance.now();
  if (L.stage === 'match' || L.stage === 'paused') {
    if (view !== 'play') {
      view = 'play';
      hideScreen();
      configureHud();
      if (room.role === 'player') input.start(false);
    } else configureHud();
    return;
  }
  // Лобби.
  if (view === 'result') {
    updateRematchStatus(L);
    return;
  }
  if (view === 'wait-result') return;
  view = 'lobby';
  input.stop();
  hud.hidden = true;
  renderLobby(L);
}

let overNames: [string, string] = ['Синие', 'Красные'];

function onOnlineOver(info: OverInfo): void {
  lastOver = info;
  // Имена запоминаем сейчас: следом придёт лобби, где вышедшего игрока уже нет.
  overNames = names();
  input.stop();
  const mine = room?.side ?? null;
  bumpSeries(info.result.winner);
  if (mine !== null && info.result.winner !== null && info.result.winner !== mine) sound.lose();
  else sound.win();
  view = 'wait-result';
  resultTimer = window.setTimeout(() => showOnlineResult(info), 1100);
}

function showRoomError(msg: string): void {
  leaveRoom();
  input.stop();
  mode = { kind: 'demo' };
  view = 'screen';
  begin({ kind: 'demo' });
  showScreen(`<div class="card"><h2>Комната недоступна</h2><p class="result-sub">${esc(msg)}</p><div class="stack"><button class="btn primary" type="button" data-go="menu">В меню</button></div></div>`);
}

function slotHtml(L: LobbyInfo, side: Side): string {
  const p = L.players.find((x) => x.side === side);
  if (!p) return `<div class="slot s${side}"><b>ждём игрока…</b><span>${side === 0 ? 'синие' : 'красные'}</span></div>`;
  const me = p.id === room?.cid;
  const rating = p.rating !== null ? ` · ${p.rating}` : '';
  const state = !p.connected ? 'отключился' : p.ready ? '<span class="ok">готов ✓</span>' : 'не готов';
  return `<div class="slot s${side}"><b>${esc(p.name)}${me ? ' (ты)' : ''}${p.pro ? proBadge : ''}</b><span>${state}${rating}</span></div>`;
}

function renderLobby(L: LobbyInfo): void {
  const url = roomUrl(L.code);
  const qrImg = '<img class="qr" alt="QR-код комнаты" />';
  const fillQr = () =>
    void qr(url).then((src) => {
      for (const img of screen.querySelectorAll<HTMLImageElement>('img.qr')) img.src = src;
    });
  const me = L.players.find((p) => p.id === room?.cid);
  const shareBox = `<div class="share">${qrImg}<div><div class="label">Код комнаты</div><div class="code">${L.code}</div>
      <div class="linkbox"><input type="text" readonly value="${esc(url)}" aria-label="Ссылка на комнату" /><button class="btn small" type="button" data-go="copy">Копировать</button></div></div></div>`;

  if (L.mode === 'duel') {
    const opp = L.players.find((p) => p.id !== room?.cid);
    let status: string;
    if (!me) status = connNote || 'Ты зритель — матч начнётся, когда оба игрока будут готовы.';
    else if (!opp) status = 'Отправь другу ссылку или покажи QR — он откроет её на своём телефоне или компьютере.';
    else if (me.ready && !opp.ready) status = 'Ждём, когда соперник нажмёт «Готов».';
    else if (!me.ready && opp.ready) status = 'Соперник готов — жми «Готов»!';
    else status = 'Когда оба нажмут «Готов», начнётся отсчёт.';
    showScreen(`<div class="card">
      <h2>Дуэль по ссылке</h2>
      ${shareBox}
      <div class="slots">${slotHtml(L, 0)}<div class="vs">VS</div>${slotHtml(L, 1)}</div>
      <p class="hint-line" style="margin:0 0 14px">${esc(status)}</p>
      <div class="stack">
        ${me ? `<button class="btn primary" type="button" data-go="ready">${me.ready ? 'Не готов' : 'Готов'}</button>` : ''}
        <button class="btn" type="button" data-go="leave">Выйти</button>
      </div>
      <p class="hint-line">Матч ${L.matchSec} с · результат считает сервер · ${auth.user ? 'рейтинг изменится, если у обоих есть аккаунт' : 'войди в аккаунт, чтобы играть на рейтинг'}</p>
    </div>`);
    fillQr();
    return;
  }

  // «Весь зал тянет»
  const teams = L.branding?.teams ?? ['Синие', 'Красные'];
  const count = (side: Side) => L.players.filter((p) => p.side === side && p.connected).length;
  const teamBox = (side: Side) => {
    const list = L.players
      .filter((p) => p.side === side && p.connected)
      .map((p) => `<span class="${p.id === room?.cid ? 'me' : ''}">${esc(p.name)}</span>`)
      .join('');
    return `<div class="team s${side}"><h3><span>${esc(teams[side])}</span><span>${count(side)}/${L.maxPerSide}</span></h3><div class="names">${list || '<span>пока никого</span>'}</div></div>`;
  };
  if (room?.role === 'screen') {
    const canStart = count(0) > 0 && count(1) > 0;
    showScreen(`<div class="crowd">
      <div class="card join">
        <h2>${esc(L.branding?.title || 'Весь зал тянет')}</h2>
        ${qrImg}
        <div class="code" style="margin-top:10px">${L.code}</div>
        <p class="url">${esc(url)}</p>
        <p class="hint-line">Наведи камеру телефона на QR — телефон станет ручкой каната.</p>
      </div>
      <div class="card" style="width:100%">
        <div class="teams">${teamBox(0)}${teamBox(1)}</div>
        <div class="tip"><b>Главное правило:</b> рывок сработает в полную силу, только если <b>70% команды</b> дёрнут в одну и ту же долю секунды — тогда «ДРУЖНО ×1,5». Вразнобой канат почти не двигается. Считайте вслух: «Бір, екі — ТАРТ!»</div>
        <div class="stack">
          <button class="btn primary" type="button" data-go="crowd-start" ${canStart ? '' : 'disabled'}>${canStart ? 'Начать раунд' : 'Нужен хотя бы один игрок в каждой команде'}</button>
          <button class="btn" type="button" data-go="leave">Закрыть комнату</button>
        </div>
        <p class="hint-line">До ${L.maxPerSide} человек на сторону${L.maxPerSide < PRO_CROWD_PER_SIDE ? ` · больше и своё оформление — в Pro организатора` : ''} · раунд ${L.matchSec} с</p>
      </div>
    </div>`);
    fillQr();
    return;
  }
  // Игрок с телефона.
  const mySide = me?.side ?? null;
  showScreen(`<div class="card">
    <h2>${esc(L.branding?.title || 'Весь зал тянет')}</h2>
    ${
      mySide === null
        ? `<p class="tip">${esc(connNote || 'Команды заполнены — ты смотришь как зритель.')}</p>`
        : `<p class="result-title" style="font-size:28px;color:${mySide === 0 ? 'var(--blue)' : 'var(--red)'}">Ты в команде «${esc(teams[mySide])}»</p>
           <p class="result-sub">Смотри на большой экран. Когда начнётся раунд, здесь появятся кнопки УПОР и РЫВОК. Дёргайте всей командой одновременно!</p>`
    }
    <div class="teams" style="margin-bottom:14px">${teamBox(0)}${teamBox(1)}</div>
    <div class="stack">
      ${mySide !== null ? `<button class="btn" type="button" data-go="switch-team">Перейти в «${esc(teams[mySide === 0 ? 1 : 0])}»</button>` : ''}
      <button class="btn" type="button" data-go="leave">Выйти</button>
    </div>
  </div>`);
}

function updateRematchStatus(L: LobbyInfo): void {
  const el = document.getElementById('rematch-status');
  if (!el || L.mode !== 'duel') return;
  const me = L.players.find((p) => p.id === room?.cid);
  const opp = L.players.find((p) => p.id !== room?.cid);
  if (!opp || !opp.connected) el.textContent = 'Соперник вышел из комнаты.';
  else if (me?.ready && opp.ready) el.textContent = 'Начинаем!';
  else if (me?.ready) el.textContent = 'Ждём, когда соперник нажмёт «Реванш».';
  else if (opp.ready) el.textContent = 'Соперник хочет реванш!';
  else el.textContent = '';
  const btn = document.querySelector<HTMLButtonElement>('[data-go="rematch-online"]');
  if (btn) btn.textContent = me?.ready ? 'Отменить реванш' : 'Реванш';
}

function csvOf(info: OverInfo, L: LobbyInfo | null): string {
  const teams = L?.branding?.teams ?? ['Синие', 'Красные'];
  const rows = [['Команда', 'Рывков', 'Прошли', 'Врезались в упор', 'Принято на упор', 'Добиваний', 'Выдохлись', 'Итог']];
  ([0, 1] as const).forEach((side) => {
    const s = info.stats[side];
    const out = info.result.winner === null ? 'ничья' : info.result.winner === side ? 'победа' : 'поражение';
    rows.push([teams[side], s.yanks, s.landed, s.blockedByOpp, s.blocks, s.punishes, s.exhaustions, out].map(String));
  });
  rows.push([`Длительность, с: ${fmtSec(info.result.durationSec)}`, '', '', '', '', '', '', '']);
  return '﻿' + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

function showOnlineResult(info: OverInfo): void {
  view = 'result';
  const L = room?.lobby ?? null;
  const r = info.result;
  const mine = room?.side ?? null;
  const crowd = L?.mode === 'crowd';
  const [n0, n1] = crowd ? (L?.branding?.teams ?? ['Синие', 'Красные']) : overNames;
  let title: string;
  let color: string;
  if (mine !== null && !(crowd && room?.role === 'screen')) {
    title = r.winner === null ? 'НИЧЬЯ' : r.winner === mine ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
    color = r.winner === null ? 'var(--text)' : r.winner === mine ? 'var(--gold)' : '#ff8a8a';
  } else {
    title = r.winner === null ? 'НИЧЬЯ' : `ПОБЕДИЛИ «${esc(r.winner === 0 ? n0 : n1)}»`;
    color = r.winner === null ? 'var(--text)' : r.winner === 0 ? 'var(--blue)' : 'var(--red)';
  }
  const sub =
    r.reason === 'forfeit'
      ? crowd
        ? 'Команда соперника отключилась и не вернулась — техническая победа'
        : 'Соперник отключился и не вернулся — техническая победа'
      : r.reason === 'line'
        ? `Лента перетянута за линию ${sideName(r.winner!)} за ${fmtSec(r.durationSec)} с`
        : r.winner === null
          ? 'Время вышло — лента осталась у центра'
          : `Время вышло — лента на стороне ${sideName(r.winner)}`;
  const [a, b] = info.stats;
  const row = (label: string, x: number, y: number) => `<tr><td>${label}</td><td>${x}</td><td>${y}</td></tr>`;
  const ratings = info.ratings
    .map((c) => {
      const d = c.after - c.before;
      return `${esc(c.name)}: ${c.before} → <b>${c.after}</b> (${d >= 0 ? '+' : ''}${d})`;
    })
    .join('<br>');
  const tip = mine !== null && !crowd ? coachTip(info.stats[mine], info.stats[mine === 0 ? 1 : 0], r.winner === mine) : '';
  const org = !!auth.user?.pro.organizer;
  let actions: string;
  if (crowd && room?.role === 'screen') {
    actions = `<button class="btn primary" type="button" data-go="crowd-start">Ещё раунд</button>
      <button class="btn" type="button" data-go="csv" ${org ? '' : 'disabled'}>Выгрузить результаты (CSV)${org ? '' : ' — Pro организатора'}</button>
      <button class="btn" type="button" data-go="crowd-lobby">Команды и QR</button>`;
  } else if (crowd) {
    actions = `<p class="hint-line">Следующий раунд запустит ведущий на большом экране.</p><button class="btn" type="button" data-go="crowd-lobby">К командам</button>`;
  } else if (mine !== null) {
    actions = `<button class="btn primary" type="button" data-go="rematch-online">Реванш</button><p class="hint-line" id="rematch-status"></p>`;
  } else actions = '<p class="hint-line">Ты зритель — следующий матч начнётся, когда игроки будут готовы.</p>';
  showScreen(
    `<div class="card">
      <p class="result-title" style="color:${color}">${title}</p>
      <p class="result-sub">${sub}</p>
      ${ratings ? `<div class="tip">Рейтинг: ${ratings}</div>` : ''}
      <table>
        <tr><th></th><th>${esc(n0)}</th><th>${esc(n1)}</th></tr>
        ${row('Рывков', a.yanks, b.yanks)}
        ${row('Прошли полностью', a.landed - (a.partial ?? 0), b.landed - (b.partial ?? 0))}
        ${row('Частично погашены упором', a.partial ?? 0, b.partial ?? 0)}
        ${row('Столкновения', a.clashes, b.clashes)}
        ${row('Врезались в упор', a.blockedByOpp, b.blockedByOpp)}
        ${row('Принято на упор', a.blocks, b.blocks)}
        ${row('Добиваний', a.punishes, b.punishes)}
        ${row('Выдохлись', a.exhaustions, b.exhaustions)}
      </table>
      ${tip ? `<div class="tip">${tip}</div>` : ''}
      <div class="stack" style="margin-top:14px">
        ${actions}
        <button class="btn" type="button" data-go="leave">Выйти из комнаты</button>
      </div>
    </div>`,
    true,
  );
  if (L) updateRematchStatus(L);
}

// ---------- HUD ----------

const hudCache: string[] = [];
function setText(el: HTMLElement, key: number, text: string, cls = ''): void {
  const v = text + '|' + cls;
  if (hudCache[key] === v) return;
  hudCache[key] = v;
  el.textContent = text;
  el.className = el.className.split(' ')[0] + (cls ? ' ' + cls : '');
}

function stance(f: Fighter): [string, string] {
  switch (f.action) {
    case 'windup':
      return [f.yankSync ? 'ДРУЖНО!' : 'РЫВОК!', 'hot'];
    case 'recover':
      return isGuarding(f) ? ['УПОР', 'hot'] : ['…', ''];
    case 'stunned':
      return ['ХВАТ СБИТ', 'bad'];
    case 'exhausted':
      return ['ВЫДОХСЯ', 'bad'];
    default:
      return isGuarding(f) ? ['УПОР', 'hot'] : ['ПЕРЕДЫШКА', ''];
  }
}

function updateHud(s: MatchState): void {
  hud.classList.toggle('counting', s.phase === 'countdown');
  for (const side of [0, 1] as const) {
    const f = s.fighters[side];
    const el = sideEls[side];
    el.fill.style.width = `${(f.stamina / RULES.staminaMax) * 100}%`;
    const cls = f.stamina < RULES.yankMinStamina ? 'empty' : f.stamina < RULES.yankCost ? 'low' : '';
    setText(el.fill, 10 + side, '', cls);
    const [text, c] = stance(f);
    setText(el.state, side, text, c);
    let meta = '';
    if (mode.kind === 'online' && room?.snap && room.lobby?.mode === 'crowd') {
      const n = room.snap.n[side];
      const share = room.snap.share[side];
      meta = `👥 ${n}${share > 0 ? ` · вместе ${Math.round(share * 100)}%` : ''}`;
    }
    setText(el.meta, 30 + side, meta, '');
  }
  if (Number.isFinite(s.timeLeftTicks)) {
    const t = s.phase === 'countdown' ? s.opts.matchSec : Math.max(0, Math.ceil(timeLeftSec(s)));
    setText(timeEl, 20, String(t), isFinalStretch(s) && s.phase === 'live' ? 'final' : '');
  } else setText(timeEl, 20, '∞');

  let b = '';
  if (mode.kind === 'online' && room) {
    const L = room.lobby;
    if (L?.stage === 'paused') {
      const left = Math.max(0, Math.ceil((L.waitMs - (performance.now() - lobbyAt)) / 1000));
      const who = L.waitSide === room.side ? 'Твоя команда отключилась' : L.mode === 'duel' ? 'Соперник отключился' : `Команда ${sideName(L.waitSide ?? 0)} отключилась`;
      b = `${who}. Ждём ${left} с — потом техническая победа.`;
    }
  }
  banner.hidden = !b;
  setText(banner, 40, b, '');
}

function layout(): void {
  const inset = hud.hidden || hud.classList.contains('watch') ? 0 : pads.getBoundingClientRect().height;
  renderer.resize(inset);
}
window.addEventListener('resize', layout);

// ---------- Обучение ----------

tutBox.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.skip')) finishTutorial();
});

function renderTutorial(): void {
  if (!tutorial) return;
  if (tutorial.done) {
    finishTutorial();
    return;
  }
  const st = TUTORIAL_STEPS[tutorial.step];
  const dots = '●'.repeat(tutorial.progress) + '○'.repeat(st.goal - tutorial.progress);
  tutBox.innerHTML = `<h3><span>${st.title}</span><span class="dots">${dots}</span></h3><p>${st.text}</p><div class="note">${esc(tutorial.note)}</div><button class="skip" type="button">Пропустить обучение</button>`;
}

function finishTutorial(): void {
  settings.tutorialDone = true;
  saveSettings(settings);
  input.stop();
  tutBox.hidden = true;
  view = 'screen';
  showScreen(
    `<div class="card">
      <h2>Готово — ты знаешь всё</h2>
      <div class="rules">
        <ul>
          <li>Перетяни ленту за свою линию — победа.</li>
          <li>Время вышло — побеждает сторона, на которой лента. У самого центра — ничья.</li>
          <li>Последние 15 секунд рывки на 35% сильнее: отыграться можно до конца.</li>
          <li>Уставший держит канат слабее — не трать силы впустую.</li>
        </ul>
      </div>
      <div class="stack">
        <button class="btn primary" type="button" data-go="bot-easy">Бой с Балой (лёгкий)</button>
        <button class="btn" type="button" data-go="menu">В меню</button>
      </div>
    </div>`,
  );
}

// ---------- Экраны ----------

function showMenu(): void {
  if (mode.kind !== 'demo') begin({ kind: 'demo' });
  view = 'menu';
  const d = settings.difficulty;
  const seg = (['easy', 'medium', 'hard'] as const)
    .map((k) => `<button type="button" data-go="diff" data-diff="${k}" class="${k === d ? 'on' : ''}">${BOT_PROFILES[k].name}<small>${BOT_PROFILES[k].title}</small></button>`)
    .join('');
  const firstTime = !settings.tutorialDone;
  showScreen(`<div class="card">
    ${accountChip()}
    <h1 class="logo">ТАРТЫС</h1>
    <p class="tagline">Перетягивание каната, где побеждает не тот, кто быстрее жмёт, а тот, кто <b>читает соперника</b>.</p>
    <div class="triad">
      <div><b>Рывок</b>сильно тянет, если соперник отдыхает</div>
      <div><b>Упор</b>гасит рывок и сбивает хват</div>
      <div><b>Передышка</b>копит силы, пока упор их жжёт</div>
    </div>
    <div class="stack">
      ${firstTime ? '<button class="btn primary" type="button" data-go="tutorial">Обучение <span class="badge">1 минута</span></button>' : ''}
      <div class="label">Бой с ботом</div>
      <div class="seg">${seg}</div>
      <button class="btn ${firstTime ? '' : 'primary'}" type="button" data-go="bot">В бой</button>
      <div class="label">С друзьями</div>
      <div class="row">
        <button class="btn" type="button" data-go="duel-create">Дуэль по ссылке</button>
        <button class="btn" type="button" data-go="local">На одном экране</button>
      </div>
      <button class="btn" type="button" data-go="crowd-setup">Весь зал тянет <span class="badge">QR · команды</span></button>
      <button class="btn" type="button" data-go="join-code">Войти по коду комнаты</button>
      <div class="row">
        ${firstTime ? '' : '<button class="btn" type="button" data-go="tutorial">Обучение</button>'}
        <button class="btn" type="button" data-go="rules">Правила</button>
        <button class="btn" type="button" data-go="stats">Статистика</button>
      </div>
      <div class="row">
        <button class="btn" type="button" data-go="leaders">Рейтинг</button>
        <button class="btn" type="button" data-go="pro">Pro</button>
      </div>
    </div>
    <div class="foot">
      <button class="linkish" type="button" data-go="sound">Звук: ${settings.sound ? 'вкл' : 'выкл'}</button>
      <button class="linkish" type="button" data-go="len">Длина матча: ${settings.matchSec} с</button>
    </div>
  </div>`);
}

function showRules(): void {
  view = 'screen';
  showScreen(`<div class="card wide rules">
    <h2>Правила</h2>
    <p>Две стороны тянут один канат. Посередине — красная лента. <b>Перетяни ленту за свою линию</b> (синяя слева, красная справа) — и ты победил. Матч длится ${settings.matchSec} секунд: если время вышло, побеждает сторона, на которой лента; если она у самого центра — ничья.</p>
    <div class="rps">
      <div><h4>Рывок</h4><p>Резко дёрнуть канат. Стоит ${RULES.yankCost} сил. Замах длится ${fmtSec(RULES.windupSec)} с — соперник видит его, но глазами успеть почти невозможно.</p><div class="beats">сильнее Передышки</div></div>
      <div><h4>Упор</h4><p>Держать кнопку: пятки в землю. Рывок в упор отдаётся назад, у атакующего сбивается хват. Упор постоянно жжёт силы.</p><div class="beats">сильнее Рывка</div></div>
      <div><h4>Передышка</h4><p>Ничего не жать. Силы восстанавливаются, а соперник в упоре тратит свои. Выдохшегося можно добить.</p><div class="beats">сильнее Упора</div></div>
    </div>
    <ul>
      <li><b>Рванул — упёрся.</b> Сразу после своего рывка можно встать в упор — ответный рывок соперника врежется в стену.</li>
      <li><b>Добивание.</b> Рывок по сопернику со сбитым хватом или выдохшемуся на 30% сильнее.</li>
      <li><b>Столкновение.</b> Два рывка одновременно — перетягивает тот, у кого было больше сил на рывок.</li>
      <li><b>Хват зависит от сил.</b> Уставший держит канат слабее, и его медленно утягивает.</li>
      <li><b>Финал.</b> Последние ${RULES.finalSec} секунд рывки на 35% сильнее — отыграться можно до сирены.</li>
      <li><b>Весь зал тянет.</b> Команда — одна сторона каната. Упор стоит, если держит хотя бы половина команды. Рывок в полную силу — только если 70% команды дёрнули в одно окно 0,15 с («ДРУЖНО ×1,5»); вразнобой — слабо.</li>
      <li><b>Честно.</b> Спам и удержание кнопки рывка не дают лишних рывков. До старта и после финала ввод не принимается. Бот играет по тем же правилам. В онлайне всё считает сервер.</li>
    </ul>
    <table>
      <tr><th></th><th>Один игрок</th><th>Двое: синие</th><th>Двое: красные</th></tr>
      <tr><td>Рывок</td><td><kbd>W</kbd> <kbd>Пробел</kbd> <kbd>↑</kbd></td><td><kbd>W</kbd></td><td><kbd>↑</kbd></td></tr>
      <tr><td>Упор (держать)</td><td><kbd>S</kbd> <kbd>Shift</kbd> <kbd>↓</kbd></td><td><kbd>S</kbd></td><td><kbd>↓</kbd></td></tr>
      <tr><td>Пауза</td><td colspan="3"><kbd>Esc</kbd> (кроме онлайна)</td></tr>
    </table>
    <p class="hint-line">На телефоне — большие кнопки УПОР и РЫВОК внизу экрана.</p>
    <div class="stack" style="margin-top:16px"><button class="btn primary" type="button" data-go="menu">Понятно</button></div>
  </div>`);
}

const MODE_LABEL: Record<string, string> = { bot: 'бот', local: 'один экран', online: 'онлайн', crowd: 'зал' };

function showStats(): void {
  view = 'screen';
  const h = loadHistory();
  const sum = summarize(h);
  const done = loadDone();
  const rows = (['easy', 'medium', 'hard'] as const)
    .map((k) => {
      const d = sum.byDifficulty[k];
      return `<tr><td>${BOT_PROFILES[k].name} · ${BOT_PROFILES[k].title}</td><td class="w">${d.wins}</td><td class="l">${d.losses}</td><td class="d">${d.draws}</td></tr>`;
    })
    .join('');
  const hist = h
    .slice(0, 15)
    .map((r) => {
      const date = new Date(r.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const who = r.mode === 'bot' ? BOT_PROFILES[r.difficulty ?? 'easy'].name : 'Вдвоём';
      let res: string;
      if (r.mode === 'local') res = r.winner === null ? '<span class="d">ничья</span>' : r.winner === 0 ? 'синие' : 'красные';
      else res = r.winner === 0 ? '<span class="w">победа</span>' : r.winner === 1 ? '<span class="l">поражение</span>' : '<span class="d">ничья</span>';
      return `<tr><td>${date}</td><td>${who}</td><td>${res}</td><td>${fmtSec(r.durationSec)} с</td></tr>`;
    })
    .join('');
  showScreen(`<div class="card wide">
    <h2>Статистика</h2>
    <div class="stats-grid">
      <div class="stat"><b>${sum.wins}</b><span>побед над ботом</span></div>
      <div class="stat"><b>${sum.losses}</b><span>поражений</span></div>
      <div class="stat"><b>${sum.bestStreak}</b><span>лучшая серия побед</span></div>
      <div class="stat"><b>${sum.fastestWinSec === null ? '—' : fmtSec(sum.fastestWinSec) + ' с'}</b><span>быстрейшая победа</span></div>
    </div>
    <table><tr><th>Соперник</th><th>Победы</th><th>Поражения</th><th>Ничьи</th></tr>${rows}</table>
    <h2 style="font-size:18px;margin-top:22px">Испытания · ${done.size}/${CHALLENGES.length}</h2>
    <table>${CHALLENGES.map((c) => `<tr><td>${done.has(c.id) ? '🏆' : '○'} <b>${c.title}</b></td><td style="text-align:left">${c.desc}</td></tr>`).join('')}</table>
    <p class="hint-line">Точность рывков: ${sum.yanks ? Math.round((sum.landed / sum.yanks) * 100) : 0}% · рывков соперника принято на упор: ${sum.blocks}</p>
    <h2 style="font-size:18px;margin-top:22px">${auth.user ? 'Аккаунт: матчи со всех устройств' : 'Последние матчи на этом устройстве'}</h2>
    <div id="hist">${
      auth.user
        ? '<p class="hint-line">Загрузка…</p>'
        : hist
          ? `<div class="history"><table>${hist}</table></div>`
          : '<p class="hint-line">Пока пусто — сыграй первый матч.</p>'
    }</div>
    <p class="hint-line">${auth.user ? '✓ — результат посчитан сервером (онлайн).' : 'Войди в аккаунт, чтобы история и рейтинг были доступны с любого устройства.'}</p>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" type="button" data-go="menu">Назад</button>
      ${auth.user ? '' : '<button class="btn" type="button" data-go="account">Войти</button>'}
      ${h.length ? '<button class="btn" type="button" data-go="clear">Очистить локальные</button>' : ''}
    </div>
  </div>`);
  if (auth.user) {
    api
      .history()
      .then((items) => {
        const el = document.getElementById('hist');
        if (!el) return;
        if (!items.length) {
          el.innerHTML = '<p class="hint-line">В аккаунте пока нет матчей.</p>';
          return;
        }
        const out = { win: '<span class="w">победа</span>', loss: '<span class="l">поражение</span>', draw: '<span class="d">ничья</span>' };
        el.innerHTML = `<div class="history"><table>${items
          .map((it) => {
            const date = new Date(it.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const d = it.ratingDelta !== null ? ` (${it.ratingDelta >= 0 ? '+' : ''}${it.ratingDelta})` : '';
            return `<tr><td>${date}</td><td>${MODE_LABEL[it.mode] ?? it.mode} · ${esc(it.opponent)}</td><td>${out[it.outcome]}${d}</td><td>${fmtSec(it.duration)} с ${it.verified ? '✓' : ''}</td></tr>`;
          })
          .join('')}</table></div>`;
      })
      .catch((e: unknown) => {
        const el = document.getElementById('hist');
        if (el) el.innerHTML = `<p class="hint-line">${esc(e instanceof ApiError ? e.message : 'Не удалось загрузить историю')}</p>`;
      });
  }
}

/** Совет после матча: что конкретно улучшить. */
function coachTip(me: FighterStats, opp: FighterStats, won: boolean): string {
  if (me.blockedByOpp >= 3) return `Твои рывки ${me.blockedByOpp} раза врезались в упор. Когда соперник упёрся — <b>отдыхай</b>: упор жжёт его силы, а выдохшегося можно добить.`;
  if (me.exhaustions > 0) return 'Ты выдохся в упоре. Упор нужен в момент рывка соперника, а не всё время — <b>держи его коротко</b>.';
  if (me.blocks === 0 && opp.landed >= 6) return 'Ни одного рывка соперника не принято на упор. Попробуй связку <b>«рванул — упёрся»</b>: зажми упор сразу после своего рывка.';
  if (me.yanks < 8) return 'Ты мало рвал. Пока соперник в передышке, <b>рывок проходит полностью</b> — не упускай моменты.';
  if (me.punishes === 0 && opp.blockedByOpp + opp.exhaustions > 0) return 'Соперник сбивал хват или выдыхался, а ты не добил. <b>Добивание на 30% сильнее</b> — лови эти моменты.';
  if (won) return 'Сильная игра. Попробуй уровень сложнее — <b>Батыр</b> запоминает твой ритм, так что меняй темп.';
  return 'Меняй ритм: сильный соперник подстраивается под паузы перед твоими рывками.';
}

function showResult(s: MatchState): void {
  view = 'result';
  const r = s.result!;
  const [n0, n1] = names();
  let title: string;
  let color: string;
  if (mode.kind === 'bot') {
    title = r.winner === 0 ? 'ПОБЕДА!' : r.winner === 1 ? 'ПОРАЖЕНИЕ' : 'НИЧЬЯ';
    color = r.winner === 0 ? 'var(--gold)' : r.winner === 1 ? '#ff8a8a' : 'var(--text)';
  } else {
    title = r.winner === null ? 'НИЧЬЯ' : r.winner === 0 ? 'СИНИЕ ПОБЕДИЛИ' : 'КРАСНЫЕ ПОБЕДИЛИ';
    color = r.winner === null ? 'var(--text)' : r.winner === 0 ? 'var(--blue)' : 'var(--red)';
  }
  const sub =
    r.reason === 'line'
      ? `Лента перетянута за линию ${sideName(r.winner!)} за ${fmtSec(r.durationSec)} с`
      : r.winner === null
        ? 'Время вышло — лента осталась у центра'
        : `Время вышло — лента на стороне ${sideName(r.winner)}`;
  const [a, b] = [s.fighters[0].stats, s.fighters[1].stats];
  const row = (label: string, x: number, y: number) => `<tr><td>${label}</td><td>${x}</td><td>${y}</td></tr>`;
  const loser: Side = r.winner === 1 ? 0 : 1;
  const tip =
    mode.kind === 'bot'
      ? coachTip(a, b, r.winner === 0)
      : coachTip(s.fighters[loser].stats, s.fighters[r.winner ?? 0].stats, false);
  const sc = series.get(seriesKey(mode));
  showScreen(
    `<div class="card">
      <p class="result-title" style="color:${color}">${title}</p>
      <p class="result-sub">${sub}</p>
      <table>
        <tr><th></th><th>${esc(n0)}</th><th>${esc(n1)}</th></tr>
        ${row('Рывков', a.yanks, b.yanks)}
        ${row('Прошли полностью', a.landed - (a.partial ?? 0), b.landed - (b.partial ?? 0))}
        ${row('Частично погашены упором', a.partial ?? 0, b.partial ?? 0)}
        ${row('Столкновения', a.clashes, b.clashes)}
        ${row('Врезались в упор', a.blockedByOpp, b.blockedByOpp)}
        ${row('Принято на упор', a.blocks, b.blocks)}
        ${row('Добиваний', a.punishes, b.punishes)}
        ${row('Выдохся', a.exhaustions, b.exhaustions)}
      </table>
      ${freshChallenges.map((c) => `<div class="tip">🏆 <b>Испытание выполнено: ${c.title}</b> — ${c.desc}</div>`).join('')}
      <div class="tip">${mode.kind === 'local' && r.winner !== null ? `Совет ${sideName(loser)}: ` : ''}${tip}</div>
      ${sc ? `<p class="hint-line">Серия реваншей: <b>${sc[0]} : ${sc[1]}</b></p>` : ''}
      <div class="stack" style="margin-top:14px">
        <button class="btn primary" type="button" data-go="rematch">Реванш <kbd>Enter</kbd></button>
        <button class="btn" type="button" data-go="menu">Меню <kbd>Esc</kbd></button>
      </div>
    </div>`,
    true,
  );
}

function pause(): void {
  if (view !== 'play' || !isLocalPlay() || source.state.phase === 'over') return;
  input.stop();
  (source as Runner).paused = true;
  view = 'pause';
  showScreen(
    `<div class="card">
      <h2>Пауза</h2>
      <div class="stack">
        <button class="btn primary" type="button" data-go="resume">Продолжить <kbd>Esc</kbd></button>
        <button class="btn" type="button" data-go="restart">Начать заново</button>
        <button class="btn" type="button" data-go="menu">В меню</button>
      </div>
    </div>`,
    true,
  );
}

function resume(): void {
  if (view !== 'pause') return;
  hideScreen();
  view = 'play';
  (source as Runner).paused = false;
  input.start(mode.kind === 'local');
}

// ---------- Онлайн: создание и вход ----------

/** Гостю без имени сначала показываем форму имени. */
function withName(title: string, next: () => void): void {
  if (playerName()) {
    next();
    return;
  }
  view = 'screen';
  pendingNameNext = next;
  showScreen(`<div class="card">
    <h2>${esc(title)}</h2>
    <form class="form">
      <input type="text" name="name" placeholder="Как тебя зовут?" maxlength="20" autocomplete="nickname" required />
      <div class="error"></div>
      <button class="btn primary" type="button" data-go="name-ok" data-submit>Дальше</button>
      <button type="submit" hidden></button>
    </form>
    <p class="hint-line">Или <button class="linkish" type="button" data-go="login-then">войди в аккаунт</button> — тогда матч пойдёт в историю и рейтинг.</p>
    <div class="stack" style="margin-top:10px"><button class="btn" type="button" data-go="menu">Назад</button></div>
  </div>`);
  screen.querySelector<HTMLInputElement>('input[name=name]')?.focus();
}
let pendingNameNext: (() => void) | null = null;

async function createRoom(kind: 'duel' | 'crowd', branding?: { title: string; teams: [string, string] }, matchSec = settings.matchSec): Promise<void> {
  view = 'screen';
  showScreen('<div class="card"><h2>Создаём комнату…</h2></div>');
  try {
    const r = await api.createRoom(kind, matchSec, branding);
    joinRoom(r.code, kind === 'crowd' ? 'screen' : 'player');
  } catch (e) {
    showScreen(`<div class="card"><h2>Онлайн недоступен</h2><p class="result-sub">${esc(e instanceof ApiError ? e.message : 'Не удалось создать комнату')}</p><div class="stack"><button class="btn primary" type="button" data-go="menu">В меню</button></div></div>`);
  }
}

function showCrowdSetup(): void {
  view = 'screen';
  const org = !!auth.user?.pro.organizer;
  const dis = org ? '' : 'disabled';
  showScreen(`<div class="card">
    <h2>Весь зал тянет</h2>
    <p class="result-sub">Этот экран станет большим экраном с канатом — выведи его на проектор. Зрители сканируют QR, выбирают команду, и их телефоны становятся ручками каната. Побеждает команда, которая дёргает <b>дружно</b>.</p>
    <form class="form">
      <div class="label">Оформление ${org ? proBadge : '· Pro организатора 🔒'}</div>
      <input type="text" name="title" placeholder="Название: «День первокурсника Нархоз»" maxlength="40" ${dis} />
      <div class="row">
        <input type="text" name="t0" placeholder="Команда слева" maxlength="24" ${dis} />
        <input type="text" name="t1" placeholder="Команда справа" maxlength="24" ${dis} />
      </div>
      <div class="label">Длина раунда</div>
      <select name="sec">${[45, 60, 90].map((s) => `<option value="${s}" ${s === 60 ? 'selected' : ''}>${s} секунд</option>`).join('')}</select>
      <p class="hint-line" style="margin:0">До ${org ? PRO_CROWD_PER_SIDE : FREE_CROWD_PER_SIDE} человек на сторону${org ? '' : ` (в Pro организатора — ${PRO_CROWD_PER_SIDE}, своё название и выгрузка CSV)`}</p>
      <button class="btn primary" type="button" data-go="crowd-create" data-submit>Открыть большой экран</button>
      <button type="submit" hidden></button>
    </form>
    <div class="row" style="margin-top:10px">
      ${org ? '' : '<button class="btn" type="button" data-go="pro">Pro организатора</button>'}
      <button class="btn" type="button" data-go="menu">Назад</button>
    </div>
  </div>`);
}

function showJoinCode(): void {
  view = 'screen';
  showScreen(`<div class="card">
    <h2>Войти по коду</h2>
    <form class="form">
      <input type="text" name="code" placeholder="Код комнаты, например KCNWL" maxlength="8" autocapitalize="characters" autocomplete="off" required style="text-transform:uppercase;letter-spacing:.1em" />
      ${playerName() ? '' : '<input type="text" name="name" placeholder="Твоё имя" maxlength="20" autocomplete="nickname" required />'}
      <div class="error"></div>
      <button class="btn primary" type="button" data-go="join-ok" data-submit>Войти</button>
      <button type="submit" hidden></button>
    </form>
    <div class="stack" style="margin-top:10px"><button class="btn" type="button" data-go="menu">Назад</button></div>
  </div>`);
  screen.querySelector<HTMLInputElement>('input[name=code]')?.focus();
}

// ---------- Маршруты кнопок ----------

beforeRoute(() => {
  sound.unlock();
  sound.click();
});

route('diff', (el) => {
  settings.difficulty = el.dataset.diff as Difficulty;
  saveSettings(settings);
  showMenu();
});
route('bot', () => begin({ kind: 'bot', difficulty: settings.difficulty }));
route('bot-easy', () => {
  settings.difficulty = 'easy';
  saveSettings(settings);
  begin({ kind: 'bot', difficulty: 'easy' });
});
route('local', () => begin({ kind: 'local' }));
route('tutorial', () => begin({ kind: 'tutorial' }));
route('rules', () => showRules());
route('stats', () => showStats());
route('menu', () => {
  leaveRoom();
  showMenu();
});
route('rematch', () => begin(mode));
route('restart', () => begin(mode));
route('resume', () => resume());
route('clear', () => {
  clearHistory();
  showStats();
});
route('sound', () => {
  settings.sound = !settings.sound;
  sound.enabled = settings.sound;
  saveSettings(settings);
  showMenu();
});
route('len', () => {
  const opts = [45, 60, 90];
  settings.matchSec = opts[(opts.indexOf(settings.matchSec) + 1) % opts.length];
  saveSettings(settings);
  showMenu();
});

route('duel-create', () => withName('Дуэль по ссылке', () => void createRoom('duel')));
route('crowd-setup', () => showCrowdSetup());
route('crowd-create', (el) => {
  const form = el.closest('form')!;
  const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | null)?.value.trim() ?? '';
  const sec = Number(val('sec')) || 60;
  const branding = auth.user?.pro.organizer ? { title: val('title'), teams: [val('t0') || 'Синие', val('t1') || 'Красные'] as [string, string] } : undefined;
  void createRoom('crowd', branding, sec);
});
route('join-code', () => showJoinCode());
route('join-ok', (el) => {
  const form = el.closest('form')!;
  const code = (form.elements.namedItem('code') as HTMLInputElement).value.trim().toUpperCase();
  const nameEl = form.elements.namedItem('name') as HTMLInputElement | null;
  const err = form.querySelector<HTMLElement>('.error')!;
  if (!ROOM_CODE_RE.test(code)) {
    err.textContent = 'Код — 4–8 латинских букв и цифр';
    return;
  }
  if (nameEl) {
    const n = nameEl.value.trim();
    if (n.length < 2) {
      err.textContent = 'Имя — хотя бы 2 символа';
      return;
    }
    guestName.set(n.slice(0, 20));
  }
  joinRoom(code, 'player');
});
route('name-ok', (el) => {
  const form = el.closest('form')!;
  const n = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
  if (n.length < 2) {
    form.querySelector<HTMLElement>('.error')!.textContent = 'Имя — хотя бы 2 символа';
    return;
  }
  guestName.set(n.slice(0, 20));
  const next = pendingNameNext;
  pendingNameNext = null;
  next?.();
});
route('login-then', () => {
  const next = pendingNameNext;
  pendingNameNext = null;
  requireAuth('Войди — и сразу продолжим.', () => next?.());
});
route('copy', (el) => {
  const inp = el.parentElement?.querySelector('input');
  if (!inp) return;
  void navigator.clipboard?.writeText(inp.value).then(
    () => (el.textContent = 'Скопировано ✓'),
    () => inp.select(),
  );
});
route('ready', () => {
  const me = room?.lobby?.players.find((p) => p.id === room?.cid);
  room?.ready(!me?.ready);
});
route('rematch-online', () => {
  const me = room?.lobby?.players.find((p) => p.id === room?.cid);
  room?.ready(!me?.ready);
});
route('switch-team', () => {
  const me = room?.lobby?.players.find((p) => p.id === room?.cid);
  if (me) room?.chooseSide(me.side === 0 ? 1 : 0);
});
route('crowd-start', () => room?.start());
route('crowd-lobby', () => {
  view = 'lobby';
  if (room?.lobby) renderLobby(room.lobby);
});
route('csv', () => {
  if (!lastOver) return;
  const blob = new Blob([csvOf(lastOver, room?.lobby ?? null)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tartys-${room?.code ?? 'room'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
route('leave', () => {
  leaveRoom();
  showMenu();
});

pauseBtn.addEventListener('click', () => pause());
pads.addEventListener('pointerdown', () => sound.unlock());

window.addEventListener('keydown', (e) => {
  sound.unlock();
  if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea')) return;
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (view === 'play' && isLocalPlay()) pause();
    else if (view === 'pause') resume();
    else if (e.code === 'Escape' && (view === 'screen' || (view === 'result' && mode.kind !== 'online'))) {
      leaveRoom();
      showMenu();
    }
    return;
  }
  if (view === 'result' && (e.code === 'Enter' || e.code === 'KeyR')) {
    if (mode.kind === 'online') go('rematch-online');
    else begin(mode);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && view === 'play' && (mode.kind === 'bot' || mode.kind === 'local')) pause();
});

// ---------- Цикл ----------

let last = performance.now();
function frame(t: number): void {
  const dt = (t - last) / 1000;
  last = t;
  const alpha = source.advance(dt);
  renderer.draw({ state: source.state, prevRope: source.prevRope, alpha, warn: tutorial?.warn ?? null }, t / 1000);
  if (!hud.hidden) updateHud(source.state);
  requestAnimationFrame(frame);
}

begin({ kind: 'demo' });
const params = new URLSearchParams(location.search);
const linkCode = params.get('room')?.toUpperCase() ?? '';
if (ROOM_CODE_RE.test(linkCode)) {
  if (params.get('screen') === '1') joinRoom(linkCode, 'screen');
  else withName('Тебя позвали в Тартыс', () => joinRoom(linkCode, 'player'));
} else showMenu();
// Для отладки в dev-сборке: источник матча доступен из консоли.
if (import.meta.env.DEV) Object.defineProperty(window, '__tartys', { get: () => source });
requestAnimationFrame(frame);
