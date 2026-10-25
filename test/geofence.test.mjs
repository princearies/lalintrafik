// ============================================================
//  Ujian geofence Kota Kinabalu
//
//  Mengunci: zon operasi, titik tengah, dan had radius 25 km.
//  Koordinat ialah lokasi sebenar bagi setiap zon yang diminta.
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = path.join(root, 'node_modules/.bin/esbuild.cmd');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

console.log('\n[0] Transpile');
const out = path.join(here, '_geofence.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/lib/geofence.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const g = await import('file:///' + out.replace(/\\/g, '/'));
console.log('  transpile geofence.ts OK');

// ---------- koordinat sebenar ----------
const KK = { lat: 5.9804, lng: 116.0735 };
const ZONES = [
  ['Pusat bandar KK', 5.9804, 116.0735],
  ['Sepanggar', 5.9553, 116.0730],
  ['Inanam', 5.9830, 116.1300],
  ['Donggongon', 5.9167, 116.1000],
  ['Penampang', 5.9333, 116.1167],
  ['Putatan', 5.8900, 116.0500],
  ['KKIA (lapangan terbang)', 5.9372, 116.0512],
];
const LUAR = [
  ['Kuala Lumpur', 3.1390, 101.6869],
  ['Kuching', 1.5535, 110.3593],
  ['Johor Bahru', 1.4927, 103.7414],
  ['Sandakan', 5.8394, 118.1171],
  ['Tawau', 4.2447, 117.8912],
];

// ---------- 1. konstanta ----------
console.log('\n[1] Konstanta');
ok(g.KK_CENTER.lat === 5.9804 && g.KK_CENTER.lng === 116.0735,
  `KK_CENTER = ${g.KK_CENTER.lat}, ${g.KK_CENTER.lng}`);
ok(g.KK_RADIUS_M === 25000, `KK_RADIUS_M = ${g.KK_RADIUS_M} m (25 km)`);

// ---------- 2. zon dalam ----------
console.log('\n[2] Zon operasi (mesti DITERIMA)');
for (const [name, lat, lng] of ZONES) {
  const km = g.distanceFromCenterM(lat, lng) / 1000;
  ok(g.isWithinGeofence(lat, lng),
    `${name}: ${km.toFixed(2)} km → dalam zon`);
}

// ---------- 3. zon luar ----------
console.log('\n[3] Luar zon (mesti DITOLAK)');
for (const [name, lat, lng] of LUAR) {
  const d = g.distanceFromCenterM(lat, lng);
  ok(!g.isWithinGeofence(lat, lng),
    `${name}: ${(d / 1000).toFixed(0)} km → luar zon`);
}

// ---------- 4. sempadan ----------
console.log('\n[4] Sempadan 25 km');
{
  // 25 km ke utara: 25000 / 111320 darjah latitud
  const edge = 5.9804 + 25000 / 111320;
  const dEdge = g.distanceFromCenterM(edge, KK.lng);
  ok(Math.abs(dEdge - 25000) < 50,
    `titik tepat di had: ${dEdge.toFixed(0)} m (jangka 25000)`);
  ok(g.isWithinGeofence(edge, KK.lng), 'titik di had → DITERIMA (inklusif)');

  const beyond = edge + 0.01; // ~1.1 km lagi
  const dBeyond = g.distanceFromCenterM(beyond, KK.lng);
  ok(!g.isWithinGeofence(beyond, KK.lng),
    `titik 1.1 km luar had (${dBeyond.toFixed(0)} m) → DITOLAK`);
}

// ---------- 5. override env ----------
console.log('\n[5] Override melalui Env');
{
  const small = { CENTER_LAT: '5.9804', CENTER_LNG: '116.0735', GEOFENCE_RADIUS_M: '5000' };
  ok(g.geofenceOf(small).radiusM === 5000, 'radius env = 5000 m diterima');
  // Sepanggar 2.79 km — masih dalam bila radius dikecilkan kepada 5 km
  ok(g.isWithinGeofence(5.9553, 116.0730, small),
    `Sepanggar (${(g.distanceFromCenterM(5.9553, 116.0730) / 1000).toFixed(2)} km) masih DITERIMA pada had 5 km`);
  // Putatan 10.38 km — jatuh luar bila radius dikecilkan kepada 5 km
  ok(!g.isWithinGeofence(5.8900, 116.0500, small),
    `Putatan (${(g.distanceFromCenterM(5.8900, 116.0500) / 1000).toFixed(2)} km) DITOLAK pada had 5 km`);
  ok(g.isWithinGeofence(5.9804, 116.0735, small), 'pusat tetap DITERIMA');

  const shifted = { CENTER_LAT: '1.5535', CENTER_LNG: '110.3593', GEOFENCE_RADIUS_M: '25000' };
  ok(g.isWithinGeofence(1.5535, 110.3593, shifted), 'pusat Kuching DITERIMA bila pusat ditukar');
  ok(!g.isWithinGeofence(5.9804, 116.0735, shifted), 'KK DITOLAK bila pusat ditukar ke Kuching');
}

// ---------- 6. env rosak -> lalai selamat ----------
console.log('\n[6] Env rosak');
{
  const broken = { CENTER_LAT: 'bukan nombor', CENTER_LNG: '', GEOFENCE_RADIUS_M: '-5' };
  const geo = g.geofenceOf(broken);
  ok(geo.lat === g.KK_CENTER.lat && geo.lng === g.KK_CENTER.lng,
    'nilai bukan nombor → jatuh balik ke pusat KK');
  ok(geo.radiusM === g.KK_RADIUS_M, 'radius negatif → jatuh balik ke 25 km');
  ok(g.isWithinGeofence(5.9804, 116.0735, broken), 'geofence masih berfungsi selepas env rosak');
}

// ---------- 7. mesej ralat ----------
console.log('\n[7] Mesej ralat');
{
  const msg = g.geofenceMessage(3.1390, 101.6869);
  ok(/luar zon operasi/.test(msg), `mesej menyatakan sebab: "${msg.slice(0, 46)}…"`);
  ok(/km dari pusat Kota Kinabalu/.test(msg), 'mesej menyatakan jarak dari KK');
  ok(/had 25 km/.test(msg), 'mesej menyatakan had geofence');
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
