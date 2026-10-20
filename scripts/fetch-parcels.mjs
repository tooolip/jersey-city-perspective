// Downloads NJ tax parcels with MOD-IV attributes (storeys, year built, construction) for the
// project area. Owner fields are deliberately not requested.
// Usage: node scripts/fetch-parcels.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const SERVICE = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/ArcGIS/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query';
const BBOX = '-74.0600,40.7130,-74.0240,40.7350';
const FIELDS = ['PAMS_PIN', 'PCLBLOCK', 'PCLLOT', 'PCLQCODE', 'PROP_CLASS', 'PROP_LOC', 'BLDG_DESC', 'BLDG_CLASS', 'YR_CONSTR', 'LAND_DESC', 'PROP_USE', 'FAC_NAME', 'DWELL'];
const PAGE = 2000;

async function page(offset) {
  const params = new URLSearchParams({
    geometry: BBOX,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: FIELDS.join(','),
    returnGeometry: 'true',
    orderByFields: 'OBJECTID',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: 'geojson',
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${SERVICE}?${params}`);
      const json = await res.json();
      if (json.features) return json;
      console.log(`  offset ${offset}: ${JSON.stringify(json).slice(0, 120)}`);
    } catch (err) {
      console.log(`  offset ${offset}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new Error(`Failed at offset ${offset}`);
}

const features = [];
for (let offset = 0; ; offset += PAGE) {
  const json = await page(offset);
  features.push(...json.features);
  console.log(`fetched ${features.length}`);
  if (json.features.length < PAGE && !json.properties?.exceededTransferLimit) break;
}
await mkdir('data/raw', { recursive: true });
await writeFile('data/raw/parcels.geojson', JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`Saved data/raw/parcels.geojson (${features.length} parcels)`);
