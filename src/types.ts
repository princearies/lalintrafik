// ============================================================
//  LALINTRAFIK — Jenis & kontrak data
// ============================================================

// ---------- Enums (padan CHECK constraints dalam schema.sql) ----------
export const REPORT_TYPES = [
  'ACCIDENT',
  'SPEED_TRAP',
  'HAZARD',
  'TRAFFIC_JAM',
  'POLICE',
  'ROAD_CLOSURE',
  'WEATHER',
  'COMMUNITY',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_STATUSES = ['ACTIVE', 'EXPIRED', 'DISMISSED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

// ---------- Baris D1 (mentah) ----------
export interface UserRow {
  id: string;
  device_id: string;
  display_name: string | null;
  created_at: number;
  last_seen_at: number;
}

export interface ReportRow {
  id: string;
  user_id: string | null;
  type: ReportType;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  geohash: string;
  heading: number | null;
  speed_kmh: number | null;
  road_name: string | null;
  note: string | null;
  severity: number;
  status: ReportStatus;
  confirm_count: number;
  dismiss_count: number;
  confidence: number;
  created_at: number;
  expires_at: number;
}

export interface LiveSessionRow {
  id: string;
  user_id: string | null;
  device_id: string;
  cell: string;
  lat: number;
  lng: number;
  heading: number | null;
  speed_kmh: number | null;
  connected_at: number;
  last_seen_at: number;
}

// ---------- Gaya domain (yang dipulangkan API) ----------
export interface Report {
  id: string;
  type: ReportType;
  lat: number;
  lng: number;
  accuracyM: number | null;
  heading: number | null;
  speedKmh: number | null;
  roadName: string | null;
  note: string | null;
  severity: number;
  status: ReportStatus;
  confirmCount: number;
  dismissCount: number;
  confidence: number;
  /** Jarak dari titik pertanyaan, meter. Hanya ada pada /nearby. */
  distanceM?: number;
  createdAt: string; // ISO 8601 — mesra untuk JSON API
  expiresAt: string;
}

export interface User {
  id: string;
  deviceId: string;
  displayName: string | null;
  createdAt: string;
  lastSeenAt: string;
}

// ---------- Payload permintaan ----------
export interface CreateReportRequest {
  type: ReportType;
  lat: number;
  lng: number;
  accuracyM?: number;
  heading?: number;
  speedKmh?: number;
  roadName?: string;
  note?: string;
  severity?: number;
  /** Id sesi untuk siaran masa nyata. */
  sessionId?: string;
}

export interface NearbyQuery {
  lat: number;
  lng: number;
  radiusM: number;
  limit: number;
  type?: ReportType;
  /** Tarikh ISO — hanya laporan selepas ini. */
  since?: string;
}

// ---------- Mesej WebSocket ----------
export type ServerMessage =
  | { kind: 'report.new'; report: Report }
  | { kind: 'report.confirm'; id: string; confirmCount: number; confidence: number }
  | { kind: 'report.dismiss'; id: string; dismissCount: number; confidence: number }
  | { kind: 'report.expire'; id: string }
  | { kind: 'presence'; online: number }
  | { kind: 'pong'; ts: number }
  | { kind: 'error'; message: string };

export type ClientMessage =
  | { kind: 'subscribe'; cell: string; lat: number; lng: number }
  | { kind: 'unsubscribe'; cell: string }
  | { kind: 'ping' }
  | { kind: 'report.confirm'; id: string }
  | { kind: 'report.dismiss'; id: string };

// ---------- Env / Bindings ----------
export interface Env {
  DB: D1Database;
  /** Rujukan ke D1 setempat untuk ujian — tidak digunakan dalam produksi. */
  DB_LOCAL?: D1Database;
  GRID: DurableObjectNamespace;
  /** Had radius (meter) yang dibenarkan — elak pertanyaan besar. */
  MAX_RADIUS_M?: string;
  /** Had baris dikembalikan oleh /nearby. */
  MAX_LIMIT?: string;
  /** Had bilangan peer setiap sel Durable Object. */
  MAX_PEERS_PER_CELL?: string;
  /** Purata TTL laporan (ms) jika jenis tidak dikenali. */
  DEFAULT_TTL_MS?: string;
  /** Hala OSRM — tukar ke tumpangan sendiri bila trafik meningkat. */
  OSRM_BASE_URL?: string;
  /** Kunci GraphHopper — pilihan, untuk failover. */
  GRAPHHOPPER_KEY?: string;
}

// ---------- Pemetaan baris → domain ----------
const msToIso = (ms: number): string => new Date(ms).toISOString();

export function toReport(r: ReportRow, distanceM?: number): Report {
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
    ...(distanceM !== undefined ? { distanceM: Math.round(distanceM) } : {}),
    createdAt: msToIso(r.created_at),
    expiresAt: msToIso(r.expires_at),
  };
}

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    deviceId: r.device_id,
    displayName: r.display_name,
    createdAt: msToIso(r.created_at),
    lastSeenAt: msToIso(r.last_seen_at),
  };
}
