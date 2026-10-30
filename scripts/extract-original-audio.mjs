// Recovers the soundtrack and planet sounds from the original 2021 Unity WebGL
// build on itch.io. Kept for provenance; the extracted clips are committed in
// public/audio/original. Run: docker compose run --rm node node scripts/extract-original-audio.mjs
import fs from 'node:fs';
import path from 'node:path';

const BUILD = 'https://html-classic.itch.zone/html/4174966/Build/Solar_System_WebGL.data.gz';
const OUT = path.resolve('.asset-cache/original-audio');

const RENAME = {
  'Background Soundtrack': 'soundtrack',
  burning: 'sun-burning',
  dronedarkandscary: 'drone-dark',
  dronehum: 'drone-hum',
};

// UnityWebData1.0: header size, then (offset, size, nameLength, name) entries.
function unpackWebData(buf) {
  const files = {};
  const headerSize = buf.readUInt32LE(16);
  for (let p = 20; p < headerSize; ) {
    const off = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    const len = buf.readUInt32LE(p + 8);
    const name = buf.toString('utf8', p + 12, p + 12 + len);
    p += 12 + len;
    files[name] = buf.subarray(off, off + size);
  }
  return files;
}

function lz4(src, outSize) {
  const out = Buffer.alloc(outSize);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) for (let x = 255; x === 255; lit += x) x = src[i++];
    src.copy(out, o, i, i + lit);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const back = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) for (let x = 255; x === 255; len += x) x = src[i++];
    len += 4;
    for (let k = 0; k < len; k++, o++) out[o] = out[o - back];
  }
  return out;
}

// UnityFS bundle (big-endian header, LZ4 blocks) -> { nodeName: Buffer }.
function unpackUnityFS(b) {
  let p = 8;
  const version = b.readUInt32BE(p);
  p += 4;
  for (let k = 0; k < 2; k++) p = b.indexOf(0, p) + 1;
  p += 8;
  const cSize = b.readUInt32BE(p);
  const uSize = b.readUInt32BE(p + 4);
  const flags = b.readUInt32BE(p + 8);
  p += 12;
  if (version >= 7) p = Math.ceil(p / 16) * 16;
  let info = b.subarray(p, p + cSize);
  p += cSize;
  if ((flags & 0x3f) >= 2) info = lz4(info, uSize);
  if (flags & 0x200) p = Math.ceil(p / 16) * 16;
  let q = 16;
  const blocks = info.readInt32BE(q);
  q += 4;
  const parts = [];
  for (let k = 0; k < blocks; k++, q += 10) {
    const u = info.readUInt32BE(q);
    const c = info.readUInt32BE(q + 4);
    const f = info.readUInt16BE(q + 8);
    const raw = b.subarray(p, p + c);
    p += c;
    parts.push((f & 0x3f) >= 2 ? lz4(raw, u) : raw);
  }
  const data = Buffer.concat(parts);
  const nodes = {};
  const count = info.readInt32BE(q);
  q += 4;
  for (let k = 0; k < count; k++) {
    const off = Number(info.readBigInt64BE(q));
    const size = Number(info.readBigInt64BE(q + 8));
    q += 20;
    const end = info.indexOf(0, q);
    nodes[info.toString('utf8', q, end)] = data.subarray(off, off + size);
    q = end + 1;
  }
  return nodes;
}

// AudioClip objects reference "sharedassets0.resource" followed by (offset, size).
// The clip name is the nearest length-prefixed string before the reference.
function* audioClips(assets, resource) {
  const tag = 'sharedassets0.resource';
  for (let i = assets.indexOf(tag); i !== -1; i = assets.indexOf(tag, i + 1)) {
    const start = i - 0;
    const len = assets.readInt32LE(start - 4);
    const q = Math.ceil((start + len) / 4) * 4;
    const off = Number(assets.readBigUInt64LE(q));
    const size = Number(assets.readBigUInt64LE(q + 8));
    if (resource.toString('latin1', off + 4, off + 8) !== 'ftyp') continue;
    let name = null;
    for (let k = start - 8; k > start - 260 && !name; k--) {
      const n = assets.readInt32LE(k);
      if (n > 1 && n < 120 && k + 4 + n <= start) {
        const s = assets.toString('latin1', k + 4, k + 4 + n);
        if (/^[A-Za-z][\w .()&'-]+$/.test(s)) name = s;
      }
    }
    yield { name, data: resource.subarray(off, off + size) };
  }
}

const res = await fetch(BUILD);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const web = unpackWebData(Buffer.from(await res.arrayBuffer()));
const bundle = unpackUnityFS(web['data.unity3d']);
fs.mkdirSync(OUT, { recursive: true });
for (const clip of audioClips(bundle['sharedassets0.assets'], web['sharedassets0.resource'])) {
  const base = RENAME[clip.name] ?? clip.name.replace(/^Solar-/, '').toLowerCase();
  fs.writeFileSync(path.join(OUT, `${base}.m4a`), clip.data);
  console.log(`${base}.m4a  ${(clip.data.length / 1024) | 0} KB  (${clip.name})`);
}
