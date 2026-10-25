// ============================================================
//  MYKIRA MAP — titik masuk Worker
//  Cloudflare Workers + Hono + D1 + Durable Objects
// ============================================================

import { Hono } from 'hono';
import type { Env } from './types';
import { cors, errorHandler, timing } from './middleware/cors';
import { reports } from './routes/reports';
import { hotspots } from './routes/hotspots';
import { getRouteCached, USER_AGENT } from './routes/routing';
import { requireLat, requireLng } from './lib/errors';
import { MAP_CENTER, MAP_RADIUS_M } from './lib/geofence';

type AppEnv = {
  Bindings: Env;
};

const app = new Hono<AppEnv>();

// ---------- middleware global ----------
// NOTA: ralat ditangkap oleh `app.onError`, BUKAN middleware `try/catch`.
// Hono 4 menangkap pengecualian di peringkat dispatch route dan
// menyerahkannya terus ke onError — middleware luaran tidak pernah
// melihat penolakan `next()`.
app.onError(errorHandler());
app.use('*', cors());
app.use('*', timing());

// ---------- siaran kesihatan ----------
app.get('/', (c) => {
  return c.json({
    name: 'Mykira Map',
    version: '1.0.0',
    status: 'ok',
    description: 'Peta trafik komuniti — koridor Kota Kinabalu → Putatan → Papar → Kimanis → Membakut',
    userAgent: USER_AGENT,
    realtime: 'websocket → Durable Object (GridDO)',
    zone: {
      center: MAP_CENTER,
      radiusM: MAP_RADIUS_M,
    },
  });
});

app.get('/healthz', (c) => c.json({ status: 'ok', ts: Date.now() }));

// ---------- API bersarang ----------
app.route('/api/v1/reports', reports);
app.route('/api/v1/hotspots', hotspots);

// ---------- routing (OSRM) ----------
app.get('/api/v1/routing', async (c) => {
  const q = c.req.query();
  const lat1 = requireLat(q.lat1);
  const lng1 = requireLng(q.lng1);
  const lat2 = requireLat(q.lat2);
  const lng2 = requireLng(q.lng2);

  const result = await getRouteCached(c, [
    { lat: lat1, lng: lng1 },
    { lat: lat2, lng: lng2 },
  ]);

  return c.json({ success: true, data: result });
});

// ---------- WebSocket: naik taraf ke Durable Object ----------
app.get('/api/v1/ws', async (c) => {
  // Klien menetapkan sel melalui query (?cell=abcd1234) — sel ini
  // menentukan DO mana yang menerima sambungan.
  const cell = c.req.query('cell') ?? '';
  if (!cell || !/^[0-9a-z]{6}$/.test(cell)) {
    return c.json(
      { success: false, error: "Query 'cell' diperlukan (geohash 6 aksara)" },
      422,
    );
  }

  const id = c.env.GRID.idFromName(cell);
  const stub = c.env.GRID.get(id);

  // Guna semula sambungan klien — DO menguruskan upgrade sebenar.
  // Ini mengekalkan Workers sebagai lapisan penghalaan tulen.
  return stub.fetch(c.req.raw);
});

// ---------- 404 & 405 ----------
app.notFound((c) => c.json({ success: false, error: 'Laluan tidak dijumpai' }, 404));

// ---------- Pembersihan berkala ----------
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(
    (async () => {
      const { expireStaleReports, pruneSessions } = await import('./db/reports');
      const expired = await expireStaleReports(env.DB);
      const pruned = await pruneSessions(env.DB);
      void event;
      if (expired || pruned) {
        console.log(`[cron] expired=${expired} prunedSessions=${pruned}`);
      }
    })(),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  scheduled,
};

// ---------- Jenis untuk Durable Object ----------
export { GridDO } from './do/GridDO';
