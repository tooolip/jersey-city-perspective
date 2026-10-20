// Downloads Mapillary map features (traffic signs and detected street objects: lights, poles,
// hydrants, signals, markings...) for the project area. Needs MAPILLARY_TOKEN in the environment
// or in .env.local (a client token from mapillary.com/dashboard/developers).
// Usage: node scripts/fetch-mapillary.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BBOX = [-74.0590, 40.7140, -74.0240, 40.7345];
const TILE = 0.004; // degrees; tiles that hit the result cap are split further
const CAP = 2000;
const FIELDS = 'id,object_value,object_type,geometry,aligned_direction,first_seen_at,last_seen_at';

async function token() {
  if (process.env.MAPILLARY_TOKEN) return process.env.MAPILLARY_TOKEN;
  try {
    const env = await readFile('.env.local', 'utf8');
    const m = /^MAPILLARY_TOKEN=(.+)$/m.exec(env);
    if (m) return m[1].trim();
  } catch {
    /* fall through */
  }
  throw new Error('Set MAPILLARY_TOKEN (or add it to .env.local)');
}

const TOKEN = await token();

async function fetchBox(b) {
  const params = new URLSearchParams({ access_token: TOKEN, fields: FIELDS, bbox: b.join(','), limit: String(CAP) });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`https://graph.mapillary.com/map_features?${params}`);
      const json = await res.json();
      if (json.data) return json.data;
      console.log(`  ${b.map((v) => v.toFixed(3))}: ${JSON.stringify(json).slice(0, 100)}`);
    } catch (err) {
      console.log(`  ${b.map((v) => v.toFixed(3))}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  throw new Error(`Failed for ${b}`);
}

async function fetchTile(b, depth = 0) {
  const data = await fetchBox(b);
  if (data.length < CAP || depth > 4) return data;
  const [x0, y0, x1, y1] = b, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const parts = await Promise.all([[x0, y0, mx, my], [mx, y0, x1, my], [x0, my, mx, y1], [mx, my, x1, y1]].map((q) => fetchTile(q, depth + 1)));
  return parts.flat();
}

const byId = new Map();
const tiles = [];
for (let x = BBOX[0]; x < BBOX[2]; x += TILE) for (let y = BBOX[1]; y < BBOX[3]; y += TILE) tiles.push([x, y, Math.min(x + TILE, BBOX[2]), Math.min(y + TILE, BBOX[3])]);
for (let i = 0; i < tiles.length; i += 6) {
  const batch = await Promise.all(tiles.slice(i, i + 6).map((t) => fetchTile(t)));
  for (const f of batch.flat()) byId.set(f.id, f);
  console.log(`tiles ${Math.min(i + 6, tiles.length)}/${tiles.length}, features ${byId.size}`);
}
await mkdir('data/raw', { recursive: true });
await writeFile('data/raw/mapillary_features.json', JSON.stringify([...byId.values()]));
console.log(`Saved data/raw/mapillary_features.json (${byId.size} features)`);
