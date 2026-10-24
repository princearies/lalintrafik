// ============================================================
//  Ujian undian (confirm/dismiss) — SQL sebenar, SQLite sebenar
//
//  Mengunci regression: `confidence` ialah kolum TERSIMPAN dalam
//  jadual `reports`. Versi lama mengemas kini confirm_count sahaja,
//  jadi bacaan seterusnya sentiasa memulangkan confidence=0 walaupun
//  confirmCount sudah bertambah — manakala siaran masa nyata membawa
//  nilai yang dikira semula. Dua sumber yang tidak sepadan.
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = path.join(root, 'node_modules/.bin/esbuild.cmd');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// ---------- transpile lapisan data ----------
console.log('\n[0] Transpile');
const out = path.join(here, '_votes_reports.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/db/reports.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const { confirmReport, dismissReport, confidenceOf, getReport } =
  await import('file:///' + out.replace(/\\/g, '/'));
console.log('  transpile reports.ts OK');

// ---------- D1 shim di atas node:sqlite ----------
/** Hanya menyokong bentuk prepare().bind().first() / .run() yang diguna. */
function d1Shim(db) {
  return {
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async first() {
          const row = db.prepare(sql).get(...bound);
          return row ?? null;
        },
        async run() {
          const info = db.prepare(sql).run(...bound);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
        async all() {
          return { results: db.prepare(sql).all(...bound) };
        },
      };
    },
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE reports (
      id            TEXT PRIMARY KEY,
      user_id       TEXT,
      type          TEXT NOT NULL,
      lat           REAL NOT NULL,
      lng           REAL NOT NULL,
      accuracy_m    REAL,
      geohash       TEXT NOT NULL,
      heading       REAL,
      speed_kmh     REAL,
      road_name     TEXT,
      note          TEXT,
      severity      INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'ACTIVE',
      confirm_count INTEGER NOT NULL DEFAULT 0,
      dismiss_count INTEGER NOT NULL DEFAULT 0,
      confidence    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL
    );
  `);
  return db;
}

const INSERT = `INSERT INTO reports
  (id, type, lat, lng, geohash, severity, status, confirm_count, dismiss_count,
   confidence, created_at, expires_at)
  VALUES (?, 'ACCIDENT', 3.139, 101.6869, 'w283cg', 0, 'ACTIVE', 0, 0, 0, '2026-01-01', '2099-01-01')`;

// ---------- 1. confidence tersimpan dikemas kini ----------
console.log('\n[1] confirm mengemas kini kolum confidence');
{
  const db = freshDb();
  db.exec(INSERT.replace('?', "'r1'"));
  const d1 = d1Shim(db);

  const r = await confirmReport(d1, 'r1');
  ok(r.confirmCount === 1, `confirmCount=1 (sebenar: ${r.confirmCount})`);
  ok(r.confidence === 100, `dikembalikan confidence=100 (sebenar: ${r.confidence})`);

  const stored = db.prepare('SELECT confirm_count, confidence FROM reports WHERE id = ?').get('r1');
  ok(stored.confidence === 100, `KOLUM TERSIMPAN confidence=100 (sebenar: ${stored.confidence})`);

  const read = await getReport(d1, 'r1');
  ok(read.confidence === 100, `bacaan semula confidence=100 (sebenar: ${read.confidence})`);
  ok(read.confirmCount === 1, `bacaan semula confirmCount=1 (sebenar: ${read.confirmCount})`);
}

// ---------- 2. dismiss mengemas kini confidence ----------
console.log('\n[2] dismiss mengemas kini kolum confidence');
{
  const db = freshDb();
  db.exec(INSERT.replace('?', "'r2'"));
  const d1 = d1Shim(db);

  await confirmReport(d1, 'r2');
  const d = await dismissReport(d1, 'r2');
  ok(d.dismissCount === 1, `dismissCount=1 (sebenar: ${d.dismissCount})`);
  ok(d.confidence === 50, `dikembalikan confidence=50 (sebenar: ${d.confidence})`);

  const stored = db.prepare('SELECT confirm_count, dismiss_count, confidence FROM reports WHERE id = ?').get('r2');
  ok(stored.confidence === 50, `KOLUM TERSIMPAN confidence=50 (sebenar: ${stored.confidence})`);

  const read = await getReport(d1, 'r2');
  ok(read.confidence === 50, `bacaan semula confidence=50 (sebenar: ${read.confidence})`);
}

// ---------- 3. confidence merosot apabila ramai menolak ----------
console.log('\n[3] confidence merosot mengikut undian');
{
  const db = freshDb();
  db.exec(INSERT.replace('?', "'r3'"));
  const d1 = d1Shim(db);

  await confirmReport(d1, 'r3');
  await confirmReport(d1, 'r3');
  await confirmReport(d1, 'r3');
  const d = await dismissReport(d1, 'r3');
  ok(d.confidence === 75, `3 confirm + 1 dismiss = 75 (sebenar: ${d.confidence})`);

  const read = await getReport(d1, 'r3');
  ok(read.confidence === 75, `tersimpan 75 (sebenar: ${read.confidence})`);
  ok(read.confirmCount === 3 && read.dismissCount === 1, `3/1 (sebenar: ${read.confirmCount}/${read.dismissCount})`);
}

// ---------- 4. lebih banyak dismiss menolak → 0 ----------
console.log('\n[4] confidence tidak pernah negatif');
{
  const db = freshDb();
  db.exec(INSERT.replace('?', "'r4'"));
  const d1 = d1Shim(db);

  await dismissReport(d1, 'r4');
  await dismissReport(d1, 'r4');
  const read = await getReport(d1, 'r4');
  ok(read.confidence === 0, `confidence=0 (sebenar: ${read.confidence})`);
  ok(read.confidence >= 0, 'confidence tidak negatif');
}

// ---------- 5. laporan tidak wujud ----------
console.log('\n[5] Laporan tidak wujud');
{
  const db = freshDb();
  const d1 = d1Shim(db);
  const r = await confirmReport(d1, 'tiada');
  ok(r === null, `confirmReport -> null (sebenar: ${r})`);
  const d = await dismissReport(d1, 'tiada');
  ok(d === null, `dismissReport -> null (sebenar: ${d})`);
}

// ---------- 6. fungsi tulisan (pure) ----------
console.log('\n[6] confidenceOf');
ok(confidenceOf(0, 0) === 0, 'confidenceOf(0,0)=0');
ok(confidenceOf(1, 0) === 100, 'confidenceOf(1,0)=100');
ok(confidenceOf(1, 1) === 50, 'confidenceOf(1,1)=50');
ok(confidenceOf(3, 1) === 75, 'confidenceOf(3,1)=75');
ok(confidenceOf(0, 5) === 0, 'confidenceOf(0,5)=0');

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
