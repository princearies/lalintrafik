// ============================================================
//  Ujian routing — OSRM melalui pelayan mock tempatan
//
//  Mengunci dua regression nyata:
//   1. OSRM demo membalas 403 kepada User-Agent kosong → tanpa
//      header UA yang sah, setiap panggilan routing gagal 502.
//   2. Ralat routing MESTI gagal dengan 502 + kod mesin, bukan
//      laluan palsu atau 500 mentah.
// ============================================================
import http from 'node:http';
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

// ---------- transpile routing.ts + errors.ts ----------
console.log('\n[0] Transpile');
const routeOut = path.join(here, '_routing.mjs');
execFileSync('cmd', ['/c', esbuild,
  path.join(root, 'src/routes/routing.ts'), '--bundle', '--format=esm',
  '--platform=neutral', '--target=es2022', '--outfile=' + routeOut,
], { stdio: 'pipe' });
const { getRoute } = await import('file:///' + routeOut.replace(/\\/g, '/'));
console.log('  transpile routing.ts OK');

// ---------- pelayan mock yang merakam User-Agent ----------
function startMock(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({
        url: req.url,
        ua: req.headers['user-agent'] ?? '',
        accept: req.headers['accept'] ?? '',
      });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}

const osrmOk = (req, res) => {
  void req;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 1234.5, duration: 678, geometry: { type: 'LineString', coordinates: [[101.1, 3.1], [101.2, 3.2]] } }],
  }));
};

const fakeCtx = (baseUrl) => ({ env: { OSRM_BASE_URL: baseUrl } });

// ---------- 1. User-Agent mesti dihantar ----------
console.log('\n[1] User-Agent');
{
  const { server, port, seen } = await startMock(osrmOk);
  const r = await getRoute(fakeCtx(`http://127.0.0.1:${port}/route/v1/driving`), [
    { lat: 3.139, lng: 101.6869 },
    { lat: 1.4927, lng: 103.7414 },
  ]);
  server.close();

  ok(seen.length === 1, `pelayan menerima 1 panggilan (sebenar: ${seen.length})`);
  ok(seen[0].ua.length > 0, `User-Agent dihantar (sebenar: "${seen[0].ua}")`);
  ok(/lalintrafik/.test(seen[0].ua), `User-Agent mengenal pasti aplikasi: "${seen[0].ua}"`);
  ok(seen[0].accept.includes('application/json'), 'Accept: application/json dihantar');
  ok(r.distanceM === 1235, `distanceM dibundarkan (sebenar: ${r.distanceM})`);
  ok(r.durationS === 678, `durationS dibundarkan (sebenar: ${r.durationS})`);
  ok(r.provider === 'osrm', `provider=osrm (sebenar: ${r.provider})`);
  ok(r.cached === false, 'cached=false untuk panggilan pertama');
  ok(Array.isArray(r.geometry.coordinates) && r.geometry.coordinates.length === 2,
    'geometri GeoJSON dipulangkan');
}

// ---------- 2. Koordinat dalam format lng,lat ----------
console.log('\n[2] Format koordinat OSRM (lng,lat)');
{
  const { server, port, seen } = await startMock(osrmOk);
  await getRoute(fakeCtx(`http://127.0.0.1:${port}/route/v1/driving`), [
    { lat: 3.139, lng: 101.6869 },
    { lat: 1.4927, lng: 103.7414 },
  ]);
  server.close();

  const coordPart = seen[0].url.split('?')[0].split('/').pop();
  ok(coordPart === '101.6869,3.139;103.7414,1.4927',
    `OSRM menerima lng,lat (sebenar: "${coordPart}")`);
  ok(seen[0].url.includes('geometries=geojson'), 'geometries=geojson diminta');
  ok(seen[0].url.includes('overview=full'), 'overview=full diminta');
}

// ---------- 3. Gagal rangkaian → 502 yang kemas ----------
console.log('\n[3] Fail-open');
{
  const { server, port } = await startMock((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'InvalidQuery' }));
  });
  let caught = null;
  try {
    await getRoute(fakeCtx(`http://127.0.0.1:${port}/route/v1/driving`), [
      { lat: 3.139, lng: 101.6869 },
      { lat: 1.4927, lng: 103.7414 },
    ]);
  } catch (e) { caught = e; }
  server.close();

  ok(caught !== null, 'ralat dilemparkan (bukan laluan palsu)');
  ok(caught?.status === 502, `status 502 (sebenar: ${caught?.status})`);
  ok(caught?.code === 'ROUTING_UNAVAILABLE', `kod ROUTING_UNAVAILABLE (sebenar: ${caught?.code})`);
}

// ---------- 4. Ralat Code !== 'Ok' → 502 ----------
console.log('\n[4] OSRM balas code bukan Ok');
{
  const { server, port } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NoRoute' }));
  });
  let caught = null;
  try {
    await getRoute(fakeCtx(`http://127.0.0.1:${port}/route/v1/driving`), [
      { lat: 3.139, lng: 101.6869 },
      { lat: 1.4927, lng: 103.7414 },
    ]);
  } catch (e) { caught = e; }
  server.close();

  ok(caught?.status === 502, `status 502 (sebenar: ${caught?.status})`);
  ok(caught?.code === 'ROUTING_UNAVAILABLE', `kod ROUTING_UNAVAILABLE (sebenar: ${caught?.code})`);
}

// ---------- 5. Kurang 2 titik → 422 ----------
console.log('\n[5] Pengesahan input');
{
  let caught = null;
  try { await getRoute(fakeCtx('http://127.0.0.1:1/x'), [{ lat: 3.1, lng: 101.1 }]); }
  catch (e) { caught = e; }
  ok(caught?.status === 422, `status 422 (sebenar: ${caught?.status})`);
  ok(caught?.code === 'NEED_2_POINTS', `kod NEED_2_POINTS (sebenar: ${caught?.code})`);
}

// ---------- 6. OSRM tiada geometri → fallback garis lurus ----------
console.log('\n[6] Fallback geometri');
{
  const { server, port } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 'Ok',
      routes: [{ distance: 1000, duration: 100 }],
    }));
  });
  const r = await getRoute(fakeCtx(`http://127.0.0.1:${port}/route/v1/driving`), [
    { lat: 3.139, lng: 101.6869 },
    { lat: 1.4927, lng: 103.7414 },
  ]);
  server.close();

  ok(r.geometry.type === 'LineString', 'fallback jenis LineString');
  ok(r.geometry.coordinates.length === 2, `fallback 2 titik (sebenar: ${r.geometry.coordinates.length})`);
  ok(r.geometry.coordinates[0][0] === 101.6869, 'fallback dalam format lng,lat');
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
