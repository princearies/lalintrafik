# MYKIRA MAP — Seni Bina Sistem & Aliran Data

Aplikasi Waze-like: laporan trafik komuniti, navigasi, dan siaran masa nyata.
Cloudflare Workers + Hono + D1 + Durable Objects.

---

## 1. Gambaran Keseluruhan

```
                        ┌──────────────────────────────────────┐
                        │           BROWSERS / MOBILE          │
                        │  MapLibre GL JS  +  Geolocation API  │
                        └───────────────┬──────────────────────┘
                                        │ HTTPS + WSS
                                        ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE EDGE (Worker)                       │
│                                                                       │
│  ┌──────────────┐   ┌───────────────┐   ┌────────────────────────┐   │
│  │ CORS         │──▶│ errorHandler  │──▶│ timing (Server-Timing) │   │
│  └──────────────┘   └───────────────┘   └───────────┬────────────┘   │
│                                                      ▼                │
│   GET  /                                    (kesihatan)              │
│   GET  /healthz                                                       │
│   GET  /api/v1/ws?cell=…                          ──┐                 │
│                                                      │                 │
│   ┌────────────────────────┐   ┌─────────────────────▼──────────┐     │
│   │  routes/reports.ts     │   │  routes/routing.ts            │     │
│   │                        │   │                               │     │
│   │ POST /reports          │   │ GET /api/v1/routing           │     │
│   │ GET  /reports/nearby   │   │   lat1,lng1,lat2,lng2          │     │
│   │ GET  /reports/:id      │   └───────────────┬───────────────┘     │
│   │ POST /reports/:id/…    │                   │                     │
│   │ POST /reports/session  │                   │ cache hit → pulang  │
│   └───────────┬────────────┘                   ▼                     │
│               │                          ┌─────────┐                 │
│               ▼                          │ OSRM    │  (luar, 8s tol) │
│        ┌──────────────┐                  └─────────┘                 │
│        │ db/reports.ts│                                               │
│        │  D1 + geo    │                                               │
│        └──────┬───────┘                                               │
│               │ siaran (waitUntil)                                    │
│               ▼                                                        │
│   ┌────────────────────────────────────────────────────────────┐     │
│   │            routes/ws.ts  →  broadcastToCell()               │     │
│   └──────────────────────────────┬─────────────────────────────┘     │
└──────────────────────────────────┼────────────────────────────────────┘
                                   │  GRID.get(idFromName(cell)).fetch
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   DURABLE OBJECT — GridDO                            │
│                   (satu instance setiap sel geohash-6)                │
│                                                                       │
│   state.id ─▶ sel ini (cth: "w283cg")                                │
│                                                                       │
│   ┌─────────────────┐        ┌──────────────────────────────────┐    │
│   │ WebSocket peers │◀──────▶│ broadcast(message)               │    │
│   │  Map<ws, Peer>  │        │  → ws.send(JSON) setiap peer      │    │
│   └─────────────────┘        └──────────────────────────────────┘    │
│                                                                       │
│   POST /broadcast           → siar tempatan                          │
│   POST /broadcast-neighbours→ siar ke 8 sel jiranan (DO lain)         │
│   GET  /status              → peers, broadcastCount                   │
│                                                                       │
│   acceptWebSocket()  → hibernasi: sambungan idle bebas CPU           │
└──────────┬───────────────────────────────┬───────────────────────────┘
           │                               │ idFromName(cellJiran)
           ▼                               ▼
   ┌──────────────┐              ┌──────────────────┐
   │   D1 (SQLite)│              │  GridDO jiranan  │
   │              │              │  (sel ±1)        │
   │ users        │              └──────────────────┘
   │ reports      │
   │ live_sessions│
   │ route_cache  │
   └──────────────┘
```

---

## 2. Aliran Data

### 2.1 Hantar laporan (tulis)

```
Client                Worker                    D1                GridDO
  │                     │                        │                    │
  │ POST /api/v1/reports│                        │                    │
  │ {type,lat,lng,note} │                        │                    │
  ├────────────────────▶│                        │                    │
  │                     │ validate (Hono + zod-like)                 │
  │                     │ geohash(lat,lng,8)     │                    │
  │                     │ cell = geohash(…,6)    │                    │
  │                     │ ttl  = ttlFor(type)    │                    │
  │                     │ INSERT reports         │                    │
  │                     ├───────────────────────▶│                    │
  │                     │◀───────────────────────┤                    │
  │                     │                        │                    │
  │         ◀── 201 Created (JSON laporan) ──┐   │                    │
  │                                          │   │                    │
  │      waitUntil ─┐ (latar belakang)       │   │                    │
  │                 ▼                        │   │                    │
  │        publishReport(cell, neighbours)   │   │                    │
  │                 ├──────────────────────────────────────────────▶ │
  │                 │                        │     broadcast + fanout │
  │                 │                        │     → ws.send()        │
  │                 │                        │     → 8 DO jiranan     │
```

**Keputusan penting:** siaran berjalan dalam `ctx.waitUntil()` — balasan HTTP pulang
dalam ~15ms tanpa menunggu DO. Kegagalan siaran **tidak** menggagalkan penulisan D1.

### 2.2 Dapatkan laporan berdekatan (baca)

```
Client              Worker                       D1
  │                   │                           │
  │ GET /nearby?lat=3.139&lng=101.6869&radiusM=5000
  ├──────────────────▶│                           │
  │                   │ boundingBox(lat,lng,5000) │
  │                   │  → {minLat,maxLat,minLng,maxLng}
  │                   │                           │
  │                   │ SELECT * FROM reports     │
  │                   │  WHERE status='ACTIVE'    │
  │                   │    AND lat  BETWEEN ? AND ?  ← idx_reports_bbox
  │                   │    AND lng  BETWEEN ? AND ?
  │                   │    AND expires_at > ?        ← buang yang tamat
  │                   │  ORDER BY created_at DESC    ← idx_reports_status_created
  │                   │  LIMIT ?
  │                   ├──────────────────────────▶│
  │                   │◀──────────────────────────┤
  │                   │                           │
  │                   │ Haversine setiap baris    │
  │                   │  → buang yang > radiusM   │
  │                   │  → set distanceM          │
  │                   │  → susun menaik           │
  │                   │                           │
  │  ◀── 200 ─────────┤                           │
  │  {data:[…], meta:{center,radiusM,count}}      │
```

**Mengapa dua peringkat?** Peti bounding ialah segi empat tepat; tanpa tapis kedua,
laporan di penjuru peti (sehingga √2 × radius) akan tersalah masuk. Haversine di JS
adalah tepat. Peti mengurangkan baris dari jutaan kepada ratusan, jadi Haversine murah.

### 2.3 Masa nyata (WebSocket)

```
Client              Worker                GridDO
  │                   │                     │
  │ WS /api/v1/ws?cell=w283cg              │
  ├──────────────────▶│                     │
  │                   │ idFromName(cell)    │
  │                   │ GRID.get(id)        │
  │                   │ stub.fetch(req) ────▶│
  │                   │                     │ acceptWebSocket()
  │ ◀══ 101 Switching ═════════════════════╪═══ ▶ WebSocket
  │                                        │
  │ {kind:'subscribe',cell,lat,lng} ══════╪═══▶  daftar peer
  │                                        │
  │        ◀── {kind:'presence',online:N} ╪═══  (ada penyambung baharu)
  │                                        │
  │        ◀── {kind:'report.new',report} ╪═══  (laporan baharu dalam sel)
  │                                        │
  │ {kind:'ping'} ════════════════════════╪═══▶  {kind:'pong',ts}
```

**Mengapa satu DO setiap sel?** Membagi beban mengikut geografi — sel di pedalaman
tidak berkongsi CPU dengan sel di Kuala Lumpur. Setiap DO melihat Hanya laporan
selnya, dan memancarkan ke 8 jiranan.

### 2.4 Routing (OSRM)

```
Client        Worker              D1 cache           OSRM
  │ GET /routing │                    │                │
  ├─────────────▶│ routeCacheKey()    │                │
  │              │ SELECT payload      │                │
  │              │  WHERE expires_at>? │                │
  │              ├───────────────────▶│                │
  │              │ hit → pulang terus  │                │
  │              │ miss → fetch OSRM  │                │
  │              ├────────────────────────────────────▶│
  │              │◀────────────────────────────────────┤
  │              │ waitUntil(save cache)               │
  │ ◀── 200 ─────┤                    │                │
```

---

## 3. Skema Data (D1)

| Jadual | Tujuan | Lajur kunci |
|---|---|---|
| `users` | Pengguna hulung `device_id` | `device_id` UNIQUE |
| `reports` | Laporan insiden | `lat`, `lng`, `geohash`, `status`, `created_at`, `expires_at` |
| `live_sessions` | Kehadiran | `device_id`, `cell`, `last_seen_at` |
| `route_cache` | Cache routing OSRM | `key`, `expires_at` |

### Indeks dan laluan baca

| Index | Melayani |
|---|---|
| `idx_reports_bbox` | `WHERE lat BETWEEN ? AND ?` |
| `idx_reports_status_created` | `WHERE status=? ORDER BY created_at DESC` |
| `idx_reports_expires` | pembersihan TTL |
| `idx_reports_geohash` | kutukan alternatif |
| `idx_sessions_cell` | kehadiran mengikut sel |
| `idx_users_device` | capaian pengguna hulung |

### CHECK constraints — halang data rosak di pintu masuk

```sql
type TEXT CHECK (type IN ('ACCIDENT','SPEED_TRAP','HAZARD','TRAFFIC_JAM',
                          'POLICE','ROAD_CLOSURE','WEATHER','COMMUNITY'))
status TEXT CHECK (status IN ('ACTIVE','EXPIRED','DISMISSED'))
severity INTEGER CHECK (severity BETWEEN 0 AND 3)
```

---

## 4. Had pelaksanaan Edge (dan di mana ia berlaku)

| Had | Nilai | Diurus bagaimana |
|---|---|---|
| CPU masa (Worker) | 30s berbayar / 10ms percuma | DO menyerap kerja siaran |
| Subrequest | 50 percuma / 1000 berbayar | siaran ke DO dikira subrequest |
| D1 baca | 5B/hari percuma | peti bounding + index |
| D1 tulis | 100k/hari percuma | disederhanakan |
| WebSocket (DO) | 3MB/hari keluar percuma | hibernasi |
| Saiz payload | 100MB | had badan 8KB dalam `readJson()` |

**Risiko utama:** `broadcastToCell` membuat 1 + 8 = 9 subrequest bagi setiap laporan.
Dengan had 50 subrequest percuma, **5 laporan pertama setiap invokasi Worker adalah
percuma**; selepas itu ia menggunakan kouta berbayar. Untuk MVP ini diterima —
naik taraf kepada Workers Paid ($5/bln) bila trafik meningkat.

---

## 5. Model Kekerapan & TTL

| Jenis | TTL | Sebab |
|---|---|---|
| `ACCIDENT` | 45 minit | insiden singkat, relevan hanya semasa |
| `SPEED_TRAP` | 90 minit | penguatkuasaan bergerak |
| `POLICE` | 90 minit | sama |
| `TRAFFIC_JAM` | 60 minit | kesesakan berubah cepat |
| `HAZARD` | 6 jam | bahaya kekal |
| `ROAD_CLOSURE` | 24 jam | penutupan rasmi |
| `WEATHER` | 3 jam | berubah |
| `COMMUNITY` | 12 jam | berita komuniti |

Laporan tamat dibuang oleh cron `*/5 * * * *` (`expireStaleReports`), dan juga
disaring dalam setiap pertanyaan (`expires_at > ?`).

---

## 6. Harga & Batasan Berskala

```
 trafik      D1 tulis/hari   subrequest/invocation   kos
─────────────────────────────────────────────────────────────
 100 lapor    100             ~9                      percuma
 1,000        1,000           ~9                      percuma
 10,000       10,000          ~90 (luar 50 percuma)   ~$5/bln (Paid)
 100,000      100,000         had baca D1             perlu arkitek semula
```

**Titik berkala:** ~10,000 laporan/hari — iaitu ketika subrequest mula dikenakan.
Dua strategi: (a) workers Paid, atau (b) siaran berkeselompok (batch) ke DO.

## 7. Ralat & Konsistensi — tiga perangkap sebenar

Seni bina ini sudah melalui tiga kegagalan sebenar. Semuanya dikunci oleh ujian.

**7.1 Ralat Hono tidak dapat ditangkap oleh middleware `try/catch`.**
Hono 4 menangkap pengecualian di peringkat `dispatch` route ( `compose.js` baris 36-41 )
dan menyerahkannya terus kepada `onError`. Middleware luaran tidak pernah melihat `next()`
menolak. Gejala: **setiap** ralat — termasuk `ValidationError(422)` dan `AppError(502)` yang
sengaja dibangkitkan — menjadi `500 Internal Server Error` teks kosong, manakala `wrangler dev`
mencetak stack trace sebenar. Dibaiki dengan `app.onError(handler)` yang memulangkan
`Response` terus (ia tidak boleh set `c.res` dan mengharap ia kekal). Lihat
`references/hono-patterns.md` dalam skill `cloudflare-workers-d1`.

**7.2 OSRM demo menolak `User-Agent` kosong dengan 403.**
`router.project-osrm.org` dibalukan nginx yang membalas **403 Forbidden** (badan HTML nginx,
bukan JSON OSRM) kepada sebarang permintaan tanpa `User-Agent` yang sah. Ia kelihatan seperti
masalah rangkaian atau URL, dan ia *tidak* boleh dikesahkan dari shell — `curl` berjaya dari IP
tempatan manakala Worker gagal. Sentiasa hantar `User-Agent` dalam fetch keluar, dan jangan
guna `cf: { cacheEverything: true }` pada panggilan API luar.

**7.3 `confidence` ialah kolum tersimpan — ia mesti dikemas kini dalam UPDATE undian.**
Jadual `reports` menyimpan `confidence`. Versi awal `confirmReport`/`dismissReport` hanya
menambah `confirm_count`/`dismiss_count`, jadi bacaan seterusnya sentiasa memulangkan `0`
walaupun `confirmCount` sudah bertambah — manakala siaran masa nyata membawa nilai yang
dikira semula oleh JS. Dua sumber kebenaran yang tidak sepadan. Sekarang kedua-dua kolum
dikemas kini dalam `UPDATE ... RETURNING` yang sama; SQLite menilai semua ungkapan `SET`
terhadap nilai baris **asal**, jadi `confirm_count + 1` di dalam ungkapan `confidence`
bersamaan dengan nilai selepas tambah.

Peraturan umum: **apabila satu nilai mempunyai dua sumber (kolom tersimpan vs nilai yang
dikira semula), ia akan tidak sepadan suatu hari.** Simpan satu sahaja, atau kemas kini
kedua-duanya dalam transaksi yang sama.
