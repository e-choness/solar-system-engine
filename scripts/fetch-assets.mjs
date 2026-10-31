// Downloads open-licensed textures, recordings and the bright-star catalog,
// optimises them, and records attribution in src/data/generated/credits.json.
//
// Run in Docker: docker compose run --rm node npm run assets [textures|audio|stars] [texture ids…]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const CACHE = path.resolve('.asset-cache/raw');
const TEX = path.resolve('public/textures');
const AUDIO = path.resolve('public/audio/recordings');
const DATA = path.resolve('public/data');
const CREDITS = path.resolve('src/data/generated/credits.json');
const UA = { 'User-Agent': 'solar-system-engine asset pipeline (https://github.com/e-choness/solar-system-engine)' };

const SSS = 'https://www.solarsystemscope.com/textures/download/';
const SSS_CREDIT = { author: 'Solar System Scope (INOVE)', license: 'CC BY 4.0', url: 'https://www.solarsystemscope.com/textures/' };
/** USGS Astrogeology global mosaics (public domain). */
const USGS = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/';

/**
 * id → source: Solar System Scope (`sss`), Wikimedia Commons titles tried in
 * order (`commons`), or a direct download (`url` + `credit`). `size` is the
 * long edge of the high-res variant; every texture also gets a 1024 px `.lo`
 * variant that loads first. `match` scales a map so its mean color equals the
 * body's catalog color (for greyscale or albedo maps).
 */
const TEXTURES = {
  sun: { sss: '8k_sun.jpg', size: 2048 },
  mercury: { sss: '8k_mercury.jpg', size: 4096 },
  'venus-atmosphere': { sss: '4k_venus_atmosphere.jpg', size: 4096 },
  earth: { sss: '8k_earth_daymap.jpg', size: 4096 },
  'earth-night': { sss: '8k_earth_nightmap.jpg', size: 4096 },
  'earth-clouds': { sss: '8k_earth_clouds.jpg', size: 4096, grey: true },
  'earth-normal': { sss: '8k_earth_normal_map.tif', size: 4096, quality: 92 },
  'earth-specular': { sss: '8k_earth_specular_map.tif', size: 2048, grey: true },
  moon: { sss: '8k_moon.jpg', size: 4096 },
  mars: { sss: '8k_mars.jpg', size: 4096 },
  jupiter: { sss: '8k_jupiter.jpg', size: 4096 },
  saturn: { sss: '8k_saturn.jpg', size: 4096 },
  'saturn-ring': { sss: '8k_saturn_ring_alpha.png', size: 4096, alpha: true, strip: true },
  uranus: { sss: '2k_uranus.jpg', size: 2048 },
  neptune: { sss: '2k_neptune.jpg', size: 2048 },
  eris: { sss: '4k_eris_fictional.jpg', size: 2048, impression: true },
  haumea: { sss: '4k_haumea_fictional.jpg', size: 2048, impression: true },
  makemake: { sss: '4k_makemake_fictional.jpg', size: 2048, impression: true },
  stars: { sss: '8k_stars_milky_way.jpg', size: 8192, quality: 82 },

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

async function writeTexture(id, raw, spec) {
  const encode = (img) => img.webp({ quality: spec.quality ?? 86, alphaQuality: 90, effort: 5 });
  const base = spec.match ? await matchColor(raw, spec.match) : sharp(raw, { limitInputPixels: false });
  const prep = (img) => (spec.grey ? img.greyscale() : img);
  if (spec.strip) {
    // Ring strips keep their aspect ratio and alpha channel.
    await encode(prep(base.clone()).resize({ width: spec.size })).toFile(path.join(TEX, `${id}.webp`));
    await encode(prep(base.clone()).resize({ width: 1024 })).toFile(path.join(TEX, `${id}.lo.webp`));
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

for (const dir of [CACHE, TEX, AUDIO, DATA, path.dirname(CREDITS)]) fs.mkdirSync(dir, { recursive: true });
const credits = { textures: {}, audio: {}, data: {} };
const only = process.argv[2];
if (!only || only === 'textures') await textures(credits, process.argv.slice(3));
if (!only || only === 'audio') await recordings(credits);
if (!only || only === 'stars') await stars(credits);

const previous = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : {};
const merged = {
  textures: { ...previous.textures, ...credits.textures },
  audio: { ...previous.audio, ...credits.audio },
  data: { ...previous.data, ...credits.data },
};
fs.writeFileSync(CREDITS, `${JSON.stringify(merged, null, 2)}\n`);
