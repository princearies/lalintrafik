// ============================================================
//  Ujian penyajian app web — `/` mesti memulangkan HTML
//
//  Worker tidak mempunyai direktori statik, jadi frontend/index.html
//  dibawa di dalam bundle dan disajikan pada `/`. Ujian ini mengunci:
//   1. `/` memulangkan HTML (bukan JSON) — inilah yang dibuka telefon.
//   2. HTML itu mengandungi elemen yang diperlukan peta.
//   3. Maklumat projek masih tersedia, hanya di bawah /api/v1/info.
// ============================================================
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = path.join(root, 'node_modules/.bin/esbuild.cmd');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

console.log('\n[0] Transpile titik masuk');
const out = path.join(here, '_serve.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/index.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + out,
], { stdio: 'pipe' });
const { app } = await import('file:///' + out.replace(/\\/g, '/'));
console.log('  transpile index.ts OK');

// Elemen yang mesti wujud supaya peta boleh berfungsi pada telefon.
const REQUIRED = [
  ['<!doctype html', 'isytihar dokumen'],
  ['<div id="map">', 'kontena peta'],
  ['name="viewport"', 'meta viewport (mudah alih)'],
  ['maplibregl', 'pustaka MapLibre'],
  ['/api/v1/hotspots', 'panggilan agregasi hotspot'],
  ['api/v1/reports/nearby', 'panggilan laporan berdekatan'],
];

console.log('\n[1] GET / memulangkan HTML app');
{
  const res = await app.request('/');
  const body = await res.text();
  ok(res.status === 200, `HTTP 200 (sebenar: ${res.status})`);
  ok((res.headers.get('content-type') || '').includes('text/html'),
    `content-type text/html (sebenar: ${res.headers.get('content-type')})`);
  ok(/^\s*<!doctype html/i.test(body), 'badan bermula dengan <!doctype html>');

  for (const [needle, label] of REQUIRED) {
    ok(body.includes(needle), `mengandungi ${label} (${needle})`);
  }
}

console.log('\n[2] Maklumat projek di /api/v1/info');
{
  const res = await app.request('/api/v1/info');
  const j = await res.json();
  ok(res.status === 200, `HTTP 200 (sebenar: ${res.status})`);
  ok(j.name === 'Mykira Map', `name=Mykira Map (sebenar: ${j.name})`);
  ok(j.zone && j.zone.center && j.zone.radiusM === 90000,
    `zon operasi: ${j.zone && j.zone.center.lat},${j.zone && j.zone.center.lng} radius=${j.zone && j.zone.radiusM}`);
}

console.log('\n[3] /healthz');
{
  const res = await app.request('/healthz');
  const j = await res.json();
  ok(res.status === 200, `HTTP 200 (sebenar: ${res.status})`);
  ok(j.status === 'ok', `status=ok (sebenar: ${j.status})`);
  ok(typeof j.ts === 'number', 'ts ialah nombor');
}

console.log('\n[4] Frontend menggunakan URL RELATIF');
{
  // Kunci utama untuk telefon: API_BASE lalai KOSONG, supaya panggilan
  // fetch diselesaikan terhadap origin laman itu sendiri. Jika ia
  // dikembali kepada 'http://localhost:8787', app hanya berfungsi di
  // desktop tempatan dan gagal pada telefon.
  const html = await (await app.request('/')).text();
  const m = html.match(/localStorage\.getItem\('lalin\.api'\)\s*\|\|\s*('[^']*'|"[^"]*")/);
  ok(!!m, 'mencari tetapan lalai API_BASE');
  if (m) ok(m[1] === "''", `API_BASE lalai kosong/relatif (sebenar: ${m[1]})`);

  // `localhost:8787` masih TIDAK dibenarkan sebagai nilai lalai — ia hanya
  // boleh muncul dalam komen yang menerangkan cara melayan diri sendiri.
  ok(!/localStorage\.getItem\('lalin\.api'\)\s*\|\|\s*['"]http:\/\/localhost/.test(html),
    'localhost:8787 bukan lagi nilai lalai (app gagal pada telefon)');
}

console.log('\n[5] boot() benar-benar dipanggil');
{
  // Pepijat sebenar: `boot()` TIDAK dipanggil. App terus berfungsi kerana
  // `locate()` memicu `refresh()` melalui `moveend`, tetapi petunjuk kekal
  // sebagai teks placeholder "Menunggu laluan API…" selamanya — pemeriksaan
  // kesihatan API tidak pernah berlaku.
  const html = await (await app.request('/')).text();
  const js = html.slice(html.indexOf('<script>'));
  // `async function boot()` mengandungi "boot()" tetapi BUKAN "boot();" —
  // jadi pencarian "boot();" hanya berjaya jika ada panggilan sebenar.
  ok(js.includes('boot();'), 'boot() dipanggil (bukan sekadar ditakrif)');
  ok(/async function boot\(\)\s*\{/.test(js), 'boot() masih ditakrifkan');
  ok(js.includes("Menunggu laluan API"), 'teks placeholder wujud dalam HTML');
  ok(js.includes("$('hint').innerHTML"), 'boot() mengemas kini petunjuk');
}

console.log('\n[6] Panel mudah alih boleh tutup');
{
  // Pada telefon panel bermula TERTUTUP supaya peta kelihatan. Memampat
  // panel sehingga ia masih menutup separuh skrin adalah lebih buruk
  // daripada menyembunyikannya sehingga diperlukan.
  const html = await (await app.request('/')).text();
  const js = html.slice(html.indexOf('<script>'));

  ok(html.includes('id="menu-toggle"'), 'butang ☰ wujud (#menu-toggle)');
  ok(html.includes('class="panel" id="panel"'), 'panel mempunyai id="panel"');
  ok(js.includes("$('menu-toggle').onclick"), 'butang ☰ ada pengendali klik');
  ok(js.includes('syncPanel()'), 'syncPanel() dipanggil');
  ok(html.includes('max-width: 640px'), 'media query mudah alih wujud');

  // ☰ tersembunyi pada desktop, kelihatan pada telefon
  ok(/\.fab\s*\{\s*display:\s*none/.test(html), '.fab tersembunyi secara lalai');
  ok(/\.fab\s*\{\s*display:\s*block/.test(html), '.fab kelihatan pada telefon');

  // panel tersembunyi pada telefon, .panel.open membukanya
  ok(/\.panel\s*\{\s*display:\s*none/.test(html), '.panel tersembunyi pada telefon');
  ok(/\.panel\.open\s*\{\s*display:\s*block/.test(html), '.panel.open membukanya');

  // log disembunyikan pada telefon — ia hanya mengelirukan di skrin kecil
  ok(/\.log\s*\{\s*display:\s*none/.test(html), '.log tersembunyi pada telefon');
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
