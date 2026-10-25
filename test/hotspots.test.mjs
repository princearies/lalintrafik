// ============================================================
//  Ujian endpoint /api/v1/hotspots
//
//  Dijalankan atas `node:sqlite` sebenar dengan DDL sebenar daripada
//  db/schema.sql, jadi SQL agregasi (ROUND, GROUP BY, HAVING) yang
//  sebenar diuji — bukan mock.
//
//  Mengunci:
//   1. Laporan dikumpulkan ke sel grid; sel terpanas dulu.
//   2. Luput / DISMISSED dikecualikan.
//   3. `dominantType` dan `heat` dikira dengan betul.
//   4. `gridDp` mengubah saiz sel.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = path.join(root, 'node_modules/.bin/esbuild.cmd');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

console.log('\n[0] Transpile + skema sebenar');
const out = path.join(here, '_hotspots.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/routes/hotspots.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const { hotspots } = await import('file:///' + out.replace(/\\/g, '/'));
console.log('  transpile hotspots.ts OK');

const SCHEMA = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);

// ---------- D1 shim ----------
const d1 = {
  prepare(sql) {
    let bound = [];
    return {
      bind(...args) { bound = args; return this; },
      async all() {
        const rows = db.prepare(sql).all(...bound);
        return { results: rows, success: true };
      },
      async first() {
        return db.prepare(sql).get(...bound) ?? null;
      },
      async run() {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
    };
  },
};

const ENV = { DB: d1, GEOFENCE_RADIUS_M: '90000', CENTER_LAT: '5.8943', CENTER_LNG: '116.0505' };

/** Masukkan satu laporan dengan kawalan penuh ke atas status & TTL. */
function insert(o) {
  db.prepare(
    `INSERT INTO reports
       (id, type, lat, lng, geohash, severity, status,
        confirm_count, dismiss_count, confidence, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id, o.type, o.lat, o.lng, 'xxxxxxx', o.severity ?? 0, o.status ?? 'ACTIVE',
    o.confirmCount ?? 0, o.dismissCount ?? 0, o.confidence ?? 0,
    o.createdAt ?? Date.now(), o.expiresAt ?? Date.now() + 3_600_000,
  );
}

const NOW = Date.now();
const PUTATAN = { lat: 5.8943, lng: 116.0505 };

// --- susun data ujian ---
// Sel A (Putatan): 4 ACCIDENT — paling panas.
//
// Langkah 0.00002 (~2 m) supaya KEEMPAT-EMPATNYA kekal dalam sel 3 dp
// yang sama. Data ujian pertama saya guna langkah 0.0002 / 0.00005 dan
// gagal — bukan kerana kod, tetapi kerana SQLite membulatkan
// `ROUND(116.0505, 3)` kepada **116.050** (bukan 116.051), jadi titik
// yang mula tepat di sempadan .0005 akan terbelah antara dua sel.
// Lihat [7] di bawah.
for (let i = 0; i < 4; i++) {
  insert({ id: `A${i}`, type: 'ACCIDENT', lat: 5.89420 + i * 0.00002,
           lng: 116.05040 + i * 0.00002, confidence: 80 });
}
// Sel B (Papar): 2 TRAFFIC_JAM
for (let i = 0; i < 2; i++) {
  insert({ id: `B${i}`, type: 'TRAFFIC_JAM', lat: 5.73330 + i * 0.00002,
           lng: 115.93330 + i * 0.00002, confidence: 40 });
}
// Sel C (Kimanis): 1 SPEED_TRAP
insert({ id: 'C0', type: 'SPEED_TRAP', lat: 5.5333, lng: 115.8833, confidence: 20 });
// Di luar kumpulan: laporan LUPUT dan DISMISSED
insert({ id: 'X1', type: 'ACCIDENT', lat: PUTATAN.lat, lng: PUTATAN.lng,
         expiresAt: NOW - 1000, status: 'ACTIVE' });
insert({ id: 'X2', type: 'ACCIDENT', lat: PUTATAN.lat, lng: PUTATAN.lng,
         status: 'DISMISSED' });

const get = async (qs) => {
  // Sub-app didaftarkan pada '/', jadi ujian memanggil terus ke '/'.
  // Dalam pengeluaran index.ts memasangnya pada '/api/v1/hotspots'.
  const res = await hotspots.request(`/${qs}`, {}, ENV);
  return { status: res.status, body: await res.json() };
};

console.log('\n[1] Kumpulan mengikut sel — terpanas dahulu');
{
  const { status, body } = await get('');
  ok(status === 200, `HTTP 200 (sebenar: ${status})`);
  ok(body.success === true, 'success=true');
  ok(body.data.length === 3, `3 sel (sebenar: ${body.data.length})`);

  const top = body.data[0];
  ok(top.total === 4, `sel terpanas: 4 laporan (sebenar: ${top.total})`);
  ok(Math.abs(top.lat - PUTATAN.lat) < 0.002, `sel terpanas di Putatan (${top.lat})`);
  ok(top.dominantType === 'ACCIDENT', `dominantType=ACCIDENT (sebenar: ${top.dominantType})`);
  ok(top.heat === 1, `heat=1.00 untuk sel terpanas (sebenar: ${top.heat})`);

  const second = body.data[1];
  ok(second.total === 2 && second.dominantType === 'TRAFFIC_JAM',
    `kedua: 2 TRAFFIC_JAM (sebenar: ${second.total} ${second.dominantType})`);
  ok(second.heat === 0.5, `heat=0.50 (sebenar: ${second.heat})`);

  const third = body.data[2];
  ok(third.total === 1 && third.dominantType === 'SPEED_TRAP',
    `ketiga: 1 SPEED_TRAP (sebenar: ${third.total} ${third.dominantType})`);
  ok(third.heat === 0.25, `heat=0.25 (sebenar: ${third.heat})`);
}

console.log('\n[2] Luput & DISMISSED dikecualikan');
{
  const { body } = await get('');
  const total = body.data.reduce((s, r) => s + r.total, 0);
  ok(total === 7, `hanya 7 laporan ACTIVE & segar (sebenar: ${total})`);
}

console.log('\n[3] Tindan & kepercayaan');
{
  const { body } = await get('');
  const top = body.data[0];
  ok(top.breakdown.accident === 4, `breakdown.accident=4 (sebenar: ${top.breakdown.accident})`);
  ok(top.breakdown.speedTrap === 0, 'breakdown.speedTrap=0');
  ok(top.confidenceAvg === 80, `confidenceAvg=80 (sebenar: ${top.confidenceAvg})`);
  ok(typeof top.rank === 'number' && top.rank === 1, `rank=1 (sebenar: ${top.rank})`);
}

console.log('\n[4] gridDp mengubah saiz sel');
{
  // gridDp 3 (~110 m) memisahkan 5.89430 dan 5.89450
  const { body: dp3 } = await get('?gridDp=3&minLat=5.894&maxLat=5.895&minLng=116.050&maxLng=116.051');
  ok(dp3.data.length === 1, `gridDp=3 → 1 sel (sebenar: ${dp3.data.length})`);
  ok(dp3.data[0].total === 4, `4 laporan dalam sel itu (sebenar: ${dp3.data[0].total})`);

  // gridDp 2 (~1.1 km) menggabungkan semuanya
  const { body: dp2 } = await get('?gridDp=2&minLat=5.894&maxLat=5.895&minLng=116.050&maxLng=116.051');
  ok(dp2.data.length === 1, `gridDp=2 → 1 sel (sebenar: ${dp2.data.length})`);
  ok(dp2.meta.cellMeters === 1113, `gridDp=2 ≈ ${dp2.meta.cellMeters} m/sel`);
  ok(dp3.meta.cellMeters === 111, `gridDp=3 ≈ ${dp3.meta.cellMeters} m/sel`);
}

console.log('\n[5] Penapis peti & had');
{
  // Peti sempit di Papar sahaja
  const { body } = await get('?minLat=5.73&maxLat=5.74&minLng=115.93&maxLng=115.94');
  ok(body.data.length === 1, `peti Papar → 1 sel (sebenar: ${body.data.length})`);
  ok(body.data[0].total === 2, `2 laporan (sebenar: ${body.data[0].total})`);

  // minCount menbuang sel kecil
  const { body: filtered } = await get('?minCount=2');
  ok(filtered.data.length === 2, `minCount=2 → buang sel 1 laporan (sebenar: ${filtered.data.length})`);

  // limit
  const { body: limited } = await get('?limit=1');
  ok(limited.data.length === 1, `limit=1 → 1 sel (sebenar: ${limited.data.length})`);

  // nilai tak sah → jatuh balik ke lalai, BUKAN ralat
  const { body: bad } = await get('?gridDp=abc&limit=abc&minCount=-5');
  ok(bad.success === true, 'nilai tak sah → lalai selamat (tiada 500)');
  ok(bad.meta.gridDp === 3, `gridDp=abc → lalai 3 (sebenar: ${bad.meta.gridDp})`);
  ok(bad.meta.count === 3, `limit=abc → lalai 50 (sebenar: ${bad.meta.count})`);

  // nilai di luar julat → DIKELIMKAN ke sempadan, bukan ditolak
  const { body: clamped } = await get('?gridDp=99&limit=9999');
  ok(clamped.meta.gridDp === 5, `gridDp=99 → dikelimkan ke 5 (sebenar: ${clamped.meta.gridDp})`);
  ok(clamped.meta.count === 7, `gridDp=5 → setiap laporan sel sendiri (sebenar: ${clamped.meta.count})`);
  ok(clamped.meta.count <= 200, `limit dikelimkan ke 200 (sebenar: ${clamped.meta.count})`);
}

console.log('\n[6] Tanpa D1');
{
  const res = await hotspots.request('/', {}, { DB: undefined });
  const body = await res.json();
  ok(res.status === 500, `HTTP 500 (sebenar: ${res.status})`);
  ok(/pangkalan data/.test(body.error), `mesej ralat kemas: "${body.error}"`);
}

console.log('\n[7] Sempadan sel — SQLite ROUND bukan "bundar ke atas"');
{
  // Penemuan sebenar: ROUND(116.0505, 3) = 116.050, BUKAN 116.051.
  // Ini adalah perangkap sebenar — titik yang mula tepat di sempadan
  // .0005 akan terbelah antara dua sel. Ujian ini menguncinya supaya
  // perubahan pada SQLite nanti tidak menyelinap masuk tanpa perhatian.
  const r1 = db.prepare('SELECT ROUND(?, 3) AS a').get(116.0505);
  const r2 = db.prepare('SELECT ROUND(?, 3) AS a').get(116.05055);
  ok(r1.a === 116.05, `ROUND(116.0505, 3) = ${r1.a} (bukan 116.051)`);
  ok(r2.a === 116.051, `ROUND(116.05055, 3) = ${r2.a}`);

  // Kesannya ke atas sel: dua titik 2 m terpisah berkongsi sel,
  // manakala titik ketiga di seberang sempadan berada dalam sel lain.
  insert({ id: 'E1', type: 'HAZARD', lat: 5.89610, lng: 116.05230, confidence: 10 });
  insert({ id: 'E2', type: 'HAZARD', lat: 5.89612, lng: 116.05232, confidence: 10 });
  const { body } = await get('?minLat=5.896&maxLat=5.897&minLng=116.052&maxLng=116.054');
  const cells = body.data.map((x) => `${x.lat},${x.lng}:${x.total}`);
  ok(cells.length === 1 && cells[0] === '5.896,116.052:2',
    `dua titik 2 m terpisah berkongsi sel (${cells.join(' | ')})`);

  // Di seberang sempadan 116.0525 — mereka terbelah.
  insert({ id: 'E3', type: 'HAZARD', lat: 5.89620, lng: 116.05330, confidence: 10 });
  const { body: split } = await get('?minLat=5.896&maxLat=5.897&minLng=116.052&maxLng=116.054');
  const totals = split.data.map((x) => x.total).sort();
  ok(totals.length === 2 && totals[0] === 1 && totals[1] === 2,
    `selepas titik ketiga → 2 sel terbelah (${totals.join(', ')})`);
}

console.log('\n[8] Kotak lalai dikelimkan ke julat koordinat yang sah');
{
  // Tanpa peti, pelayan mengelirukan geofence 90 km sebagai kotak darjah
  // penuh. 90 km ke selatan Putatan ialah -802 darjah — `meta.bbox` tidak
  // boleh mengaluarkan klien memetakannya.
  const { body } = await get('');
  const b = body.meta.bbox;
  ok(b.minLat >= -90 && b.maxLat <= 90, `lat dikelimkan (sebenar: ${b.minLat}..${b.maxLat})`);
  ok(b.minLng >= -180 && b.maxLng <= 180, `lng dikelimkan (sebenar: ${b.minLng}..${b.maxLng})`);
  ok(b.minLat < b.maxLat && b.minLng < b.maxLng, 'kotak lalai tidak songsang');
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
