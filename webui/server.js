// Doom web UI server: serves the browser client from ./public, provisions Doom MicroVMs, and bridges the browser
// (POST + SSE) to them (one WebSocket per MicroVM per execution environment).
//
// Each browser tab plays its own game in its own MicroVM. The MicroVM id is the tab's session id: provision
// returns it, and the tab sends it back on every other call (X-Doom-Session header, or ?microvm= where a header
// can't be set). Any execution environment can serve any tab: it looks the MicroVM up by id (GetMicrovm) and
// mints its own token. The webui's IAM role only covers the Doom image, so ids of other MicroVMs are refused.
//
// Browser API:
//   POST /api/provision     start a MicroVM for this tab -> {mode, state, microvmId}; 503 TooManyMicrovms when
//                           MAX_MICROVMS are already live
//   GET  /api/status        {mode, state, microvmId, startedAt, expiresAt}; state NONE when the MicroVM is gone
//   POST /api/stream        SSE: hello, music, frame (base64), sound, end - the same events the MicroVM sends
//   POST /api/input         {"events":[{"code":"KeyW","down":true}, ...]} -> forwarded over the WebSocket
//   POST /api/terminate     end the tab's MicroVM (sent with navigator.sendBeacon when the tab closes or reloads)
//   GET  /api/sounds        sound samples JSON (proxied from the MicroVM)
//   GET  /api/music/:lump   MP3 (proxied from the MicroVM)
//   GET  /config            {mode, region} or {mode:"local", target} for the architecture diagram
//
// The MicroVM endpoint needs an auth token (X-aws-proxy-auth, from CreateMicrovmAuthToken) and the target port
// (X-aws-proxy-port: 8081). Both are added here; the browser never sees the token.
//
// Locally (LOCAL_GAME_URL) there's one container and nothing to provision: every tab gets the session id "local"
// and shares that one game.
//
// Env:
//   MICROVM_IMAGE_ARN     MicroVM image to run (required unless LOCAL_GAME_URL is set)
//   MICROVM_RUN_ROLE_ARN  execution role for the MicroVM
//   MAX_MICROVMS          live MicroVMs (from this image) at most; provisioning beyond it is refused (default 10)
//   LOCAL_GAME_URL        e.g. http://localhost:8081 - talk to a locally running container instead (no auth)
//   AWS_REGION, STATIC_DIR, PORT (ignored on Lambda Web Functions, which set AWS_LAMBDA_HTTP_ENDPOINT=host:port)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import WebSocket from "ws";
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  GetMicrovmCommand,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  TerminateMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
} from "@aws-sdk/client-lambda-microvms";

const { MICROVM_IMAGE_ARN, MICROVM_RUN_ROLE_ARN, LOCAL_GAME_URL } = process.env;
const STATIC_DIR = process.env.STATIC_DIR || path.join(import.meta.dirname, "public");
// On Lambda Web Functions the runtime says where to listen; locally listen on all interfaces (IPv4 + IPv6).
const [HOST, PORT] = process.env.AWS_LAMBDA_HTTP_ENDPOINT?.split(":") ?? [undefined, process.env.PORT || 3000];

if (!MICROVM_IMAGE_ARN && !LOCAL_GAME_URL) {
  console.error("Set MICROVM_IMAGE_ARN and MICROVM_RUN_ROLE_ARN (or LOCAL_GAME_URL for local development)");
  process.exit(1);
}
const local = Boolean(LOCAL_GAME_URL);
const region = process.env.AWS_REGION || MICROVM_IMAGE_ARN?.split(":")[3];

// MicroVM lifecycle: 5 min max lifetime; suspend after 2 min without inbound traffic, terminate after 2 min
// suspended; traffic to a suspended MicroVM resumes it.
const MAX_LIFETIME_S = 300;
const IDLE_POLICY = { autoResumeEnabled: true, maxIdleDurationSeconds: 120, suspendedDurationSeconds: 120 };
// The public endpoint has no auth and every tab starts a MicroVM, so this caps what anyone with the URL can run.
const MAX_MICROVMS = Number(process.env.MAX_MICROVMS || 10);
const GAME_PORT = 8081;
const TOKEN_MINUTES = 60; // the maximum; longer than a MicroVM lives
const DEAD_STATES = new Set(["TERMINATED", "TERMINATING"]);
const SESSION_HEADER = "x-doom-session";
const MICROVM_ID_RE = /^microvm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_ID = "local";
// Lambda Web Functions end a request at the 900 s timeout; end streams a bit earlier so the client reconnects.
const STREAM_MAX_MS = 840_000;
const KEEPALIVE_MS = 15_000;
// While a browser watches, ping the MicroVM so it doesn't count as idle (idleness = no inbound traffic).
const WS_PING_MS = 20_000;
// Keep an unused WebSocket this long after the last stream or input, then close it.
const WS_LINGER_MS = 30_000;
// Forget a session (its endpoint and token) this long after its last use; it's looked up again if needed.
const SESSION_IDLE_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;

const microvms = !local && new LambdaMicrovmsClient({ region });

// ---- Sessions: one per MicroVM this execution environment talks to ----

// microvmId -> { id, endpoint, token, tokenExpiresAt, link, clients, hello, musicState, lastFrameSse,
//                lingerTimer, lastUsed }
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, clients: new Set(), link: null, hello: null, musicState: null, lastFrameSse: null, lingerTimer: null };
    sessions.set(id, s);
  }
  s.lastUsed = Date.now();
  return s;
}

// Ends a session whose MicroVM is gone: closes its WebSocket and tells its browser streams.
function dropSession(s, reason) {
  closeLink(s, reason);
  clearTimeout(s.lingerTimer);
  for (const c of s.clients) c.res.end(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
  sessions.delete(s.id);
}

setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.link && s.clients.size === 0 && Date.now() - s.lastUsed > SESSION_IDLE_MS) sessions.delete(s.id);
  }
}, SESSION_IDLE_MS).unref();

// The tab's session id: from the X-Doom-Session header, or ?microvm= (sendBeacon can't set headers).
function sessionId(req) {
  const id = req.headers[SESSION_HEADER] ?? new URL(req.url, "http://localhost").searchParams.get("microvm");
  if (local ? id === LOCAL_ID : MICROVM_ID_RE.test(id ?? "")) return id;
  throw Object.assign(new Error("X-Doom-Session header required: the MicroVM id from /api/provision"), {
    status: 400,
    name: "BadSession",
  });
}

const notProvisioned = (message) => Object.assign(new Error(message), { status: 409, name: "NotProvisioned" });

// ---- MicroVMs ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getMicrovm(id) {
  try {
    return await microvms.send(new GetMicrovmCommand({ microvmIdentifier: id }));
  } catch (err) {
    if (err.name === "ResourceNotFoundException") return null;
    throw err;
  }
}

// MicroVMs from our image that aren't terminated (any tab's).
async function countLiveMicrovms() {
  let live = 0;
  let nextToken;
  do {
    const page = await microvms.send(new ListMicrovmsCommand({ imageIdentifier: MICROVM_IMAGE_ARN, maxResults: 50, nextToken }));
    for (const item of page.items ?? []) if (!DEAD_STATES.has(item.state)) live++;
    nextToken = page.nextToken;
  } while (nextToken);
  return live;
}

// The tab's MicroVM as the browser should see it. A gone one ends the session here.
async function status(id) {
  if (local) return { mode: "local", state: "RUNNING", microvmId: LOCAL_ID };
  const mv = await getMicrovm(id);
  if (!mv || DEAD_STATES.has(mv.state)) {
    const s = sessions.get(id);
    if (s) dropSession(s, "microvm terminated");
    return { mode: "microvm", state: mv?.state ?? "NONE", microvmId: id };
  }
  const startedAt = mv.startedAt ? new Date(mv.startedAt) : null;
  return {
    mode: "microvm",
    state: mv.state,
    microvmId: id,
    startedAt: startedAt?.toISOString() ?? null,
    expiresAt: startedAt ? new Date(startedAt.getTime() + MAX_LIFETIME_S * 1000).toISOString() : null,
  };
}

// Starts a MicroVM for a tab. Returns right away (PENDING); the endpoint and token are fetched in the background.
async function provision() {
  if (local) return status(LOCAL_ID);
  // Concurrent provisions can both pass this check, so the cap can be exceeded by a few; good enough as a guard.
  const live = await countLiveMicrovms();
  if (live >= MAX_MICROVMS) {
    throw Object.assign(new Error(`${live} MicroVMs running (max ${MAX_MICROVMS})`), { status: 503, name: "TooManyMicrovms" });
  }
  const res = await microvms.send(
    new RunMicrovmCommand({
      imageIdentifier: MICROVM_IMAGE_ARN,
      executionRoleArn: MICROVM_RUN_ROLE_ARN,
      maximumDurationInSeconds: MAX_LIFETIME_S,
      idlePolicy: IDLE_POLICY,
      runHookPayload: "{}",
    }),
  );
  console.log(`provisioned microvm ${res.microvmId} (${live + 1} live)`);
  const s = getSession(res.microvmId);
  ensureRunning(s).catch((err) => console.error(`microvm ${s.id} did not start: ${err.name}: ${err.message}`));
  return { mode: "microvm", state: "PENDING", microvmId: s.id };
}

async function terminate(id) {
  if (local) return; // the local container is everyone's
  const s = sessions.get(id);
  if (s) dropSession(s, "microvm terminated");
  try {
    await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
    console.log(`terminated microvm ${id}`);
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }
}

// Makes sure the session's MicroVM is RUNNING (resuming it if suspended) with an endpoint and a valid token.
// There's no RESUMING state: a resumed MicroVM goes SUSPENDED -> RUNNING.
async function ensureRunning(s, { timeoutMs = 120_000 } = {}) {
  if (local) return;
  const deadline = Date.now() + timeoutMs;
  let resumed = false;
  for (;;) {
    const mv = await getMicrovm(s.id);
    if (!mv || DEAD_STATES.has(mv.state)) {
      dropSession(s, "microvm terminated");
      throw notProvisioned(`MicroVM ${s.id} is gone`);
    }
    if (mv.state === "RUNNING" && mv.endpoint) {
      s.endpoint = mv.endpoint;
      break;
    }
    if (mv.state === "SUSPENDED" && !resumed) {
      await microvms.send(new ResumeMicrovmCommand({ microvmIdentifier: s.id }));
      resumed = true;
    }
    if (Date.now() > deadline) throw new Error(`MicroVM ${s.id} did not reach RUNNING (state ${mv.state})`);
    await sleep(750);
  }
  if (!s.token || s.tokenExpiresAt - Date.now() < 60_000) {
    const res = await microvms.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: s.id,
        allowedPorts: [{ port: GAME_PORT }],
        expirationInMinutes: TOKEN_MINUTES,
      }),
    );
    s.token = res.authToken?.["X-aws-proxy-auth"];
    s.tokenExpiresAt = Date.now() + TOKEN_MINUTES * 60_000;
  }
}

// Where and how to reach the game server inside the session's MicroVM.
function target(s, pathname, { ws = false } = {}) {
  if (local) {
    const url = new URL(pathname, LOCAL_GAME_URL);
    if (ws) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { url: url.toString(), headers: {} };
  }
  return {
    url: `${ws ? "wss" : "https"}://${s.endpoint}${pathname}`,
    headers: { "X-aws-proxy-auth": s.token, "X-aws-proxy-port": String(GAME_PORT) },
  };
}

// ---- WebSocket link to a MicroVM (one per session) ----

function sseToClients(s, msg, { droppable = false } = {}) {
  for (const c of s.clients) {
    if (droppable && c.res.writableNeedDrain) continue; // slow browser: skip this frame
    c.res.write(msg);
  }
}

async function openLink(s) {
  if (s.link) return s.link.ready;
  const ready = (async () => {
    await ensureRunning(s);
    const { url, headers } = target(s, "/ws", { ws: true });
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    link.ws = ws;
    ws.on("message", (data, isBinary) => onLinkMessage(s, data, isBinary));
    ws.on("close", (code) => onLinkClosed(s, ws, code));
    ws.on("error", (err) => console.error(`microvm ${s.id} websocket error: ${err.message}`));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    console.log(`microvm websocket open (${local ? LOCAL_GAME_URL : s.id})`);
    link.ping = setInterval(() => s.clients.size && ws.ping(), WS_PING_MS);
    syncSubscription(s);
  })();
  const link = { ws: null, ready };
  s.link = link;
  ready.catch((err) => {
    console.error(`microvm ${s.id} websocket failed: ${err.name}: ${err.message}`);
    if (s.link === link) s.link = null;
  });
  return ready;
}

function onLinkMessage(s, data, isBinary) {
  if (isBinary) {
    s.lastFrameSse = `event: frame\ndata: ${data.toString("base64")}\n\n`;
    return sseToClients(s, s.lastFrameSse, { droppable: true });
  }
  let msg;
  try {
    msg = JSON.parse(data.toString("utf8"));
  } catch {
    return;
  }
  const { t, ...body } = msg;
  if (t === "hello") s.hello = body;
  if (t === "music") s.musicState = body;
  if (t === "sound") return sseToClients(s, `event: sound\ndata: ${JSON.stringify(body.ev)}\n\n`);
  sseToClients(s, `event: ${t}\ndata: ${JSON.stringify(body)}\n\n`);
}

function onLinkClosed(s, ws, code) {
  if (s.link?.ws !== ws) return;
  clearInterval(s.link.ping);
  s.link = null;
  console.log(`microvm ${s.id} websocket closed (${code}), ${s.clients.size} streams open`);
  // Browsers reconnect on "end"; the next stream reopens the link (resuming the MicroVM if it was suspended).
  sseToClients(s, `event: end\ndata: ${JSON.stringify({ reason: "microvm connection closed" })}\n\n`);
  for (const c of s.clients) c.res.end();
}

function closeLink(s, reason) {
  if (!s.link) return;
  const ws = s.link.ws;
  clearInterval(s.link.ping);
  s.link = null;
  ws?.close(1000, reason);
}

// Frames and audio flow only while a browser is watching this session through this environment.
function syncSubscription(s) {
  if (s.link?.ws?.readyState === WebSocket.OPEN) s.link.ws.send(JSON.stringify({ t: "subscribe", on: s.clients.size > 0 }));
  clearTimeout(s.lingerTimer);
  if (s.clients.size === 0) s.lingerTimer = setTimeout(() => s.clients.size === 0 && closeLink(s, "idle"), WS_LINGER_MS);
}

// ---- Browser handlers ----

async function handleStream(req, res) {
  const s = getSession(sessionId(req));
  await openLink(s);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  if (s.hello) res.write(`event: hello\ndata: ${JSON.stringify(s.hello)}\n\n`);
  if (s.musicState) res.write(`event: music\ndata: ${JSON.stringify(s.musicState)}\n\n`);
  if (s.lastFrameSse) res.write(s.lastFrameSse);

  const c = { res, opened: Date.now() };
  c.keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  c.timer = setTimeout(() => res.end(`event: end\ndata: ${JSON.stringify({ reason: "max stream duration" })}\n\n`), STREAM_MAX_MS);
  s.clients.add(c);
  syncSubscription(s);
  console.log(`stream opened for ${s.id} (${s.clients.size} open)`);

  res.on("close", () => {
    clearInterval(c.keepalive);
    clearTimeout(c.timer);
    s.clients.delete(c);
    s.lastUsed = Date.now();
    syncSubscription(s);
    console.log(`stream closed for ${s.id} after ${((Date.now() - c.opened) / 1000).toFixed(1)}s (${s.clients.size} open)`);
  });
}

async function handleInput(req, res) {
  const s = getSession(sessionId(req));
  const { events } = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  await openLink(s);
  if (!s.link?.ws) throw notProvisioned(`MicroVM ${s.id} connection closed`);
  s.link.ws.send(JSON.stringify({ t: "input", events: Array.isArray(events) ? events : [] }));
  syncSubscription(s); // restarts the linger timer for input-only environments
  sendJson(res, 200, { ok: true });
}

// GET passthrough to the game server (sounds JSON, music MP3s), with the auth headers added.
async function handleDownload(req, pathname, res) {
  const s = getSession(sessionId(req));
  await ensureRunning(s);
  const { url, headers } = target(s, pathname);
  const up = await fetch(url, { headers });
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/octet-stream" });
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).pipe(res);
}

// ---- HTTP plumbing ----

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res) {
  const root = path.resolve(STATIC_DIR);
  const { pathname } = new URL(req.url, "http://localhost");
  const file = path.join(root, path.normalize(pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "NotFound" });
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer({ noDelay: true }, async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (req.method === "POST" && pathname === "/api/provision") return sendJson(res, 202, await provision());
    if (req.method === "GET" && pathname === "/api/status") return sendJson(res, 200, await status(sessionId(req)));
    if (req.method === "POST" && pathname === "/api/stream") return await handleStream(req, res);
    if (req.method === "POST" && pathname === "/api/input") return await handleInput(req, res);
    if (req.method === "POST" && pathname === "/api/terminate") {
      await terminate(sessionId(req));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && pathname === "/api/sounds") return await handleDownload(req, "/sounds", res);
    const music = pathname.match(/^\/api\/music\/([A-Za-z0-9_]{1,8})$/);
    if (req.method === "GET" && music) return await handleDownload(req, `/music/${music[1]}`, res);
    // Only what the diagram shows; this is public, so no ARNs (they contain the account ID).
    if (req.method === "GET" && pathname === "/config") {
      return sendJson(res, 200, local ? { mode: "local", target: LOCAL_GAME_URL } : { mode: "microvm", region });
    }
    if (req.method === "GET" && pathname === "/healthz") return sendJson(res, 200, { status: "ok" });
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 404, { error: "NotFound" });
  } catch (err) {
    const status = err.status || err.$metadata?.httpStatusCode || 502;
    console.error(`${req.method} ${pathname} -> ${status} ${err.name}: ${err.message}`);
    sendJson(res, status, { error: err.name });
  }
});

server.listen(Number(PORT), HOST, () => {
  console.log(`doom webui on :${PORT} -> ${local ? LOCAL_GAME_URL : `MicroVM image ${MICROVM_IMAGE_ARN}`}`);
});
