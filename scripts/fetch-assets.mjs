// Downloads open-licensed textures, recordings, shape models and the bright-star catalog,
// optimises them, and records attribution in src/data/generated/credits.json.
//
// Run in Docker: docker compose run --rm node npm run assets [textures|audio|stars|shapes|mid|ktx2] [ids…]
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const CACHE = path.resolve('.asset-cache/raw');
const TEX = path.resolve('public/textures');
const AUDIO = path.resolve('public/audio/recordings');
const DATA = path.resolve('public/data');
const CREDITS = path.resolve('src/data/generated/credits.json');
const MID_LIST = path.resolve('src/data/generated/mid-textures.json');
/** Long edge of the tier phones stream instead of the full-resolution map. */
const MID_SIZE = 2048;
const execFileAsync = promisify(execFile);
const UA = { 'User-Agent': 'solar-system-engine asset pipeline (https://github.com/e-choness/solar-system-engine)' };

const SSS = 'https://www.solarsystemscope.com/textures/download/';
const SSS_CREDIT = { author: 'Solar System Scope (INOVE)', license: 'CC BY 4.0', url: 'https://www.solarsystemscope.com/textures/' };
/** USGS Astrogeology global mosaics (public domain). */
const USGS = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/';
/** SDO/AIA synoptic (Carrington) maps assembled by the STEREO Science Center (US government work). */
const AIA_MAPS = 'https://stereo-ssc.nascom.nasa.gov/data/ins_data/secchi/carrmaps/aia/cm/fits/';
/** Where the Sun's eruptions start: the brightest active regions of that map. */
const SUN_ACTIVE = path.resolve('src/data/generated/sun-active.json');
const SHAPES_DIR = path.resolve('public/shapes');
const SHAPE_LIST = path.resolve('src/data/generated/shapes.json');
const KTX2_LIST = path.resolve('src/data/generated/ktx2-textures.json');
const KTX2_TMP = path.resolve('.asset-cache/ktx2');

/**
 * id → source: Solar System Scope (`sss`), Wikimedia Commons titles tried in
 * order (`commons`), or a direct download (`url` + `credit`). `size` is the
 * long edge of the high-res variant; every texture also gets a 1024 px `.lo`
 * variant that loads first, and maps wider than MID_SIZE a `.mid` variant for
 * phones. `match` scales a map so its mean color equals the
 * body's catalog color (for greyscale or albedo maps). `linear` marks data maps
 * that are not sRGB color (as LINEAR in src/engine/textures.ts does), and `ktx`
 * forces one codec for every KTX2 tier (see writeKtx2).
 *
 * `truth` recolors a map to the planet's measured color (see trueColor), as
 * linear sRGB: the geometric albedos of Mallama, Krobusek & Pavlov 2017 (Icarus
 * 282, Table 7) through the CIE 1931 observer under 5778 K sunlight. `luma` also
 * sets the mean luminance, for a map far darker than the world it shows.
 */
const TEXTURES = {
  // Real data: SDO/AIA 304 Å over one solar rotation near the 2024 maximum, at its full resolution (see aiaMap).
  sun: {
    url: `${AIA_MAPS}cmAIA304cr2290C0.fts.gz`,
    aia: true,
    credit: {
      title: 'SDO/AIA 304 Å Carrington map, rotation 2290 (16 Oct – 13 Nov 2024)',
      author: 'NASA/SDO and the AIA science team; map by the NASA STEREO Science Center',
      license: 'Public domain',
    },
    // The map's native 0.125° grid; finer detail comes from the shader.
    size: 2880,
  },
  // The source map is neutral grey, so a plain tint is enough.
  mercury: { sss: '8k_mercury.jpg', size: 4096, match: '#8a8173' },
  'venus-atmosphere': { sss: '4k_venus_atmosphere.jpg', size: 4096, truth: [0.7, 0.6903, 0.6465] },
  earth: { sss: '8k_earth_daymap.jpg', size: 4096 },
  'earth-night': { sss: '8k_earth_nightmap.jpg', size: 4096 },
  'earth-clouds': { sss: '8k_earth_clouds.jpg', size: 4096, grey: true, linear: true },
  'earth-normal': { sss: '8k_earth_normal_map.tif', size: 4096, quality: 92, linear: true, ktx: 'uastc' },
  'earth-specular': { sss: '8k_earth_specular_map.tif', size: 2048, grey: true, linear: true },
  moon: { sss: '8k_moon.jpg', size: 4096 },
  mars: { sss: '8k_mars.jpg', size: 4096, truth: [0.2574, 0.1686, 0.0892] },
  jupiter: { sss: '8k_jupiter.jpg', size: 4096 },
  saturn: { sss: '8k_saturn.jpg', size: 4096 },
  'saturn-ring': { sss: '8k_saturn_ring_alpha.png', size: 4096, alpha: true, strip: true },
  uranus: { sss: '2k_uranus.jpg', size: 2048 },
  // The source follows the enhanced Voyager 2 images; Irwin et al. 2024 show Neptune is nearly as pale as Uranus.
  neptune: { sss: '2k_neptune.jpg', size: 2048, truth: [0.2648, 0.4451, 0.5628], luma: 0.52 },
  eris: { sss: '4k_eris_fictional.jpg', size: 2048, impression: true },
  haumea: { sss: '4k_haumea_fictional.jpg', size: 2048, impression: true },
  makemake: { sss: '4k_makemake_fictional.jpg', size: 2048, impression: true },
  // Nothing streams the sky past its `.lo` tier, so it needs no `.mid`. That tier is magnified
  // across the whole sky, where ETC1S blocks would show around every star.
  stars: { sss: '8k_stars_milky_way.jpg', size: 8192, quality: 82, mid: false, ktx: 'uastc' },

  ceres: {
    // Dawn Framing Camera, 140 m/px; centred on 180° E.
    url: `${USGS}Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif`,
    credit: {
      title: 'Ceres Dawn FC global mosaic (DLR, 20 px/°)',
      author: 'NASA/JPL-Caltech/UCLA/MPS/DLR/IDA, USGS Astrogeology',
      license: 'Public domain',
    },
    match: '#8a8580',
    size: 4096,
  },
  vesta: { commons: ['Vesta map by Askaniy.png', 'Vesta map for GeoHack.png'], size: 2048 },
  phobos: { commons: ['Phobos map by Askaniy.png', 'Phobos Viking Mosaic DLRcontrol 7200.jpg'], size: 2048 },
  deimos: { commons: ['Deimos map by Askaniy.png', 'Deimos color map.jpg'], size: 2048 },
  io: {
    // Galileo SSI color merged with Voyager, 1 km/px; centred on 0°.
    url: `${USGS}Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif`,
    credit: {
      title: 'Io Galileo SSI–Voyager global color mosaic (1 km/px)',
      author: 'NASA/JPL, USGS Astrogeology',
      license: 'Public domain',
    },
    size: 4096,
  },
  // Galileo + Voyager color, centred on 180° W.
  europa: { commons: ['Moon Europa color map.jpg'], size: 4096 },
  ganymede: { commons: ['Ganymede map by Askaniy.png', 'Map of Ganymede by Björn Jónsson.jpg'], size: 4096 },
  callisto: { commons: ['Callisto map by Askaniy.png', 'Callisto USGS global small.jpg'], size: 4096 },
  mimas: { commons: ['Map of Mimas colorized 2014-04 PIA18437.jpg'], size: 2048 },
  enceladus: { commons: ['Color map of Enceladus PIA18435 (modified).jpg'], size: 2048 },
  tethys: { commons: ['Tethys Color Map.jpg'], size: 2048 },
  dione: { commons: ['Dione Color Map.jpg'], size: 2048 },
  rhea: { commons: ['Rhea Color Map.jpg'], size: 2048 },
  iapetus: { commons: ['Iapetus Color Map.jpg'], size: 2048 },
  titan: { commons: ['Titan map April 2011 full.png'], size: 2048 },
  miranda: { commons: ['Miranda map.jpg'], size: 2048 },
  ariel: { commons: ['Ariel map JPL USGS.jpg'], size: 1440 },
  umbriel: { commons: ['Umbriel map JPL USGS.jpg'], size: 1440 },
  titania: { commons: ['Titania map JPL USGS.jpg'], size: 1440 },
  oberon: { commons: ['Oberon map JPL USGS.jpg'], size: 1440 },
  triton: { commons: ['Triton Map.jpg'], size: 4096 },
  pluto: { commons: ['Pluto color mapmosaic.jpg'], size: 4096 },
  // New Horizons encounter hemisphere, centred on 0° (the sub-Pluto point).
  charon: { commons: ['Charon map iau1803c.jpg'], size: 4096 },
  bennu: { commons: ['Bennu map by Askaniy (albedo).png'], match: '#3c3a38', size: 2048 },
  ryugu: { commons: ['Ryugu albedo map by Askaniy (enhanced).png', 'Ryugu albedo map by Askaniy.png'], match: '#3a3836', size: 2048 },
};

const RECORDINGS = {
  'europa-juno.mp3': {
    url: 'https://space.physics.uiowa.edu/plasma-wave/juno/audio/202209/jno-E45-LFRH-22-272-0836-1006-1st-try-Matlab-modified.mp3',
    credit: {
      author: 'NASA/JPL-Caltech/SwRI/University of Iowa',
      license: 'CC BY 3.0',
      url: 'https://space.physics.uiowa.edu/plasma-wave/juno/audio/202209/jno-E45-LFRH-Europa-fuh-22-272-0836-1006-blk.html',
    },
  },
  'ganymede-juno.m4a': {
    url: 'https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia25/pia25030/PIA25030.mov',
    extractAudio: true,
    credit: {
      author: 'NASA/JPL-Caltech/SwRI/University of Iowa',
      license: 'NASA media guidelines',
      url: 'https://photojournal.jpl.nasa.gov/catalog/PIA25030',
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) {
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return file;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`${res.status} ${url}`);
    await sleep(5000 * (attempt + 1));
  }
  throw new Error(`gave up on ${url}`);
}

/** Resolve a Commons file title to a server-scaled thumbnail URL + license. */
async function commonsInfo(title, width) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  const q = {
    action: 'query',
    format: 'json',
    titles: `File:${title}`,
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: String(width),
    iiextmetadatafilter: 'LicenseShortName|Artist|Credit',
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(u, { headers: UA });
    const text = await res.text();
    if (text.startsWith('{')) {
      const page = Object.values(JSON.parse(text).query.pages)[0];
      const ii = page.imageinfo?.[0];
      if (!ii) return null;
      const strip = (s) =>
        (s ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const md = ii.extmetadata ?? {};
      return {
        url: ii.width > width ? ii.thumburl : ii.url,
        page: ii.descriptionurl,
        license: strip(md.LicenseShortName?.value) || 'see source',
        author: strip(md.Artist?.value || md.Credit?.value).slice(0, 160) || 'Wikimedia Commons',
      };
    }
    await sleep(8000 * (attempt + 1));
  }
  throw new Error(`Commons API unavailable for ${title}`);
}

/** The map as 8-bit RGB scaled per channel so its mean sRGB color is `hex`. */
async function matchColor(raw, hex) {
  // Widen to RGB first: linear() cannot add bands to a greyscale map.
  const rgb = await sharp(raw, { limitInputPixels: false }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const img = () => sharp(rgb.data, { raw: rgb.info, limitInputPixels: false });
  const { channels } = await img().stats();
  const gains = [1, 3, 5].map((k, c) => Number.parseInt(hex.slice(k, k + 2), 16) / Math.max(1, channels[c].mean));
  const out = await img().linear(gains, [0, 0, 0]).raw().toBuffer({ resolveWithObject: true });
  return sharp(out.data, { raw: out.info, limitInputPixels: false });
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const DECODE = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255));
const LUMA = [0.2126, 0.7152, 0.0722];

/**
 * One pixel recolored: a power curve on its R/G and B/G ratios, and a Reinhard-style curve with
 * knee `k` on its luminance (Infinity leaves it alone). Unlike a power curve, that brightens
 * a dark map while keeping its features' contrast, and white stays white.
 */
function recolor(r, g, b, [pr, pb, k]) {
  const green = Math.max(g, 1e-4);
  const rg = Math.max(r, 1e-4) / green;
  const bg = Math.max(b, 1e-4) / green;
  const y0 = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  const y = k === Number.POSITIVE_INFINITY ? y0 : (y0 * (1 + k)) / (y0 + k);
  const nr = rg ** pr;
  const nb = bg ** pb;
  const ng = y / (LUMA[0] * nr + LUMA[1] + LUMA[2] * nb);
  return [Math.min(1, nr * ng), Math.min(1, ng), Math.min(1, nb * ng)];
}

/**
 * The map recolored so its area-weighted mean is `truth`. Per-channel gains would tint
 * polar caps and clouds; powers of the color ratios leave neutral pixels neutral.
 */
async function trueColor(raw, { truth, luma }) {
  const source = await sharp(raw, { limitInputPixels: false })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = await sharp(source.data, { raw: source.info, limitInputPixels: false })
    .resize(512, 256, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mean = (powers) => {
    const sum = [0, 0, 0];
    let total = 0;
    for (let y = 0; y < info.height; y++) {
      const weight = Math.sin((Math.PI * (y + 0.5)) / info.height);
      for (let x = 0; x < info.width; x++) {
        const k = (y * info.width + x) * info.channels;
        const out = recolor(DECODE[data[k]], DECODE[data[k + 1]], DECODE[data[k + 2]], powers);
        for (let c = 0; c < 3; c++) sum[c] += out[c] * weight;
        total += weight;
      }
    }
    return sum.map((v) => v / total);
  };
  /** Bisects one power until `error` changes sign. */
  const solve = (powers, index, low, high, error) => {
    const at = (p) => error(mean(powers.with(index, p)));
    let [lo, hi] = [low, high];
    const rising = at(hi) > at(lo);
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) > 0 === rising) hi = mid;
      else lo = mid;
    }
    return powers.with(index, (lo + hi) / 2);
  };
  let powers = [1, 1, Number.POSITIVE_INFINITY];
  for (let round = 0; round < 5; round++) {
    powers = solve(powers, 0, 0, 1.5, ([r, g]) => r / g - truth[0] / truth[1]);
    powers = solve(powers, 1, 0, 1.5, ([, g, b]) => b / g - truth[2] / truth[1]);
    if (luma) powers = solve(powers, 2, 0.02, 4, (m) => LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2] - luma);
  }
  console.log(`     recolor R/G ^${powers[0].toFixed(3)}, B/G ^${powers[1].toFixed(3)}, luminance knee ${powers[2].toFixed(3)}`);

  const out = Buffer.alloc(source.data.length);
  const channels = source.info.channels;
  for (let k = 0; k < out.length; k += channels) {
    const c = recolor(DECODE[source.data[k]], DECODE[source.data[k + 1]], DECODE[source.data[k + 2]], powers);
    for (let i = 0; i < 3; i++) out[k + i] = Math.round(toSrgb(c[i]) * 255);
  }
  return sharp(out, { raw: source.info, limitInputPixels: false });
}

/** Reads a gzipped single-image FITS file with 32-bit float pixels; rows run from the bottom (south) up. */
function readFits(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const header = {};
  let end = 0;
  for (let off = 0; off < buf.length; off += 80) {
    const card = buf.toString('latin1', off, off + 80);
    if (card.startsWith('END')) {
      end = off + 80;
      break;
    }
    if (card[8] === '=') header[card.slice(0, 8).trim()] = card.slice(10).split('/')[0].replace(/'/g, '').trim();
  }
  if (Number(header.BITPIX) !== -32) throw new Error(`${file}: expected 32-bit float pixels, got BITPIX ${header.BITPIX}`);
  const w = Number(header.NAXIS1);
  const h = Number(header.NAXIS2);
  const start = Math.ceil(end / 2880) * 2880;
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = buf.readFloatBE(start + i * 4);
  return { w, h, data };
}

/** Linear sRGB ramp for 304 Å intensity: dark filaments deep red, network orange, active regions near white. */
const SOLAR_RAMP = [
  [0, [0.16, 0.02, 0]],
  [0.3, [0.55, 0.12, 0.01]],
  [0.55, [0.92, 0.36, 0.04]],
  [0.75, [1, 0.62, 0.16]],
  [0.9, [1, 0.84, 0.48]],
  [1, [1, 0.98, 0.9]],
];

function solarRamp(t) {
  for (let k = 1; k < SOLAR_RAMP.length; k++) {
    const [t1, c1] = SOLAR_RAMP[k];
    if (t > t1 && k < SOLAR_RAMP.length - 1) continue;
    const [t0, c0] = SOLAR_RAMP[k - 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    return c0.map((v, i) => v + (c1[i] - v) * f);
  }
  return SOLAR_RAMP.at(-1)[1];
}

/** Mean linear color of an sRGB map, weighted by the area each row covers on the sphere. */
async function meanColor(img) {
  const { data, info } = await img.clone().removeAlpha().resize(512, 256, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let total = 0;
  for (let y = 0; y < info.height; y++) {
    const weight = Math.sin((Math.PI * (y + 0.5)) / info.height);
    for (let x = 0; x < info.width; x++) {
      const k = (y * info.width + x) * info.channels;
      for (let c = 0; c < 3; c++) sum[c] += weight * DECODE[data[k + c]];
      total += weight;
    }
  }
  return sum.map((v) => v / total);
}

/** The x in [lo, hi] where a decreasing f crosses zero. */
function bisect(lo, hi, f) {
  for (let i = 0; i < 16; i++) {
    const mid = Math.sqrt(lo * hi);
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/**
 * The Sun's map from an SDO/AIA 304 Å synoptic map: calibration gaps filled, north
 * up, Carrington longitude 0 in the centre column (the IAU prime meridian), and the
 * log intensity coloured with SOLAR_RAMP, then curved to the mean color of the
 * artistic map it replaces, so exposure, bloom and the Sun's familiar hue stay as they were.
 * Also writes the brightest active regions to SUN_ACTIVE, where eruptions start.
 */
async function aiaMap(file) {
  const { w, h, data } = readFits(file);
  const bad = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) if (!(data[i] > 0)) bad[i] = 1;

  // Assembly artefacts run the full height of the map: columns from a missing exposure are
  // darker than their neighbours at every latitude, and the last days of the rotation
  // brighten toward the 360° edge. Out they go, with a margin for their soft edges.
  const median = (values) => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;
  const column = Float32Array.from({ length: w }, (_, x) => {
    const values = [];
    for (let y = h >> 2; y < (3 * h) >> 2; y++) if (!bad[y * w + x]) values.push(data[y * w + x]);
    return median(values);
  });
  const odd = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    const around = [];
    for (let d = 6; d <= 30; d++) around.push(column[(x + d) % w], column[(x - d + w) % w]);
    const typical = median(around);
    const nearEdge = x < 16 || x >= w - 16;
    if (column[x] < 0.8 * typical || (nearEdge && column[x] > 1.15 * typical)) odd[x] = 1;
  }
  const oddColumns = [];
  for (let x = 0; x < w; x++) {
    if (![-3, -2, -1, 0, 1, 2, 3].some((d) => odd[(x + d + w) % w])) continue;
    oddColumns.push(x);
    for (let y = 0; y < h; y++) bad[y * w + x] = 1;
  }

  // Short gaps: interpolate along the row (longitude wraps).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!bad[row + x] || bad[row + ((x - 1 + w) % w)] !== 0) continue;
      let len = 0;
      while (len < w && bad[row + ((x + len) % w)]) len++;
      if (len > w / 16) continue;
      const a = data[row + ((x - 1 + w) % w)];
      const b = data[row + ((x + len) % w)];
      for (let k = 0; k < len; k++) {
        const i = row + ((x + k) % w);
        data[i] = a + ((b - a) * (k + 1)) / (len + 1);
        bad[i] = 2;
      }
    }
  }
  // Poleward of 72° SDO sees the Sun edge-on, or not at all: replace that with the 72° ring,
  // blurred more and more toward the pole until it is the ring's mean. The shader adds detail there.
  const cap = Math.round(h / 10);
  const fillCap = (edge, toward) => {
    const ring = new Float32Array(w);
    for (let k = 0; k < 6; k++) for (let x = 0; x < w; x++) ring[x] += data[(edge - toward * k) * w + x] / 6;
    const mean = ring.reduce((a, b) => a + b) / w;
    const prefix = new Float64Array(3 * w + 1);
    for (let i = 0; i < 3 * w; i++) prefix[i + 1] = prefix[i] + ring[i % w];
    for (let j = 1; j <= cap; j++) {
      const f = j / cap;
      const r = Math.max(1, Math.round((f * w) / 8));
      const row = (edge + toward * j) * w;
      for (let x = 0; x < w; x++) {
        const box = (prefix[x + r + w + 1] - prefix[x - r + w]) / (2 * r + 1);
        data[row + x] = box + (mean - box) * f * f;
        bad[row + x] = 0;
      }
    }
  };
  fillCap(cap, -1); // south: FITS rows start there
  fillCap(h - 1 - cap, 1);
  const unfilled = bad.reduce((n, b) => n + (b === 1 ? 1 : 0), 0);
  if (unfilled) throw new Error(`${file}: ${unfilled} pixels outside the polar caps have no data`);

  const logs = Float32Array.from(data, (v) => Math.log(Math.max(v, 1e-3)));
  // The rotation's first and last days meet at 0°/360° with different exposures: ramp the
  // brightness on both sides over 15° so they meet halfway (row offsets smoothed over 5°).
  const span = Math.round(w / 24);
  const step = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let left = 0;
    let right = 0;
    for (let k = 6; k < 30; k++) {
      left += logs[y * w + w - 1 - k] / 24;
      right += logs[y * w + k] / 24;
    }
    step[y] = left - right;
  }
  for (let y = 0; y < h; y++) {
    let d = 0;
    let n = 0;
    for (let k = Math.max(0, y - 20); k <= Math.min(h - 1, y + 20); k++, n++) d += step[k];
    d /= n;
    for (let k = 0; k < span; k++) {
      const t = (1 - k / span) / 2;
      logs[y * w + k] += d * t;
      logs[y * w + w - 1 - k] -= d * t;
    }
  }
  const sample = Array.from({ length: Math.floor(logs.length / 7) }, (_, k) => logs[k * 7]).sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.005)];
  const hi = sample[Math.floor(sample.length * 0.998)];
  const level = Float32Array.from(logs, (v) => Math.min(1, Math.max(0, (v - lo) / (hi - lo))));

  // A gamma on the level sets the brightness, powers on green and blue the hue (white stays white).
  const color = (t, [gamma, pg, pb]) => {
    const c = solarRamp(t ** gamma);
    return [c[0], c[1] ** pg, c[2] ** pb];
  };
  /** Area-weighted mean over every 4th pixel, in linear light. */
  const mean = (params) => {
    const sum = [0, 0, 0];
    let total = 0;
    for (let y = 0; y < h; y += 4) {
      const weight = Math.sin((Math.PI * (y + 0.5)) / h);
      for (let x = 0; x < w; x += 4) {
        const c = color(level[y * w + x], params);
        for (let i = 0; i < 3; i++) sum[i] += weight * c[i];
        total += weight;
      }
    }
    return sum.map((v) => v / total);
  };
  const luma = (m) => LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2];
  const target = await meanColor(sharp(path.join(CACHE, '8k_sun.jpg')));
  let params = [1, 1, 1];
  for (let round = 0; round < 4; round++) {
    params = params.with(
      0,
      bisect(0.2, 5, (g) => luma(mean(params.with(0, g))) - luma(target)),
    );
    const ratio = (m, i) => m[i] / m[0] - target[i] / target[0];
    params = params.with(
      1,
      bisect(0.2, 5, (p) => ratio(mean(params.with(1, p)), 1)),
    );
    params = params.with(
      2,
      bisect(0.2, 8, (p) => ratio(mean(params.with(2, p)), 2)),
    );
  }
  console.log(
    `     AIA ${w}×${h}, replaced columns ${oddColumns.join(' ')}; gamma ${params[0].toFixed(3)}, green ^${params[1].toFixed(3)}, blue ^${params[2].toFixed(3)} for mean ${target.map((v) => v.toFixed(3)).join(' ')}`,
  );

  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w; // FITS rows start in the south
    for (let x = 0; x < w; x++) {
      const c = color(level[src + x], params);
      const o = (y * w + ((x + (w >> 1)) % w)) * 3;
      for (let i = 0; i < 3; i++) out[o + i] = Math.round(toSrgb(c[i]) * 255);
    }
  }
  writeActiveRegions(w, h, level);
  return sharp(out, { raw: { width: w, height: h, channels: 3 } });
}

/** The brightest active regions, at least 12° apart, as Carrington latitude/longitude in degrees. */
function writeActiveRegions(w, h, level) {
  const bins = new Float32Array(360 * 180);
  const per = w / 360;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) bins[Math.floor(y / per) * 360 + Math.floor(x / per)] += level[y * w + x] / (per * per);
  const smooth = new Float32Array(bins.length);
  for (let b = 0; b < 180; b++)
    for (let l = 0; l < 360; l++) {
      let sum = 0;
      for (let db = -2; db <= 2; db++)
        for (let dl = -2; dl <= 2; dl++) sum += bins[Math.min(179, Math.max(0, b + db)) * 360 + ((l + dl + 360) % 360)];
      smooth[b * 360 + l] = sum / 25;
    }
  const typical = [...smooth].sort((a, b) => a - b)[smooth.length >> 1];
  const candidates = [];
  for (let b = 40; b < 140; b++) for (let l = 0; l < 360; l++) candidates.push({ b, l, v: smooth[b * 360 + l] });
  candidates.sort((a, b) => b.v - a.v);
  const picked = [];
  const deg = Math.PI / 180;
  for (const c of candidates) {
    if (picked.length === 12) break;
    const lat = c.b + 0.5 - 90; // FITS rows start in the south
    const lon = c.l + 0.5;
    const near = picked.some(
      (p) =>
        Math.acos(
          Math.min(
            1,
            Math.sin(lat * deg) * Math.sin(p.lat * deg) + Math.cos(lat * deg) * Math.cos(p.lat * deg) * Math.cos((lon - p.lon) * deg),
          ),
        ) <
        12 * deg,
    );
    if (!near) picked.push({ lat, lon, v: c.v });
  }
  const top = picked[0].v;
  const regions = picked.map((p) => ({
    lat: Number(p.lat.toFixed(1)),
    lon: Number(p.lon.toFixed(1)),
    strength: Number(((p.v - typical) / (top - typical)).toFixed(3)),
  }));
  fs.writeFileSync(SUN_ACTIVE, `${JSON.stringify(regions, null, 2)}\n`);
  console.log(`     ${regions.length} active regions → ${path.relative(process.cwd(), SUN_ACTIVE)}`);
}

const webp = (img, spec) => img.webp({ quality: spec.quality ?? 86, alphaQuality: 90, effort: 5 });

/** Derives the phone tier from the shipped high-res map; nothing to do for maps already this small. */
async function writeMid(id, spec) {
  const hi = path.join(TEX, `${id}.webp`);
  const { width, height } = await sharp(hi).metadata();
  if (spec.mid === false || width <= MID_SIZE) return;
  const size = { width: MID_SIZE, height: Math.round((height * MID_SIZE) / width), fit: 'fill' };
  await webp(sharp(hi).resize(size), spec).toFile(path.join(TEX, `${id}.mid.webp`));
}

/** The texture bank loads `.mid` only for ids in this list. */
function writeMidList() {
  const ids = fs
    .readdirSync(TEX)
    .filter((f) => f.endsWith('.mid.webp'))
    .map((f) => f.slice(0, -'.mid.webp'.length));
  fs.writeFileSync(
    MID_LIST,
    `${JSON.stringify(ids.sort(), null, 2)}
`,
  );
  console.log(`mid  ${ids.length} textures have a ${MID_SIZE} px tier`);
}

/** Long edge of each GPU-compressed tier: `.lo` everyone preloads, `.mid` phones stream up close. */
const KTX2_TIERS = { lo: 1024, mid: MID_SIZE };
/** ETC1S: about a WebP's download, 4–8 bits per texel on the GPU, softer detail. */
const ETC1S = ['--encode', 'basis-lz', '--clevel', '4', '--qlevel', '255'];
/** UASTC: near-lossless (SSIM ≥ 0.998 against the WebP), about 3.5× its download. */
const UASTC = (lambda) => [
  ...['--encode', 'uastc', '--uastc-quality', '2', '--uastc-rdo', '--uastc-rdo-l', String(lambda)],
  ...['--uastc-rdo-d', '32768', '--zstd', '20'],
];
const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/**
 * Writes Basis Universal KTX2 copies of a shipped map, which the GPU samples
 * without unpacking: 4–8× less memory than a decoded WebP and no image decode
 * on the main thread. `.lo` is ETC1S, since it's only seen from afar; `.mid`, the
 * tier phones see up close, is UASTC so craters stay sharp. Desktops keep the
 * full-resolution WebP. Sizes round up to powers of two because WebGL requires
 * compressed mip levels to be multiples of the 4 px block. Rows are stored bottom-up to
 * match three's flipY for images.
 */
async function writeKtx2(id, spec) {
  const hi = path.join(TEX, `${id}.webp`);
  if (!fs.existsSync(hi)) return;
  fs.mkdirSync(KTX2_TMP, { recursive: true });
  const { width, height, hasAlpha } = await sharp(hi).metadata();
  const format = `R8G8B8${hasAlpha ? 'A8' : ''}_${spec.linear ? 'UNORM' : 'SRGB'}`;
  for (const [tier, edge] of Object.entries(KTX2_TIERS)) {
    const scale = Math.min(1, edge / width);
    const w = pow2(width * scale);
    const h = pow2(height * scale);
    const out = path.join(TEX, `${id}.${tier}.ktx2`);
    if (tier === 'mid' && (spec.mid === false || w <= KTX2_TIERS.lo)) {
      fs.rmSync(out, { force: true });
      continue;
    }
    const png = path.join(KTX2_TMP, `${id}.${tier}.png`);
    const img = sharp(hi, { limitInputPixels: false }).resize(w, h, { fit: 'fill' }).toColourspace('srgb');
    await (hasAlpha ? img.ensureAlpha() : img.removeAlpha()).png({ compressionLevel: 1 }).toFile(png);
    const codec = (spec.ktx ?? (tier === 'lo' ? 'etc1s' : 'uastc')) === 'etc1s' ? ETC1S : UASTC(spec.linear ? 0.5 : 1);
    await execFileAsync('ktx', [
      ...['create', '--format', format, '--assign-tf', spec.linear ? 'linear' : 'srgb', '--assign-primaries', 'bt709'],
      ...['--convert-texcoord-origin', 'bottom-left', '--generate-mipmap', '--threads', '8', ...codec, png, out],
    ]);
    fs.rmSync(png);
    const kb = (fs.statSync(out).size / 1024) | 0;
    console.log(
      `ktx2 ${`${id}.${tier}`.padEnd(22)} ${`${w}×${h}`.padEnd(10)} ${String(kb).padStart(6)} KB  ${codec === ETC1S ? 'ETC1S' : 'UASTC'}`,
    );
  }
}

/** The texture bank asks for a KTX2 tier only when this list says it exists. */
function writeKtx2List() {
  const files = fs.readdirSync(TEX);
  const list = (tier) =>
    files
      .filter((f) => f.endsWith(`.${tier}.ktx2`))
      .map((f) => f.slice(0, -`.${tier}.ktx2`.length))
      .sort();
  const out = { lo: list('lo'), mid: list('mid') };
  fs.writeFileSync(KTX2_LIST, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`ktx2 ${out.lo.length} maps have a compressed .lo tier, ${out.mid.length} a compressed .mid tier`);
}

/** Runs `fn` over `items`, at most `n` at a time. */
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

async function writeTexture(id, raw, spec) {
  const encode = (img) => webp(img, spec);
  const base = spec.aia
    ? await aiaMap(raw)
    : spec.truth
      ? await trueColor(raw, spec)
      : spec.match
        ? await matchColor(raw, spec.match)
        : sharp(raw, { limitInputPixels: false });
  const prep = (img) => (spec.grey ? img.greyscale() : img);
  if (spec.strip) {
    // Ring strips keep their aspect ratio and alpha channel.
    await encode(prep(base.clone()).resize({ width: spec.size })).toFile(path.join(TEX, `${id}.webp`));
    await encode(prep(base.clone()).resize({ width: 1024 })).toFile(path.join(TEX, `${id}.lo.webp`));
    await writeMid(id, spec);
    await writeKtx2(id, spec);
    return;
  }
  // Planet maps are forced to an exact 2:1 equirectangular frame.
  const hi = Math.floor(Math.min(spec.size, (await base.metadata()).width ?? spec.size) / 2) * 2;
  await encode(
    prep(base.clone())
      .removeAlpha()
      .resize(hi, hi / 2, { fit: 'fill' }),
  ).toFile(path.join(TEX, `${id}.webp`));
  await encode(prep(base.clone()).removeAlpha().resize(1024, 512, { fit: 'fill' })).toFile(path.join(TEX, `${id}.lo.webp`));
  await writeMid(id, spec);
  await writeKtx2(id, spec);
}

async function textures(credits, ids) {
  for (const [id, spec] of Object.entries(TEXTURES)) {
    if (ids.length && !ids.includes(id)) continue;
    let source = null;
    if (spec.url) {
      const raw = await download(spec.url, path.join(CACHE, path.basename(new URL(spec.url).pathname)));
      source = { raw, credit: { ...spec.credit, url: spec.url } };
    }
    if (spec.commons && !source) {
      for (const title of spec.commons) {
        const info = await commonsInfo(title, spec.size);
        await sleep(1500);
        if (!info) continue;
        // Keyed by title, so switching a body to another map never reuses the old download.
        const raw = await download(info.url, path.join(CACHE, title.replace(/[^\w.-]+/g, '_')));
        source = { raw, credit: { title, author: info.author, license: info.license, url: info.page } };
        break;
      }
    }
    const sss = source ? null : (spec.sss ?? spec.fallback?.sss);
    if (sss) {
      const raw = await download(SSS + sss, path.join(CACHE, sss));
      source = { raw, credit: { title: sss, ...SSS_CREDIT }, impression: spec.impression ?? spec.fallback?.impression };
    }
    if (!source) {
      console.warn(`!! ${id}: no source available`);
      continue;
    }
    await writeTexture(id, source.raw, { ...spec, ...(sss ? {} : {}) });
    credits.textures[id] = { ...source.credit, impression: Boolean(source.impression) };
    const kb = (fs.statSync(path.join(TEX, `${id}.webp`)).size / 1024) | 0;
    console.log(`tex  ${id.padEnd(18)} ${String(kb).padStart(6)} KB  ${source.credit.license}  ← ${source.credit.title}`);
  }
  writeMidList();
  writeKtx2List();
}

async function recordings(credits) {
  for (const [file, spec] of Object.entries(RECORDINGS)) {
    const raw = await download(spec.url, path.join(CACHE, path.basename(new URL(spec.url).pathname)));
    const out = path.join(AUDIO, file);
    if (spec.extractAudio) {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vn', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', out]);
    } else {
      fs.copyFileSync(raw, out);
    }
    credits.audio[file] = spec.credit;
    console.log(`aud  ${file.padEnd(18)} ${String((fs.statSync(out).size / 1024) | 0).padStart(6)} KB  ${spec.credit.license}`);
  }
}

/**
 * Yale Bright Star Catalogue (V/50) via VizieR: every star down to magnitude
 * 6.5 as unit vectors in the J2000 equatorial frame plus magnitude and B−V.
 */
async function stars(credits) {
  const query =
    '/viz-bin/asu-tsv?-source=V/50/catalog&-out.max=unlimited' + '&-out=_RAJ2000&-out=_DEJ2000&-out=Vmag&-out=B-V&Vmag=%3C6.5&-oc.form=d';
  const mirrors = ['https://vizier.cds.unistra.fr', 'https://vizier.cfa.harvard.edu', 'https://vizier.iucaa.in'];
  let raw = null;
  for (const mirror of mirrors) {
    try {
      raw = await download(mirror + query, path.join(CACHE, 'bsc5.tsv'));
      break;
    } catch (err) {
      console.warn(`   VizieR mirror ${mirror} failed: ${err.cause?.code ?? err.message}`);
    }
  }
  if (!raw) throw new Error('all VizieR mirrors failed');
  const rows = fs
    .readFileSync(raw, 'utf8')
    .split('\n')
    .filter((l) => /^\s*\d/.test(l))
    .map((l) => l.split('\t').map((s) => Number.parseFloat(s)))
    .filter((r) => r.length >= 3 && r.slice(0, 3).every(Number.isFinite));
  const out = new Float32Array(rows.length * 5);
  rows.forEach(([ra, dec, mag, bv], k) => {
    const a = (ra * Math.PI) / 180;
    const d = (dec * Math.PI) / 180;
    out.set([Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d), mag, Number.isFinite(bv) ? bv : 0.6], k * 5);
  });
  fs.writeFileSync(path.join(DATA, 'stars.bin'), Buffer.from(out.buffer));
  credits.data.stars = {
    title: 'Yale Bright Star Catalogue, 5th ed. (V/50)',
    author: 'Hoffleit & Warren, via CDS VizieR',
    license: 'CDS terms (free with acknowledgement)',
    url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50',
  };
  console.log(`dat  stars.bin          ${rows.length} stars`);
}

/** The PDS Small Bodies Node's holdings at the University of Maryland. */
const UMD = 'https://pdssbn.astro.umd.edu/holdings/';

/**
 * Measured shape models for small worlds with no surface imagery to map, replacing their
 * procedural lumps up close. `unit` converts the file's lengths to km; `triangles` is the
 * budget after simplification.
 */
const SHAPES = {
  '67p': {
    url: `${UMD}ro-c-multi-5-67p-shape-v2.0/data/triplate/spg_dlr/shap4s/cg_dlr_spg_shap4s_200k.wrl`,
    triangles: 40000,
    credit: {
      title: 'SPG SHAP4S plate model, 200k plates (RO-C-MULTI-5-67P-SHAPE-V2.0)',
      author: 'F. Preusker & F. Scholten (DLR); ESA/Rosetta/MPS for OSIRIS Team',
      license: 'ESA Rosetta archive data, free use with credit',
      url: `${UMD}ro-c-multi-5-67p-shape-v2.0/`,
    },
  },
  tempel1: {
    url: `${UMD}dif-c-hriv_its_mri-5-tempel1-shape-v2.0/data/tempel1_2012_cart.wrl`,
    triangles: 24000,
    credit: {
      title: 'Plate shape model of comet 9P/Tempel 1, v2.0',
      author: 'T. L. Farnham & P. C. Thomas; NASA Deep Impact',
      license: 'Public domain',
      url: `${UMD}dif-c-hriv_its_mri-5-tempel1-shape-v2.0/`,
    },
  },
  hartley2: {
    url: `${UMD}dif-c-hriv_mri-5-hartley2-shape-v1.0/data/hartley2_2012_cart.wrl`,
    triangles: 24000,
    credit: {
      title: 'Plate shape model of comet 103P/Hartley 2, v1.0',
      author: 'T. L. Farnham & P. C. Thomas; NASA EPOXI',
      license: 'Public domain',
      url: `${UMD}dif-c-hriv_mri-5-hartley2-shape-v1.0/`,
    },
  },
  wild2: {
    url: `${UMD}sdu-c-navcam-5-wild2-shape-model-v2.1/data/wild2_cart_full.tab`,
    unit: 0.001,
    triangles: 24000,
    credit: {
      title: 'Stardust NAVCAM shape model of comet 81P/Wild 2, v2.1',
      author: 'T. Farnham, T. Duxbury & J.-Y. Li; NASA Stardust',
      license: 'Public domain',
      url: `${UMD}sdu-c-navcam-5-wild2-shape-model-v2.1/`,
    },
  },
  arrokoth: {
    url: `${UMD}pds4-nh_derived:arrokoth_shapemodel_porter2024-v1.0/arrokoth_porter_2024_v01.obj`,
    triangles: 30000,
    credit: {
      title: 'New Horizons shape model of (486958) Arrokoth (Porter et al. 2024)',
      author: 'S. B. Porter et al.; NASA/JHUAPL/SwRI New Horizons',
      license: 'Public domain',
      url: `${UMD}pds4-nh_derived:arrokoth_shapemodel_porter2024-v1.0/`,
    },
  },
  didymos: {
    url: `${UMD}pds4-dart_shapemodel:data_derived_didymos_model_v003-v1.0/didymos_g_9309mm_spc_obj_0000n00000_v003.obj`,
    triangles: 24000,
    credit: {
      title: 'DART shape model of (65803) Didymos, v003 at 9.3 m (Daly et al. 2023)',
      author: 'R. T. Daly et al.; NASA/Johns Hopkins APL DART',
      license: 'Public domain',
      url: `${UMD}pds4-dart_shapemodel:data_derived_didymos_model_v003-v1.0/`,
    },
  },
};

/** Vertices (km) and triangles of a Wavefront OBJ, VRML 2 or PDS vertex/plate table. */
function parseShape(text, unit = 1) {
  const pos = [];
  const idx = [];
  const polygon = (face) => {
    for (let k = 1; k + 1 < face.length; k++) idx.push(face[0], face[k], face[k + 1]);
  };
  if (text.startsWith('#VRML')) {
    const block = (key) => {
      const at = text.search(new RegExp(`\\b${key}\\s*\\[`));
      // Comments can sit inside the blocks ("# 2" after each vertex).
      return text.slice(text.indexOf('[', at) + 1, text.indexOf(']', at)).replace(/#.*/g, '');
    };
    for (const s of block('point').match(/-?[\d.]+(?:e[-+]?\d+)?/gi)) pos.push(Number(s) * unit);
    let face = [];
    for (const s of block('coordIndex').match(/-?\d+/g)) {
      const n = Number(s);
      if (n >= 0) face.push(n);
      else {
        polygon(face);
        face = [];
      }
    }
  } else if (/^v\s/m.test(text)) {
    for (const line of text.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (t[0] === 'v') pos.push(Number(t[1]) * unit, Number(t[2]) * unit, Number(t[3]) * unit);
      else if (t[0] === 'f')
        polygon(
          t.slice(1).map((s) => {
            const n = Number.parseInt(s, 10);
            return n < 0 ? pos.length / 3 + n : n - 1;
          }),
        );
    }
  } else {
    // Counts, then "x y z flag" vertices, then 0-based "a b c flag" plates.
    const lines = text.trim().split('\n');
    const [nv, nf] = lines[0].trim().split(/\s+/).map(Number);
    for (let i = 1; i <= nv; i++) {
      const t = lines[i].trim().split(/\s+/);
      pos.push(Number(t[0]) * unit, Number(t[1]) * unit, Number(t[2]) * unit);
    }
    for (let i = nv + 1; i <= nv + nf; i++) idx.push(...lines[i].trim().split(/\s+/).slice(0, 3).map(Number));
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/**
 * Simplifies a model to its triangle budget and writes it as a small binary the engine
 * streams in: a header (magic, vertex count, index count, radius in km), int16 positions in
 * the engine's mesh axes (x, pole, −y) as fractions of the radius, then the indices.
 */
async function writeShape(id, spec) {
  const raw = await download(spec.url, path.join(CACHE, `shape-${id}${path.extname(spec.url)}`));
  const { positions, indices } = parseShape(fs.readFileSync(raw, 'utf8'), spec.unit);
  const vertices = positions.length / 3;
  if (!vertices || indices.some((i) => i >= vertices)) throw new Error(`${id}: malformed shape model`);
  await MeshoptSimplifier.ready;
  // Weld vertices that files repeat per face, so the simplifier sees one closed surface.
  const weld = MeshoptSimplifier.generatePositionRemap(positions, 3);
  const welded = [];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [weld[indices[t]], weld[indices[t + 1]], weld[indices[t + 2]]];
    if (a !== b && b !== c && a !== c) welded.push(a, b, c);
  }
  const source = Uint32Array.from(welded);
  const target = Math.min(source.length, spec.triangles * 3);
  const [simple, error] = MeshoptSimplifier.simplify(source, positions, 3, target, 0.05);

  // Keep only the vertices still in use, in first-use order.
  const order = new Map();
  const out = new Uint32Array(simple.length);
  simple.forEach((v, i) => {
    if (!order.has(v)) order.set(v, order.size);
    out[i] = order.get(v);
  });
  const kept = [...order.keys()];
  let radius = 0;
  for (const v of kept) radius = Math.max(radius, Math.hypot(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]));
  // Faces must wind outwards: a positive enclosed volume.
  let volume = 0;
  for (let t = 0; t < out.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => kept[out[t + k]] * 3);
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [a, a + 1, a + 2, b, b + 1, b + 2, c, c + 1, c + 2].map((i) => positions[i]);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  if (volume < 0) for (let t = 0; t < out.length; t += 3) [out[t + 1], out[t + 2]] = [out[t + 2], out[t + 1]];

  const q = new Int16Array(kept.length * 3 + (kept.length % 2 ? 1 : 0));
  kept.forEach((v, i) => {
    const [x, y, z] = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]].map((c) => Math.round((c / radius) * 32767));
    q.set([x, z, -y], i * 3);
  });
  const header = new Uint32Array([0x31504853, kept.length, out.length, 0]);
  new Float32Array(header.buffer)[3] = radius;
  const index = kept.length > 0xffff ? out : Uint16Array.from(out);
  const file = path.join(SHAPES_DIR, `${id}.bin`);
  fs.writeFileSync(file, Buffer.concat([header, q, index].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength))));
  const bytes = fs.statSync(file).size;
  console.log(
    `shp  ${id.padEnd(9)} ${indices.length / 3} → ${out.length / 3} triangles, error ${(error * 100).toFixed(2)}%, ` +
      `radius ${radius.toFixed(3)} km, volume ${Math.abs(volume).toPrecision(4)} km³, ${(bytes / 1024).toFixed(0)} KB`,
  );
  return { radius: Number(radius.toFixed(4)), triangles: out.length / 3 };
}

async function shapes(credits, ids) {
  fs.mkdirSync(SHAPES_DIR, { recursive: true });
  const list = fs.existsSync(SHAPE_LIST) ? JSON.parse(fs.readFileSync(SHAPE_LIST, 'utf8')) : {};
  for (const [id, spec] of Object.entries(SHAPES)) {
    if (ids.length && !ids.includes(id)) continue;
    try {
      list[id] = await writeShape(id, spec);
      credits.shapes[id] = spec.credit;
    } catch (err) {
      console.warn(`shp  ${id}: ${err.message}`);
    }
  }
  fs.writeFileSync(SHAPE_LIST, `${JSON.stringify(list, null, 2)}\n`);
}

for (const dir of [CACHE, TEX, AUDIO, DATA, path.dirname(CREDITS)]) fs.mkdirSync(dir, { recursive: true });
const credits = { textures: {}, audio: {}, data: {}, shapes: {} };
const only = process.argv[2];
if (!only || only === 'textures') await textures(credits, process.argv.slice(3));
if (!only || only === 'audio') await recordings(credits);
if (!only || only === 'stars') await stars(credits);
if (!only || only === 'shapes') await shapes(credits, only ? process.argv.slice(3) : []);
if (only === 'mid') {
  // Backfills the phone tier from the shipped maps without touching the sources.
  for (const [id, spec] of Object.entries(TEXTURES)) await writeMid(id, spec);
  writeMidList();
}
if (only === 'ktx2') {
  // Backfills the KTX2 tiers from the shipped maps; each `ktx` run is itself multithreaded.
  const ids = process.argv.slice(3);
  const todo = Object.entries(TEXTURES).filter(([id]) => !ids.length || ids.includes(id));
  await pool(todo, 4, ([id, spec]) => writeKtx2(id, spec));
  writeKtx2List();
}

const previous = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : {};
const merged = {
  textures: { ...previous.textures, ...credits.textures },
  audio: { ...previous.audio, ...credits.audio },
  data: { ...previous.data, ...credits.data },
  shapes: { ...previous.shapes, ...credits.shapes },
};
fs.writeFileSync(CREDITS, `${JSON.stringify(merged, null, 2)}\n`);
