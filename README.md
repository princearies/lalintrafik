# MYKIRA MAP 🗺️

Aplikasi web komuniti untuk laporan trafik, navigasi dan insiden — ala Waze, tetapi ringan dan dihoskan sepenuhnya di Cloudflare Edge.

**Stack:** Cloudflare Workers · Hono.js (TypeScript) · D1 (SQLite) · Durable Objects · MapLibre GL JS · OSRM

**Siap untuk Android** — API REST dan WebSocket adalah tulen, tiada kekangenan framework frontend.

**Worker:** `https://mykira-map.mykira.workers.dev` · **Repo:** `github.com/princearies/mykira-map`

---

## Ciri

| Ciri | Cara ia bekerja |
|---|---|
| Laporan insiden | `POST /api/v1/reports` — kemalangan, perangkap, bahaya, sesak, polis, tutup jalan |
| Kuari berdekatan | `GET /api/v1/reports/nearby` — peti bounding + Haversine, di bawah 5ms |
| Masa nyata | WebSocket ke Durable Object, siaran geofenced kepada 8 sel jiranan |
| Navigasi | `GET /api/v1/routing` — OSRM dengan **smart cache D1** |
| Hotspot | `GET /api/v1/hotspots` — agregasi kepadatan grid + lapisan kluster |
| Kepercayaan komuniti | `confirm` / `dismiss` → skor keyakinan 0–100 |
| TTL automatik | laporan luput mengikut jenis; cron `*/5 * * * *` membersihkan |

---

## Zon Operasi — Koridor Selatan Sabah

Aplikasi ini **berlesen untuk satu koridor sahaja**:

```
Kota Kinabalu → Putatan → Papar → Kimanis → Membakut (Kg Pimping)
```

Semua laporan ditapis oleh geofence **sebelum** menyentuh D1.

| Tetapan | Nilai |
|---|---|
| Titik tengah | `5.8943, 116.0505` — **Putatan, Sabah** |
| Had radius | **90 km** (julat diminta 80–100 km) |
| Jarak dari pusat | KK 10 · KKIA 5 · Petagas 3 · Lok Kawi 5 · Papar 22 · Kimanis 44 · Membakut 62 km |

```
POST /api/v1/reports   dengan lat/lng di luar 90 km  →  422
{"success":false,"error":"Laporan di luar zon operasi — 1621.2 km dari Putatan (had 90 km)"}
```

Empat sifat penting:

1. **Dipaksa sebelum D1** — laporan luar zon tidak pernah masuk pangkalan data.
2. **`/nearby` tanpa koordinat** jatuh balik ke Putatan dengan radius 90 km.
3. **Radius `/nearby` tidak pernah melebihi geofence** — klien tidak boleh menarik laporan dari seluruh Sabah.
4. **Titik tengah di Putatan, bukan KK** — supaya KK (utara) dan Membakut (selatan) berada pada jarak yang hampir sama di dalam bulatan geofence.

Semua tetapan boleh ditukar tanpa mengubah kod:

```toml
CENTER_LAT          = "5.8943"
CENTER_LNG          = "116.0505"
GEOFENCE_RADIUS_M   = "90000"
```

Nilai env yang rosak (kosong, bukan nombor, negatif) **jatuh balik kepada lalai**, bukan mematikan geofence. Ini penting kerana `Number('')` ialah `0`, bukan `NaN` — tanpa semakan rentetan kosong, satu pembolehubah kosong akan mengalih geofence ke 0°E tanpa sebarang ralat.

---

## Smart Cache Laluan (D1)

Routing ialah panggilan keluar yang paling mahal, jadi ia disimpan dalam D1.

```
permintaan laluan
      │
      ├─ bundar koordinat kepada 3 dp (~110 m)
      │
      ├─ D1?  ──ada & belum luput──→  balas (< 10 ms, tiada OSRM)
      │        │
      │        └─tiada/luput─┐
      │                      ↓
      └──────────────────→  OSRM  →  simpan ke D1 (7 hari) → balas
```

### Skema

```sql
CREATE TABLE route_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_lat  REAL NOT NULL,      -- dibundarkan 3 dp
  origin_lng  REAL NOT NULL,
  dest_lat    REAL NOT NULL,
  dest_lng    REAL NOT NULL,
  route_data  TEXT NOT NULL,      -- GeoJSON LineString mentah
  distance    REAL,               -- meter
  duration    REAL,               -- saat
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_route_coords
  ON route_cache (origin_lat, origin_lng, dest_lat, dest_lng);
```

### Tiga keputusan rekaan

**Kunci dibundarkan kepada 3 tempat perpuluhan (~110 m).** Sengaja kasar:
laluan yang titik mulanya berbeza ~100 m berkongsi entri yang sama. Untuk
trafik araya (bukan navigasi pintu-ke-pintu) perbezaan itu tidak ketara,
dan kadar hit cache meningkat dengan ketara.

Pembundaran dilakukan dengan `toFixed(3)`, **bukan**
`Math.round(v * 1000) / 1000`. Keduanya berbeza pada nilai sempadan — bagi
`116.0505` yang pertama memberi `116.050` manakala yang kedua memberi
`116.051` — kerana pendaraban `v * 1000` membundarkan double terlebih
dahulu. `toFixed` membundar pada double yang sama seperti `ROUND()` SQLite
lihat, jadi kunci JS dan sel SQL tidak akan lari berasingan. Lihat
`references/geo-aggregation-on-d1.md` dalam skill `cloudflare-workers-d1`.

**A→B dan B→A berkongsi entri.** Laluan disimpan dalam **kedua-dua** susunan,
jadi bacaan sentiasa satu pertanyaanan dan laluan balik dari Membakut ke KK
tidak pernah memanggil OSRM. Kosnya dua baris untuk satu laluan — berbaloi.

**Indeks koordinat adalah UNIQUE**, bukan sekadar indeks biasa. Ia melindungi
carian koordinat *dan* menghalang baris pendupa apabila laluan yang sama
diminta serentak oleh berbilang peranti.

### Dua perangkap yang nyata

**Tulisan cache mesti didaftarkan dengan `ctx.waitUntil()`.** Menggunakan
`void promise` kelihatan bersih tetapi runtime boleh membatalkan tulisan
begitu balasan dihantar — dan ia gagal **senyap**. Gejala fosilnya: hanya
5 baris muncul daripada 32 panggilan, tanpa sebarang mesej ralat.

**Hanya laluan 2 titik diCache.** Dua laluan yang berbeza perantaraan akan
berkongsi kunci dan yang kedua menerima geometri yang **SALAH**. Cache yang
salah lebih buruk daripada cache miss, jadi laluan 3+ titik diteruskan terus
ke OSRM.

---

## Struktur Projek

```
mykira-map/
├── db/
│   └── schema.sql               ← 4 jadual (users, reports, live_sessions, route_cache)
├── src/
│   ├── index.ts                 ← titik masuk Hono
│   ├── types.ts                 ← jenis + Env
│   ├── lib/
│   │   ├── errors.ts            ← ValidationError, AppError, pangkuh input
│   │   ├── geo.ts               ← geohash, Haversine, peti bounding
│   │   └── geofence.ts          ← geofence koridor Sabah
│   ├── db/
│   │   └── reports.ts           ← lapisan akses D1
│   ├── middleware/
│   │   └── cors.ts              ← CORS + errorHandler
│   ├── routes/
│   │   ├── reports.ts           ← laporan (cipta/nearby/confirm/dismiss)
│   │   ├── routing.ts           ← OSRM + smart cache D1
│   │   └── ws.ts                ← penghubung Worker ↔ Durable Object
│   └── do/
│       └── GridDO.ts            ← Durable Object siaran
├── frontend/
│   └── index.html               ← demo MapLibre (buka terus di pelayar)
├── scripts/
│   ├── deploy_worker_rest.py    ← deploy melalui REST API
│   ├── apply_schema_remote.py   ← guna schema.sql melalui REST
│   └── migrate_route_cache.py   ← wujudkan semula route_cache
├── test/
│   ├── schema.test.mjs          ← skema + CHECK constraints
│   ├── geo.test.mjs             ← geohash, Haversine, peti bounding
│   ├── data.test.mjs            ← lapisan D1
│   ├── routing.test.mjs         ← OSRM + User-Agent
│   ├── votes.test.mjs           ← confirm/dismiss (SQLite sebenar)
│   ├── geofence.test.mjs        ← geofence koridor
│   ├── route_cache.test.mjs     ← smart cache (SQLite sebenar)
│   └── _e2e_live.mjs            ← WebSocket→DO (perlu server hidup)
├── ARCHITECTURE.md
└── wrangler.toml
```

---

## Permulaan Pantas

```bash
npm install
npm run db:apply:local     # jadual ke D1 setempat
npm run dev                # http://localhost:8787
```

Buka `frontend/index.html` terus di pelayar untuk peta.

**Ujian:**

```bash
npm run typecheck   # 0 ralat
npm test            # 130 PASS (7 fail ujian)
npm run test:e2e    # 20 PASS — perlu `wrangler dev` sedang berjalan
```

---

## Rujukan API

### Maklumat

```http
GET /              → nama, userAgent, zon operasi
GET /healthz       → { status: "ok", ts }
```

### Laporan

| Kaedah | Laluan | Keterangan |
|---|---|---|
| POST | `/api/v1/reports` | Header `X-Device-Id` diperlukan |
| GET | `/api/v1/reports/nearby` | `lat`, `lng`, `radiusM` — semua pilihan, lalai ke Putatan |
| GET | `/api/v1/reports` | `minLat`, `minLng`, `maxLat`, `maxLng` |
| GET | `/api/v1/reports/:id` | satu laporan |
| POST | `/api/v1/reports/:id/confirm` | `?cell=` untuk siaran masa nyata |
| POST | `/api/v1/reports/:id/dismiss` | `?cell=` untuk siaran masa nyata |

### Routing

```http
GET /api/v1/routing?lat1=5.9804&lng1=116.0735&lat2=5.4500&lng2=115.7300
```

Karakter respons: `{ success, data: { distanceM, durationS, geometry, provider, cached } }`
— `provider` ialah `"osrm"` untuk laluan baharu dan `"cache"` untuk yang
dibaca dari D1.

### Hotspot

```http
GET /api/v1/hotspots?gridDp=3&limit=50&minCount=1&minLat=&maxLat=&minLng=&maxLng=
```

Satu pertanyaan SQL: kumpulkan laporan mengikut `ROUND(lat, dp)` / `ROUND(lng, dp)`
dan susun menurun mengikut jumlah. Tiada jadual baharu, tiada pek — selamat
dipanggil kerap oleh Android.

| Parameter | Julat | Lalai | Kesan |
|---|---|---|---|
| `gridDp` | 1–5 | 3 | kedalaman grid (~111 m pada dp 3) |
| `limit` | 1–200 | 50 | bilangan sel dipulangkan |
| `minCount` | ≥1 | 1 | buang sel lebih rendah daripada ini |
| `minLat`…`maxLng` | — | geofence penuh | peti pandangan |

Nilai di luar julat **dikelimkan**, bukan ditolak; nilai tak sah jatuh balik
ke lalai. Kotak lalai dikelimkan kepada `[-90, 90]` / `[-180, 180]` supaya
`meta.bbox` tidak pernah mengeluarkan koordinat mustahil.

Karakter respons:

```jsonc
{
  "success": true,
  "data": [{
    "rank": 1, "lat": 5.894, "lng": 116.05,
    "total": 6,                      // laporan dalam sel ini
    "dominantType": "HAZARD",        // untuk warna ikon
    "confidenceAvg": 17,             // purata keyakinan komuniti
    "heat": 1.0,                     // 0..1, normal terhadap sel terpanas
    "breakdown": { "accident": 1, "speedTrap": 0, "hazard": 5,
                   "trafficJam": 0, "police": 0, "roadClosure": 0 }
  }],
  "meta": { "gridDp": 3, "cellMeters": 111, "count": 1, "bbox": { } }
}
```

`heat` dinormalkan supaya klien mewarnakan peta tanpa perlu tahu jumlah mutlak.
Laporan `DISMISSED` dan yang telah luput dikecualikan.

> **Perangkap SQLite.** `ROUND(x, 3)` bukan "bundar ke atas":
> `ROUND(116.0505, 3)` = **116.050**, bukan 116.051. Dua laporan yang
> berjarak 1 m tidak semestinya berada dalam sel yang sama. Ini kelakaran
> SQLite, dan dikunci oleh ujian `test/hotspots.test.mjs` bahagian [7].

### Masa nyata

```http
GET /api/v1/ws?cell=<geohash 6 aksara>
```

---

## Bacaan Lanjut

- `ARCHITECTURE.md` — aliran data, model kekerapan, perangkap
- `db/schema.sql` — skema penuh dengan komen rekaan
