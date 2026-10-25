// ============================================================
//  MYKIRA MAP — Hotspot (agregasi kepadatan laporan)
//
//  Mengumpulkan laporan ke dalam sel grid dan mengikutkan sel yang
//  paling panas. Satu pertanyaanan SQL sahja — tiada jadual baharu,
//  tiada pek — jadi selamat untuk dipanggil kerap oleh Android.
//
//  Mengapa ROUND() dan bukan geohash?
//  ROUND(lat, 3) ialah sel ~110 m dan merupakan kumpulan SQL tulen.
//  geohash huruf bermaksud klien dan pelayan mesti bersetuju tentang
//  set aksara yang sama; ROUND tidak mempunyai masalah itu.
//
//  PERANGKAP: SQLite `ROUND(x, 3)` bukan "bundar ke atas" —
//  `ROUND(116.0505, 3)` menghasilkan **116.050**, bukan 116.051.
//  Titik yang mula tepat di sempadan .0005 akan terbelah antara dua
//  sel. Ini bukan pepijat — ia kelakaran SQLite — tetapi ia bermakna
//  dua laporan yang jaraknya 1 m TIDAK semestinya berada dalam sel
//  yang sama. Ujian `test/hotspots.test.mjs` bahagian [7] mengunci
//  kelakaran ini.
//
//  `heat` dinormalkan 0..1 terhadap sel terpanas, jadi klien tidak
//  perlu tahu jumlah mutlak untuk mewarnakan peta.
// ============================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { clampInt, optionalNumber } from '../lib/errors';
import { geofenceOf } from '../lib/geofence';

export const hotspots = new Hono<{ Bindings: Env }>();

/** Jenis insiden yang diletakkan dalam tindan — tertib. */
const TYPES = [
  'ACCIDENT',
  'SPEED_TRAP',
  'HAZARD',
  'TRAFFIC_JAM',
  'POLICE',
  'ROAD_CLOSURE',
] as const;

type TypeKey = (typeof TYPES)[number];
const TYPE_KEYS: Record<TypeKey, string> = {
  ACCIDENT: 'accident',
  SPEED_TRAP: 'speedTrap',
  HAZARD: 'hazard',
  TRAFFIC_JAM: 'trafficJam',
  POLICE: 'police',
  ROAD_CLOSURE: 'roadClosure',
};

/**
 * GET /api/v1/hotspots
 *
 * Query (semua pilihan):
 *   minLat, minLng, maxLat, maxLng  — peti pandangan; lalai geofence penuh
 *   gridDp                          — kedalaman grid perpuluhan (1..5, lalai 3)
 *   limit                           — bilangan sel dipulangkan (1..200, lalai 50)
 *   minCount                        — buang sel lebih rendah daripada ini (lalai 1)
 */
hotspots.get('/', async (c) => {
  const q = c.req.query();
  const g = geofenceOf(c.env);

  // --- peti pandangan ---
  // Lalai: geofence penuh (90 km dari Putatan) — ditukar kepada darjah.
  const kmToDegLat = 1 / 111.32;
  const kmToDegLng = 1 / (111.32 * Math.cos((g.lat * Math.PI) / 180));

  // SENTINEL: kotak geofence penuh (90 km dari Putatan) ditukar kepada
  // darjah. `clamp` di sini penting — 90 km ke selatan ialah -802 darjah,
  // dan mengembalikan lat di luar [-90, 90] dalam `meta.bbox` mengelirukan
  // klien yang memetanya.
  const minLat = Math.max(-90, optionalNumber(q.minLat, 'minLat', -90, 90) ?? g.lat - g.radiusM * kmToDegLat);
  const maxLat = Math.min(90, optionalNumber(q.maxLat, 'maxLat', -90, 90) ?? g.lat + g.radiusM * kmToDegLat);
  const minLng = Math.max(-180, optionalNumber(q.minLng, 'minLng', -180, 180) ?? g.lng - g.radiusM * kmToDegLng);
  const maxLng = Math.min(180, optionalNumber(q.maxLng, 'maxLng', -180, 180) ?? g.lng + g.radiusM * kmToDegLng);

  const gridDp = clampInt(q.gridDp, 'gridDp', 1, 5, 3);
  const limit = clampInt(q.limit, 'limit', 1, 200, 50);
  const minCount = clampInt(q.minCount, 'minCount', 1, 1000, 1);

  if (!c.env.DB) {
    return c.json({ success: false, error: 'Ralat pangkalan data' }, 500);
  }

  // --- agregasi grid ---
  // Satu pertanyaanan: kumpulkan mengikut ROUND() dan susun menurun.
  const { results } = await c.env.DB.prepare(
    `SELECT
        ROUND(lat, ?)      AS lat,
        ROUND(lng, ?)      AS lng,
        COUNT(*)           AS total,
        SUM(confidence)    AS confidenceSum,
        SUM(CASE type WHEN 'ACCIDENT'    THEN 1 ELSE 0 END) AS accident,
        SUM(CASE type WHEN 'SPEED_TRAP'  THEN 1 ELSE 0 END) AS speedTrap,
        SUM(CASE type WHEN 'HAZARD'      THEN 1 ELSE 0 END) AS hazard,
        SUM(CASE type WHEN 'TRAFFIC_JAM' THEN 1 ELSE 0 END) AS trafficJam,
        SUM(CASE type WHEN 'POLICE'      THEN 1 ELSE 0 END) AS police,
        SUM(CASE type WHEN 'ROAD_CLOSURE' THEN 1 ELSE 0 END) AS roadClosure
       FROM reports
      WHERE status = 'ACTIVE'
        AND expires_at > ?
        AND lat BETWEEN ? AND ?
        AND lng BETWEEN ? AND ?
      GROUP BY ROUND(lat, ?), ROUND(lng, ?)
     HAVING COUNT(*) >= ?
      ORDER BY total DESC, confidenceSum DESC
      LIMIT ?`,
  )
    .bind(
      gridDp, gridDp,
      Date.now(),
      minLat, maxLat, minLng, maxLng,
      gridDp, gridDp,
      minCount,
      limit,
    )
    .all<{
      lat: number;
      lng: number;
      total: number;
      confidenceSum: number;
      accident: number;
      speedTrap: number;
      hazard: number;
      trafficJam: number;
      police: number;
      roadClosure: number;
    }>();

  const rows = results ?? [];

  // Sel terpanas menetapkan skala `heat` — klien mewarnakan tanpa
  // perlu mengetahui jumlah mutlak.
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 1);

  const data = rows.map((r, i) => {
    const breakdown: Record<string, number> = {};
    for (const t of TYPES) breakdown[TYPE_KEYS[t]] = r[TYPE_KEYS[t] as keyof typeof r] as number;

    // jenis dominan = tertinggi; dipakai untuk warna ikon
    let dominantType: TypeKey = TYPES[0];
    let best = -1;
    for (const t of TYPES) {
      const v = breakdown[TYPE_KEYS[t]];
      if (v > best) { best = v; dominantType = t; }
    }

    return {
      rank: i + 1,
      lat: r.lat,
      lng: r.lng,
      total: r.total,
      confidenceAvg: Math.round(r.confidenceSum / r.total),
      heat: Math.round((r.total / maxTotal) * 100) / 100,
      dominantType,
      breakdown,
    };
  });

  return c.json({
    success: true,
    data,
    meta: {
      gridDp,
      cellMeters: Math.round(111_320 / 10 ** gridDp),
      count: data.length,
      bbox: { minLat, maxLat, minLng, maxLng },
    },
  });
});
