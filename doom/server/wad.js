// Minimal WAD reader: lump directory, digitized sound effects (DMX format 3 lumps) and music lumps.

import fs from "node:fs";

// Returns [{ name, data: Buffer }] in directory order. Names are upper-cased.
export function readLumps(wadPath) {
  const wad = fs.readFileSync(wadPath);
  const magic = wad.toString("latin1", 0, 4);
  if (magic !== "IWAD" && magic !== "PWAD") throw new Error(`${wadPath}: not a WAD file`);
  const numLumps = wad.readInt32LE(4);
  const dirOffset = wad.readInt32LE(8);

  const lumps = [];
  for (let i = 0; i < numLumps; i++) {
    const entry = dirOffset + i * 16;
    const pos = wad.readInt32LE(entry);
    const size = wad.readInt32LE(entry + 4);
    const name = wad.toString("latin1", entry + 8, entry + 16).replace(/\0.*$/, "").toUpperCase();
    lumps.push({ name, data: wad.subarray(pos, pos + size) });
  }
  return lumps;
}

// Returns { [lumpName]: { rate, pcm: Buffer of unsigned 8-bit mono samples } }.
export function readSounds(wadPath) {
  const sounds = {};
  for (const { name, data } of readLumps(wadPath)) {
    if (!name.startsWith("DS") || data.length < 8) continue;

    // DMX header: format u16 (= 3), sample rate u16, sample count u32 (including 16 padding bytes at
    // each end, which DMX skips - same handling as chocolate-doom's i_sdlsound.c).
    if (data.readUInt16LE(0) !== 3) continue;
    const rate = data.readUInt16LE(2);
    const length = data.readUInt32LE(4);
    if (length > data.length - 8 || length <= 48) continue;
    sounds[name] = { rate, pcm: data.subarray(24, 24 + length - 32) };
  }
  return sounds;
}

// Returns [{ name, data }] for music lumps (D_*), in MIDI ("MThd") or MUS ("MUS\x1a") format.
export function readMusic(wadPath) {
  return readLumps(wadPath).filter(({ name, data }) => {
    const magic = data.toString("latin1", 0, 4);
    return name.startsWith("D_") && (magic === "MThd" || magic === "MUS\x1a");
  });
}
