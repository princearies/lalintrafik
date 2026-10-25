// ============================================================
//  MYKIRA MAP — Routing OSRM + Smart Cache D1
//
//  Kenapa perkhidmatan luar? Routing engine tidak boleh berjalan dalam
//  Worker (tiada akses data OSM, tiada OSRM). Kita delegated ke OSRM
//  awam atau tumpangan sendiri, dengan fail-open yang kemas.
//
//  Aliran:
//    1. Bundarkan koordinat kepada 3 tempat perpuluhan (~110 m).
//    2. Semak D1 — hit dijawab terus (< 10 ms, tiada panggilan keluar).
//    3. Miss → panggil OSRM → simpan ke D1 → balas.
//
//  PENTING: jangan fetch ke perkhidmatan luar dengan
//  `cf: { cacheEverything: true }` — ia menghasilkan 404/salah. Guna
//  fetch(url, { headers }) biasa dan cache sendiri dalam D1.
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

/**
 * Identiti projek — dihantar sebagai `User-Agent` untuk setiap panggilan
 * keluar supaya Cloudflare dan OSRM boleh mengenal pasti Mykira Map.
 *
 * PENTING: OSRM demo (router.project-osrm.org) dibalukan nginx yang
 * membalas **403** kepada User-Agent kosong. Tanpa ini setiap panggilan
 * routing gagal.
 */
export const USER_AGENT = 'MykiraMap-Worker-Putatan/1.0 (+https://mykira.workers.dev)';

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
 * Tempat perpuluhan kunci cache — 3 dp ≈ 110 m.
 *
 * Ini disengajakan KASAR: laluan yang titik mulanya berbeza ~100 m akan
 * berkongsi entri cache yang sama. Untuk aplikasi trafik araya itu
 * (bukan navigasi pintu-ke-pintu) perbezaan itu tidak ketara, dan kadar
 * hit cache meningkat dengan ketara.
 */
const ROUTE_KEY_FACTOR = 1_000;   // 10^3 → 3 tempat perpuluhan

/** Bundarkan koordinat kepada 3 tempat perpuluhan untuk kunci cache. */
export function routeKeyRound(v: number): number {
  return Math.round(v * ROUTE_KEY_FACTOR) / ROUTE_KEY_FACTOR;
}

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
        'User-Agent': USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Tempoh cache laluan (ms). Geometri jalan berubah lambat, jadi panjang. */
const DEFAULT_ROUTE_CACHE_TTL_MS = 7 * 24 * 3_600_000;   // 7 hari
/** Had maksimum — elakkan nilai env yang pelik menyimpan terlalu lama. */
const MAX_ROUTE_CACHE_TTL_MS = 30 * 24 * 3_600_000;      // 30 hari

function routeCacheTtlMs(env?: Env): number {
  const n = Number(env?.ROUTE_CACHE_TTL_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROUTE_CACHE_TTL_MS;
  return Math.min(n, MAX_ROUTE_CACHE_TTL_MS);
}

/** Unit kunci cache — 4 koordinat yang telah dibundarkan. */
interface RouteKey {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

/**
 * Kunci cache untuk dua titik.
 *
 * Hanya laluan 2 titik yang diCache. Laluan 3+ titik (mengandungi
 * perantaraan) TIDAK berkongsi kunci dengan selamat — dua laluan yang
 * berbeza perantaraan akan berkongsi entri dan yang kedua menerima
 * geometri yang SALAH. Cache yang salah lebih buruk daripada cache miss,
 * jadi laluan 3+ titik diteruskan terus ke OSRM.
 */
function routeKeyOf(points: LatLng[]): RouteKey | null {
  if (points.length !== 2) return null;
  const [a, b] = points;
  return {
    originLat: routeKeyRound(a.lat),
    originLng: routeKeyRound(a.lng),
    destLat: routeKeyRound(b.lat),
    destLng: routeKeyRound(b.lng),
  };
}

/** Kedua-dua susunan arah — A→B dan B→A ialah laluan yang sama. */
function keyOrders(k: RouteKey): Array<[number, number, number, number]> {
  return [
    [k.originLat, k.originLng, k.destLat, k.destLng],
    [k.destLat, k.destLng, k.originLat, k.originLng],
  ];
}

/**
 * Baca laluan dari D1. Miss → null.
 *
 * Ralat D1 (tiada jadual, tiada binding) dikembalikan sebagai miss —
 * cache tidak pernah mematikan routing.
 */
async function readRouteCache(
  db: D1Database,
  key: RouteKey,
  ttlMs: number,
): Promise<RouteResult | null> {
  const cutoff = Date.now() - ttlMs;
  try {
    for (const [oLat, oLng, dLat, dLng] of keyOrders(key)) {
      const row = await db
        .prepare(
          `SELECT route_data, distance, duration
             FROM route_cache
            WHERE origin_lat = ? AND origin_lng = ?
              AND dest_lat = ? AND dest_lng = ?
              AND strftime('%s', created_at) * 1000 > ?
            LIMIT 1`,
        )
        .bind(oLat, oLng, dLat, dLng, cutoff)
        .first<{ route_data: string; distance: number; duration: number }>();

      if (row) {
        return {
          distanceM: Math.round(row.distance),
          durationS: Math.round(row.duration),
          geometry: JSON.parse(row.route_data) as RouteResult['geometry'],
          provider: 'cache',
          cached: true,
        };
      }
    }
  } catch {
    // D1 tiada / jadual belum diguna — bukan ralat kritikal.
  }
  return null;
}

/**
 * Cache routing dalam D1 — "smart cache".
 *
 * Geometri jalan berubah sangat lambat, jadi laluan yang sama boleh
 * dikekalkan berhari-hari. Panggilan pertama pergi ke OSRM; semua
 * panggilan berikutnya dijawab dari D1 dalam milisaat.
 */
export async function getRouteCached(
  c: Context<{ Bindings: Env }>,
  points: LatLng[],
): Promise<RouteResult> {
  const ttlMs = routeCacheTtlMs(c.env);
  const key = routeKeyOf(points);

  if (!c.env.DB || !key) {
    return getRoute(c, points);
  }

  const cached = await readRouteCache(c.env.DB, key, ttlMs);
  if (cached) return cached;

  const result = await getRoute(c, points);

  // PENTING: daftarkan dengan `waitUntil`, JANGAN `void`.
  //
  // Kerja latar yang tidak didaftarkan boleh DIBATALKAN oleh runtime
  // begitu balasan dihantar — dan D1 terhenti tanpa sebarang ralat.
  // Gejala fosilnya: hanya sebahagian kecil tulisan yang muncul walaupun
  // setiap panggilan berjaya (5 baris daripada 32 panggilan), dan cache
  // kelihatan "tidak berfungsi" tanpa sebarang mesej ralat.
  const saving = saveRouteCache(c, key, result).catch(() => {});
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(saving);
  } else {
    void saving;
  }

  return result;
}

/**
 * Simpan laluan ke D1 — KEDUA arah.
 *
 * Menulis kedua-dua susunan bermakna setiap bacaan sentiasa satu
 * pertanyaanan, tanpa perlu mencuba arah terbalik. Kosnya dua baris
 * untuk satu laluan, tetapi laluan jarak jauh amat berbaloi untuk
 * dijawab dalam < 10 ms.
 */
async function saveRouteCache(
  c: Context<{ Bindings: Env }>,
  key: RouteKey,
  result: RouteResult,
): Promise<void> {
  const db = c.env.DB!;
  const payload = JSON.stringify(result.geometry);

  for (const [oLat, oLng, dLat, dLng] of keyOrders(key)) {
    await db
      .prepare(
        `INSERT INTO route_cache
           (origin_lat, origin_lng, dest_lat, dest_lng, route_data, distance, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin_lat, origin_lng, dest_lat, dest_lng)
         DO UPDATE SET route_data = excluded.route_data,
                       distance   = excluded.distance,
                       duration   = excluded.duration,
                       created_at = CURRENT_TIMESTAMP`,
      )
      .bind(oLat, oLng, dLat, dLng, payload, result.distanceM, result.durationS)
      .run();
  }
}
