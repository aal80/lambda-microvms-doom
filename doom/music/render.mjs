// Build-time step: renders every MIDI music lump in the IWAD to MP3 (fluidsynth + General MIDI soundfont,
// then lame), so the browser can just play audio files. Rendering is done in float so nothing clips;
// tracks whose peak would exceed -1 dBFS are scaled down (quieter tracks are left as rendered).
//
// Usage: node render.mjs <iwad> <soundfont.sf2> <outdir>
// Writes <outdir>/<sha1>.mp3 per distinct track and <outdir>/index.json mapping lump name -> file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readMusic } from "../server/wad.js";

const run = promisify(execFile);
const [iwad, soundfont, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: node render.mjs <iwad> <soundfont.sf2> <outdir>");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "music-"));

// Several lumps can hold the same song (e.g. D_INTRO / D_INTROA); render each distinct one once.
const index = {};
const tracks = new Map(); // sha1 -> MIDI data
for (const { name, data } of readMusic(iwad)) {
  if (data.toString("latin1", 0, 4) !== "MThd") {
    console.warn(`skipping ${name}: MUS format not supported (only MIDI)`);
    continue;
  }
  const id = crypto.createHash("sha1").update(data).digest("hex").slice(0, 16);
  index[name] = `${id}.mp3`;
  tracks.set(id, data);
}

const GAIN = 0.5; // FluidSynth's default (0.2) is quiet for these MIDIs
const MAX_PEAK = 0.891; // -1 dBFS

// Float32 stereo WAV (as written by fluidsynth -O float) -> 16-bit PCM WAV, scaled so the peak <= MAX_PEAK.
function floatWavTo16(src, dst) {
  const wav = fs.readFileSync(src);
  let off = 12;
  let fmt = null;
  while (off + 8 <= wav.length) {
    const id = wav.toString("latin1", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: wav.readUInt16LE(off + 8), channels: wav.readUInt16LE(off + 10), rate: wav.readUInt32LE(off + 12), bits: wav.readUInt16LE(off + 22) };
    if (id === "data") {
      if (fmt?.format !== 3 || fmt.bits !== 32) throw new Error(`${src}: expected 32-bit float WAV`);
      const samples = new Float32Array(wav.buffer.slice(wav.byteOffset + off + 8, wav.byteOffset + off + 8 + size));
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      const scale = peak > MAX_PEAK ? MAX_PEAK / peak : 1;
      const out = Buffer.alloc(44 + samples.length * 2);
      out.write("RIFF", 0, "latin1");
      out.writeUInt32LE(36 + samples.length * 2, 4);
      out.write("WAVEfmt ", 8, "latin1");
      out.writeUInt32LE(16, 16);
      out.writeUInt16LE(1, 20); // PCM
      out.writeUInt16LE(fmt.channels, 22);
      out.writeUInt32LE(fmt.rate, 24);
      out.writeUInt32LE(fmt.rate * fmt.channels * 2, 28);
      out.writeUInt16LE(fmt.channels * 2, 32);
      out.writeUInt16LE(16, 34);
      out.write("data", 36, "latin1");
      out.writeUInt32LE(samples.length * 2, 40);
      for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(samples[i] * scale * 32767), 44 + i * 2);
      fs.writeFileSync(dst, out);
      return { peak, scale };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`${src}: no data chunk`);
}

async function render(id, midi) {
  const mid = path.join(tmp, `${id}.mid`);
  const raw = path.join(tmp, `${id}.f32.wav`);
  const wav = path.join(tmp, `${id}.wav`);
  fs.writeFileSync(mid, midi);
  await run("fluidsynth", ["-ni", "-q", "-g", String(GAIN), "-r", "44100", "-O", "float", "-F", raw, soundfont, mid]);
  const { peak, scale } = floatWavTo16(raw, wav);
  fs.rmSync(raw);
  await run("lame", ["--quiet", "-V", "5", wav, path.join(outDir, `${id}.mp3`)]);
  fs.rmSync(wav);
  if (scale < 1) console.log(`${id}: peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS, scaled by ${(20 * Math.log10(scale)).toFixed(1)} dB`);
}

const queue = [...tracks];
// Each job holds a few hundred MB of float audio, so cap parallelism.
const workers = Array.from({ length: Math.min(os.cpus().length, 4) }, async () => {
  for (let job; (job = queue.shift()); ) await render(...job);
});
await Promise.all(workers);

fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2));
fs.rmSync(tmp, { recursive: true });
console.log(`rendered ${tracks.size} tracks for ${Object.keys(index).length} music lumps into ${outDir}`);
