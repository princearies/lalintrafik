// ============================================================
//  Ujian geospatial + logik nearby (dengan mock D1)
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- transpile geo.ts + errors.ts ----------
console.log('\n[0] Transpile');
const geoOut = path.join(here, '_geo.mjs');
const errOut = path.join(here, '_errors.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/lib/geo.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + geoOut,
], { stdio: 'pipe' });
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/lib/errors.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + errOut,
], { stdio: 'pipe' });
const geo = await import('file:///' + geoOut.replace(/\\/g, '/'));
const errs = await import('file:///' + errOut.replace(/\\/g, '/'));
console.log('   siap');

// ---------- [1] Haversine ----------
console.log('\n[1] Haversine');
// Kuala Lumpur (3.1390, 101.6869) → Johor Bahru (1.4927, 103.7414) ≈ 294 km
const d = geo.haversineM(3.139, 101.6869, 1.4927, 103.7414);
console.log(`   KL → JB = ${(d / 1000).toFixed(1)} km`);
ok(near(d / 1000, 294, 8), 'KL→JB ≈ 294 km');

// Jarak sifar
ok(geo.haversineM(3.1, 101.6, 3.1, 101.6) < 0.01, 'jarak sifar ≈ 0');

// 1 darjah latitud ≈ 111.32 km
const dLat = geo.haversineM(0, 0, 1, 0);
console.log(`   1° latitud = ${(dLat / 1000).toFixed(2)} km`);
ok(near(dLat / 1000, 111.32, 0.5), '1° latitud ≈ 111.32 km');

// ---------- [2] geohash ----------
console.log('\n[2] geohash');
const h = geo.geohash(3.139, 101.6869, 8);
console.log(`   geohash(3.139,101.6869,8) = ${h}`);
ok(h.length === 8, 'panjang 8');
ok(/^[0-9a-z]{8}$/.test(h), 'aksara geohash sah');

// kejituan: dua titik dekat → geohash sama pada precision tinggi
const h1 = geo.geohash(3.1390, 101.6869, 8);
const h2 = geo.geohash(3.1391, 101.6870, 8);
console.log(`   h1=${h1}  h2=${h2}`);
ok(h1 === h2, 'titik 11m berhampiran → geohash sama');

// titik jauh → geohash berbeza
const h3 = geo.geohash(1.4927, 103.7414, 6);
console.log(`   geohash(JB,6) = ${h3}`);
ok(h1.slice(0, 6) !== h3, 'KL vs JB → geohash 6 berbeza');

// ---------- [3] boundingBox ----------
console.log('\n[3] boundingBox');
const box = geo.boundingBox(3.139, 101.6869, 5_000);
console.log(`   5km di KL: lat ${box.minLat.toFixed(4)}..${box.maxLat.toFixed(4)} lng ${box.minLng.toFixed(4)}..${box.maxLng.toFixed(4)}`);
const dLatDeg = (box.maxLat - box.minLat) * 111.32;
const dLngDeg = (box.maxLng - box.minLng) * 111.32 * Math.cos((3.139 * Math.PI) / 180);
console.log(`   saiz peti: ${(dLatDeg).toFixed(2)} km (lat) × ${(dLngDeg).toFixed(2)} km (lng)`);
ok(near(dLatDeg, 10, 0.5), 'lebarnya peti ≈ 10 km (2×5km)');
ok(dLngDeg > 9 && dLngDeg < 11, 'lintangnya peti ≈ 10 km pada latitud 3°');

// ---------- [4] TTL ----------
console.log('\n[4] TTL mengikut jenis');
const cases = [
  ['ACCIDENT', 45 * 60_000],
  ['SPEED_TRAP', 90 * 60_000],
  ['ROAD_CLOSURE', 24 * 3_600_000],
  ['UNKNOWN_TYPE', 3_600_000],
];
for (const [t, exp] of cases) {
  const got = errs.ttlFor(t, {});
  ok(got === exp, `TTL ${t} = ${got / 60_000} minit`);
}

// ---------- [5] pengesah ----------
console.log('\n[5] Pengesah');
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

ok(!throws(() => errs.requireLat(3.139)), 'lat sah diterima');
ok(throws(() => errs.requireLat(95)), 'lat 95 ditolak');
ok(throws(() => errs.requireLng(200)), 'lng 200 ditolak');
ok(throws(() => errs.requireEnum('BOGUS', 'type', ['ACCIDENT'])), 'enum haram ditolak');
ok(errs.clampInt('abc', 'limit', 1, 100, 50) === 50, 'input bukan angka → nilai lalai');
ok(errs.clampInt(5000, 'limit', 1, 100, 50) === 100, 'melebihi had → dihadkan');

// ---------- [6] Parameter query sentiasa string ----------
console.log('\n[6] Paksaan string (parameter query)');
// Ini pepijat sebenar: ?lat=3.139 sampai sebagai STRING.
ok(errs.requireLat('3.139') === 3.139, "requireLat('3.139') diterima");
ok(errs.requireLng('101.6869') === 101.6869, "requireLng('101.6869') diterima");
ok(errs.requireNumber('5000', 'radiusM') === 5000, "requireNumber('5000') diterima");
ok(errs.requireLat(' 3.139 ') === 3.139, "requireLat(' 3.139 ') — ruang dipotong");
ok(throws(() => errs.requireLat('abc')), "requireLat('abc') ditolak");
ok(throws(() => errs.requireLat('')), "requireLat('') ditolak");
ok(throws(() => errs.requireNumber(null, 'x')), 'requireNumber(null) ditolak');
ok(errs.optionalNumber(undefined, 'accuracyM', 0, 100) === undefined, 'optionalNumber(undefined) → undefined');
ok(errs.optionalNumber('12', 'accuracyM', 0, 100) === 12, "optionalNumber('12') diterima");
ok(throws(() => errs.optionalNumber('500', 'accuracyM', 0, 100)), "optionalNumber('500') di luar had ditolak");

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
