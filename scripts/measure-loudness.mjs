// Measures the integrated loudness (EBU R128) and true peak of every clip in
// public/audio and writes src/data/generated/loudness.json. The audio engine
// uses it to play all clips at one loudness, whatever level they were
// mastered at.
//
// Run in Docker: docker compose run --rm node npm run loudness
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('public/audio');
const OUT = path.resolve('src/data/generated/loudness.json');

const files = fs
  .readdirSync(ROOT, { recursive: true })
  .map((f) => String(f).replaceAll('\\', '/'))
  .filter((f) => /\.(m4a|mp3|ogg|opus|wav)$/.test(f))
  .sort();

const clips = {};
for (const file of files) {
  const full = path.join(ROOT, file);
  const channels = Number(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', full])
      .toString()
      .trim(),
  );
  // ebur128 prints its summary to stderr.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', full, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const lufs = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(summary.match(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  if (!Number.isFinite(lufs) || !Number.isFinite(peak)) throw new Error(`could not measure ${file}`);
  clips[file] = { lufs, peak, channels };
  console.log(
    `${file.padEnd(32)} ${lufs.toFixed(1).padStart(6)} LUFS  ${peak.toFixed(1).padStart(5)} dBTP  ${channels === 1 ? 'mono' : 'stereo'}`,
  );
}

fs.writeFileSync(
  OUT,
  `${JSON.stringify({ source: 'ffmpeg ebur128: integrated loudness (LUFS) and true peak (dBTP) per clip', clips }, null, 2)}\n`,
);
console.log(`\nwrote ${files.length} clips → ${path.relative(process.cwd(), OUT)}`);
