-- ============================================================
--  LALINTRAFIK — Skema D1 (Crowdsourced traffic & incident reports)
--  Target: Cloudflare D1 (SQLite Edge)
--
--  Rekaan ruang: `geohash` (precision 8) dijana di Worker.
--  Query berdaptar-kotak (bounding box) → tapis Haversine di JS.
--  Tiada Vectorize — token akaun ini tiada akses (403).
--
--  Masa: INTEGER (unix milliseconds) — REAL/INTEGER lebih pantas
--  daripada perbandingan string tarikh dalam D1.
-- ============================================================

-- ------------------------------------------------------------
-- 1) USERS — mesra tanpa-akaun (device_id hulung)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL UNIQUE,          -- hulung dari localStorage client
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- ------------------------------------------------------------
-- 2) REPORTS — laporan insiden
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,

  -- jenis insiden (CHECK = halang nilai haram dari terus masuk ke D1)
  type          TEXT NOT NULL
                  CHECK (type IN ('ACCIDENT','SPEED_TRAP','HAZARD','TRAFFIC_JAM',
                                  'POLICE','ROAD_CLOSURE','WEATHER','COMMUNITY')),

  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  accuracy_m    REAL,
  geohash       TEXT NOT NULL,                -- precision 8 (~38m x 19m)
  heading       REAL,
  speed_kmh     REAL,
  road_name     TEXT,
  note          TEXT,
  severity      INTEGER NOT NULL DEFAULT 0 CHECK (severity BETWEEN 0 AND 3),

  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','EXPIRED','DISMISSED')),

  -- kepercayaan komuniti
  confirm_count INTEGER NOT NULL DEFAULT 0,
  dismiss_count INTEGER NOT NULL DEFAULT 0,
  confidence    INTEGER NOT NULL DEFAULT 0,

  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL              -- TTL laporan ( jenis-dependent )
);

-- ------------------------------------------------------------
-- 3) LIVE_SESSIONS — kehadiran masa nyata
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  device_id    TEXT NOT NULL,
  cell         TEXT NOT NULL,                 -- geohash precision 6 (~1.2km x 0.6km)
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  heading      REAL,
  speed_kmh    REAL,
  connected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- ============================================================
-- INDEXES
-- ============================================================

-- bacaan peta: laporan dalam kotak lat/lng + aktif + terbaru
CREATE INDEX IF NOT EXISTS idx_reports_bbox
  ON reports (lat, lng);

-- tapisan status + susunan masa (dipakai bersama bbox)
CREATE INDEX IF NOT EXISTS idx_reports_status_created
  ON reports (status, created_at DESC);

-- pembersihan TTL berkala
CREATE INDEX IF NOT EXISTS idx_reports_expires
  ON reports (expires_at);

-- kutukan geohash (alternatif kepada bbox untuk grid)
CREATE INDEX IF NOT EXISTS idx_reports_geohash
  ON reports (geohash);

CREATE INDEX IF NOT EXISTS idx_reports_user
  ON reports (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_cell
  ON live_sessions (cell, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_device
  ON live_sessions (device_id);

CREATE INDEX IF NOT EXISTS idx_users_device
  ON users (device_id);

-- ------------------------------------------------------------
-- 4) ROUTE_CACHE — cache routing OSRM (elak panggilan berulang)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_route_cache_expires
  ON route_cache (expires_at);
