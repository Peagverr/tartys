// Точка входа Cloudflare Worker: API, WebSocket-комнаты и статика игры.

import { ROOM_CODE_RE } from '../src/net/protocol';
import { handleApi } from './api';
import type { Env } from './db';

export { Room } from './room';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env, url.pathname);
      } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ error: 'Ошибка сервера' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!ROOM_CODE_RE.test(code)) return new Response('Неверный код комнаты', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Ожидается WebSocket', { status: 426 });
      // Наружу у комнаты открыт только WebSocket — служебный /init доступен лишь из API.
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request('https://room/ws', { headers: req.headers }));
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
