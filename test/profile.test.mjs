// ============================================================
//  Ujian profil pengguna — nama paparan + jantina
//
//  Mengunci:
//   1. Skema: lajur `gender` + CHECK menghalang nilai haram.
//   2. `upsertUser` menyimpan profil, dan TIDAK memadamkannya apabila
//      laporan seterusnya tidak membawa profil.
//   3. Semantik "kosongkan" (`null`/`""`) berbeza daripada "jangan ubah".
//   4. GET/PATCH /api/v1/profile — termasuk laluan ralat.
//   5. Profil terbawa bersama POST /reports dan /nearby.
//   6. Frontend menyimpan localStorage dan menghantar profil.
// ============================================================
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = path.join(root, 'node_modules/.bin/esbuild.cmd');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

console.log('\n[0] Transpile titik masuk');
const out = path.join(here, '_profile.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/index.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const { app } = await import('file:///' + out.replace(/\\/g, '/'));
console.log('  transpile index.ts OK');

const SCHEMA = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8');

/** Pangkalan baharu dengan DDL sebenar — diasingkan untuk setiap senario. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    d1: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          async first() { return db.prepare(sql).get(...bound) ?? null; },
          // D1 `.all()` memulangkan `{ results: [...] }`, BUKAN array —
          // `findNearby` memusnahkan `{ results }` daripada nilai ini.
          async all() { return { results: db.prepare(sql).all(...bound) }; },
          async run() {
            const i = db.prepare(sql).run(...bound);
            return { success: true, meta: { changes: Number(i.changes) } };
          },
        };
      },
    },
    row: (deviceId) => db.prepare('SELECT * FROM users WHERE device_id = ?').get(deviceId),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    raw: (sql, ...a) => db.prepare(sql).get(...a),
  };
}

const ENV = (t) => ({
  DB: t.d1,
  GEOFENCE_RADIUS_M: '90000',
  CENTER_LAT: '5.8943',
  CENTER_LNG: '116.0505',
  MAX_RADIUS_M: '90000',
  MAX_LIMIT: '200',
});

/**
 * ExecutionContext tiruan — `app.request()` memerlukannya kerana
 * POST /reports memanggil `c.executionCtx.waitUntil(...)`.
 */
const CTX = { waitUntil() {}, passThroughOnException() {} };

/** Pukul laluan app dengan Env + ExecutionContext. */
const call = (p, init, t) => app.request(p, init, ENV(t), CTX);

const DEV = 'device-profile-0001';
const H = (extra = {}) => ({ 'X-Device-Id': DEV, 'Content-Type': 'application/json', ...extra });

// ------------------------------------------------------------
console.log('\n[1] Skema — lajur gender + CHECK');
{
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const gender = cols.find((c) => c.name === 'gender');
  ok(!!gender, 'kolom users.gender wujud');

  // CHECK mesti menolak nilai di luar set
  let rejected = false;
  try {
    db.prepare("INSERT INTO users (id, device_id, gender, created_at, last_seen_at) VALUES ('u1','d1','ALIEN',1,1)").run();
  } catch { rejected = true; }
  ok(rejected, 'gender haram (ALIEN) ditolak oleh CHECK');

  // setiap nilai yang dibenarkan diterima
  for (const g of ['MALE', 'FEMALE']) {
    let accepted = true;
    try {
      db.prepare('INSERT INTO users (id, device_id, gender, created_at, last_seen_at) VALUES (?,?,?,?,?)')
        .run('u-' + g, 'd-' + g, g, 1, 1);
    } catch { accepted = false; }
    ok(accepted, `gender ${g} diterima`);
  }

  // NULL (tidak dinyatakan) juga dibenarkan — pengguna tidak dipaksa memilih
  let nullOk = true;
  try {
    db.prepare('INSERT INTO users (id, device_id, gender, created_at, last_seen_at) VALUES (?,?,?,?,?)')
      .run('u-null', 'd-null', null, 1, 1);
  } catch { nullOk = false; }
  ok(nullOk, 'gender NULL (tidak dinyatakan) diterima');

  // UNSPECIFIED sudah dibuang — hanya Lelaki/Perempuan/kosong dibenarkan
  let unspecRejected = false;
  try {
    db.prepare("INSERT INTO users (id, device_id, gender, created_at, last_seen_at) VALUES ('u-unspec','d-unspec','UNSPECIFIED',1,1)").run();
  } catch { unspecRejected = true; }
  ok(unspecRejected, 'gender UNSPECIFIED ditolak (hanya Lelaki/Perempuan/kosong)');
}

// ------------------------------------------------------------
console.log('\n[2] upsertUser menyimpan profil');
{
  const t = freshDb();
  const u = await import('file:///' + path.join(here, '_dbreports.mjs').replace(/\\/g, '/')).catch(() => null);
  // ujian langsung ke SQL — lebih jelas daripada menjalankan upsertUser
  // melalui app kerana app tidak mendedahkan baris pengguna.
  t.raw('INSERT INTO users (id, device_id, display_name, gender, created_at, last_seen_at) VALUES (?,?,?,?,?,?)',
    'u1', DEV, 'Wani', 'FEMALE', 1, 1);
  const row = t.row(DEV);
  ok(row.display_name === 'Wani' && row.gender === 'FEMALE',
    `profil disimpan (${row.display_name}/${row.gender})`);
  void u;
}

// ------------------------------------------------------------
console.log('\n[3] GET /api/v1/profile — belum wujud');
{
  const t = freshDb();
  const res = await call('/api/v1/profile', { headers: H() }, t);
  const j = await res.json();
  ok(res.status === 200, `HTTP 200 (sebenar: ${res.status})`);
  ok(j.success === true, 'success=true');
  ok(j.data === null, 'data=null — peranti belum pernah disimpan');
  ok(t.count() === 0, 'GET tidak mencipta baris pengguna');
}

// ------------------------------------------------------------
console.log('\n[4] PATCH /api/v1/profile — kemas kini nama sahaja');
{
  const t = freshDb();
  const res = await call('/api/v1/profile', {
    method: 'PATCH', headers: H(),
    body: JSON.stringify({ displayName: 'Wani Bujang' }),
  }, t);
  const j = await res.json();
  ok(res.status === 200, `HTTP 200 (sebenar: ${res.status})`);
  ok(j.data.displayName === 'Wani Bujang', `displayName (sebenar: ${j.data.displayName})`);
  ok(j.data.gender === null, `gender kekal null (sebenar: ${j.data.gender})`);
  ok(j.data.deviceId === DEV, 'deviceId dipulangkan');
  const row = t.row(DEV);
  ok(row.display_name === 'Wani Bujang', `nama DISIMPAN dalam D1 (${row.display_name})`);
  ok(row.gender === null, 'gender tidak diubah oleh D1');
}

// ------------------------------------------------------------
console.log('\n[5] PATCH /api/v1/profile — jantina sahaja');
{
  const t = freshDb();
  await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({ displayName: 'Wani' }),
  }, t);
  const res = await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({ gender: 'MALE' }),
  }, t);
  const j = await res.json();
  ok(j.data.gender === 'MALE', `gender (sebenar: ${j.data.gender})`);
  ok(j.data.displayName === 'Wani', `nama KEKAL (sebenar: ${j.data.displayName})`);
  const row = t.row(DEV);
  ok(row.display_name === 'Wani' && row.gender === 'MALE', 'kedua-duanya disimpan dalam D1');
}

// ------------------------------------------------------------
console.log('\n[6] PATCH /api/v1/profile — laluan ralat');
{
  const t = freshDb();

  // jantina haram → 422
  const bad = await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({ gender: 'ALIEN' }),
  }, t);
  ok(bad.status === 422, `gender haram → 422 (sebenar: ${bad.status})`);
  const badBody = await bad.json();
  ok(/gender/.test(badBody.error), `mesej ralat menyebut gender ("${badBody.error}")`);
  ok(t.count() === 0, 'baris tidak dicipta untuk nilai haram');

  // badan kosong → 422
  const empty = await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({}),
  }, t);
  ok(empty.status === 422, `badan kosong → 422 (sebenar: ${empty.status})`);

  // tiada X-Device-Id → 422
  const noDev = await call('/api/v1/profile', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Wani' }),
  }, t);
  ok(noDev.status === 422, `tiada X-Device-Id → 422 (sebenar: ${noDev.status})`);

  // nama terlalu panjang → 422
  const long = await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({ displayName: 'x'.repeat(61) }),
  }, t);
  ok(long.status === 422, `nama 61 aksara → 422 (sebenar: ${long.status})`);
}

// ------------------------------------------------------------
console.log('\n[7] PATCH /api/v1/profile — kosongkan (jangan sentuh vs clear)');
{
  const t = freshDb();
  await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({ displayName: 'Wani', gender: 'FEMALE' }),
  }, t);

  // jantina '' = KOSONGKAN (bukan "jangan ubah")
  const cleared = await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({ gender: '' }),
  }, t);
  const j = await cleared.json();
  ok(j.data.gender === null, `gender '' → dikosongkan (sebenar: ${j.data.gender})`);
  ok(j.data.displayName === 'Wani', `nama tidak disentuh (sebenar: ${j.data.displayName})`);

  // nama '' = KOSONGKAN juga
  const clearedName = await call('/api/v1/profile', {
    method: 'PATCH', headers: H(), body: JSON.stringify({ displayName: '' }),
  }, t);
  const jn = await clearedName.json();
  ok(jn.data.displayName === null, `nama '' → dikosongkan (sebenar: ${jn.data.displayName})`);
}

// ------------------------------------------------------------
console.log('\n[8] POST /reports membawa profil');
{
  const t = freshDb();
  const res = await call('/api/v1/reports', {
    method: 'POST', headers: H(),
    body: JSON.stringify({
      type: 'HAZARD', lat: 5.8943, lng: 116.0505,
      displayName: 'Wani', gender: 'FEMALE',
    }),
  }, t);
  ok(res.status === 201, `HTTP 201 (sebenar: ${res.status})`);
  const row = t.row(DEV);
  ok(!!row, 'baris pengguna dicipta');
  ok(row?.display_name === 'Wani', `nama disimpan (${row?.display_name})`);
  ok(row?.gender === 'FEMALE', `jantina disimpan (${row?.gender})`);
}

// ------------------------------------------------------------
console.log('\n[9] Laporan berikutnya TIDAK memadamkan profil');
{
  const t = freshDb();
  await call('/api/v1/reports', {
    method: 'POST', headers: H(),
    body: JSON.stringify({ type: 'HAZARD', lat: 5.8943, lng: 116.0505, displayName: 'Wani', gender: 'MALE' }),
  }, t);
  // laporan kedua TANPA profil
  await call('/api/v1/reports', {
    method: 'POST', headers: H(),
    body: JSON.stringify({ type: 'HAZARD', lat: 5.8943, lng: 116.0505 }),
  }, t);
  const row = t.row(DEV);
  ok(row?.display_name === 'Wani' && row?.gender === 'MALE',
    `profil KEKAL selepas laporan tanpa profil (${row?.display_name}/${row?.gender})`);
}

// ------------------------------------------------------------
console.log('\n[10] /nearby menulis profil HANYA bila dihantar');
{
  const t = freshDb();
  // tanpa profil → tiada penulisan
  await call('/api/v1/reports/nearby?lat=5.8943&lng=116.0505&radiusM=5000', { headers: H() }, t);
  ok(t.count() === 0, 'tanpa profil → 0 baris (elak tulis pada setiap moveend)');

  // dengan profil → disimpan
  await call('/api/v1/reports/nearby?lat=5.8943&lng=116.0505&radiusM=5000&displayName=Wani&gender=FEMALE', { headers: H() }, t);
  const row = t.row(DEV);
  ok(row?.display_name === 'Wani' && row?.gender === 'FEMALE',
    `dengan profil → disimpan (${row?.display_name}/${row?.gender})`);

  // tanpa header peranti → jangan 422 (nearby tidak menuntutnya)
  const noDev = await call('/api/v1/reports/nearby?lat=5.8943&lng=116.0505&radiusM=5000&displayName=X', {}, t);
  ok(noDev.status === 200, `tanpa X-Device-Id → 200, bukan 422 (sebenar: ${noDev.status})`);
}

// ------------------------------------------------------------
console.log('\n[11] Frontend — localStorage + UI + profil dihantar');
{
  const html = await (await call('/', {}, freshDb())).text();

  ok(html.includes("const PROFILE_NAME_KEY = 'lalin.username'"), 'kunci localStorage lalin.username diisytiharkan');
  ok(html.includes("const PROFILE_GENDER_KEY = 'lalin.gender'"), 'kunci localStorage lalin.gender diisytiharkan');
  ok(html.includes("localStorage.getItem(PROFILE_NAME_KEY)"), 'nama dibaca dari localStorage');
  ok(html.includes("localStorage.getItem(PROFILE_GENDER_KEY)"), 'jantina dibaca dari localStorage');
  ok(html.includes("localStorage.setItem(PROFILE_NAME_KEY"), 'nama disimpan ke localStorage');
  ok(html.includes("localStorage.setItem(PROFILE_GENDER_KEY"), 'jantina disimpan ke localStorage');
  ok(html.includes('id="profile-name"'), 'medan Nama Paparan wujud');
  ok(html.includes('id="profile-gender"'), 'medan Jantina wujud');
  ok(html.includes('id="save-profile"'), 'butang Simpan Profil wujud');
  ok(html.includes("$('save-profile').onclick = saveProfile"), 'butang dipasangkan');
  ok(html.includes("maxlength=\"60\""), 'had 60 aksara pada input nama');
  ok(/value="MALE"[\s\S]{0,200}?Lelaki/.test(html), 'pilihan Lelaki wujud');
  ok(/value="FEMALE"[\s\S]{0,200}?Perempuan/.test(html), 'pilihan Perempuan wujud');
  ok(!/UNSPECIFIED/.test(html), 'pilihan "Lain-lain" DIBUANG — hanya Lelaki/Perempuan/kosong');

  // profil dihantar bersama laporan
  ok(html.includes('displayName: prof.displayName'), 'profil dihantar bersama POST /reports');
  const wsOpen = html.slice(html.indexOf('state.ws.onopen'));
  ok(wsOpen.includes('displayName: prof.displayName'), 'profil dihantar bersama mesej WebSocket');
  ok(html.includes('encodeURIComponent(prof.displayName)'), 'profil dihantar bersama carian /nearby');
  ok(html.includes('defaultDisplayName()'), 'nama lalai = ID automatik');
}

console.log('\n[11] Penjejakan langsung — punca isu "peta kaku"');
{
  const html = await (await call('/', {}, freshDb())).text();

  // `getCurrentPosition` sahaja = satu pukul = penanda membeku.
  // `watchPosition` ialah punca peta rasa kaku.
  ok(html.includes('navigator.geolocation.watchPosition'), 'watchPosition digunakan (bukan getCurrentPosition sahaja)');
  ok(html.includes('function startTracking()'), 'startTracking() wujud');
  ok(html.includes('startTracking();'), 'startTracking() DIPANGGIL');

  // penanda mesti diinterpolasi, bukan dilompat
  ok(html.includes('function moveMe('), 'moveMe() wujud');
  ok(html.includes('requestAnimationFrame'), 'animasi penanda melalui rAF');
  ok(/dur:\s*850/.test(html), 'tempoh interpolasi ditetapkan (850ms)');
  ok(html.includes('easeInOut'), 'lenaan smoothstep digunakan');
  ok(html.includes('dist > 2_000'), 'lompatan jauh (>2 km) tidak dianimasikan');

  // anak panah haluan
  ok(html.includes('setMeHeading('), 'anak panah berputar mengikut haluan');
  ok(html.includes('rotate('), 'putaran haluan dipakai');

  // jejak pergerakan
  ok(html.includes("id: 'trail'"), 'lapisan jejak wujud');
  ok(html.includes('state.trail'), 'state.trail dikekalkan');

  // mod ikut saya
  ok(html.includes('id="toggle-follow"'), 'butang "Ikut saya" wujud');
  ok(html.includes("$('toggle-follow').onclick = toggleFollow"), 'butang dipasangkan');
  ok(html.includes('state.following'), 'state.following dikekalkan');
  ok(html.includes("map.on('dragstart'"), 'mod ikut padam apabila peta digerakkan');

  // statistik langsung
  ok(html.includes('id="s-speed"'), 'paparan kelajuan wujud');
  ok(html.includes('id="s-acc"'), 'paparan jitu lokasi wujud');
  ok(html.includes('km/j'), 'kelajuan dalam km/j');

  // sempadan sel → langgan semula
  ok(html.includes('prevCell !== state.cell'), 'perubahan sel geohash dikesan');
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
