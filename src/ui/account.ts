// Аккаунт, рейтинг и Тартыс Pro (тестовая оплата).

import { ARENA_LOOKS, SKIN_LOOKS } from '../game/renderer';
import { api, ApiError, auth } from '../net/api';
import { ARENAS, FREE_ARENAS, FREE_CROWD_PER_SIDE, FREE_SKINS, PLANS, PRO_CROWD_PER_SIDE, SKINS, type Plan } from '../net/protocol';
import { esc, go, route, showScreen } from './dom';

const SKIN_NAMES: Record<string, string> = { classic: 'Классический', gold: 'Золотой', night: 'Ночной', steppe: 'Степной' };
const ARENA_NAMES: Record<string, string> = { steppe: 'Степь на закате', winter: 'Зимний Алатау', city: 'Астана' };

let userListener: () => void = () => undefined;
/** Вызывается, когда вход, выход или косметика поменялись. */
export function onUserChange(fn: () => void): void {
  userListener = fn;
}

let authNote = '';
let authTab: 'login' | 'register' = 'login';
let afterAuth: (() => void) | null = null;

export const proBadge = '<span class="pro-badge">PRO</span>';

export function accountChip(): string {
  const u = auth.user;
  if (!u) return '<button class="account-chip" type="button" data-go="account">Войти</button>';
  return `<button class="account-chip" type="button" data-go="account">${esc(u.name)} · ${u.rating}${u.pro.player || u.pro.organizer ? proBadge : ''}</button>`;
}

/** Показать вход; после успешного входа выполнить next. */
export function requireAuth(note: string, next: () => void): void {
  authNote = note;
  afterAuth = next;
  showAccount();
}

export function showAccount(): void {
  const u = auth.user;
  if (!u) {
    showScreen(`<div class="card">
      <h2>${authTab === 'login' ? 'Вход' : 'Регистрация'}</h2>
      ${authNote ? `<p class="tip">${esc(authNote)}</p>` : '<p class="result-sub">Аккаунт хранит историю матчей и рейтинг — войди с любого устройства и продолжай.</p>'}
      <div class="tabs">
        <button type="button" data-go="tab-login" class="${authTab === 'login' ? 'on' : ''}">Вход</button>
        <button type="button" data-go="tab-register" class="${authTab === 'register' ? 'on' : ''}">Регистрация</button>
      </div>
      <form class="form" autocomplete="on">
        <input type="text" name="name" placeholder="Имя (2–20 символов)" maxlength="20" autocomplete="username" required />
        <input type="password" name="password" placeholder="Пароль (от 4 символов)" maxlength="100" autocomplete="${authTab === 'login' ? 'current-password' : 'new-password'}" required />
        <div class="error"></div>
        <button class="btn primary" type="button" data-go="do-auth" data-submit>${authTab === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
        <button type="submit" hidden></button>
      </form>
      <div class="stack" style="margin-top:10px"><button class="btn" type="button" data-go="menu">Назад</button></div>
    </div>`);
    return;
  }
  const looks = (list: readonly string[], free: string[], current: string, kind: 'skin' | 'arena') =>
    list
      .map((k) => {
        const locked = !u.pro.player && !free.includes(k);
        const swatch =
          kind === 'skin'
            ? `background:linear-gradient(180deg, ${SKIN_LOOKS[k][0]} 60%, ${SKIN_LOOKS[k][1]} 60%)`
            : `background:linear-gradient(180deg, ${ARENA_LOOKS[k].sky[1]}, ${ARENA_LOOKS[k].sky[3]} 70%, ${ARENA_LOOKS[k].ground[0]} 70%)`;
        const name = kind === 'skin' ? SKIN_NAMES[k] : ARENA_NAMES[k];
        return `<button type="button" class="look ${k === current ? 'on' : ''} ${locked ? 'locked' : ''}" data-go="${kind}" data-v="${k}"><i style="${swatch}"></i>${name}${locked ? ' 🔒' : ''}</button>`;
      })
      .join('');
  showScreen(`<div class="card">
    <h2>${esc(u.name)} ${u.pro.player || u.pro.organizer ? proBadge : ''}</h2>
    <div class="stats-grid" id="me-stats">
      <div class="stat"><b>${u.rating}</b><span>рейтинг онлайн</span></div>
      <div class="stat"><b id="me-w">…</b><span>побед онлайн</span></div>
      <div class="stat"><b id="me-l">…</b><span>поражений</span></div>
      <div class="stat"><b>${u.pro.organizer ? 'да' : 'нет'}</b><span>Pro организатора</span></div>
    </div>
    <div class="label">Калпак</div>
    <div class="looks">${looks(SKINS, FREE_SKINS, u.skin, 'skin')}</div>
    <div class="label" style="margin-top:12px">Арена</div>
    <div class="looks">${looks(ARENAS, FREE_ARENAS, u.arena, 'arena')}</div>
    ${u.pro.player ? '' : '<p class="hint-line">Арены и калпаки — только внешний вид, на силу в матче не влияют. Открываются в <b>Тартыс Pro</b>.</p>'}
    <div class="error" style="margin-top:8px"></div>
    <div class="row" style="margin-top:8px">
      <button class="btn" type="button" data-go="stats">История</button>
      <button class="btn" type="button" data-go="leaders">Рейтинг</button>
      <button class="btn" type="button" data-go="pro">Pro</button>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" type="button" data-go="menu">В меню</button>
      <button class="btn" type="button" data-go="logout">Выйти</button>
    </div>
  </div>`);
  api
    .me()
    .then((r) => {
      const w = document.getElementById('me-w');
      const l = document.getElementById('me-l');
      if (w) w.textContent = String(r.wins);
      if (l) l.textContent = String(r.losses);
    })
    .catch(() => undefined);
}

route('account', () => {
  authNote = '';
  afterAuth = null;
  showAccount();
});
route('tab-login', () => {
  authTab = 'login';
  showAccount();
});
route('tab-register', () => {
  authTab = 'register';
  showAccount();
});

route('do-auth', async (el) => {
  const form = el.closest('form')!;
  const name = (form.elements.namedItem('name') as HTMLInputElement).value;
  const password = (form.elements.namedItem('password') as HTMLInputElement).value;
  const err = form.querySelector<HTMLElement>('.error')!;
  (el as HTMLButtonElement).disabled = true;
  err.textContent = '';
  try {
    if (authTab === 'login') await api.login(name, password);
    else await api.register(name, password);
    userListener();
    const next = afterAuth;
    afterAuth = null;
    authNote = '';
    if (next) next();
    else showAccount();
  } catch (e) {
    err.textContent = e instanceof ApiError ? e.message : 'Не получилось';
    (el as HTMLButtonElement).disabled = false;
  }
});

route('logout', async () => {
  await api.logout();
  userListener();
  go('menu');
});

async function setLook(kind: 'skin' | 'arena', value: string, el: HTMLElement): Promise<void> {
  const u = auth.user;
  if (!u) return;
  const free = kind === 'skin' ? FREE_SKINS : FREE_ARENAS;
  if (!u.pro.player && !free.includes(value)) {
    showPro();
    return;
  }
  try {
    await api.profile(kind === 'skin' ? value : u.skin, kind === 'arena' ? value : u.arena);
    userListener();
    showAccount();
  } catch (e) {
    const err = el.closest('.card')?.querySelector<HTMLElement>('.error');
    if (err) err.textContent = e instanceof ApiError ? e.message : 'Не получилось';
  }
}
route('skin', (el) => void setLook('skin', el.dataset.v!, el));
route('arena', (el) => void setLook('arena', el.dataset.v!, el));

// ---------- Рейтинг ----------

export async function showLeaders(): Promise<void> {
  showScreen(`<div class="card"><h2>Рейтинг онлайн-дуэлей</h2><p class="hint-line">Загрузка…</p></div>`);
  let rows = '';
  try {
    const leaders = await api.leaderboard();
    rows = leaders
      .map(
        (l, i) =>
          `<tr><td>${i + 1}. ${esc(l.name)}${l.pro ? proBadge : ''}</td><td><b>${l.rating}</b></td><td class="w">${l.wins}</td><td class="l">${l.losses}</td></tr>`,
      )
      .join('');
  } catch (e) {
    rows = `<tr><td colspan="4">${esc(e instanceof ApiError ? e.message : 'Ошибка')}</td></tr>`;
  }
  showScreen(`<div class="card">
    <h2>Рейтинг онлайн-дуэлей</h2>
    <p class="result-sub">Рейтинг Эло: растёт за победы в онлайн-дуэлях между игроками с аккаунтом. Считает сервер — подделать нельзя.</p>
    <table><tr><th>Игрок</th><th>Рейтинг</th><th>Победы</th><th>Поражения</th></tr>${rows || '<tr><td colspan="4">Пока никто не сыграл онлайн-дуэль с аккаунтом.</td></tr>'}</table>
    <div class="stack" style="margin-top:16px"><button class="btn primary" type="button" data-go="menu">В меню</button></div>
  </div>`);
}
route('leaders', () => void showLeaders());

// ---------- Pro ----------

const fmtPrice = (n: number) => n.toLocaleString('ru-RU') + ' ₸';

export function showPro(): void {
  const u = auth.user;
  const active = (p: Plan) => (p === 'player' ? !!u?.pro.player : !!u?.pro.organizer);
  const btn = (p: Plan) =>
    active(p)
      ? '<button class="btn" type="button" disabled>Активно ✓</button>'
      : `<button class="btn primary" type="button" data-go="buy" data-plan="${p}">Оформить</button>`;
  showScreen(`<div class="card wide">
    <h2>Тартыс Pro</h2>
    <p class="result-sub">Платно — только оформление и инструменты для мероприятий. Сила рывка, выносливость и шансы на победу у всех одинаковые.</p>
    <div class="plans">
      <div class="plan">
        <h3>${PLANS.player.title}</h3>
        <div class="price">${fmtPrice(PLANS.player.price)} <small>${PLANS.player.period}</small></div>
        <ul>
          <li>Арены «Зимний Алатау» и «Астана»</li>
          <li>Калпаки: золотой, ночной, степной</li>
          <li>Значок PRO в рейтинге и лобби</li>
          <li><b>Никакого преимущества в матче</b></li>
        </ul>
        ${btn('player')}
      </div>
      <div class="plan">
        <h3>${PLANS.organizer.title}</h3>
        <div class="price">${fmtPrice(PLANS.organizer.price)} <small>${PLANS.organizer.period}</small></div>
        <ul>
          <li>«Весь зал тянет» до ${PRO_CROWD_PER_SIDE} человек на сторону (бесплатно — ${FREE_CROWD_PER_SIDE})</li>
          <li>Своё название мероприятия и команд на большом экране: «Экономфак против IT»</li>
          <li>Выгрузка результатов раундов в CSV</li>
          <li>Для кураторских часов, дней первокурсника, тимбилдингов</li>
        </ul>
        ${btn('organizer')}
      </div>
    </div>
    <div class="testmode">Тестовый режим: оплата имитируется, реальные деньги не списываются и данные карты не нужны. Функции включаются сразу — можно проверить, что получает покупатель.</div>
    <div class="stack" style="margin-top:14px"><button class="btn" type="button" data-go="menu">В меню</button></div>
  </div>`);
}
route('pro', () => showPro());

function showCheckout(plan: Plan): void {
  const p = PLANS[plan];
  showScreen(`<div class="card">
    <h2>Оформление</h2>
    <table>
      <tr><td>План</td><td style="text-align:right"><b>${p.title}</b></td></tr>
      <tr><td>Период</td><td style="text-align:right">${p.period}</td></tr>
      <tr><td>К оплате</td><td style="text-align:right"><b>${fmtPrice(p.price)}</b></td></tr>
      <tr><td>Аккаунт</td><td style="text-align:right">${esc(auth.user?.name ?? '')}</td></tr>
    </table>
    <div class="testmode" style="margin-top:14px">ТЕСТОВЫЙ РЕЖИМ. Это демонстрация оплаты: деньги не списываются, карта не нужна.</div>
    <div class="error" style="margin-top:8px"></div>
    <div class="stack" style="margin-top:8px">
      <button class="btn primary" type="button" data-go="pay" data-plan="${plan}">Оплатить ${fmtPrice(p.price)} (тест)</button>
      <button class="btn" type="button" data-go="pro">Отмена</button>
    </div>
  </div>`);
}

route('buy', (el) => {
  const plan = el.dataset.plan as Plan;
  if (!auth.user) requireAuth('Чтобы оформить Pro, войди или зарегистрируйся — покупка привязывается к аккаунту.', () => showCheckout(plan));
  else showCheckout(plan);
});

route('pay', async (el) => {
  const plan = el.dataset.plan as Plan;
  (el as HTMLButtonElement).disabled = true;
  try {
    const r = await api.checkout(plan);
    userListener();
    const unlocked =
      plan === 'player'
        ? '<li>Арены «Зимний Алатау» и «Астана»</li><li>Калпаки: золотой, ночной, степной</li><li>Значок PRO</li>'
        : `<li>Комнаты «Весь зал тянет» до ${PRO_CROWD_PER_SIDE} человек на сторону</li><li>Своё название мероприятия и команд</li><li>Выгрузка результатов в CSV</li>`;
    showScreen(`<div class="card">
      <h2>Оплачено ✓</h2>
      <p class="result-sub">${PLANS[plan].title} — ${fmtPrice(r.receipt.amount)}, тестовый режим (деньги не списаны).</p>
      <div class="tip"><b>Что открылось:</b><ul style="margin:6px 0 0;padding-left:18px">${unlocked}</ul></div>
      <div class="stack">
        ${
          plan === 'player'
            ? '<button class="btn primary" type="button" data-go="account">Выбрать арену и калпак</button>'
            : '<button class="btn primary" type="button" data-go="crowd-setup">Создать мероприятие</button>'
        }
        <button class="btn" type="button" data-go="menu">В меню</button>
      </div>
    </div>`);
  } catch (e) {
    const err = el.closest('.card')?.querySelector<HTMLElement>('.error');
    if (err) err.textContent = e instanceof ApiError ? e.message : 'Не получилось';
    (el as HTMLButtonElement).disabled = false;
  }
});
