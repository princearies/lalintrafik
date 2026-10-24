# LALINTRAFIK 🗺️

Aplikasi web komuniti untuk laporan trafik, navigasi dan insiden — ala Waze, tetapi ringan dan dihoskan sepenuhnya di Cloudflare Edge.

**Stack:** Cloudflare Workers · Hono.js (TypeScript) · D1 (SQLite) · Durable Objects · MapLibre GL JS · OSRM

---

## Ciri

| Ciri | Cara ia bekerja |
|---|---|
| Laporan insiden | `POST /api/v1/reports` — kemalangan, perangkap, bahaya, sesak, polis, tutup jalan |
| Kuari berdekatan | `GET /api/v1/reports/nearby` — peti bounding + Haversine, di bawah 5ms |
| Masa nyata | WebSocket ke Durable Object, siaran geofenced kepada 8 sel jiranan |
| Navigasi | `GET /api/v1/routing` — OSRM dengan cache D1 |
| Kepercayaan komuniti | `confirm` / `dismiss` → skor keyakinan 0–100 |
| TTL automatik | laporan luput mengikut jenis; cron `*/5 * * * *` membersihkan |

---

## Struktur Projek

```
lalintrafik/
├── db/
│   └── schema.sql            ← 4 jadual + 8 index + CHECK constraints
├── src/
│   ├── index.ts              ← titik masuk Worker (Hono)
│   ├── types.ts              ← jenis & Env
│   ├── lib/
│   │   ├── geo.ts            ← geohash, haversine, peti bounding
│   │   └── errors.ts         ← ValidationError, AppError, pengesah
│   ├── middleware/
│   │   └── cors.ts           ← CORS + pengendali ralat berpusat
│   ├── db/
│   │   └── reports.ts        ← lapisan data D1
│   ├── routes/
│   │   ├── reports.ts        ← laporan + nearby + undian
│   │   ├── routing.ts        ← OSRM + cache
│   │   └── ws.ts             ← penghubung Worker ↔ Durable Object
│   └── do/
│       └── GridDO.ts         ← Durable Object siaran
├── frontend/
│   └── index.html            ← demo MapLibre (buka terus di pelayar)
├── test/
│   ├── schema.test.mjs       ← 16 ujian (SQLite tempatan)
│   ├── geo.test.mjs          ← 29 ujian (geohash, Haversine, peti bounding)
│   ├── data.test.mjs         ← 22 ujian (lapisan D1 dengan mock)
│   ├── routing.test.mjs      ← 22 ujian (OSRM melalui pelayan mock)
│   ├── votes.test.mjs        ← 21 ujian (confirm/dismiss pada SQLite sebenar)
│   └── _e2e_live.mjs         ← 13 ujian WebSocket→DO (perlu `wrangler dev`)
├── ARCHITECTURE.md           ← seni bina + aliran data (ASCII)
└── wrangler.toml
```

---

## Permulaan Pantas

```bash
npm install

# 1. Cipta D1
npx wrangler d1 create lalintrafik

# 2. Guna ID yang diberikan dalam wrangler.toml
#    database_id = "…"

# 3. Guna skema
npx wrangler d1 execute lalintrafik --remote --file=db/schema.sql

# 4. Uji setempat
npm run dev

# 5. Buka demo
#    frontend/index.html — klik "Cari saya" untuk mula
```

**Ujian:**

```bash
npm run typecheck   # 0 ralat
npm test            # 110 PASS (schema 16, geo 29, data 22, routing 22, votes 21)
npm run test:e2e    # 13 PASS — perlu `wrangler dev` sedang berjalan
```

### Dua perangkap yang dijumpai (dan dikunci oleh ujian)

**1. Ralat Hono tidak dapat ditangkap oleh middleware `try/catch`.**
Hono 4 (`compose.js`) menangkap pengecualian di peringkat `dispatch` route
dan menyerahkannya terus kepada `onError` — middleware luaran tidak pernah
melihat penolakan `next()`. Akibatnya setiap ralat menjadi `500 Internal
Server Error` yang sama. Gunakan `app.onError(handler)`, bukan
`app.use('*', tryCatch)`.

**2. OSRM demo menolak `User-Agent` kosong dengan 403.**
`router.project-osrm.org` dibalukan nginx yang membalas **403 Forbidden**
kepada sebarang permintaan tanpa `User-Agent` yang sah. Tanda sebenar:
badan balasan ialah HTML nginx, bukan JSON OSRM — jadi jangan salah sangka
dengan rangkaian. Hantar `User-Agent: lalintrafik/1.0 (...)`. Diuji dalam
`test/routing.test.mjs` melalui pelayan mock yang merakam kepala yang
diterima.

---

## Rujukan API

### Hantar laporan

```http
POST /api/v1/reports
X-Device-Id: dev-abc123
Content-Type: application/json

{
  "type": "ACCIDENT",
  "lat": 3.1390,
  "lng": 101.6869,
  "accuracyM": 12,
  "note": "Bas rempat menunggu di sisi",
  "severity": 2
}
```

```
201 Created
{ "success": true, "data": { "id": "…", "type": "ACCIDENT", "expiresAt": "…", "ttlMs": 2700000 } }
```

### Laporan berdekatan

```http
GET /api/v1/reports/nearby?lat=3.1390&lng=101.6869&radiusM=5000&limit=50
GET /api/v1/reports/nearby?lat=3.1390&lng=101.6869&radiusM=5000&type=SPEED_TRAP
```

```json
{
  "success": true,
  "data": [{ "id": "…", "type": "ACCIDENT", "lat": 3.1391, "lng": 101.687,
             "distanceM": 15, "confirmCount": 3, "confidence": 75 }],
  "meta": { "center": { "lat": 3.139, "lng": 101.6869 }, "radiusM": 5000, "count": 1 }
}
```

### Undian

```http
POST /api/v1/reports/:id/confirm?cell=w283cg   → { "confirmCount": 4, "confidence": 80 }
POST /api/v1/reports/:id/dismiss?cell=w283cg   → { "dismissCount": 1, "confidence": 67 }
```

### Routing

```http
GET /api/v1/routing?lat1=3.139&lng1=101.6869&lat2=1.4927&lng2=103.7414
```

```json
{
  "success": true,
  "data": { "distanceM": 292610, "durationS": 10843,
             "geometry": { "type": "LineString", "coordinates": [[101.6869, 3.139], …] },
             "provider": "osrm", "cached": false }
}
```

### WebSocket

```js
const ws = new WebSocket(`https://<worker>/api/v1/ws?cell=${geohash(lat, lng, 6)}`);
ws.send(JSON.stringify({ kind: 'subscribe', cell, lat, lng }));

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  // { kind: 'presence', online: 12 }
  // { kind: 'report.new', report: {…} }
  // { kind: 'report.confirm', id, confirmCount, confidence }
};
```

---

## Keputusan Rekabentuk

### Kenapa peti bounding + Haversine, bukan hanya Haversine?

D1 tidak mempunyai indeks spatial (tiada PostGIS, tiada R-tree dalam SQLite Edge).
Haversine tulen memerlukan `SELECT * FROM reports` — setiap laporan, seluruh dunia,
setiap kali. Tidak boleh diterima.

Sebaliknya: hitung peti segi empat tepat (min/max lat/lng), gunakan `idx_reports_bbox`
untuk mengurangkan kepada ratusan baris, kemudian gunakan Haversine untuk ketepatan.
Peti itu sengaja melebih-lebihkan (ia segi empat tepat), jadi tapisan kedua diperlukan.

**Kos:** indeks berjaya pada set 10,000 baris dalam **1.53ms**.

### Kenapa Durable Objects, bukan KV atau D1?

Siaran masa nyata memerlukan mengubah soket yang sudah sedia ada. Hanya Durable Objects
mengekalkan WebSockets. KV dan D1 adalah store — bukan saluran.

DO juga menyelesaikan masalah kedua: **geofencing**. Dengan satu DO setiap sel geohash-6
(~1.2km × 0.6km), DO tahu tepat siapa yang berdekatan. Tiada pertanyaan "siapa dalam 5km
saya?" — ia sudah diketahui secara struktur.

### Kenapa satu sel setiap laporan?

Garis lintang 6 aksara geohash ≈ 1.2km × 0.6km. Ia lebih besar daripada radius 5km
yang anda pertanyakan — maksudnya sel yang sama sering kali dilanggan oleh ramai
pengguna berdekatan. Fanout kepada 8 jiranan meliputi ~10km, supaya pengguna di
sempadan masih melihat insiden seberang sempadan.

### Kenapa hulung `device_id`, bukan akaun?

Tiada kata laluan, tiada e-mel, tiada data peribadi. Pengguna kekal tanpa nama; peranti
mereka mengenal pasti mereka. Ini menghapuskan seluruh kelas risiko privasi — dan
menghapuskanfriction pendaftaran.

### TTL mengikut jenis insiden

| Jenis | TTL | Sebab |
|---|---|---|
| `ACCIDENT` | 45 minit | insiden singkat |
| `SPEED_TRAP` | 90 minit | penguatkuasaan bergerak |
| `POLICE` | 90 minit | sama |
| `TRAFFIC_JAM` | 60 minit | kesesakan berubah cepat |
| `HAZARD` | 6 jam | bahaya kekal |
| `ROAD_CLOSURE` | 24 jam | penutupan rasmi |
| `WEATHER` | 3 jam | berubah |
| `COMMUNITY` | 12 jam | berita komuniti |

Laporan tamat disaring dalam setiap pertanyaan (`expires_at > ?`) **dan** dibuang oleh
cron, jadi D1 tidak membesar tanpa had.

### CORS: tuas halus yang mudah tersalah

```ts
// SALAH — imbasan menafikan kombinasi ini
'Access-Control-Allow-Origin: *'
'Access-Control-Allow-Credentials: true'

// BETUL — pacak balik asal sebenar
'Access-Control-Allow-Origin: <origin>'
'Vary: Origin'
```

---

## Had dan Batasan

| Had | Nilai | Diurus bagaimana |
|---|---|---|
| CPU Worker | 30s berbayar / 10ms percuma | DO menyerap kerja siaran |
| Subrequest | 50 percuma / 1000 berbayar | 9 subrequest setiap laporan (1 sel + 8 jiran) |
| Baca D1 | 5B/hari percuma | peti bounding + index |
| Tulis D1 | 100k/hari percuma | disederhanakan |
| WebSocket DO | 3MB/hari keluar percuma | hibernasi |
| Payload | 100MB | had badan 8KB dalam `readJson()` |

**Titik berkala:** ~10,000 laporan/hari, apabila subrequest mula dikenakan.
Naik taraf kepada Workers Paid ($5/bln) atau kumpulkan siaran.

---

## Keselamatan

- **Tiada rahsia dalam `wrangler.toml`** — guna `wrangler secret put`
- **Had badan** menolak muat naik gergasi sebelum diproses
- **Had kadar** untuk laluan tulis (naik taraf: `ratelimit` binding)
- **Tiada data peribadi** disimpan — hanya `device_id` dan lokasi yang dihantar
- **Ralat D1** tidak didedah kepada pelanggan (hanya log dalaman)

---

## Pelan Hala

1. **Siaran berkeselompok** — kumpulkan laporan untuk sel yang sama dan siarkan sekali
2. **Arah perbelaluan** — libatkan pilihan rute dalam pertanyaan nearby
3. **Belanjawan jalan** — pastikan laporan secara automatik apabila pengguna lulus
4. **Foto** — lampiran R2 untuk laporan
5. **Analisis** — taburan insiden dari semasa ke semasa

---

## Lesen

MIT
