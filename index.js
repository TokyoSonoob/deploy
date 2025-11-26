"use strict";

require("dotenv").config();

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_STATUS_CHANNEL_ID = "1438730644288176229";
const DISCORD_LOG_CHANNEL_ID = "1413527503636529303";
const PORT = Number(process.env.PORT || 3000);

if (!DISCORD_TOKEN) process.exit(1);

const CHECK_EVERY_MS = 60000;
const RECHECK_AFTER_DEPLOY_MS = 600000;

function parseBotEnv(envKey) {
  const raw = process.env[envKey];
  if (!raw) return null;
  const m = raw.match(/^\s*\{\s*"?(https?:\/\/[^"]+)"?\s*,\s*"?(https?:\/\/[^"]+)"?\s*\}\s*$/);
  if (!m) return null;
  return {
    id: envKey,
    name: envKey,
    url: m[1],
    deployUrl: m[2],
    status: "unknown",
    lastDeployAt: 0,
    lastCheckAt: 0,
    lastPingMs: 0,
    failCount: 0
  };
}

const BOTS = [];
for (const key of Object.keys(process.env)) {
  if (/^bot\d+$/i.test(key)) {
    const b = parseBotEnv(key);
    if (b) BOTS.push(b);
  }
}

BOTS.sort((a, b) => {
  const na = parseInt(a.id.slice(3), 10) || 0;
  const nb = parseInt(b.id.slice(3), 10) || 0;
  return na - nb;
});

if (BOTS.length === 0) process.exit(1);

let checking = false;

const STATUS_FILE = "./.statusMessageId";
const globalState = { statusMessageId: null, lastLoopMs: 0 };

if (fs.existsSync(STATUS_FILE)) {
  try {
    const id = fs.readFileSync(STATUS_FILE, "utf8").trim();
    if (id) globalState.statusMessageId = id;
  } catch {}
}

function simpleRequest(rawUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch { return reject("bad-url"); }
    const lib = u.protocol === "http:" ? http : https;
    const started = Date.now();
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "GET",
        timeout: 8000
      },
      res => {
        res.resume();
        resolve({ statusCode: res.statusCode || 0, duration: Date.now() - started });
      }
    );
    req.on("timeout", () => { req.destroy(); reject("timeout"); });
    req.on("error", reject);
    req.end();
  });
}

function discordApi(path, method, body) {
  return new Promise((resolve, reject) => {
    let data = null;
    if (body) {
      try { data = JSON.stringify(body); } catch {}
    }
    const req = https.request(
      {
        hostname: "discord.com",
        port: 443,
        path: `/api/v10${path}`,
        method,
        headers: {
          Authorization: `Bot ${DISCORD_TOKEN}`,
          "Content-Type": "application/json"
        }
      },
      res => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          if ((res.statusCode || 0) >= 400) return reject(new Error("http " + res.statusCode));
          if (!raw) return resolve(null);
          try { resolve(JSON.parse(raw)); } catch { resolve(null); }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sendStatusMessage(embed) {
  const r = await discordApi(`/channels/${DISCORD_STATUS_CHANNEL_ID}/messages`, "POST", { embeds: [embed] });
  return r && r.id ? r.id : null;
}

async function editStatusMessage(id, embed) {
  await discordApi(`/channels/${DISCORD_STATUS_CHANNEL_ID}/messages/${id}`, "PATCH", { embeds: [embed] });
}

async function sendLog(content) {
  try {
    await discordApi(`/channels/${DISCORD_LOG_CHANNEL_ID}/messages`, "POST", { content });
  } catch {}
}

function fmt(t) {
  return t.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
}

function fmtUptime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function botStatus(bot) {
  let label = "UNKNOWN";
  if (bot.status === "up") label = "ONLINE";
  else if (bot.status === "deploying") label = "DEPLOYING";
  else if (bot.status === "adminClosed") label = "ADMIN-CLOSED";
  else if (bot.status === "down") label = "OFFLINE";
  const ping = bot.lastPingMs ? `\n• Ping: ${bot.lastPingMs} ms` : "";
  return (
    `Status: **${label}**\n` +
    `• URL: \`${bot.url}\`\n` +
    `• Last Check: ${bot.lastCheckAt ? fmt(new Date(bot.lastCheckAt)) : "-"}\n` +
    `• Last Deploy: ${bot.lastDeployAt ? fmt(new Date(bot.lastDeployAt)) : "-"}${ping}`
  );
}

function buildEmbed() {
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const up = process.uptime();
  const monitorField = {
    name: "Monitor",
    value:
      `• RAM: ${rssMb}MB (heap ${heapMb}MB)\n` +
      `• Uptime: ${fmtUptime(up)}\n` +
      `• Loop: ${globalState.lastLoopMs}ms\n` +
      `• Interval: ${(CHECK_EVERY_MS / 1000).toFixed(0)}s`
  };
  const botFields = BOTS.map(b => ({
    name: b.id.toUpperCase(),
    value: botStatus(b)
  }));
  return {
    title: "Bot Monitor",
    color: 0x1e1e2f,
    fields: [monitorField].concat(botFields),
    timestamp: new Date().toISOString()
  };
}

async function updateStatus() {
  const embed = buildEmbed();
  if (!globalState.statusMessageId) {
    const id = await sendStatusMessage(embed);
    if (id) {
      globalState.statusMessageId = id;
      try { fs.writeFileSync(STATUS_FILE, id); } catch {}
    }
    return;
  }
  try {
    await editStatusMessage(globalState.statusMessageId, embed);
  } catch {
    const id = await sendStatusMessage(embed);
    if (id) {
      globalState.statusMessageId = id;
      try { fs.writeFileSync(STATUS_FILE, id); } catch {}
    }
  }
}

async function deploy(bot, prevStatus) {
  try {
    await simpleRequest(bot.deployUrl);
    const ts = fmt(new Date());
    await sendLog(`[DEPLOY] ${bot.id} | url=${bot.url} | prev=${prevStatus} | time=${ts}`);
  } catch {}
}

async function checkBot(bot, now) {
  bot.lastCheckAt = now;
  let up = false;
  try {
    const r = await simpleRequest(bot.url);
    if (r.statusCode >= 200 && r.statusCode < 400) up = true;
    bot.lastPingMs = r.duration || 0;
  } catch {
    up = false;
    bot.lastPingMs = 0;
  }
  const prev = bot.status;
  if (up) {
    bot.status = "up";
    bot.failCount = 0;
    bot.lastDeployAt = 0;
    return;
  }
  if (bot.status === "deploying") {
    if (now - bot.lastDeployAt >= RECHECK_AFTER_DEPLOY_MS) bot.status = "adminClosed";
    return;
  }
  if (bot.status === "adminClosed") return;
  bot.failCount = (bot.failCount || 0) + 1;
  if (bot.failCount < 2) {
    bot.status = "down";
    return;
  }
  bot.lastDeployAt = now;
  bot.failCount = 0;
  bot.status = "deploying";
  await deploy(bot, prev);
}

async function checkAll() {
  if (checking) return;
  checking = true;
  const t0 = Date.now();
  const now = Date.now();
  for (const bot of BOTS) {
    try { await checkBot(bot, now); } catch {}
  }
  await updateStatus();
  globalState.lastLoopMs = Date.now() - t0;
  if (global.gc) {
    try { global.gc(); } catch {}
  }
  checking = false;
}

function startLoop() {
  checkAll();
  setInterval(checkAll, CHECK_EVERY_MS);
}

function getJsonStatus() {
  const mem = process.memoryUsage();
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    monitor: {
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(1)),
      heapMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
      uptimeSec: Math.floor(process.uptime()),
      lastLoopMs: globalState.lastLoopMs,
      intervalSec: CHECK_EVERY_MS / 1000
    },
    bots: BOTS.map(b => ({
      id: b.id,
      url: b.url,
      deployUrl: b.deployUrl,
      status: b.status,
      lastCheckAt: b.lastCheckAt || null,
      lastDeployAt: b.lastDeployAt || null,
      lastPingMs: b.lastPingMs || 0,
      failCount: b.failCount || 0
    }))
  };
}

const server = http.createServer((req, res) => {
  const u = req.url || "/";
  if (u === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("botdeploy OK");
  } else if (u === "/status") {
    const j = JSON.stringify(getJsonStatus());
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(j);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, () => startLoop());

process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});
