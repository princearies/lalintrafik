// ============================================================
//  Ujian skema D1 — SQLite sebenar + semakan kekangan
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.log('  FAIL', msg); }
};

const file = path.join(root, 'test.db');
if (fs.existsSync(file)) fs.unlinkSync(file);
const db = new DatabaseSync(file);
db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));

console.log('\n[1] Jadual');
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all().map((r) => r.name);
console.log('  ', tables.join(', '));
for (const t of ['users', 'reports', 'live_sessions', 'route_cache']) {
  ok(tables.includes(t), `${t} wujud`);
}

console.log('\n[2] Index');
const idx = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
).all().map((r) => r.name);
console.log('  ', idx.join(', '));
const expectIdx = [
  'idx_reports_bbox',
  'idx_reports_status_created',
  'idx_reports_expires',
  'idx_reports_geohash',
  'idx_sessions_cell',
  'idx_users_device',
  'idx_route_coords',
  'idx_route_cache_created',
];
for (const i of expectIdx) ok(idx.includes(i), `index ${i}`);

console.log('\n[2b] route_cache — skema koordinat');
{
  const rcCols = db.prepare('PRAGMA table_info(route_cache)').all().map((c) => c.name);
  for (const c of ['id', 'origin_lat', 'origin_lng', 'dest_lat', 'dest_lng',
                   'route_data', 'distance', 'duration', 'created_at']) {
    ok(rcCols.includes(c), `kolom route_cache.${c}`);
  }

  const uniqSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'idx_route_coords'",
  ).get();
  ok(/UNIQUE/i.test(uniqSql?.sql ?? ''), 'idx_route_coords adalah UNIQUE');

  // indeks UNIQUE mesti benar-benar menghalang baris pendupa
  let dup = false;
  try {
    const ins = db.prepare(
      `INSERT INTO route_cache
         (origin_lat, origin_lng, dest_lat, dest_lng, route_data)
       VALUES (?, ?, ?, ?, '[]')`,
    );
    ins.run(5.894, 116.05, 5.45, 115.73);
    ins.run(5.894, 116.05, 5.45, 115.73);
  } catch { dup = true; }
  ok(dup, 'baris pendupa ditolak oleh indeks UNIQUE');
}

console.log('\n[3] CHECK constraints menolak nilai haram');
let rejected = false;
try {
  db.prepare("INSERT INTO reports (id,type,lat,lng,geohash,created_at,expires_at) VALUES ('x','BOGUS',1,1,'abc',0,0)").run();
} catch { rejected = true; }
ok(rejected, 'type haram ditolak');

rejected = false;
try {
  db.prepare("INSERT INTO reports (id,type,lat,lng,geohash,status,severity,created_at,expires_at) VALUES ('x','ACCIDENT',1,1,'abc','BOGUS',0,0,0)").run();
} catch { rejected = true; }
ok(rejected, 'status haram ditolak');

rejected = false;
try {
  db.prepare("INSERT INTO reports (id,type,lat,lng,geohash,severity,created_at,expires_at) VALUES ('x','ACCIDENT',1,1,'abc',9,0,0)").run();
} catch { rejected = true; }
ok(rejected, 'severity di luar 0-3 ditolak');

console.log('\n[4] Prestasi: peti bounding pada set 10k baris');
db.exec('BEGIN');
const ins = db.prepare(
  `INSERT INTO reports (id,type,lat,lng,geohash,status,severity,created_at,expires_at)
   VALUES (?,?,?,?,?,?,0,?,?)`,
);
const base = Date.now();
for (let i = 0; i < 10_000; i++) {
  // tabur di sekitar Kuala Lumpur (3.1390, 101.6869)
  const lat = 3.1390 + (Math.random() - 0.5) * 1.5;
  const lng = 101.6869 + (Math.random() - 0.5) * 1.5;
  ins.run(`r${i}`, 'ACCIDENT', lat, lng, 'abcd1234', 'ACTIVE', base, base + 3_600_000);
}
db.exec('COMMIT');

const t0 = performance.now();
const box = db.prepare(
  `SELECT COUNT(*) AS n FROM reports
    WHERE status = 'ACTIVE' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      AND expires_at > ?`,
).get(3.0, 3.3, 101.5, 101.9, base);
const t1 = performance.now();
console.log(`   baris dalam peti: ${box.n}  (${(t1 - t0).toFixed(2)}ms)`);
ok(box.n > 0, 'peti bounding memulangkan baris');
ok(t1 - t0 < 100, `peti bounding pantas (<100ms, aktual ${(t1 - t0).toFixed(2)}ms)`);

const t2 = performance.now();
db.prepare(
  `SELECT COUNT(*) AS n FROM reports
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
).get(3.0, 3.3, 101.5, 101.9);
const t3 = performance.now();
console.log(`   tanpa penapis status: ${(t3 - t2).toFixed(2)}ms`);

db.close();
fs.unlinkSync(file);

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
