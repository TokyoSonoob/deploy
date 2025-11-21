"use strict";

require("dotenv").config(); // โหลด .env อัตโนมัติ

const http = require("http");
const https = require("https");
const { URL } = require("url");

// =========================================
// ENV CONFIG
// =========================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = "1438730644288176229";

if (!DISCORD_TOKEN) {
  console.error("[ERR] ต้องตั้งค่า DISCORD_TOKEN ใน .env ก่อน");
  process.exit(1);
}

// อ่าน bots จาก env: bot1={"url","deployUrl"}
function parseBotEnv(envKey) {
  const raw = process.env[envKey];
  if (!raw) return null;

  // รูปแบบ {"url","deploy"}
  const match =
    raw.match(/^\s*\{\s*"?(https?:\/\/[^"]+)"?\s*,\s*"?(https?:\/\/[^"]+)"?\s*\}\s*$/);

  if (!match) {
    console.error(`[WARN] env ${envKey} ไม่ถูกต้อง →`, raw);
    return null;
  }

  return {
    id: envKey,
    name: envKey,
    url: match[1],
    deployUrl: match[2],
    status: "unknown",
    lastDeployAt: 0,
    lastCheckAt: 0
  };
}

// โหลด bots ทั้งหมด bot1, bot2, bot3, bot4, ...
const BOTS = [];
for (const key of Object.keys(process.env)) {
  if (/^bot\d+$/i.test(key)) {
    const bot = parseBotEnv(key);
    if (bot) BOTS.push(bot);
  }
}

if (BOTS.length === 0) {
  console.error("[ERR] ไม่พบบอทใน env เลย (เช่น bot1={...})");
  process.exit(1);
}

console.log("[INFO] Loaded bots:", BOTS.map(b => `${b.id}=${b.url}`).join(" | "));

// =========================================
// CONFIG
// =========================================

const CHECK_EVERY_MS = 60 * 1000;            // เช็คทุก 1 นาที
const RECHECK_AFTER_DEPLOY_MS = 10 * 60 * 1000; // 10 นาที

let checking = false;

const globalState = {
  statusMessageId: null
};

// =========================================
// HTTP Utils
// =========================================
function simpleRequest(rawUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch { return reject(new Error("Invalid URL")); }

    const lib = u.protocol === "http:" ? http : https;

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
        resolve(res.statusCode || 0);
      }
    );

    req.on("timeout", () => { req.destroy(); reject("timeout"); });
    req.on("error", reject);
    req.end();
  });
}

// =========================================
// Discord REST API (เบา RAM ไม่ใช้ discord.js)
// =========================================

function discordApi(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const req = https.request(
      {
        hostname: "discord.com",
        port: 443,
        path: `/api/v10${path}`,
        method,
        headers: {
          Authorization: `Bot ${DISCORD_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "BotDeployMonitor (SeaMuww)"
        }
      },
      res => {
        let raw = "";
        res.on("data", chunk => raw += chunk);
        res.on("end", () => {
          try { resolve(raw ? JSON.parse(raw) : null); }
          catch { resolve(null); }
        });
      }
    );

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sendMessage(embed) {
  const res = await discordApi(
    `/channels/${DISCORD_CHANNEL_ID}/messages`,
    "POST",
    { embeds: [embed] }
  );
  return res?.id || null;
}

async function editMessage(id, embed) {
  await discordApi(
    `/channels/${DISCORD_CHANNEL_ID}/messages/${id}`,
    "PATCH",
    { embeds: [embed] }
  );
}

// =========================================
// Embed
// =========================================
function fmt(t) {
  return t.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
}

function botStatus(bot) {
  let icon = "⚪";
  if (bot.status === "up") icon = "🟢";
  else if (bot.status === "deploying") icon = "⏳";
  else if (bot.status === "adminClosed") icon = "⚫";
  else if (bot.status === "down") icon = "🔴";

  return (
    `${icon} **${bot.id}**\n` +
    `• URL: \`${bot.url}\`\n` +
    `• เช็คล่าสุด: ${bot.lastCheckAt ? fmt(new Date(bot.lastCheckAt)) : "-"}\n` +
    `• Deploy ล่าสุด: ${bot.lastDeployAt ? fmt(new Date(bot.lastDeployAt)) : "-"}`
  );
}

function buildEmbed() {
  return {
    title: "📊 สถานะบอททั้งหมด",
    description: "ตรวจทุก 1 นาที — ถ้าดับจะ deploy ใหม่ 1 ครั้ง",
    color: 0x5865f2,
    fields: BOTS.map(bot => ({
      name: bot.id,
      value: botStatus(bot)
    })),
    timestamp: new Date().toISOString()
  };
}

async function updateStatus() {
  const embed = buildEmbed();

  if (!globalState.statusMessageId) {
    globalState.statusMessageId = await sendMessage(embed);
  } else {
    try {
      await editMessage(globalState.statusMessageId, embed);
    } catch {
      globalState.statusMessageId = await sendMessage(embed);
    }
  }
}

// =========================================
// Deploy logic
// =========================================

async function deploy(bot) {
  try {
    console.log(`[INFO] DEPLOY ${bot.id} → ${bot.deployUrl}`);
    await simpleRequest(bot.deployUrl);
  } catch (e) {
    console.error(`[ERR] Deploy ${bot.id} failed:`, e);
  }
}

// =========================================
// Bot Checker
// =========================================

async function checkBot(bot, now) {
  bot.lastCheckAt = now;

  let isUp = false;
  try {
    const code = await simpleRequest(bot.url);
    if (code >= 200 && code < 400) isUp = true;
  } catch { isUp = false; }

  let newStatus = bot.status;

  if (isUp) {
    newStatus = "up";
    bot.lastDeployAt = 0;
  } else {
    if (bot.status === "unknown" || bot.status === "up") {
      bot.lastDeployAt = now;
      await deploy(bot);
      newStatus = "deploying";
    } else if (bot.status === "deploying") {
      if (now - bot.lastDeployAt >= RECHECK_AFTER_DEPLOY_MS) {
        newStatus = "adminClosed";
      }
    } else if (bot.status === "adminClosed") {
      newStatus = "adminClosed";
    } else {
      newStatus = "down";
    }
  }

  bot.status = newStatus;
}

// =========================================
// Loop
// =========================================

async function checkAll() {
  if (checking) return;
  checking = true;

  const now = Date.now();

  for (const bot of BOTS) {
    try {
      await checkBot(bot, now);
    } catch (e) {
      console.error(`[ERR] checkBot(${bot.id}):`, e.message);
    }
  }

  await updateStatus();
  checking = false;
}

function startLoop() {
  checkAll();
  setInterval(checkAll, CHECK_EVERY_MS);
}

// =========================================
// Tiny HTTP Server (ให้ Render / Host รู้ว่าบอทยังรัน)
// =========================================

http.createServer((req, res) => {
  res.writeHead(200, {"Content-Type": "text/plain"});
  res.end("botdeploy alive");
}).listen(3000, () => {
  console.log("[INFO] botdeploy server started on port 3000");
  startLoop();
});

// =========================================
// Avoid crash
// =========================================

process.on("unhandledRejection", err => console.error("[UNHANDLED]", err));
process.on("uncaughtException", err => console.error("[CRASH]", err));
