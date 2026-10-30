// Regenerates the dynamic parts of README.md (between <!-- auto:name --> and
// <!-- /auto:name --> markers) and writes CREDITS.md, from the body catalog,
// the asset credits, package versions and the media kit captions.
//
// Run in Docker: docker compose run --rm node npm run readme
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG } from '../src/data/catalog.ts';

const read = (f) => fs.readFileSync(path.resolve(f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const credits = JSON.parse(read('src/data/generated/credits.json'));
const captions = fs.existsSync('media/screenshots/captions.json') ? JSON.parse(read('media/screenshots/captions.json')) : {};
const stars = fs.existsSync('public/data/stars.bin') ? fs.statSync('public/data/stars.bin').size / 20 : 0;
const events = (read('src/ui/Events.svelte').match(/\{ when: '/g) ?? []).length;

const REPO = 'e-choness/solar-system-engine';
const ITCH = 'https://echoness.itch.io/solar-system';
const ver = (name) => (pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? '').replace(/^[\^~]/, '');
const esc = (s) => String(s).replaceAll('-', '--').replaceAll('_', '__').replaceAll(' ', '%20');
// HTML rather than Markdown: the badges sit inside a centred <p>, where GitHub does not parse Markdown.
const html = (alt, src, link) =>
  link
    ? `<a href="${link}"><img alt="${alt}" src="${src.replaceAll('&', '&amp;')}"></a>`
    : `<img alt="${alt}" src="${src.replaceAll('&', '&amp;')}">`;
const badge = (label, message, color, logo, link) => {
  const img = `https://img.shields.io/badge/${esc(label)}-${esc(message)}-${color}?style=flat-square${logo ? `&logo=${logo}&logoColor=white` : ''}`;
  return html(label, img, link);
};

const KIND = {
  star: 'Star',
  planet: 'Planets',
  dwarf: 'Dwarf planets',
  moon: 'Moons',
  asteroid: 'Asteroids & Kuiper belt objects',
  comet: 'Comets',
};
const count = (k) => CATALOG.filter((b) => b.kind === k).length;
const photo = CATALOG.filter((b) => b.visual.map && !b.visual.impression).length;
const impressions = CATALOG.filter((b) => b.visual.impression).length;
const sounds = { original: 0, recording: 0, sonification: 0 };
for (const b of CATALOG) sounds[b.audio.kind]++;

// ─────────────────────────────────────────────────────────── sections

const sections = {
  badges: [
    html('Play on itch.io', 'https://img.shields.io/badge/play-itch.io-FA5C5C?style=for-the-badge&logo=itchdotio&logoColor=white', ITCH),
    html(
      'Publish',
      `https://img.shields.io/github/actions/workflow/status/${REPO}/publish.yml?branch=main&style=for-the-badge&label=publish&logo=githubactions&logoColor=white`,
      `https://github.com/${REPO}/actions/workflows/publish.yml`,
    ),
    '<br>',
    [
      badge('version', pkg.version, '8ec5ff'),
      badge('worlds', CATALOG.length, 'ffb35c'),
      badge('license', 'PolyForm NC 1.0.0', 'lightgrey', null, 'LICENSE.md'),
      badge('three.js', ver('three'), '000000', 'threedotjs', 'https://threejs.org'),
      badge('renderer', 'WebGPU · WebGL 2', '005a9c', 'webgpu'),
      badge('Svelte', ver('svelte'), 'ff3e00', 'svelte', 'https://svelte.dev'),
      badge('Vite', ver('vite'), '646cff', 'vite', 'https://vite.dev'),
      badge('TypeScript', ver('typescript'), '3178c6', 'typescript', 'https://www.typescriptlang.org'),
      badge('built in', 'Docker', '2496ed', 'docker', '#development'),
    ].join(' '),
  ].join('\n'),

  stats: [
    '| | |',
    '| --- | --- |',
    `| 🪐 **Worlds** | ${CATALOG.length}: the Sun, ${count('planet')} planets, ${count('moon')} moons, ${count('dwarf')} dwarf planets, ${count('asteroid')} asteroids & Kuiper belt objects, ${count('comet')} comets |`,
    `| 🛰️ **Surface maps** | ${photo} from spacecraft imagery, ${impressions} artist’s impressions, procedural GPU surfaces for the rest |`,
    `| 🎧 **Sound** | original soundtrack, ${sounds.original} original world sounds, ${sounds.recording} spacecraft recordings, ${sounds.sonification} live sonifications |`,
    `| ✨ **Sky** | ${stars.toLocaleString('en-US')} real stars from the Yale Bright Star Catalogue, the Milky Way, asteroid belt, Trojans, Kuiper belt and Oort cloud |`,
    `| 🕰️ **Time** | any moment from 1800 to 2200, ${events} one-click historic and upcoming events |`,
  ].join('\n'),

  gallery: (() => {
    const files = Object.keys(captions);
    if (!files.length) return '_Run `npm run media` to generate screenshots._';
    const rows = ['<table>'];
    for (let i = 0; i < files.length; i += 2) {
      rows.push('  <tr>');
      for (const f of files.slice(i, i + 2)) {
        rows.push(`    <td width="50%"><img src="media/screenshots/${f}" alt="${captions[f]}"><br><sub>${captions[f]}</sub></td>`);
      }
      rows.push('  </tr>');
    }
    rows.push('</table>');
    return rows.join('\n');
  })(),

  bodies: Object.entries(KIND)
    .map(([kind, title]) => {
      const list = CATALOG.filter((b) => b.kind === kind);
      if (!list.length) return '';
      const rows = list.map((b) => {
        const parent = b.parent && b.kind === 'moon' ? CATALOG.find((p) => p.id === b.parent)?.name : '';
        const map = b.visual.map ? (b.visual.impression ? '🎨 impression' : '📷 spacecraft') : '✨ procedural';
        const sound = { original: '🎵 original', recording: '🎙️ recording', sonification: '🎛️ sonified' }[b.audio.kind];
        const r = b.physical.radius;
        return `| [${b.name}](${b.wiki}) | ${b.class}${parent ? ` · ${parent}` : ''} | ${r >= 100 ? Math.round(r).toLocaleString('en-US') : r} km | ${map} | ${sound} |`;
      });
      return [
        `<details${kind === 'planet' ? ' open' : ''}><summary><b>${title}</b> (${list.length})</summary>`,
        '',
        '| Name | Type | Radius | Surface | Sound |',
        '| --- | --- | ---: | --- | --- |',
        ...rows,
        '',
        '</details>',
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n\n'),

  stack: [
    '| Layer | Technology |',
    '| --- | --- |',
    `| Rendering | [three.js](https://threejs.org) ${ver('three')} \`WebGPURenderer\` with TSL node materials; automatic WebGL 2 fallback |`,
    `| Post-processing | TSL render pipeline: bloom, lens flare, ACES filmic tone mapping |`,
    `| UI | [Svelte](https://svelte.dev) ${ver('svelte')} (runes), Lucide icons, glass design system |`,
    `| Audio | Web Audio API: streamed soundtrack, spacecraft recordings, real-time synthesis for sonifications, convolution reverb |`,
    `| Build | [Vite](https://vite.dev) ${ver('vite')} (Rolldown), [TypeScript](https://www.typescriptlang.org) ${ver('typescript')}, [Biome](https://biomejs.dev) ${ver('@biomejs/biome')}, [Vitest](https://vitest.dev) ${ver('vitest')} |`,
    `| Assets | sharp, ffmpeg and JPL Horizons scripts, all run in Docker |`,
    `| Delivery | GitHub Actions → Docker build → [butler](https://itch.io/docs/butler/) → itch.io |`,
  ].join('\n'),

  credits: [
    `- **Surface maps:** ${Object.keys(credits.textures).length} maps from Solar System Scope (CC BY 4.0), NASA/JPL/USGS (public domain) and Askaniy (CC BY-SA 3.0).`,
    `- **Recordings:** ${Object.keys(credits.audio).length} NASA Juno Waves recordings (NASA/JPL-Caltech/SwRI/University of Iowa).`,
    '- **Data:** JPL Horizons and Standish planetary elements (NASA/JPL), IAU WGCCRE rotation models, Yale Bright Star Catalogue (via CDS VizieR).',
    '- **Original music and sounds:** _Solar System_ (2021) by Echo Yin.',
    '',
    'Every file and its license is listed in **[CREDITS.md](CREDITS.md)**.',
  ].join('\n'),

  updated: `<sub>Generated by \`npm run readme\` · v${pkg.version} · ${new Date().toISOString().slice(0, 10)}</sub>`,
};

// ─────────────────────────────────────────────────────────── README

let readme = read('README.md');
for (const [name, body] of Object.entries(sections)) {
  const re = new RegExp(`(<!-- auto:${name} -->)[\\s\\S]*?(<!-- /auto:${name} -->)`);
  if (!re.test(readme)) {
    console.warn(`README.md has no auto:${name} block`);
    continue;
  }
  readme = readme.replace(re, `$1\n${body}\n$2`);
}
fs.writeFileSync('README.md', readme);

// ─────────────────────────────────────────────────────────── CREDITS.md

const nameOf = (id) =>
  ({
    'venus-atmosphere': 'Venus (clouds)',
    'earth-night': 'Earth (night lights)',
    'earth-clouds': 'Earth (clouds)',
    'earth-normal': 'Earth (relief)',
    'earth-specular': 'Earth (oceans)',
    'saturn-ring': 'Saturn (rings)',
    stars: 'Milky Way',
  })[id] ??
  CATALOG.find((b) => b.id === id)?.name ??
  id;
const clean = (s) => String(s).replace(/\s+/g, ' ').replace(/\|/g, '/').trim();

// Svelte is a dev dependency but its runtime ships in the bundle.
const softwareRows = Object.keys({ ...pkg.dependencies, svelte: pkg.devDependencies.svelte })
  .sort()
  .map((name) => {
    const meta = JSON.parse(read(path.join('node_modules', name, 'package.json')));
    const url = typeof meta.homepage === 'string' ? meta.homepage : `https://www.npmjs.com/package/${name}`;
    return `| [${name}](${url}) | ${meta.version} | ${meta.license ?? '—'} |`;
  });

const creditsMd = [
  '# Credits',
  '',
  'Solar System stands on the work of spacecraft teams, mappers, astronomers and open-source developers. Thank you.',
  '',
  '## Music and sound',
  '',
  '| Sound | Source | License |',
  '| --- | --- | --- |',
  '| Soundtrack, Sun and planet sounds (`public/audio/original/`) | _Solar System_ (2021) by Echo Yin | © Echo Yin, non-commercial use within this project |',
  ...Object.entries(credits.audio).map(([file, c]) => `| \`${file}\` | [${clean(c.author)}](${c.url}) | ${c.license} |`),
  `| Sonifications of ${sounds.sonification} worlds | Synthesised live in the browser from each body’s physical data | PolyForm Noncommercial 1.0.0 |`,
  '',
  '## Surface maps',
  '',
  '| World | Source file | Author | License |',
  '| --- | --- | --- | --- |',
  ...Object.entries(credits.textures).map(
    ([id, c]) =>
      `| ${nameOf(id)}${c.impression ? ' _(artist’s impression)_' : ''} | [${clean(c.title)}](${c.url}) | ${clean(c.author).slice(0, 140)} | ${c.license} |`,
  ),
  '',
  'Maps are resized to 2:1 equirectangular frames and re-encoded as WebP; CC BY-SA 3.0 derivatives stay under CC BY-SA 3.0.',
  '',
  '## Science data',
  '',
  '| Data | Source | License |',
  '| --- | --- | --- |',
  '| Orbits of moons, dwarf planets, asteroids and comets | [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/), NASA/JPL-Caltech | Public domain |',
  '| Planet orbits (1800–2050 elements, extrapolated) | [E. M. Standish, JPL](https://ssd.jpl.nasa.gov/planets/approx_pos.html) | Public domain |',
  '| Rotation and pole models | [IAU WGCCRE](https://astrogeology.usgs.gov/groups/iau-wgccre) reports (2009, 2015) | Published data |',
  ...Object.values(credits.data).map((d) => `| ${d.title} | [${d.author}](${d.url}) | ${d.license} |`),
  '| Physical properties and facts | NASA Planetary Fact Sheets, JPL SSD, Wikipedia | Public domain / CC BY-SA 4.0 |',
  '',
  '## Software',
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...softwareRows,
  '',
  `Development tools: Vite, Svelte, TypeScript, Biome, Vitest, Playwright, sharp (see \`package.json\`).`,
  '',
].join('\n');
fs.writeFileSync('CREDITS.md', creditsMd);

console.log(
  `README.md and CREDITS.md updated (${CATALOG.length} worlds, ${Object.keys(credits.textures).length} maps, ${Object.keys(captions).length} screenshots)`,
);
