// ============================================================
//  Utiliti geospatial — geohash + Haversine + peti bounding
// ============================================================

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Radius bumi (meter) untuk Haversine. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Jarak Great-Circle antara dua titik, dalam METER.
 * formula Haversine — stabil untuk jarak kecil.
 */
export function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Peti bounding (minLat, minLng, maxLat, maxLng) untuk radius tertentu.
 *
 * Penting: 1 darjah latitud ≈ 111,320 m di mana-mana, tetapi 1 darjah
 * longitud mengecil dengan `cos(latitud)`. Menggunakan 111,320 untuk kedua-duanya
 * menghasilkan peti yang TERLALU BESAR di lintang tinggi — masih betul dari segi
 * ketepatan (tapis Haversine kemudiannya), tetapi lebih lama.
 */
export function boundingBox(
  lat: number,
  lng: number,
  radiusM: number,
): { minLat: number; minLng: number; maxLat: number; maxLng: number } {
  const latDelta = radiusM / 111_320;
  const cosLat = Math.cos(toRad(lat));
  // elak pembahagian kosong di hampir-kutub
  const lngDelta = radiusM / Math.max(111_320 * Math.abs(cosLat), 1e-6);

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/** Jadual geohash precision → saiz sel (lebar x tinggi, meter). */
export const GEOHASH_CELL_M: Record<number, { w: number; h: number }> = {
  4: { w: 39_100, h: 19_500 },
  5: { w: 4_900, h: 4_900 },
  6: { w: 1_230, h: 610 },
  7: { w: 152, h: 152 },
  8: { w: 38, h: 19 },
  9: { w: 4.8, h: 4.8 },
};

/**
 * Kod geohash untuk lat/lng pada precision tertentu.
 * Digunakan sebagai kunci sharding Durable Object (precision 6)
 * dan sebagai lajur indeks (precision 8).
 */
export function geohash(lat: number, lng: number, precision = 8): string {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let hash = '';

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        idx = idx * 2 + 1;
        lngMin = mid;
      } else {
        idx = idx * 2;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx = idx * 2;
        latMax = mid;
      }
    }

    evenBit = !evenBit;
    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }

  return hash;
}

/**
 * 8 sel jiranan bagi satu geohash (termasuk dirinya sendiri).
 * Dipakai untuk menghantar siaran ke sel bersebelahan — pengguna di
 * sempadan sel masih menerima laporan dari seberang sempadan.
 */
export function neighbourCells(hash: string): string[] {
  // Ketepatan sel jiranan bergantung pada panjang hash — untuk precision 6
  // kita guna grid darjah secara langsung untuk elak juzuk geohash yang
  // mengandungi bit bergantian lat/lng yang rumit.
  if (hash.length !== 6) return [hash];

  const cell = GEOHASH_CELL_M[6];
  const base = decodeCell(hash);
  if (!base) return [hash];

  const out: string[] = [];
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const lat = base.lat + dLat * (cell.h / 111_320);
      const lng = base.lng + dLng * (cell.w / (111_320 * Math.max(Math.abs(Math.cos(toRad(base.lat))), 1e-6)));
      out.push(geohash(lat, lng, 6));
    }
  }
  return out;
}

function decodeCell(hash: string): { lat: number; lng: number } | null {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let evenBit = true;

  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null;
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        if (idx & mask) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (idx & mask) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }

  return {
    lat: (latMin + latMax) / 2,
    lng: (lngMin + lngMax) / 2,
  };
}

/** Sel precision 6 untuk sharding Durable Object. */
export function cellFor(lat: number, lng: number): string {
  return geohash(lat, lng, 6);
}
