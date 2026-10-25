// ============================================================
//  Ujian cache laluan D1 — tingkah laku, bukan implementasi
//
//  Mengunci tiga jaminan:
//   1. Panggilan pertama → OSRM dipanggil, keputusan disimpan ke D1.
//   2. Panggilan kedua (koordinat sama) → OSRM TIDAK dipanggil lagi;
//      data datang dari D1.
//   3. A→B dan B→A berkongsi entri cache yang SAMA (kunci tidak
//      bergantung arah) — ini hampir memergingkan kadar hit.
// ============================================================
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = path.join(root, 'node_modules/.bin/esbuild.cmd');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

console.log('\n[0] Transpile');
const out = path.join(here, '_route_cache.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/routes/routing.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const { getRouteCached } = await import('file:///' + out.replace(/\\/g, '/'));
console.log('  transpile routing.ts OK');

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
          distance: 123_456,
          duration: 7_890,
          geometry: { type: 'LineString', coordinates: [[116.0735, 5.9804], [116.1000, 5.9167]] },
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

// ---------- D1 mock dengan jadual route_cache ----------
function makeD1() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async first() {
          if (/FROM route_cache/.test(sql)) {
            const [key, now] = bound;
            const r = rows.get(key);
            return r && r.expires_at > now ? { payload: r.payload } : null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO route_cache/.test(sql)) {
            const [key, payload, expiresAt] = bound;
            rows.set(key, { payload, expires_at: expiresAt });
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
}

const ctx = (db, env = {}) => ({ env: { DB: db, ...env } });

// ---------- laluan sebenar dalam zon KK ----------
const A = { lat: 5.9804, lng: 116.0735 };   // pusat bandar KK
const B = { lat: 5.8900, lng: 116.0500 };   // Putatan

console.log('\n[1] Cache miss → panggil OSRM → simpan ke D1');
{
  const osrm = await startOsrm();
  const db = makeD1();
  const r1 = await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);

  ok(r1.cached === false, 'panggilan pertama: cached=false');
  ok(osrm.calls() === 1, `OSRM dipanggil tepat 1 kali (sebenar: ${osrm.calls()})`);
  ok(db.rows.size === 1, `1 entri disimpan ke D1 (sebenar: ${db.rows.size})`);

  const entry = [...db.rows.values()][0];
  const payload = JSON.parse(entry.payload);
  ok(payload.distanceM === 123_456, `jarak dari OSRM disimpan (${payload.distanceM})`);
  ok(payload.provider === 'osrm', 'provider=osrm disimpan');

  const ttl = entry.expires_at - Date.now();
  ok(ttl > 0 && ttl <= 24 * 3_600_000,
    `TTL lalai 24 jam (sebenar: ${(ttl / 3_600_000).toFixed(1)} jam)`);
  await osrm.close();
}

console.log('\n[2] Cache hit → OSRM TIDAK dipanggil');
{
  const osrm = await startOsrm();
  const db = makeD1();

  await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);
  const r2 = await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);

  ok(r2.cached === true, 'panggilan kedua: cached=true');
  ok(osrm.calls() === 1, `OSRM masih 1 panggilan sahaja (sebenar: ${osrm.calls()})`);
  ok(r2.distanceM === 123_456, 'data dibaca balik dari D1 dengan betul');
  await osrm.close();
}

console.log('\n[3] Kunci tidak bergantung ARAH (A→B = B→A)');
{
  const osrm = await startOsrm();
  const db = makeD1();

  await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);
  const r = await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [B, A]);

  ok(r.cached === true, 'B→A dijawab dari cache tanpa panggil OSRM');
  ok(osrm.calls() === 1, `OSRM masih 1 panggilan sahaja (sebenar: ${osrm.calls()})`);
  ok(db.rows.size === 1, `masih 1 entri cache (sebenar: ${db.rows.size})`);
  await osrm.close();
}

console.log('\n[4] Entri luput → panggil OSRM semula');
{
  const osrm = await startOsrm();
  const db = makeD1();

  await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);
  // paksa luput
  for (const [k, v] of db.rows) db.rows.set(k, { ...v, expires_at: Date.now() - 1 });

  const r = await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);
  ok(r.cached === false, 'entri luput → cached=false');
  ok(osrm.calls() === 2, `OSRM dipanggil semula (sebenar: ${osrm.calls()})`);
  await osrm.close();
}

console.log('\n[5] TTL boleh ditetapkan melalui Env');
{
  const osrm = await startOsrm();
  const db = makeD1();
  const TTL_1H = 3_600_000;

  await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url, ROUTE_CACHE_TTL_MS: String(TTL_1H) }), [A, B]);
  const ttl = [...db.rows.values()][0].expires_at - Date.now();
  ok(Math.abs(ttl - TTL_1H) < 5_000, `TTL env 1 jam dipatuhi (sebenar: ${(ttl / 60_000).toFixed(1)} min)`);
  await osrm.close();
}

console.log('\n[6] Entri rosak di D1 → jatuh balik ke OSRM (bukan crash)');
{
  const osrm = await startOsrm();
  const db = makeD1();

  await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);
  for (const [k, v] of db.rows) db.rows.set(k, { ...v, payload: '{json rosak' });

  const r = await getRouteCached(ctx(db, { OSRM_BASE_URL: osrm.url }), [A, B]);
  ok(r.cached === false, 'JSON rosak → cached=false (jatuh balik ke OSRM)');
  ok(osrm.calls() === 2, `OSRM dipanggil semula (sebenar: ${osrm.calls()})`);
  ok(r.distanceM === 123_456, 'laluan baharu masih dipulangkan dengan betul');
  await osrm.close();
}

console.log('\n[7] Tanpa D1 → terus ke OSRM (tiada cache)');
{
  const osrm = await startOsrm();
  const r = await getRouteCached(ctx(null, { OSRM_BASE_URL: osrm.url }), [A, B]);
  ok(r.cached === false, 'tiada D1 → cached=false');
  ok(osrm.calls() === 1, 'OSRM dipanggil terus');
  await osrm.close();
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
