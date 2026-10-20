// Downloads OpenStreetMap features for the project area via the Overpass API.
// Usage: node scripts/fetch-osm.mjs [osm_features] [osm_relations]
import { writeFile, mkdir } from 'node:fs/promises';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Detail area (Jersey City downtown, with a small margin) and a wider area for water.
const AREA = '40.712,-74.062,40.737,-74.020';
const WIDE = '40.690,-74.075,40.750,-73.985';

const QUERIES = {
  // Ways and nodes: tags plus inline geometry.
  osm_features: `[out:json][timeout:180];
(
  way["highway"](${AREA});
  way["railway"](${AREA});
  way["natural"~"water|coastline|wood|scrub|grassland|sand|beach"](${WIDE});
  way["water"](${WIDE});
  way["leisure"~"park|garden|playground|pitch|dog_park|track|marina"](${AREA});
  way["landuse"](${AREA});
  way["amenity"="parking"](${AREA});
  way["man_made"~"pier|breakwater|bridge"](${AREA});
  way["barrier"~"fence|wall|retaining_wall"](${AREA});
  node["natural"="tree"](${AREA});
  node["highway"~"street_lamp|traffic_signals"](${AREA});
);
out tags geom;`,
  // Multipolygon relations (Hudson River, parks) need full member geometry.
  osm_relations: `[out:json][timeout:180];
(
  relation["natural"="water"](${WIDE});
  relation["water"](${WIDE});
  relation["leisure"="park"](${AREA});
);
out geom;`,
};

async function fetchWithRetry(query) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      console.log(`Attempt ${attempt + 1}: ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'jersey-city-perspective/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) return text;
      console.log(`  -> HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.log(`  -> ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** Math.min(attempt, 4)));
  }
  throw new Error('All Overpass attempts failed');
}

await mkdir('data/raw', { recursive: true });
const only = process.argv.slice(2);
for (const [name, query] of Object.entries(QUERIES)) {
  if (only.length && !only.includes(name)) continue;
  const json = await fetchWithRetry(query);
  await writeFile(`data/raw/${name}.json`, json);
  console.log(`Saved data/raw/${name}.json (${(json.length / 1e6).toFixed(1)} MB)`);
}
