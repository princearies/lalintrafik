// ============================================================
//  Ujian lapisan data — createReport, findNearby, confirm/dismiss
//  dengan mock D1 yang merakam kenyataan SQL.
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = path.join(root, 'node_modules/.bin/esbuild.cmd');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.log('  FAIL', msg); }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const out = path.join(here, '_reports.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/db/reports.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const db = await import('file:///' + out.replace(/\\/g, '/'));

// ------------------------------------------------------------
//  Mock D1
// ------------------------------------------------------------
function makeMock(rows = {}) {
  const calls = [];

  const stmt = (sql) => ({
    bind(...params) {
      const rec = { sql, params };
      calls.push(rec);
      return {
        async run() {
          const m = /^INSERT|^UPDATE|^DELETE/i.test(sql);
          return { success: true, meta: { changes: m ? 1 : 0 } };
        },
        async first() {
          if (/UPDATE [\s\S]* RETURNING/i.test(sql)) return rows.update_returning?.[0] ?? null;
          if (/SELECT \* FROM reports WHERE id =/i.test(sql)) return rows.single?.[0] ?? null;
          if (/FROM users WHERE device_id/i.test(sql)) return rows.user?.[0] ?? null;
          if (/FROM live_sessions/i.test(sql)) return rows.first?.[0] ?? null;
          return rows.first?.[0] ?? null;
        },
        async all() {
          if (/FROM reports/i.test(sql) && /lat BETWEEN/i.test(sql)) {
            return { results: rows.nearby ?? [], success: true };
          }
          return { results: [], success: true };
        },
      };
    },
  });

  return { calls, prepare: (sql) => stmt(sql) };
}

// ---------- [1] createReport ----------
console.log('\n[1] createReport');
const mock1 = makeMock();
const created = await db.createReport(
  mock1,
  { type: 'ACCIDENT', lat: 3.139, lng: 101.6869, userId: 'u1', deviceId: 'dev-1' },
  {},
);
ok(created.report.type === 'ACCIDENT', 'jenis dipulangkan');
ok(near(created.report.lat, 3.139), 'lat dipulangkan');
ok(created.cell.length === 6, `sel geohash 6 aksara (${created.cell})`);
ok(created.report.id.length === 16, 'ID 16 aksara');
ok(created.report.status === 'ACTIVE', 'status ACTIVE');
ok(created.report.createdAt.includes('T'), 'createdAt ISO 8601');

const insertCall = mock1.calls.find((c) => /^INSERT INTO reports/i.test(c.sql));
ok(!!insertCall, 'INSERT reports dijalankan');
const sql = insertCall.sql;
ok(/expires_at/i.test(sql), 'expires_at diset');
ok(/geohash/i.test(sql), 'geohash diset');

// ---------- [2] TTL dipohon ke tarikh tamat ----------
console.log('\n[2] TTL → expires_at');
const ttlMs =
  new Date(created.report.expiresAt).getTime() - new Date(created.report.createdAt).getTime();
console.log(`   TTL ACCIDENT = ${ttlMs / 60000} minit`);
ok(ttlMs === 45 * 60_000, 'ACCIDENT tamat dalam 45 minit');

const rc = await db.createReport(
  makeMock(),
  { type: 'ROAD_CLOSURE', lat: 3.1, lng: 101.6, userId: null, deviceId: 'dev-2' },
  {},
);
const ttl2 =
  new Date(rc.report.expiresAt).getTime() - new Date(rc.report.createdAt).getTime();
console.log(`   TTL ROAD_CLOSURE = ${ttl2 / 3600000} jam`);
ok(ttl2 === 24 * 3_600_000, 'ROAD_CLOSURE tamat dalam 24 jam');

// ---------- [3] findNearby ----------
console.log('\n[3] findNearby');
const fakeRows = [
  { id: 'r1', user_id: 'u1', type: 'ACCIDENT', lat: 3.1391, lng: 101.687, accuracy_m: null,
    geohash: 'w283cgqn', heading: null, speed_kmh: null, road_name: null, note: null,
    severity: 0, status: 'ACTIVE', confirm_count: 0, dismiss_count: 0, confidence: 0,
    created_at: Date.now(), expires_at: Date.now() + 3_600_000 },
  { id: 'r2', user_id: 'u2', type: 'HAZARD', lat: 3.2, lng: 101.8, accuracy_m: null,
    geohash: 'w283xyz', heading: null, speed_kmh: null, road_name: null, note: null,
    severity: 1, status: 'ACTIVE', confirm_count: 0, dismiss_count: 0, confidence: 0,
    created_at: Date.now(), expires_at: Date.now() + 3_600_000 },
];
const mock3 = makeMock({ nearby: fakeRows });
const found = await db.findNearby(
  mock3,
  { lat: 3.139, lng: 101.6869, radiusM: 1000, limit: 50 },
  { limit: 50, maxRadiusM: 5000 },
);
console.log(`   ${fakeRows.length} baris dari mock, ${found.length} setelah tapis Haversine`);
ok(found.length >= 1, 'laporan berdekatan dipulangkan');

const nearbySql = mock3.calls.find((c) => /lat BETWEEN/i.test(c.sql));
ok(!!nearbySql, 'pertanyaan peti bounding dijana');
ok(/status = \?/.test(nearbySql.sql), 'penapis status ACTIVE');
ok(/expires_at > \?/.test(nearbySql.sql), 'penapis TTL');
ok(nearbySql.params.length >= 5, 'parameter peti terikat (4 koordinat + status)');

// ---------- [4] confirm / dismiss ----------
console.log('\n[4] confirm / dismiss');
const mock4 = makeMock({ update_returning: [{ confirm_count: 3, dismiss_count: 1 }] });
const conf = await db.confirmReport(mock4, 'r1');
ok(conf.confirmCount === 3, 'confirmCount dipulangkan');
ok(conf.confidence === 75, `confidence 75% (3/(3+1)) — aktual ${conf.confidence}`);

ok(db.confidenceOf(0, 0) === 0, 'confidence 0 jika tiada undian');
ok(db.confidenceOf(10, 0) === 100, 'confidence 100 jika semua setuju');
ok(db.confidenceOf(0, 10) === 0, 'confidence 0 jika semua tolak');
ok((await db.confirmReport(makeMock({ update_returning: [] }), 'tiada')) === null, 'laporan tiada → null');

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
