// ============================================================
//  Ujian cache laluan D1 — skema KOORDINAT
//
//  Menggunakan `node:sqlite` sebenar dengan DDL sebenar daripada
//  db/schema.sql, jadi ia menguji SQL sebenar termasuk strftime().
//  Setiap senario mendapat pangkalan baru supaya tiada saling ganggu.
//
//  Mengunci:
//   1. Miss → OSRM dipanggil, keputusan disimpan ke D1.
//   2. Hit → OSRM TIDAK dipanggil lagi; data dari D1.
//   3. A→B dan B→A berkongsi entri (laluan balik tidak panggil OSRM).
//   4. Kunci dibundarkan 3 dp (~110 m) — titik berdekatan berkongsi.
// ============================================================
import http from 'node:http';
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
const out = path.join(here, '_route_cache.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/routes/routing.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const { getRouteCached, routeKeyRound, USER_AGENT } =
  await import('file:///' + out.replace(/\\/g, '/'));
console.log('  transpile routing.ts OK');

const SCHEMA = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8');

/** Pangkalan baharu dengan skema sebenar — diasingkan untuk setiap senario. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    d1: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          async first() {
            return db.prepare(sql).get(...bound) ?? null;
          },
          async run() {
            const info = db.prepare(sql).run(...bound);
            return { success: true, meta: { changes: Number(info.changes) } };
          },
        };
      },
    },
    count: () => db.prepare('SELECT COUNT(*) AS n FROM route_cache').get().n,
    rows: () => db.prepare('SELECT * FROM route_cache').all(),
    expireAll: () => db.exec("UPDATE route_cache SET created_at = datetime('now', '-30 days')"),
    ageAll: (sql) => db.exec(`UPDATE route_cache SET created_at = datetime('now', '${sql}')`),
  };
}

const ctx = (env, db) => ({ env: { DB: db, ...env } });

// ---------- pelayan OSRM mock yang mengira panggilan ----------
function startOsrm() {
  return new Promise((resolve) => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 'Ok',
        routes: [{
          distance: 234_567,
          duration: 8_123,
          geometry: { type: 'LineString', coordinates: [[116.0505, 5.8943], [115.7300, 5.4500]] },
        }],
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/route/v1/driving`,
        calls: () => calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---------- laluan sebenar dalam koridor ----------
// KOORDINAT FIXTURE DIPILIH JAUH DARI SEMPADAN `.0005`.
// 116.0735 duduk TEPAT di sempadan sel 116.073/116.074 dan terbelah antara
// dua sel tanpa sebab yang dapat dilihat — lihat references/geo-aggregation-on-d1.md.
// 116.0734 berada 11 m di dalam sel, jadi selnya tidak bergolek.
const KK = { lat: 5.9804, lng: 116.0734 };          // Kota Kinabalu
const MEMBAKUT = { lat: 5.4500, lng: 115.7300 };    // Kg Pimping, Membakut
// Jangkaan 3 dp diperoleh daripada fungsi yang sama — ujian ini tidak pernah
// mengekodkan sempadan secara manual, jadi ia tidak akan lapuk lagi.
const KK_3DP = { lat: routeKeyRound(KK.lat), lng: routeKeyRound(KK.lng) };
const MEMBAKUT_3DP = { lat: routeKeyRound(MEMBAKUT.lat), lng: routeKeyRound(MEMBAKUT.lng) };

console.log('\n[1] Miss → OSRM dipanggil → disimpan');
{
  const t = freshDb();
  const osrm = await startOsrm();
  const r1 = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, MEMBAKUT]);

  ok(r1.cached === false, 'panggilan pertama: cached=false');
  ok(r1.provider === 'osrm', `provider=osrm (sebenar: ${r1.provider})`);
  ok(osrm.calls() === 1, `OSRM dipanggil 1 kali (sebenar: ${osrm.calls()})`);
  ok(t.count() === 2, `2 baris disimpan — kedua-dua arah (sebenar: ${t.count()})`);

  const rows = t.rows();
  ok(rows.some((r) => r.origin_lat === KK_3DP.lat && r.origin_lng === KK_3DP.lng
                 && r.dest_lat === MEMBAKUT_3DP.lat && r.dest_lng === MEMBAKUT_3DP.lng),
    `baris A→B pada 3 dp (${KK_3DP.lat},${KK_3DP.lng} → ${MEMBAKUT_3DP.lat},${MEMBAKUT_3DP.lng})`);
  ok(rows.some((r) => r.origin_lat === MEMBAKUT_3DP.lat && r.dest_lat === KK_3DP.lat),
    'baris B→A juga disimpan (arah songsang)');
  ok(rows.every((r) => r.distance === 234_567 && r.duration === 8_123),
    'distance & duration disimpan');
  ok(rows.every((r) => r.origin_lat === routeKeyRound(r.origin_lat)),
    'koordinat disimpan pada tepat 3 tempat perpuluhan');
  ok(rows.every((r) => typeof r.route_data === 'string' && r.route_data.startsWith('{"type":"LineString"')),
    'route_data menyimpan GeoJSON LineString mentah');
  await osrm.close();
}

console.log('\n[2] Hit → OSRM TIDAK dipanggil');
{
  const t = freshDb();
  const osrm = await startOsrm();

  await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, MEMBAKUT]);
  ok(osrm.calls() === 1, 'persediaan: OSRM dipanggil sekali');
  const r2 = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, MEMBAKUT]);

  ok(r2.cached === true, 'panggilan kedua: cached=true');
  ok(r2.provider === 'cache', `provider=cache (sebenar: ${r2.provider})`);
  ok(osrm.calls() === 1, `OSRM TIDAK dipanggil (sebenar: ${osrm.calls()})`);
  ok(r2.distanceM === 234_567 && r2.durationS === 8_123,
    'jarak & masa dibaca balik dengan betul');
  ok(r2.geometry.type === 'LineString' && r2.geometry.coordinates.length === 2,
    'geometri GeoJSON dipulihkan sepenuhnya');
  await osrm.close();
}

console.log('\n[3] Arah songsang juga HIT');
{
  const t = freshDb();
  const osrm = await startOsrm();
  await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, MEMBAKUT]);

  const r = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [MEMBAKUT, KK]);
  ok(r.cached === true, 'B→A dijawab dari cache tanpa OSRM');
  ok(osrm.calls() === 1, `OSRM masih 1 panggilan sahaja (sebenar: ${osrm.calls()})`);
  await osrm.close();
}

console.log('\n[4] Kunci dibundarkan 3 dp (~110 m)');
{
  ok(routeKeyRound(5.89434) === 5.894, `5.89434 → ${routeKeyRound(5.89434)}`);
  ok(routeKeyRound(5.89436) === 5.894, `5.89436 → ${routeKeyRound(5.89436)}`);
  ok(routeKeyRound(116.05055) === 116.051, `116.05055 → ${routeKeyRound(116.05055)}`);
  ok(routeKeyRound(5.9804) === 5.98, `5.9804 → ${routeKeyRound(5.9804)}`);

  // Kunci JS mesti jatuh dalam sel yang SAMA seperti ROUND() SQLite.
  // `Math.round(v * 1000) / 1000` gagal di sini: 116.0505 → 116.051,
  // manakala SQLite → 116.050. Jika kedua-dua laluan lari berasingan,
  // kunci yang dijana JS tidak akan pernah menemui sel yang dijana SQL.
  const sqliteDb = new DatabaseSync(':memory:');
  const sqliteRound = (v) => sqliteDb.prepare('SELECT ROUND(?, 3) AS a').get(v).a;
  for (const v of [116.0505, 116.0515, 116.0525, 116.0535, 116.0545, 116.0555]) {
    ok(routeKeyRound(v) === sqliteRound(v),
      `kunci JS sepadan dengan ROUND() SQLite bagi ${v} (${routeKeyRound(v)} vs ${sqliteRound(v)})`);
  }

  const t = freshDb();
  const osrm = await startOsrm();
  await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, MEMBAKUT]);

  const r = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [
    { lat: 5.98042, lng: 116.07342 },   // ~2 m dari KK, sel grid yang sama
    { lat: 5.45001, lng: 115.73002 },   // ~1 m dari Membakut
  ]);
  ok(r.cached === true, 'titik ~2 m berbeza tetap HIT (toleransi ~110 m)');
  ok(osrm.calls() === 1, `OSRM tidak dipanggil semula (sebenar: ${osrm.calls()})`);
  await osrm.close();
}

console.log('\n[5] Entri luput → panggil OSRM semula');
{
  const t = freshDb();
  const osrm = await startOsrm();
  await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, MEMBAKUT]);
  t.expireAll();

  const r = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, MEMBAKUT]);
  ok(r.cached === false, 'entri luput → cached=false');
  ok(osrm.calls() === 2, `OSRM dipanggil semula (sebenar: ${osrm.calls()})`);
  await osrm.close();
}

console.log('\n[6] TTL boleh ditetapkan melalui Env');
{
  const t = freshDb();
  const osrm = await startOsrm();
  const TTL_1JAM = 3_600_000;
  await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url, ROUTE_CACHE_TTL_MS: String(TTL_1JAM) }, t.d1), [KK, MEMBAKUT]);
  t.ageAll('-2 hours');

  const r = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url, ROUTE_CACHE_TTL_MS: String(TTL_1JAM) }, t.d1), [KK, MEMBAKUT]);
  ok(r.cached === false, 'TTL 1 jam → entri 2 jam dianggap luput');
  await osrm.close();
}

console.log('\n[7] Laluan 3+ titik TIDAK diCache');
{
  const t = freshDb();
  const osrm = await startOsrm();
  const via = { lat: 5.7333, lng: 115.9333 };   // Papar
  const r1 = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, via, MEMBAKUT]);
  const r2 = await getRouteCached(ctx({ OSRM_BASE_URL: osrm.url }, t.d1), [KK, via, MEMBAKUT]);

  ok(r1.cached === false && r2.cached === false, '3 titik → sentiasa cached=false');
  ok(osrm.calls() === 2, `OSRM dipanggil setiap kali (sebenar: ${osrm.calls()})`);
  ok(t.count() === 0, `tiada baris disimpan (sebenar: ${t.count()})`);
  await osrm.close();
}

console.log('\n[8] Tanpa D1 → terus ke OSRM');
{
  const osrm = await startOsrm();
  const r = await getRouteCached({ env: { OSRM_BASE_URL: osrm.url } }, [KK, MEMBAKUT]);
  ok(r.cached === false, 'tiada D1 → cached=false');
  ok(osrm.calls() === 1, 'OSRM dipanggil terus');
  await osrm.close();
}

console.log('\n[9] Identiti projek');
ok(USER_AGENT.startsWith('MykiraMap-Worker-Putatan/'),
  `User-Agent: "${USER_AGENT}"`);
ok(!/lalintrafik/i.test(USER_AGENT), 'User-Agent tidak mengandungi nama lama');

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
