// ============================================================
//  Lapisan akses data D1 — laporan, pengguna, sesi
//  Semua fungsi menerima D1Database terus (tiada global state).
// ============================================================

import type {
  CreateReportRequest,
  Env,
  LiveSessionRow,
  NearbyQuery,
  Report,
  ReportRow,
  ReportType,
  UserRow,
} from '../types';
import { boundingBox, cellFor, geohash, haversineM } from '../lib/geo';
import { newId, nowMs, ttlFor } from '../lib/errors';

// ------------------------------------------------------------
//  Laporan
// ------------------------------------------------------------
export interface CreateReportArgs extends CreateReportRequest {
  userId: string | null;
  deviceId: string;
}

export interface CreatedReport {
  report: Report;
  /** Sel 6 aksara tempat laporan ini berada — untuk siaran. */
  cell: string;
  /** Sel jiranan (8) — untuk siaran lintas sempadan. */
  neighbours: string[];
}

export async function createReport(db: D1Database, args: CreateReportArgs, env?: Env): Promise<CreatedReport> {
  const ts = nowMs();
  const id = newId();
  const ttl = ttlFor(args.type, env);

  const report: Report = {
    id,
    type: args.type,
    lat: args.lat,
    lng: args.lng,
    accuracyM: args.accuracyM ?? null,
    heading: args.heading ?? null,
    speedKmh: args.speedKmh ?? null,
    roadName: args.roadName ?? null,
    note: args.note ?? null,
    severity: args.severity ?? 0,
    status: 'ACTIVE',
    confirmCount: 0,
    dismissCount: 0,
    confidence: 0,
    createdAt: new Date(ts).toISOString(),
    expiresAt: new Date(ts + ttl).toISOString(),
  };

  // geohash precision 8 untuk indeks, 6 untuk sel siaran
  const geo8 = geohash(args.lat, args.lng, 8);
  const cell = cellFor(args.lat, args.lng);

  await db
    .prepare(
      `INSERT INTO reports
        (id, user_id, type, lat, lng, accuracy_m, geohash,
         heading, speed_kmh, road_name, note, severity, status,
         confirm_count, dismiss_count, confidence, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, 0, 0, ?, ?)`,
    )
    .bind(
      id,
      args.userId,
      args.type,
      args.lat,
      args.lng,
      args.accuracyM ?? null,
      geo8,
      args.heading ?? null,
      args.speedKmh ?? null,
      args.roadName ?? null,
      args.note ?? null,
      args.severity ?? 0,
      ts,
      ts + ttl,
    )
    .run();

  return { report, cell, neighbours: [] };
}

export interface NearbyOptions {
  limit: number;
  maxRadiusM: number;
  type?: ReportType;
  sinceMs?: number;
  /** TTL minimum — laporan yang sudah tamat tidak dipulangkan. */
  includeExpired?: boolean;
}

/**
 * Laporan berdekatan.
 *
 * Strategi dua peringkat:
 *  1. D1 peti bounding (lat BETWEEN, lng BETWEEN) — indeks `idx_reports_bbox`
 *     mengecilkan baris dibaca kepada ribuan terdekat, bukan jutaan.
 *  2. Haversine di JS — peti ialah segi empat tepat, jadi laporan di penjuru
 *     boleh berada lebih jauh daripada radius sebenar.
 */
export async function findNearby(
  db: D1Database,
  q: NearbyQuery,
  opts: NearbyOptions,
): Promise<Report[]> {
  const box = boundingBox(q.lat, q.lng, q.radiusM);

  const sql = [
    'SELECT * FROM reports',
    'WHERE status = ?',
    '  AND lat BETWEEN ? AND ?',
    '  AND lng BETWEEN ? AND ?',
    q.type ? '  AND type = ?' : '',
    opts.sinceMs !== undefined ? '  AND created_at >= ?' : '',
    opts.includeExpired ? '' : '  AND expires_at > ?',
    'ORDER BY created_at DESC',
    'LIMIT ?',
  ]
    .filter(Boolean)
    .join('\n');

  const params: (string | number)[] = ['ACTIVE', box.minLat, box.maxLat, box.minLng, box.maxLng];
  if (q.type) params.push(q.type);
  if (opts.sinceMs !== undefined) params.push(opts.sinceMs);
  if (!opts.includeExpired) params.push(nowMs());
  params.push(Math.max(opts.limit * 4, 200)); // lebihan untuk tampis Haversine

  const { results } = await db.prepare(sql).bind(...params).all<ReportRow>();

  const out: Report[] = [];
  for (const row of results) {
    const d = haversineM(q.lat, q.lng, row.lat, row.lng);
    if (d > q.radiusM) continue;
    out.push({ ...toReportShallow(row), distanceM: Math.round(d) });
    if (out.length >= opts.limit) break;
  }

  return out;
}

/** Pemetaan ringkas tanpa import penuh types (elakkan gelung). */
function toReportShallow(r: ReportRow): Report {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: r.id,
    type: r.type,
    lat: r.lat,
    lng: r.lng,
    accuracyM: r.accuracy_m,
    heading: r.heading,
    speedKmh: r.speed_kmh,
    roadName: r.road_name,
    note: r.note,
    severity: r.severity,
    status: r.status,
    confirmCount: r.confirm_count,
    dismissCount: r.dismiss_count,
    confidence: r.confidence,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
  };
}

/** Satu laporan mengikut ID. */
export async function getReport(db: D1Database, id: string): Promise<Report | null> {
  const row = await db
    .prepare('SELECT * FROM reports WHERE id = ?')
    .bind(id)
    .first<ReportRow>();
  return row ? toReportShallow(row) : null;
}

/** Tambah pengesahkan. Pulangkan nilai baharu, atau null kalau laporan tiada. */
export async function confirmReport(
  db: D1Database,
  id: string,
): Promise<{ confirmCount: number; confidence: number } | null> {
  // PENTING: `confidence` adalah kolum tersimpan, jadi ia mesti dikemas
  // kini dalam UPDATE yang sama — jika tidak, bacaan seterusnya akan
  // memulangkan 0 walaupun confirmCount sudah bertambah. SQLite
  // menilai semua ungkapan SET terhadap nilai baris ASAL, jadi
  // `confirm_count + 1` di sini ialah nilai selepas tambah.
  const row = await db
    .prepare(
      `UPDATE reports
          SET confirm_count = confirm_count + 1,
              confidence = CAST(ROUND((confirm_count + 1) * 100.0
                                      / (confirm_count + 1 + dismiss_count)) AS INTEGER)
        WHERE id = ?
        RETURNING confirm_count, dismiss_count`,
    )
    .bind(id)
    .first<{ confirm_count: number; dismiss_count: number }>();
  if (!row) return null;
  return {
    confirmCount: row.confirm_count,
    confidence: confidenceOf(row.confirm_count, row.dismiss_count),
  };
}

export async function dismissReport(
  db: D1Database,
  id: string,
): Promise<{ dismissCount: number; confidence: number } | null> {
  // Sama seperti confirm — penyebut sentiasa >= 1 kerana kita menambah 1.
  const row = await db
    .prepare(
      `UPDATE reports
          SET dismiss_count = dismiss_count + 1,
              confidence = CAST(ROUND(confirm_count * 100.0
                                      / (confirm_count + dismiss_count + 1)) AS INTEGER)
        WHERE id = ?
        RETURNING confirm_count, dismiss_count`,
    )
    .bind(id)
    .first<{ confirm_count: number; dismiss_count: number }>();
  if (!row) return null;
  return {
    dismissCount: row.dismiss_count,
    confidence: confidenceOf(row.confirm_count, row.dismiss_count),
  };
}

/** Kepercayaan komuniti: 0-100, berkurangan apabila ramai yang menolak. */
export function confidenceOf(confirms: number, dismisses: number): number {
  const total = confirms + dismisses;
  if (total === 0) return 0;
  return Math.max(0, Math.min(100, Math.round((confirms / total) * 100)));
}

/** Laporan yang sudah tamat — untuk pembersihan berkala. */
export async function expireStaleReports(db: D1Database, limit = 500): Promise<number> {
  const r = await db
    .prepare(
      "UPDATE reports SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ? LIMIT ?",
    )
    .bind(nowMs(), limit)
    .run();
  return r.meta.changes ?? 0;
}

// ------------------------------------------------------------
//  Pengguna (device_id hulung)
// ------------------------------------------------------------
/** Profil yang dihantar bersama laporan/carian — `undefined` = jangan ubah. */
export interface UserProfile {
  displayName?: string | null;
  gender?: string | null;
}

/** Cari profil sedia ada mengikut device_id (hulung, tanpa akaun). */
export async function getProfile(db: D1Database, deviceId: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE device_id = ?').bind(deviceId).first<UserRow>();
}

/**
 * Cipta atau kemas kini pengguna mengikut `device_id`.
 *
 * Hanya medan yang dihantar akan ditulis — laporan yang tidak membawa
 * profil tidak memadamkan nama pengguna. Apabila profil dihantar, baris
 * dibaca semula supaya nilai dipulangkan adalah nilai yang DISIMPAN, bukan
 * tangkaan.
 */
export async function upsertUser(
  db: D1Database,
  deviceId: string,
  profile?: UserProfile,
): Promise<UserRow> {
  const ts = nowMs();
  const existing = await db
    .prepare('SELECT * FROM users WHERE device_id = ?')
    .bind(deviceId)
    .first<UserRow>();

  const hasProfile =
    profile?.displayName !== undefined || profile?.gender !== undefined;

  if (existing) {
    if (hasProfile) {
      const sets = ['last_seen_at = ?'];
      const args: (string | number | null)[] = [ts];
      if (profile?.displayName !== undefined) {
        sets.push('display_name = ?');
        args.push(profile.displayName ?? null);
      }
      if (profile?.gender !== undefined) {
        sets.push('gender = ?');
        args.push(profile.gender ?? null);
      }
      args.push(deviceId);
      await db
        .prepare(`UPDATE users SET ${sets.join(', ')} WHERE device_id = ?`)
        .bind(...args)
        .run();

      const row = await db
        .prepare('SELECT * FROM users WHERE device_id = ?')
        .bind(deviceId)
        .first<UserRow>();
      return row ?? { ...existing, last_seen_at: ts };
    }

    await db
      .prepare('UPDATE users SET last_seen_at = ? WHERE device_id = ?')
      .bind(ts, deviceId)
      .run();
    return { ...existing, last_seen_at: ts };
  }

  const id = newId();
  await db
    .prepare(
      'INSERT INTO users (id, device_id, display_name, gender, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, deviceId, profile?.displayName ?? null, profile?.gender ?? null, ts, ts)
    .run();

  return {
    id,
    device_id: deviceId,
    display_name: profile?.displayName ?? null,
    gender: profile?.gender ?? null,
    created_at: ts,
    last_seen_at: ts,
  };
}

// ------------------------------------------------------------
//  Sesi langsung
// ------------------------------------------------------------
export async function upsertSession(
  db: D1Database,
  deviceId: string,
  userId: string | null,
  lat: number,
  lng: number,
  heading?: number | null,
  speedKmh?: number | null,
): Promise<LiveSessionRow> {
  const ts = nowMs();
  const cell = cellFor(lat, lng);
  const id = newId();

  await db
    .prepare(
      `INSERT INTO live_sessions
        (id, user_id, device_id, cell, lat, lng, heading, speed_kmh, connected_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         cell = excluded.cell,
         lat = excluded.lat,
         lng = excluded.lng,
         heading = excluded.heading,
         speed_kmh = excluded.speed_kmh,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(id, userId, deviceId, cell, lat, lng, heading ?? null, speedKmh ?? null, ts, ts)
    .run();

  return {
    id,
    user_id: userId,
    device_id: deviceId,
    cell,
    lat,
    lng,
    heading: heading ?? null,
    speed_kmh: speedKmh ?? null,
    connected_at: ts,
    last_seen_at: ts,
  };
}

/** Bilangan peranti aktif dalam sel (untuk mesej `presence`). */
export async function countSessionsInCell(db: D1Database, cell: string): Promise<number> {
  const r = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM live_sessions WHERE cell = ? AND last_seen_at > ?',
    )
    .bind(cell, nowMs() - 120_000)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Bersihkan sesi mati — dipanggil oleh cron. */
export async function pruneSessions(db: D1Database, olderThanMs = 120_000): Promise<number> {
  const r = await db
    .prepare('DELETE FROM live_sessions WHERE last_seen_at < ?')
    .bind(nowMs() - olderThanMs)
    .run();
  return r.meta.changes ?? 0;
}
