// Browser client: provisions the Doom MicroVM, renders the frame stream and sends key events.
//
// The browser talks only to the webui: frames arrive as SSE on a long-lived POST /api/stream (read with fetch),
// keys go out as short POST /api/input. The webui relays both over its WebSocket to the MicroVM.
// Sound effects arrive as events on the same stream and are played locally from samples fetched once;
// music events name a track, which is fetched as an MP3 (pre-rendered at image build time) and looped.
// There's a single game: one MicroVM, shared by all tabs. It must be provisioned first (Provision DOOM).

import { loadConfig, pulse, setRates } from "/diagram.js";

const WIDTH = 320;
const HEIGHT = 200;

const screen = document.getElementById("screen");
const ctx = document.getElementById("canvas").getContext("2d");
const connEl = document.getElementById("conn");
const statsEl = document.getElementById("stats");
const soundBtn = document.getElementById("sound");
const vmEl = document.getElementById("vm");
const provisionEl = document.getElementById("provision");
const provisionBtn = document.getElementById("provision-btn");
const provisionMsg = document.getElementById("provision-msg");
// The controls, also shown under the Provision button so they're visible before the game starts.
document.getElementById("provision-help").innerHTML = document.querySelector(".help").innerHTML;
const image = ctx.createImageData(WIDTH, HEIGHT);
const pixels = new Uint32Array(image.data.buffer);
const palette = new Uint32Array(256);

// Calls the webui API. kind: "input" or "fetch" lights the matching arrows in the diagram; streams don't count.
function api(path, { body, kind } = {}) {
  if (kind) {
    stats.requests++;
    pulse(kind);
  }
  return fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ---- MicroVM provisioning + status ----

let vm = { state: "UNKNOWN" }; // latest /api/status
let vmStatusTimer = null;

// The MicroVM can be streamed from while it's running, or suspended (the webui resumes it on connect).
const vmUsable = () => ["RUNNING", "SUSPENDED", "SUSPENDING"].includes(vm.state);

async function refreshStatus() {
  try {
    renderStatus(await (await api("/api/status")).json());
  } catch (err) {
    console.warn("status failed:", err);
  }
  clearTimeout(vmStatusTimer);
  vmStatusTimer = setTimeout(refreshStatus, vm.state === "PENDING" ? 1000 : 3000);
}

function renderStatus(status) {
  vm = status;
  const none = !vmUsable() && vm.state !== "PENDING";
  provisionEl.hidden = vmUsable();
  provisionBtn.hidden = !none;
  provisionMsg.textContent =
    vm.state === "PENDING" ? "Starting the MicroVM…" : vm.state === "UNKNOWN" ? "" : "No MicroVM running.";
  renderCountdown();
}

function renderCountdown() {
  if (vm.mode === "local") return (vmEl.textContent = "local container");
  const left = vm.expiresAt ? Math.max(0, Math.round((new Date(vm.expiresAt) - Date.now()) / 1000)) : null;
  const time = left === null ? "" : ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
  vmEl.textContent = `MicroVM ${vm.state.toLowerCase()}${vmUsable() ? time : ""}`;
}
setInterval(renderCountdown, 1000);

provisionBtn.addEventListener("click", async () => {
  provisionBtn.disabled = true;
  try {
    const res = await api("/api/provision", { body: {}, kind: "fetch" });
    renderStatus(await res.json());
  } catch (err) {
    provisionMsg.textContent = `Provisioning failed: ${err.message}`;
  } finally {
    provisionBtn.disabled = false;
    refreshStatus();
  }
});

// ---- Frame stream ----

const stats = { frames: 0, bytes: 0, audio: 0, requests: 0, inputRtt: 0 };
let latestFrame = null; // base64 of the newest undecoded frame; older ones are dropped
let decoding = false;

async function runStream() {
  let backoff = 500;
  for (;;) {
    if (!vmUsable()) {
      connEl.textContent = "not connected";
      await sleep(500);
      continue;
    }
    try {
      connEl.textContent = "connecting…";
      const res = await api("/api/stream", { body: {} });
      if (res.status === 409) {
        refreshStatus(); // the MicroVM is gone: show Provision DOOM again
        await res.text();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      connEl.textContent = "connected";
      backoff = 500;
      for await (const { event, data } of readSse(res.body)) {
        if (event === "frame") onFrame(data);
        else if (event === "hello") onHello(JSON.parse(data));
        else if (event === "sound") onSoundEvents(JSON.parse(data));
        else if (event === "music") onMusicEvent(JSON.parse(data));
        else if (event === "end") {
          console.log("stream ended:", data);
          refreshStatus();
        }
      }
    } catch (err) {
      console.warn("stream error:", err);
      connEl.textContent = `disconnected (${err.message})`;
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 10000);
  }
}

async function* readSse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

// "webp" (current game servers) or "deflate" (palette + indices; older ones don't say).
let frameFormat = "deflate";

function onHello(hello) {
  frameFormat = hello.frameFormat || "deflate";
  connEl.textContent = `connected · ${hello.microvm}`;
  soundsVersion.resolve(hello.sounds);
}

// Current game servers send a batch per game tic: [["s",ch,vol,sep,lump], ["u",ch,vol,sep], ["x",ch], ...].
// Older ones sent one {op:"start"|"update"|"stop",ch,vol,sep,lump} object per event.
const SOUND_OPS = { s: "start", u: "update", x: "stop" };

function onSoundEvents(data) {
  const events = Array.isArray(data)
    ? data.map(([op, ch, vol, sep, lump]) => ({ op: SOUND_OPS[op], ch, vol, sep, lump }))
    : [data];
  stats.audio += events.length;
  pulse("audio");
  for (const ev of events) onSound(ev);
}

function onMusicEvent(ev) {
  stats.audio++;
  pulse("audio");
  onMusic(ev);
}

function onFrame(b64) {
  pulse("frame");
  stats.frames++;
  stats.bytes += b64.length;
  latestFrame = b64;
  if (!decoding) decodeLoop();
}

async function decodeLoop() {
  decoding = true;
  try {
    while (latestFrame) {
      const bytes = base64ToBytes(latestFrame);
      latestFrame = null;
      if (frameFormat === "webp") {
        // Decoded off the main thread by the browser; drawn 1:1, the canvas CSS scales it up pixelated.
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      } else {
        draw(await inflate(bytes));
      }
    }
  } catch (err) {
    console.warn("frame decode failed:", err);
  } finally {
    decoding = false;
  }
}

function base64ToBytes(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Frame = 768 bytes RGB palette + 320*200 palette indices.
function draw(raw) {
  for (let i = 0; i < 256; i++) {
    palette[i] = 0xff000000 | (raw[i * 3 + 2] << 16) | (raw[i * 3 + 1] << 8) | raw[i * 3]; // ABGR (little-endian RGBA)
  }
  for (let p = 0; p < WIDTH * HEIGHT; p++) pixels[p] = palette[raw[768 + p]];
  ctx.putImageData(image, 0, 0);
}

// ---- Sound ----

// Browsers only allow audio after a user gesture, so the AudioContext is created on first click/keypress.
let audio = null;
let master = null;
const buffers = new Map(); // lump name -> AudioBuffer
const playing = new Map(); // engine channel -> { src, gain, pan }

function initAudio() {
  if (audio) return audio.resume();
  audio = new AudioContext();
  master = audio.createGain();
  master.connect(audio.destination);
  musicGain = audio.createGain();
  audio.createMediaElementSource(musicEl).connect(musicGain).connect(master);
  applyMusic();
  loadSounds().catch((err) => {
    console.warn("loading sounds failed:", err);
    soundBtn.textContent = "sound: failed";
  });
}

// Version of the sounds JSON, from the stream's hello event (older game servers don't send one: no caching then).
const soundsVersion = Promise.withResolvers();

// The sounds JSON (~1.9 MB) is cached in the browser (Cache API), keyed by its version, so it's downloaded only
// when it changes. The Cache API needs a secure context (https or localhost); without it, fetch every time.
async function fetchSounds() {
  const version = await soundsVersion.promise;
  const cache = version && globalThis.caches && (await caches.open("doom-sounds"));
  const key = `/cache/sounds/${version}`;
  const cached = cache && (await cache.match(key));
  if (cached) return cached.json();

  const res = await api("/api/sounds", { kind: "fetch" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (cache) {
    for (const old of await cache.keys()) await cache.delete(old);
    await cache.put(key, new Response(text, { headers: { "content-type": "application/json" } }));
  }
  return JSON.parse(text);
}

async function loadSounds() {
  soundBtn.textContent = "sound: loading…";
  const { sounds } = await fetchSounds();
  for (const [name, { rate, pcm }] of Object.entries(sounds)) {
    const bytes = base64ToBytes(pcm);
    const buf = audio.createBuffer(1, bytes.length, rate);
    const samples = buf.getChannelData(0);
    for (let i = 0; i < bytes.length; i++) samples[i] = (bytes[i] - 128) / 128; // unsigned 8-bit PCM
    buffers.set(name, buf);
  }
  updateSoundButton();
}

// vol 0..127; sep 0 (left) .. 128 (center) .. 254 (right)
function applyParams(node, vol, sep) {
  node.gain.gain.value = vol / 127;
  node.pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 127));
}

function stopChannel(ch) {
  const node = playing.get(ch);
  if (!node) return;
  playing.delete(ch);
  node.src.stop();
}

function onSound(ev) {
  if (!audio || audio.state !== "running") return;
  if (ev.op === "start") {
    stopChannel(ev.ch);
    const buffer = buffers.get(ev.lump);
    if (!buffer) return;
    const node = { src: audio.createBufferSource(), gain: audio.createGain(), pan: audio.createStereoPanner() };
    node.src.buffer = buffer;
    node.src.connect(node.gain).connect(node.pan).connect(master);
    applyParams(node, ev.vol, ev.sep);
    node.src.onended = () => playing.get(ev.ch) === node && playing.delete(ev.ch);
    playing.set(ev.ch, node);
    node.src.start();
  } else if (ev.op === "update") {
    const node = playing.get(ev.ch);
    if (node) applyParams(node, ev.vol, ev.sep);
  } else if (ev.op === "stop") {
    stopChannel(ev.ch);
  }
}

// ---- Music ----

const musicEl = new Audio();
let musicGain = null;
let music = { op: "stop", lump: null, loop: false, vol: 127 }; // latest state from the engine
let musicLump = null; // track currently loaded into musicEl
const musicUrls = new Map(); // lump -> blob URL

function onMusic(ev) {
  music = ev;
  applyMusic();
}

async function applyMusic() {
  if (!musicGain) return; // audio not enabled yet; applied once it is
  musicGain.gain.value = music.vol / 127;
  if (!music.lump || music.op === "stop") {
    musicEl.pause();
    musicLump = null;
    return;
  }
  if (music.lump !== musicLump) {
    const lump = (musicLump = music.lump);
    musicEl.pause();
    const url = await musicUrl(lump).catch((err) => console.warn(`music ${lump}:`, err));
    if (!url || musicLump !== lump) return; // failed, or the track changed while fetching
    musicEl.src = url;
    musicEl.loop = music.loop;
  }
  if (music.op === "pause") musicEl.pause();
  else musicEl.play().catch((err) => console.warn("music play:", err));
}

async function musicUrl(lump) {
  if (!musicUrls.has(lump)) {
    const res = await api(`/api/music/${lump}`, { kind: "fetch" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    musicUrls.set(lump, URL.createObjectURL(await res.blob()));
  }
  return musicUrls.get(lump);
}

let muted = false;

function updateSoundButton() {
  master.gain.value = muted ? 0 : 1;
  soundBtn.textContent = muted ? "sound: off" : "sound: on";
}

// Keep keyboard focus on the game when toggling sound.
soundBtn.addEventListener("mousedown", (e) => e.preventDefault());
soundBtn.addEventListener("click", () => {
  if (!audio) return initAudio();
  muted = !muted;
  updateSoundButton();
});

// ---- Input ----

const held = new Set();
let queue = [];
let sending = false;

// Only one input request in flight at a time: events that arrive meanwhile are batched into the next
// request. Keeps order and naturally coalesces under latency.
async function flushInput() {
  if (sending || queue.length === 0) return;
  sending = true;
  const events = queue;
  queue = [];
  const t0 = performance.now();
  try {
    const res = await api("/api/input", { body: { events }, kind: "input" });
    if (!res.ok) console.warn("input failed:", res.status, await res.text());
    stats.inputRtt = performance.now() - t0;
  } catch (err) {
    console.warn("input error:", err);
  }
  sending = false;
  flushInput();
}

function sendKey(code, down) {
  queue.push({ code, down });
  flushInput();
}

screen.addEventListener("pointerdown", initAudio);

screen.addEventListener("keydown", (e) => {
  if (e.metaKey) return; // leave browser shortcuts alone
  initAudio();
  e.preventDefault();
  if (e.repeat || held.has(e.code)) return;
  held.add(e.code);
  sendKey(e.code, true);
});

screen.addEventListener("keyup", (e) => {
  e.preventDefault();
  if (!held.delete(e.code)) return;
  sendKey(e.code, false);
});

// Release everything on focus loss so keys don't stay stuck down in the game.
screen.addEventListener("blur", () => {
  for (const code of held) sendKey(code, false);
  held.clear();
});

// ---- Stats ----

let lastStats = { ...stats, t: performance.now() };
setInterval(() => {
  const now = performance.now();
  const secs = (now - lastStats.t) / 1000;
  const rate = (key) => (stats[key] - lastStats[key]) / secs;
  const fps = rate("frames").toFixed(0);
  const mbps = ((rate("bytes") * 8) / 1e6).toFixed(1);
  const rtt = stats.inputRtt.toFixed(0);
  statsEl.textContent = `${fps} fps · ${mbps} Mbit/s · input rtt ${rtt} ms`;
  setRates({
    req: `${rate("requests").toFixed(0)} req/s · rtt ${rtt} ms`,
    vid: `${fps} fps · ${mbps} Mb/s`,
    aud: `${rate("audio").toFixed(0)} audio ev/s`,
  });
  lastStats = { ...stats, t: now };
}, 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

screen.focus();
loadConfig();
refreshStatus();
runStream();
