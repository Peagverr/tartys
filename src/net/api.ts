// HTTP API и сохранённый вход.

import type { HistoryItem, LeaderRow, Plan, PublicUser, RoomConfig, RoomMode, Branding } from './protocol';

const TOKEN_KEY = 'tartys.token.v1';
const USER_KEY = 'tartys.user.v1';
const NAME_KEY = 'tartys.name.v1';

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно */
  }
}

export const auth = {
  token: load(TOKEN_KEY),
  user: ((): PublicUser | null => {
    try {
      return JSON.parse(load(USER_KEY) ?? 'null') as PublicUser | null;
    } catch {
      return null;
    }
  })(),
  set(token: string | null, user: PublicUser | null): void {
    this.token = token;
    this.user = user;
    store(TOKEN_KEY, token);
    store(USER_KEY, user ? JSON.stringify(user) : null);
  },
};

/** Имя гостя для онлайн-комнат. */
export const guestName = {
  get: () => load(NAME_KEY) ?? '',
  set: (n: string) => store(NAME_KEY, n),
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Нет связи с сервером', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && auth.token && path !== '/api/login') auth.set(null, null);
    throw new ApiError(data.error ?? `Ошибка ${res.status}`, res.status);
  }
  return data as T;
}

export const api = {
  async register(name: string, password: string) {
    const r = await call<{ token: string; user: PublicUser }>('/api/register', 'POST', { name, password });
    auth.set(r.token, r.user);
    return r.user;
  },
  async login(name: string, password: string) {
    const r = await call<{ token: string; user: PublicUser }>('/api/login', 'POST', { name, password });
    auth.set(r.token, r.user);
    return r.user;
  },
  async logout() {
    await call('/api/logout', 'POST', {}).catch(() => undefined);
    auth.set(null, null);
  },
  async me() {
    const r = await call<{ user: PublicUser; wins: number; losses: number }>('/api/me');
    auth.set(auth.token, r.user);
    return r;
  },
  history: () => call<{ items: HistoryItem[] }>('/api/history').then((r) => r.items),
  saveMatch: (m: { mode: 'bot' | 'local'; opponent: string; outcome: string; reason: string; duration: number; stats: unknown }) =>
    call('/api/history', 'POST', m),
  leaderboard: () => call<{ leaders: LeaderRow[] }>('/api/leaderboard').then((r) => r.leaders),
  async profile(skin: string, arena: string) {
    const r = await call<{ user: PublicUser }>('/api/profile', 'POST', { skin, arena });
    auth.set(auth.token, r.user);
    return r.user;
  },
  async checkout(plan: Plan) {
    const r = await call<{ user: PublicUser; receipt: { plan: Plan; amount: number; test: boolean; at: number } }>(
      '/api/checkout/test',
      'POST',
      { plan },
    );
    auth.set(auth.token, r.user);
    return r;
  },
  createRoom: (mode: RoomMode, matchSec: number, branding?: Branding) =>
    call<{ code: string; config: RoomConfig }>('/api/rooms', 'POST', { mode, matchSec, branding }),
};
