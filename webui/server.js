// Doom web UI server: serves the browser client from ./public, provisions the Doom MicroVM, and bridges the
// browser (POST + SSE) to the MicroVM (one WebSocket per execution environment).
//
// Browser API:
//   POST /api/provision     start the MicroVM (or return the one that's already running) -> status
//   GET  /api/status        {mode, state, microvmId, startedAt, expiresAt}; state NONE when there's no MicroVM
//   POST /api/stream        SSE: hello, music, frame (base64), sound, end - the same events the MicroVM sends
//   POST /api/input         {"events":[{"code":"KeyW","down":true}, ...]} -> forwarded over the WebSocket
//   GET  /api/sounds        sound samples JSON (proxied from the MicroVM)
//   GET  /api/music/:lump   MP3 (proxied from the MicroVM)
//   GET  /config            {mode, region} or {mode:"local", target} for the architecture diagram
//
// The MicroVM endpoint needs an auth token (X-aws-proxy-auth, from CreateMicrovmAuthToken) and the target port
// (X-aws-proxy-port: 8081). Both are added here; the browser never sees the token. The MicroVM id, endpoint and
// token live in memory. Lambda Web Functions can run several execution environments, so one that doesn't know
// the MicroVM (e.g. the provision request went elsewhere) finds it with ListMicrovms and mints its own token.
//
// Env:
//   MICROVM_IMAGE_ARN     MicroVM image to run (required unless LOCAL_GAME_URL is set)
//   MICROVM_RUN_ROLE_ARN  execution role for the MicroVM
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
const GAME_PORT = 8081;
const TOKEN_MINUTES = 60; // the maximum; longer than a MicroVM lives
const DEAD_STATES = new Set(["TERMINATED", "TERMINATING"]);
// Lambda Web Functions end a request at the 900 s timeout; end streams a bit earlier so the client reconnects.
const STREAM_MAX_MS = 840_000;
const KEEPALIVE_MS = 15_000;
// While a browser watches, ping the MicroVM so it doesn't count as idle (idleness = no inbound traffic).
const WS_PING_MS = 20_000;
// Keep an unused WebSocket this long after the last stream or input, then close it.
const WS_LINGER_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

const microvms = !local && new LambdaMicrovmsClient({ region });

// ---- The MicroVM ----

let vm = null; // { id, endpoint, token, tokenExpiresAt, startedAt }
let provisioning = null; // in-flight provision, so concurrent clicks start one MicroVM

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getMicrovm(id) {
  try {
    return await microvms.send(new GetMicrovmCommand({ microvmIdentifier: id }));
  } catch (err) {
    if (err.name === "ResourceNotFoundException") return null;
    throw err;
  }
}

// Finds our live MicroVM (this execution environment may not have provisioned it): the newest one from our
// image that isn't terminated.
async function findMicrovm() {
  const live = [];
  let nextToken;
  do {
    const page = await microvms.send(new ListMicrovmsCommand({ imageIdentifier: MICROVM_IMAGE_ARN, maxResults: 50, nextToken }));
    for (const item of page.items ?? []) if (!DEAD_STATES.has(item.state)) live.push(item);
    nextToken = page.nextToken;
  } while (nextToken);
  live.sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0));
  return live[0] ? getMicrovm(live[0].microvmId) : null;
}

// The current MicroVM as the browser should see it. Forgets one that has terminated.
async function status() {
  if (local) return { mode: "local", state: "RUNNING", microvmId: "local" };
  if (provisioning && !vm) return { mode: "microvm", state: "PENDING" };
  let mv = vm ? await getMicrovm(vm.id) : await findMicrovm();
  if (!mv || DEAD_STATES.has(mv.state)) {
    if (mv && vm?.id === mv.microvmId) closeLink("microvm terminated");
    vm = null;
    return { mode: "microvm", state: mv?.state ?? "NONE", microvmId: mv?.microvmId ?? null };
  }
  vm ??= { id: mv.microvmId };
  vm.startedAt = mv.startedAt;
  if (mv.endpoint) vm.endpoint = mv.endpoint;
  const startedAt = mv.startedAt ? new Date(mv.startedAt) : null;
  return {
    mode: "microvm",
    state: mv.state,
    microvmId: mv.microvmId,
    startedAt: startedAt?.toISOString() ?? null,
    expiresAt: startedAt ? new Date(startedAt.getTime() + MAX_LIFETIME_S * 1000).toISOString() : null,
  };
}

async function provision() {
  if (local) return status();
  const current = await status();
  if (current.state !== "NONE" && !DEAD_STATES.has(current.state)) return current;
  provisioning ??= (async () => {
    try {
      const res = await microvms.send(
        new RunMicrovmCommand({
          imageIdentifier: MICROVM_IMAGE_ARN,
          executionRoleArn: MICROVM_RUN_ROLE_ARN,
          maximumDurationInSeconds: MAX_LIFETIME_S,
          idlePolicy: IDLE_POLICY,
          runHookPayload: "{}",
        }),
      );
      vm = { id: res.microvmId };
      console.log(`provisioned microvm ${vm.id}`);
      await ensureRunning(); // endpoint + token, kept in memory
    } finally {
      provisioning = null;
    }
  })();
  provisioning.catch((err) => console.error(`provisioning failed: ${err.name}: ${err.message}`));
  return { mode: "microvm", state: "PENDING" };
}

// Makes sure the MicroVM is RUNNING (resuming it if suspended) with an endpoint and a valid token.
// There's no RESUMING state: a resumed MicroVM goes SUSPENDED -> RUNNING.
async function ensureRunning({ timeoutMs = 120_000 } = {}) {
  if (local) return;
  if (!vm) {
    const mv = await findMicrovm();
    if (!mv) throw Object.assign(new Error("no MicroVM provisioned"), { status: 409, name: "NotProvisioned" });
    vm = { id: mv.microvmId };
  }
  const deadline = Date.now() + timeoutMs;
  let resumed = false;
  for (;;) {
    const mv = await getMicrovm(vm.id);
    if (!mv || DEAD_STATES.has(mv.state)) {
      vm = null;
      throw Object.assign(new Error("the MicroVM is gone"), { status: 409, name: "NotProvisioned" });
    }
    if (mv.state === "RUNNING" && mv.endpoint) {
      vm.endpoint = mv.endpoint;
      vm.startedAt = mv.startedAt;
      break;
    }
    if (mv.state === "SUSPENDED" && !resumed) {
      await microvms.send(new ResumeMicrovmCommand({ microvmIdentifier: vm.id }));
      resumed = true;
    }
    if (Date.now() > deadline) throw new Error(`MicroVM ${vm.id} did not reach RUNNING (state ${mv.state})`);
    await sleep(750);
  }
  if (!vm.token || vm.tokenExpiresAt - Date.now() < 60_000) {
    const res = await microvms.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: vm.id,
        allowedPorts: [{ port: GAME_PORT }],
        expirationInMinutes: TOKEN_MINUTES,
      }),
    );
    vm.token = res.authToken?.["X-aws-proxy-auth"];
    vm.tokenExpiresAt = Date.now() + TOKEN_MINUTES * 60_000;
  }
}

// Where and how to reach the game server inside the MicroVM.
function target(pathname, { ws = false } = {}) {
  if (local) {
    const url = new URL(pathname, LOCAL_GAME_URL);
    if (ws) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { url: url.toString(), headers: {} };
  }
  return {
    url: `${ws ? "wss" : "https"}://${vm.endpoint}${pathname}`,
    headers: { "X-aws-proxy-auth": vm.token, "X-aws-proxy-port": String(GAME_PORT) },
  };
}

// ---- WebSocket link to the MicroVM (one per execution environment) ----

const clients = new Set(); // open browser SSE streams
let link = null; // { ws, ready: Promise }
let hello = null; // latest hello from the MicroVM, replayed to new browser streams
let musicState = null;
let lastFrameSse = null;
let lingerTimer = null;

function sseToClients(msg, { droppable = false } = {}) {
  for (const c of clients) {
    if (droppable && c.res.writableNeedDrain) continue; // slow browser: skip this frame
    c.res.write(msg);
  }
}

async function openLink() {
  if (link) return link.ready;
  const ready = (async () => {
    await ensureRunning();
    const { url, headers } = target("/ws", { ws: true });
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    link.ws = ws;
    ws.on("message", onLinkMessage);
    ws.on("close", (code) => onLinkClosed(ws, code));
    ws.on("error", (err) => console.error(`microvm websocket error: ${err.message}`));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    console.log(`microvm websocket open (${local ? LOCAL_GAME_URL : vm.id})`);
    link.ping = setInterval(() => clients.size && ws.ping(), WS_PING_MS);
    syncSubscription();
  })();
  link = { ws: null, ready };
  ready.catch((err) => {
    console.error(`microvm websocket failed: ${err.name}: ${err.message}`);
    if (link?.ready === ready) link = null;
  });
  return ready;
}

function onLinkMessage(data, isBinary) {
  if (isBinary) {
    lastFrameSse = `event: frame\ndata: ${data.toString("base64")}\n\n`;
    return sseToClients(lastFrameSse, { droppable: true });
  }
  let msg;
  try {
    msg = JSON.parse(data.toString("utf8"));
  } catch {
    return;
  }
  const { t, ...body } = msg;
  if (t === "hello") hello = body;
  if (t === "music") musicState = body;
  if (t === "sound") return sseToClients(`event: sound\ndata: ${JSON.stringify(body.ev)}\n\n`);
  sseToClients(`event: ${t}\ndata: ${JSON.stringify(body)}\n\n`);
}

function onLinkClosed(ws, code) {
  if (link?.ws !== ws) return;
  clearInterval(link.ping);
  link = null;
  console.log(`microvm websocket closed (${code}), ${clients.size} streams open`);
  // Browsers reconnect on "end"; the next stream reopens the link (resuming the MicroVM if it was suspended).
  sseToClients(`event: end\ndata: ${JSON.stringify({ reason: "microvm connection closed" })}\n\n`);
  for (const c of clients) c.res.end();
}

function closeLink(reason) {
  if (!link) return;
  const ws = link.ws;
  clearInterval(link.ping);
  link = null;
  ws?.close(1000, reason);
}

// Frames and audio flow only while a browser is watching through this environment.
function syncSubscription() {
  if (link?.ws?.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify({ t: "subscribe", on: clients.size > 0 }));
  clearTimeout(lingerTimer);
  if (clients.size === 0) lingerTimer = setTimeout(() => clients.size === 0 && closeLink("idle"), WS_LINGER_MS);
}

// ---- Browser handlers ----

async function handleStream(req, res) {
  await openLink();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  if (hello) res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  if (musicState) res.write(`event: music\ndata: ${JSON.stringify(musicState)}\n\n`);
  if (lastFrameSse) res.write(lastFrameSse);

  const c = { res, opened: Date.now() };
  c.keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  c.timer = setTimeout(() => res.end(`event: end\ndata: ${JSON.stringify({ reason: "max stream duration" })}\n\n`), STREAM_MAX_MS);
  clients.add(c);
  syncSubscription();
  console.log(`stream opened (${clients.size} open)`);

  res.on("close", () => {
    clearInterval(c.keepalive);
    clearTimeout(c.timer);
    clients.delete(c);
    syncSubscription();
    console.log(`stream closed after ${((Date.now() - c.opened) / 1000).toFixed(1)}s (${clients.size} open)`);
  });
}

async function handleInput(req, res) {
  const { events } = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  await openLink();
  link.ws.send(JSON.stringify({ t: "input", events: Array.isArray(events) ? events : [] }));
  syncSubscription(); // restarts the linger timer for input-only environments
  sendJson(res, 200, { ok: true });
}

// GET passthrough to the game server (sounds JSON, music MP3s), with the auth headers added.
async function handleDownload(pathname, res) {
  await ensureRunning();
  const { url, headers } = target(pathname);
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
    if (req.method === "GET" && pathname === "/api/status") return sendJson(res, 200, await status());
    if (req.method === "POST" && pathname === "/api/stream") return await handleStream(req, res);
    if (req.method === "POST" && pathname === "/api/input") return await handleInput(req, res);
    if (req.method === "GET" && pathname === "/api/sounds") return await handleDownload("/sounds", res);
    const music = pathname.match(/^\/api\/music\/([A-Za-z0-9_]{1,8})$/);
    if (req.method === "GET" && music) return await handleDownload(`/music/${music[1]}`, res);
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
