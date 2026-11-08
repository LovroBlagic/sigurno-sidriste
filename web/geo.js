/* Šest geo-funkcija koje motor koristi, s istim značenjem kao u @turf/turf 7.
 * Umjesto cijelog Turfa (135 modula s CDN-a pri svakom učitavanju) - par desetaka redaka.
 * Udaljenosti u km na kugli polumjera 6371.0088 km, kutevi u stupnjevima, [lon, lat].
 */
const R = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const point = (coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates } });

export function distance([x1, y1], [x2, y2]) {
  const a = Math.sin(rad(y2 - y1) / 2) ** 2 + Math.cos(rad(y1)) * Math.cos(rad(y2)) * Math.sin(rad(x2 - x1) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearing([x1, y1], [x2, y2]) {
  const l1 = rad(x1), l2 = rad(x2), p1 = rad(y1), p2 = rad(y2);
  return deg(Math.atan2(Math.sin(l2 - l1) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1)));
}

export function destination([x, y], km, bearingDeg) {
  const p1 = rad(y), l1 = rad(x), b = rad(bearingDeg), d = km / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return point([deg(l2), deg(p2)]);
}

// Svi parovi koordinata geometrije (Point, Polygon, MultiPolygon, ...)
function* coords(c) {
  if (typeof c[0] === "number") yield c;
  else for (const x of c) yield* coords(x);
}

export function bbox(f) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  if (!f.geometry) return b; // prazna geometrija: kao Turf, [Inf, Inf, -Inf, -Inf]
  for (const [x, y] of coords(f.geometry.coordinates)) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}

// Točka na rubu računa se kao unutra (kao Turf bez ignoreBoundary)
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (cross === 0 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return "edge";
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(p, rings) {
  const outer = inRing(p, rings[0]);
  if (!outer) return false;
  if (outer === "edge") return true;
  for (const hole of rings.slice(1)) {
    const h = inRing(p, hole);
    if (h === "edge") return true;
    if (h) return false;
  }
  return true;
}

export function booleanPointInPolygon(pt, f) {
  const p = pt.geometry ? pt.geometry.coordinates : pt;
  const g = f.geometry || f;
  if (!g) return false;
  if (g.type === "Polygon") return inPolygon(p, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((rings) => inPolygon(p, rings));
  return false;
}
