// ============================================================
//  Routing — OSRM / GraphHopper (fail-open)
//
//  Kenapa perkhidmatan luar? Routing engine tidak boleh berjalan dalam
//  Worker (tiada akses data OSM, tiada OSRM). Kita delegated ke OSRM
//  awam atau tumpangan sendiri, dengan fail-open yang kemas.
//
//  PENTING: jangan fetch ke perkhidmatan luar dengan
//  `cf: { cacheEverything: true }` — ia menghasilkan 404/salah. Guna
//  fetch(url, { headers: KEPAJA_JSON }) dan cache sendiri.
// ============================================================

import type { Context } from 'hono';
import type { Env } from '../types';
import { AppError } from '../lib/errors';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteResult {
  /** Jarak dalam meter. */
  distanceM: number;
  /** Anggaran masa dalam saat. */
  durationS: number;
  /** Gometri GeoJSON (LineString) untuk melukis pada peta. */
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  /** Sumber sebenar yang menjawab — untuk diagnosis. */
  provider: string;
  /** Cached? */
  cached: boolean;
}

type OsrmResponse = {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry?: { type: 'LineString'; coordinates: [number, number][] };
  }>;
};

const OSRM_DEFAULT = 'https://router.project-osrm.org/route/v1/driving';

/** Nisbah talaian — 8s. Jangan biarkan routing menggantung peta. */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Lakukan laluan antara dua titik (atau lebih).
 *
 * OSRM awam mencukupi untuk MVP. Gagal dengan ralat jelas, BUKAN dengan
 * laluan palsu — pengguna lebih baik tahu berbanding tersesat.
 */
export async function getRoute(
  c: Context<{ Bindings: Env }>,
  points: LatLng[],
): Promise<RouteResult> {
  if (points.length < 2) {
    throw new AppError('Routing memerlukan sekurang-kurangnya 2 titik', 422, 'NEED_2_POINTS');
  }

  const base = c.env.OSRM_BASE_URL ?? OSRM_DEFAULT;

  // OSRM mahukan lng,lat (terbalik daripada kebiasaan)
  const coord = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url =
    `${base}/${coord}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=false` +
    `&annotations=false`;

  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    const json = (await res.json()) as OsrmResponse;

    if (json.code !== 'Ok' || !json.routes?.length) {
      throw new AppError(
        `OSRM gagal: ${json.code ?? 'tiada respons'}`,
        502,
        'ROUTING_UNAVAILABLE',
      );
    }

    const route = json.routes[0];
    return {
      distanceM: Math.round(route.distance),
      durationS: Math.round(route.duration),
      geometry: route.geometry ?? fallbackGeometry(points),
      provider: 'osrm',
      cached: false,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Jangan buang punca sebenar — tanpa ini kegagalan routing tidak
    // boleh dikesanakan. Butiran dalaman TIDAK dihantar kepada klien,
    // ia hanya dicetak ke log peladang.
    const cause = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[routing] gagal memanggil OSRM — ${cause}`);
    throw new AppError(
      'Perkhidmatan routing tidak tersedia buat sementara',
      502,
      'ROUTING_UNAVAILABLE',
    );
  }
}

/** Lukisan garis lurus — dipulangkan hanya jika OSRM tiada geometri. */
function fallbackGeometry(points: LatLng[]): { type: 'LineString'; coordinates: [number, number][] } {
  return { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) };
}

/** fetch dengan had masa — elakkan Worker tergantung selamanya. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      headers: {
        Accept: 'application/json',
        // PENTING: OSRM demo (router.project-osrm.org) dibalukan nginx
        // yang membalas 403 kepada User-Agent kosong/lalai. Tanpa ini
        // setiap panggilan routing gagal dengan 502.
        'User-Agent': 'lalintrafik/1.0 (+https://github.com/)',
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cache routing dalam D1.
 *
 * Routing jarang berubah untuk laluan yang sama, jadi cache 1 jam
 * menjimatkan panggilan OSRM dan mempercepatkan peta.
 */
export async function getRouteCached(
  c: Context<{ Bindings: Env }>,
  points: LatLng[],
): Promise<RouteResult> {
  if (!c.env.DB || points.length > 4) {
    return getRoute(c, points);
  }

  const key = routeCacheKey(points);

  try {
    const cached = await c.env.DB.prepare(
      'SELECT payload FROM route_cache WHERE key = ? AND expires_at > ?',
    )
      .bind(key, Date.now())
      .first<{ payload: string }>();

    if (cached) {
      return { ...(JSON.parse(cached.payload) as RouteResult), cached: true };
    }
  } catch {
    // cache gagal — bukan ralat kritikal
  }

  const result = await getRoute(c, points);
  void saveRouteCache(c, key, result).catch(() => {});
  return result;
}

function routeCacheKey(points: LatLng[]): string {
  const raw = points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
  // hash ringkas — jangan guna crypto.subtle di sini (async)
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (h * 31 + raw.charCodeAt(i)) | 0;
  }
  return `route:${Math.abs(h).toString(36)}`;
}

async function saveRouteCache(
  c: Context<{ Bindings: Env }>,
  key: string,
  result: RouteResult,
): Promise<void> {
  await c.env.DB!.prepare(
    `INSERT INTO route_cache (key, payload, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
  )
    .bind(key, JSON.stringify(result), Date.now() + 3_600_000)
    .run();
}
