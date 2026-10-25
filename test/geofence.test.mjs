// ============================================================
//  Ujian geofence Mykira Map — koridor selatan Sabah
//
//  Koridor: Kota Kinabalu → Putatan → Papar → Kimanis → Membakut
//  Pusat: Putatan (5.8943, 116.0505) · Had: 90 km
//
//  Koordinat ialah lokasi sebenar bagi setiap bandar dalam koridor.
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

// ---------- koordinat sebenar dalam koridor ----------
const PUTATAN = { lat: 5.8943, lng: 116.0505 };
const DALAM = [
  ['Kota Kinabalu', 5.9804, 116.0735],        // ~10 km
  ['KKIA (lapangan terbang)', 5.9372, 116.0512],   // ~5 km
  ['Petagas', 5.9167, 116.0667],              // ~3 km
  ['Putatan (pusat)', 5.8943, 116.0505],      // 0 km
  ['Lok Kawi', 5.8600, 116.0800],             // ~5 km
  ['Papar', 5.7333, 115.9333],                // ~22 km
  ['Kimanis', 5.5333, 115.8833],              // ~44 km
  ['Kg Pimping, Membakut', 5.4500, 115.7300], // ~62 km
];
const LUAR = [
  ['Kuala Lumpur', 3.1390, 101.6869],
  ['Kuching', 1.5535, 110.3593],
  ['Johor Bahru', 1.4927, 103.7414],
  ['Sandakan', 5.8394, 118.1171],
  ['Tawau', 4.2447, 117.8912],
  ['Singapura', 1.3521, 103.8198],
];

// ---------- 1. konstanta ----------
console.log('\n[1] Konstanta');
ok(g.MAP_CENTER.lat === 5.8943 && g.MAP_CENTER.lng === 116.0505,
  `MAP_CENTER = ${g.MAP_CENTER.lat}, ${g.MAP_CENTER.lng} (Putatan)`);
ok(g.MAP_RADIUS_M === 90000, `MAP_RADIUS_M = ${g.MAP_RADIUS_M} m (90 km)`);

// ---------- 2. keseluruhan koridor ----------
console.log('\n[2] Koridor operasi (mesti DITERIMA)');
for (const [name, lat, lng] of DALAM) {
  const km = g.distanceFromCenterM(lat, lng) / 1000;
  ok(g.isWithinGeofence(lat, lng),
    `${name}: ${km.toFixed(1)} km → dalam zon`);
}

// ---------- 3. luar zon ----------
console.log('\n[3] Luar zon (mesti DITOLAK)');
for (const [name, lat, lng] of LUAR) {
  const km = g.distanceFromCenterM(lat, lng) / 1000;
  ok(!g.isWithinGeofence(lat, lng),
    `${name}: ${km.toFixed(0)} km → luar zon`);
}

// ---------- 4. sempadan 90 km ----------
console.log('\n[4] Sempadan 90 km');
{
  // 90 km ke utara: 90000 / 111320 darjah latitud
  const edge = PUTATAN.lat + 90000 / 111320;
  const dEdge = g.distanceFromCenterM(edge, PUTATAN.lng);
  ok(Math.abs(dEdge - 90000) < 200,
    `titik tepat di had: ${dEdge.toFixed(0)} m (jangka 90000)`);
  ok(g.isWithinGeofence(edge, PUTATAN.lng), 'titik di had → DITERIMA (inklusif)');

  const beyond = edge + 0.05; // ~5.5 km lagi
  const dBeyond = g.distanceFromCenterM(beyond, PUTATAN.lng);
  ok(!g.isWithinGeofence(beyond, PUTATAN.lng),
    `titik ${((dBeyond - 90000) / 1000).toFixed(1)} km luar had → DITOLAK`);
}

// ---------- 5. override env ----------
console.log('\n[5] Override melalui Env');
{
  const kecil = { CENTER_LAT: '5.8943', CENTER_LNG: '116.0505', GEOFENCE_RADIUS_M: '20000' };
  ok(g.geofenceOf(kecil).radiusM === 20000, 'radius env = 20000 m diterima');
  // KK ~10 km — masih dalam pada had 20 km
  ok(g.isWithinGeofence(5.9804, 116.0735, kecil),
    `KK (${(g.distanceFromCenterM(5.9804, 116.0735) / 1000).toFixed(1)} km) masih DITERIMA pada had 20 km`);
  // Papar ~22 km — jatuh luar pada had 20 km
  ok(!g.isWithinGeofence(5.7333, 115.9333, kecil),
    `Papar (${(g.distanceFromCenterM(5.7333, 115.9333) / 1000).toFixed(1)} km) DITOLAK pada had 20 km`);

  const alih = { CENTER_LAT: '1.5535', CENTER_LNG: '110.3593', GEOFENCE_RADIUS_M: '90000' };
  ok(g.isWithinGeofence(1.5535, 110.3593, alih), 'Kuching DITERIMA bila pusat ditukar');
  ok(!g.isWithinGeofence(5.8943, 116.0505, alih), 'Putatan DITOLAK bila pusat ditukar ke Kuching');
}

// ---------- 6. env rosak -> lalai selamat ----------
console.log('\n[6] Env rosak');
{
  const rosak = { CENTER_LAT: 'bukan nombor', CENTER_LNG: '', GEOFENCE_RADIUS_M: '-5' };
  const geo = g.geofenceOf(rosak);
  ok(geo.lat === g.MAP_CENTER.lat && geo.lng === g.MAP_CENTER.lng,
    'nilai kosong/bukan nombor → jatuh balik ke Putatan');
  ok(geo.radiusM === g.MAP_RADIUS_M, 'radius negatif → jatuh balik ke 90 km');
  ok(g.isWithinGeofence(5.8943, 116.0505, rosak), 'geofence masih berfungsi selepas env rosak');
}

// ---------- 7. mesej ralat ----------
console.log('\n[7] Mesej ralat');
{
  const msg = g.geofenceMessage(3.1390, 101.6869);
  ok(/luar zon operasi/.test(msg), 'mesej menyatakan sebab');
  ok(/km dari Putatan/.test(msg), `mesej menyatakan jarak dari Putatan: "${msg.slice(0, 48)}…"`);
  ok(/had 90 km/.test(msg), 'mesej menyatakan had geofence 90 km');
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
