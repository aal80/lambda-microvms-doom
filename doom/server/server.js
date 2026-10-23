// Lambda MicroVM server that runs Doom.
//
// Two ports (the Lambda MicroVM two-port model):
//   8080  lifecycle hooks + health. Lambda calls POST /aws/lambda-microvms/runtime/v1/<hook>:
//           /ready     build time: 200 once Doom has drawn a frame and the encoder is warm, so the snapshot
//                      captures a running game (503 = not yet)
//           /validate  build time, on a fresh MicroVM from the snapshot: reads the big files once so the
//                      platform prefetches them on real starts (disk and memory are loaded lazily)
//           /run       runtime: a MicroVM started; we keep its id for the hello message
//         GET /health
//   8081  the game, reached through the MicroVM endpoint with the X-aws-proxy-port: 8081 header:
//           GET /ws           WebSocket (the webui keeps one per execution environment)
//           GET /sounds       JSON {sounds: {DSPISTOL: {rate, pcm: base64 u8}}}
//           GET /music/:lump  audio/mpeg (pre-rendered at image build time)
//           GET /health
//
// WebSocket protocol. MicroVM -> webui:
//   text   {"t":"hello","width":320,"height":200,"frameFormat":"webp","microvm":"<id>","sounds":"<version>"}
//   text   {"t":"music","op":"play"|"stop"|"pause"|"resume"|"volume","lump":"D_E1M1","loop":true,"vol":0-127}
//   text   {"t":"sound","ev":[["s",ch,vol,sep,"DSPISTOL"], ["u",ch,vol,sep], ["x",ch], ...]}  one batch per tic
//   text   {"t":"end","reason":"..."}
//   binary one frame (WebP q85, or deflate-raw(768 B palette + 320*200 indices) when FRAME_FORMAT=deflate)
// webui -> MicroVM:
//   {"t":"subscribe","on":true|false}   frames + audio events only go to subscribed sockets
//   {"t":"input","events":[{"code":"KeyW","down":true}, ...]}
//
// One MicroVM = one game. Doom starts before the snapshot (so a new MicroVM resumes a running game) and is
// restarted on demand if it exits (e.g. quit from the menu).
//
// Env: DOOM_BIN, DOOM_IWAD, DOOM_ARGS, MUSIC_DIR, HOOK_PORT, GAME_PORT, MAX_FPS, FRAME_FORMAT, FRAME_QUALITY

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import { readSounds } from "./wad.js";

const HOOK_PORT = Number(process.env.HOOK_PORT || 8080);
const GAME_PORT = Number(process.env.GAME_PORT || 8081);
const HOOK_BASE_PATH = "/aws/lambda-microvms/runtime/v1";
const DOOM_BIN = process.env.DOOM_BIN || "/game/doomgeneric_headless";
const DOOM_IWAD = process.env.DOOM_IWAD || "/game/freedoom1.wad";
const DOOM_ARGS = (process.env.DOOM_ARGS || "").split(" ").filter(Boolean);
const MUSIC_DIR = process.env.MUSIC_DIR || "/game/music";
// Optional frame-rate cap to trade smoothness for bandwidth; 0 = send every distinct frame (~35 fps).
const MAX_FPS = Number(process.env.MAX_FPS || 0);
// WebP q85: ~20 KB/frame vs ~30 KB lossless deflate, crisp pixel art.
const FRAME_FORMAT = process.env.FRAME_FORMAT === "deflate" ? "deflate" : "webp";
const FRAME_QUALITY = Number(process.env.FRAME_QUALITY || 85);
// A socket with more than this queued is too slow: it skips frames until it catches up.
const MAX_BUFFERED_BYTES = 512 * 1024;
// The biggest files a cold MicroVM would otherwise page in from the snapshot on first use (see /validate).
const WARM_FILES = ["/usr/local/bin/node", DOOM_BIN, DOOM_IWAD];
const WARM_DIRS = ["/game/server/node_modules/@img", MUSIC_DIR]; // sharp's libvips binaries, the MP3s

const WIDTH = 320;
const HEIGHT = 200;
const FRAME_BYTES = 256 * 3 + WIDTH * HEIGHT;
// Engine -> server records on fd 3 (see engine/headless.h): [type u8][len u32 LE][payload].
const REC_FRAME = 1;
const REC_SOUND = 2;
const REC_MUSIC = 3;
const SOUND_OPS = { 1: "s", 2: "u", 3: "x" }; // start, update, stop
const MUSIC_OPS = { 1: "play", 2: "stop", 3: "pause", 4: "resume", 5: "volume" };
// Sound updates closer than this to what was last sent are inaudible (0.8% gain / pan) and not sent.
const SOUND_VOL_EPS = 1;
const SOUND_SEP_EPS = 2;

// KeyboardEvent.code -> Doom key code (doomkeys.h). This is a plain keyboard mapping; which key does what in the
// game is set by the engine's key_* bindings (engine/doomgeneric_headless.c: WASD move/turn, K fire, L use).
const KEY = {
  ArrowRight: 0xae, ArrowLeft: 0xac, ArrowUp: 0xad, ArrowDown: 0xaf, // menus, automap
  Comma: 0x2c, Period: 0x2e,
  Space: 0xa2,               // KEY_USE: unbound now that use is on L
  ControlLeft: 0xa3, ControlRight: 0xa3, // KEY_FIRE: unbound now that fire is on K
  ShiftLeft: 0x80 + 0x36, ShiftRight: 0x80 + 0x36, // run
  AltLeft: 0x80 + 0x38, AltRight: 0x80 + 0x38,     // strafe modifier
  Escape: 27, Enter: 13, Tab: 9, Backspace: 0x7f,
  Minus: 0x2d, Equal: 0x3d,
  F1: 0x80 + 0x3b, F2: 0x80 + 0x3c, F3: 0x80 + 0x3d, F4: 0x80 + 0x3e, F5: 0x80 + 0x3f,
  F6: 0x80 + 0x40, F7: 0x80 + 0x41, F8: 0x80 + 0x42, F9: 0x80 + 0x43, F10: 0x80 + 0x44,
  F11: 0x80 + 0x57, F12: 0x80 + 0x58,
};
for (let c = 65; c <= 90; c++) KEY[`Key${String.fromCharCode(c)}`] = c + 32; // KeyA -> 'a'
for (let d = 0; d <= 9; d++) KEY[`Digit${d}`] = 48 + d;

// ---- Doom process ----

let doom = null;
const subscribers = new Set(); // WebSockets that want frames + audio events

// Resolves when the engine has drawn its first frame, i.e. finished initializing.
const firstFrame = Promise.withResolvers();

function startDoom() {
  if (doom) return doom;
  const args = ["-iwad", DOOM_IWAD, ...DOOM_ARGS];
  console.log(`starting ${DOOM_BIN} ${args.join(" ")}`);
  const proc = spawn(DOOM_BIN, args, { stdio: ["pipe", "inherit", "inherit", "pipe"], cwd: "/tmp" });

  let pending = Buffer.alloc(0);
  proc.stdio[3].on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let latest = null;
    const sounds = [];
    while (pending.length >= 5) {
      const len = pending.readUInt32LE(1);
      if (pending.length < 5 + len) break;
      const type = pending[0];
      const payload = pending.subarray(5, 5 + len);
      pending = pending.subarray(5 + len);
      if (type === REC_FRAME && len === FRAME_BYTES) {
        latest = payload;
        firstFrame.resolve();
      } else if (type === REC_SOUND) queueSound(payload, sounds);
      else if (type === REC_MUSIC) onMusic(payload);
    }
    // Only the newest frame of a chunk matters; its sound events go out first, as one batch.
    if (sounds.length) broadcastSounds(sounds);
    if (latest) broadcastFrame(Buffer.from(latest));
  });
  proc.stdin.on("error", () => {});
  proc.on("exit", (code, signal) => {
    console.log(`doom exited code=${code} signal=${signal}`);
    if (doom === proc) doom = null;
    broadcast(JSON.stringify({ t: "end", reason: "doom exited" }));
  });
  doom = proc;
  return proc;
}

function broadcast(text) {
  for (const ws of subscribers) ws.send(text);
}

// ---- Frames ----

let lastFrame = null; // newest distinct frame from the engine
let lastFrameData = null; // its encoded bytes, once encoded
let lastSentAt = 0;
let encoding = false;

function broadcastFrame(frame) {
  // Doom redraws ~2x per game tic; about half the frames are byte-identical to the previous one.
  if (lastFrame?.equals(frame)) return;
  const now = Date.now();
  if (MAX_FPS && now - lastSentAt < (1000 / MAX_FPS) * 0.8) return;
  lastFrame = frame;
  lastFrameData = null;
  if (subscribers.size === 0) return;
  lastSentAt = now;
  if (!encoding) encodeAndSend();
}

// Encodes the newest frame (WebP runs in libvips' thread pool, off the event loop) and sends it to every
// subscriber. Frames that arrive during an encode replace each other, so a slow encode drops frames.
async function encodeAndSend() {
  encoding = true;
  try {
    while (lastFrame && !lastFrameData && subscribers.size > 0) {
      const frame = lastFrame;
      const data = await encodeFrame(frame);
      if (lastFrame === frame) lastFrameData = data;
      for (const ws of subscribers) {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow link: skip, it gets the next one
        ws.send(data);
      }
    }
  } catch (err) {
    console.error(`frame encoding failed: ${err.message}`);
  } finally {
    encoding = false;
  }
}

// Reused for every WebP encode; only one encode runs at a time.
const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);

async function encodeFrame(frame) {
  if (FRAME_FORMAT !== "webp") return zlib.deflateRawSync(frame, { level: 6 });
  for (let p = 0; p < WIDTH * HEIGHT; p++) {
    const c = frame[768 + p] * 3;
    rgb[p * 3] = frame[c];
    rgb[p * 3 + 1] = frame[c + 1];
    rgb[p * 3 + 2] = frame[c + 2];
  }
  return sharp(rgb, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .webp({ quality: FRAME_QUALITY, effort: 2 })
    .toBuffer();
}

// ---- Sound + music events ----

// Last vol/sep sent per channel, to skip inaudible updates.
const soundSent = new Map();

// Adds one engine sound event to the current batch, coalescing per channel: an update folds into a start or
// update already in the batch, a stop drops a pending update, and an update too small to hear is skipped.
function queueSound(p, batch) {
  const [op, ch, vol, sep] = [SOUND_OPS[p[0]], p[1], p[2], p[3]];
  const prev = batch.findLast((e) => e[1] === ch);
  if (op === "u") {
    if (prev && prev[0] !== "x") {
      prev[2] = vol;
      prev[3] = sep;
      return;
    }
    const last = soundSent.get(ch);
    if (last && Math.abs(last.vol - vol) <= SOUND_VOL_EPS && Math.abs(last.sep - sep) <= SOUND_SEP_EPS) return;
    batch.push([op, ch, vol, sep]);
  } else if (op === "s") {
    batch.push([op, ch, vol, sep, p.toString("latin1", 4, 12).replace(/\0.*$/, "").toUpperCase()]);
  } else {
    if (prev?.[0] === "u") batch.splice(batch.lastIndexOf(prev), 1);
    batch.push([op, ch]);
  }
}

function broadcastSounds(batch) {
  if (subscribers.size === 0) return;
  for (const [op, ch, vol, sep] of batch) {
    if (op === "x") soundSent.delete(ch);
    else soundSent.set(ch, { vol, sep });
  }
  // Never dropped (unlike frames): they're tiny and a lost stop would leave a sound playing.
  broadcast(JSON.stringify({ t: "sound", ev: batch }));
}

// Current music state, replayed to sockets that subscribe later.
const music = { lump: null, loop: false, vol: 127, paused: false };

function onMusic(p) {
  const op = MUSIC_OPS[p[0]];
  music.vol = p[2];
  if (op === "play") {
    const lump = p.toString("latin1", 4, 12).replace(/\0.*$/, "").toUpperCase();
    Object.assign(music, { lump, loop: p[1] === 1, paused: false });
  } else if (op === "stop") music.lump = null;
  else if (op === "pause") music.paused = true;
  else if (op === "resume") music.paused = false;
  broadcast(JSON.stringify({ t: "music", op, lump: music.lump, loop: music.loop, vol: music.vol }));
}

function musicState() {
  return music.lump
    ? { t: "music", op: music.paused ? "pause" : "play", lump: music.lump, loop: music.loop, vol: music.vol }
    : { t: "music", op: "stop", lump: null, loop: false, vol: music.vol };
}

// ---- Static data (loaded before the snapshot) ----

// Sound samples from the IWAD, serialized once, and the music lump -> MP3 index written by music/render.mjs.
const soundsJson = (() => {
  const out = {};
  for (const [name, { rate, pcm }] of Object.entries(readSounds(DOOM_IWAD))) out[name] = { rate, pcm: pcm.toString("base64") };
  const json = JSON.stringify({ sounds: out });
  console.log(`loaded ${Object.keys(out).length} sounds from ${DOOM_IWAD} (${json.length} bytes JSON)`);
  return json;
})();
// Lets browsers cache the sounds and only download them again when they change.
const soundsVersion = crypto.createHash("sha1").update(soundsJson).digest("hex").slice(0, 12);
const musicIndex = JSON.parse(fs.readFileSync(path.join(MUSIC_DIR, "index.json"), "utf8"));

// ---- Game server (8081) ----

// The MicroVM id, from the /run hook payload. Until /run (e.g. running locally) a random id made on first use:
// anything made before the snapshot would be shared by every MicroVM started from it.
let microvmId = null;
const instanceId = () => (microvmId ??= `local-${crypto.randomBytes(4).toString("hex")}`);

function onSocket(ws) {
  startDoom();
  console.log(`websocket connected (${wss.clients.size} open)`);
  ws.send(JSON.stringify({ t: "hello", width: WIDTH, height: HEIGHT, frameFormat: FRAME_FORMAT, microvm: instanceId(), sounds: soundsVersion }));

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.t === "input") onInput(msg.events);
    else if (msg.t === "subscribe") setSubscribed(ws, msg.on === true);
  });
  ws.on("close", () => {
    subscribers.delete(ws);
    console.log(`websocket closed (${wss.clients.size} open, ${subscribers.size} subscribed)`);
  });
  ws.on("error", (err) => console.error(`websocket error: ${err.message}`));
}

function setSubscribed(ws, on) {
  if (!on) return subscribers.delete(ws);
  if (subscribers.has(ws)) return;
  startDoom();
  // The current state right away: music, then the picture (cached if encoded, else encode now for everyone).
  ws.send(JSON.stringify(musicState()));
  subscribers.add(ws);
  if (lastFrameData) ws.send(lastFrameData);
  else if (!encoding) encodeAndSend();
}

function onInput(events) {
  const bytes = [];
  for (const e of Array.isArray(events) ? events : []) {
    const key = KEY[e?.code];
    if (key !== undefined) bytes.push(e.down ? 1 : 0, key);
  }
  if (bytes.length) startDoom().stdin.write(Buffer.from(bytes));
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const gameServer = http.createServer({ noDelay: true }, (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  if (pathname === "/health") return sendJson(res, 200, { status: "ok" });
  if (pathname === "/sounds") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(soundsJson);
  }
  const m = pathname.match(/^\/music\/([A-Z0-9_]{1,8})$/i);
  if (m) {
    const lump = m[1].toUpperCase();
    const file = Object.hasOwn(musicIndex, lump) && musicIndex[lump];
    if (!file) return sendJson(res, 404, { error: `no music for lump: ${lump}` });
    const full = path.join(MUSIC_DIR, file);
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": fs.statSync(full).size });
    return fs.createReadStream(full).pipe(res);
  }
  sendJson(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
wss.on("connection", onSocket);
gameServer.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://localhost").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ---- Hook server (8080) ----

let ready = false; // Doom running + encoder warm + game server listening
let warm = "idle"; // idle | warming | done

// Reads the biggest files once so their pages are in the page cache while /validate runs: the platform records
// what a fresh MicroVM touches and prefetches it on real starts. Best-effort: never fails the build.
function startWarm() {
  if (warm !== "idle") return;
  warm = "warming";
  const files = [...WARM_FILES];
  for (const dir of WARM_DIRS) {
    try {
      for (const f of fs.readdirSync(dir, { recursive: true })) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isFile()) files.push(full);
      }
    } catch {}
  }
  const t0 = Date.now();
  Promise.all(files.map((f) => fs.promises.readFile(f).then((b) => b.length, () => 0))).then((sizes) => {
    const mb = sizes.reduce((a, b) => a + b, 0) / 1e6;
    console.log(`warmed ${files.length} files (${mb.toFixed(0)} MB) in ${Date.now() - t0} ms`);
    warm = "done";
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

const hookServer = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === "/health") return sendJson(res, ready ? 200 : 503, { status: ready ? "ok" : "starting" });
  if (req.method !== "POST" || !pathname.startsWith(HOOK_BASE_PATH)) return sendJson(res, 404, { error: "not found" });

  const hook = pathname.slice(HOOK_BASE_PATH.length);
  const body = await readJsonBody(req);
  if (hook === "/ready") return sendJson(res, ready ? 200 : 503, { status: ready ? "ready" : "starting" });
  if (hook === "/validate") {
    if (!ready) return sendJson(res, 503, { status: "starting" });
    startWarm();
    return sendJson(res, warm === "done" ? 200 : 503, { status: warm });
  }
  if (hook === "/run") {
    if (body.microvmId) microvmId = body.microvmId;
    console.log(`/run microvmId=${body.microvmId || "(none)"}`);
    return sendJson(res, 200, { status: "accepted" });
  }
  sendJson(res, 200, { status: "ignored" });
});

hookServer.listen(HOOK_PORT, "0.0.0.0", () => console.log(`hooks on :${HOOK_PORT} under ${HOOK_BASE_PATH}`));

// Start Doom, wait for its first frame, warm the encoder, then open the game port: /ready only says yes after
// all of that, so the snapshot holds a running game with libvips initialized.
const startedAt = Date.now();
startDoom();
await Promise.race([firstFrame.promise, new Promise((r) => setTimeout(r, 60_000))]);
if (lastFrame) await encodeFrame(lastFrame);
gameServer.listen(GAME_PORT, "0.0.0.0", () => {
  ready = true;
  console.log(`game on :${GAME_PORT}, ready after ${Date.now() - startedAt} ms`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    doom?.kill("SIGTERM");
    process.exit(0);
  });
}
