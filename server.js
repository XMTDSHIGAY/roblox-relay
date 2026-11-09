'use strict';

/**
 * Roblox 上报中继服务（零第三方依赖）
 *
 * 职责：只做「收数据 -> 鉴权 -> 校验/限流/去重 -> 转发」，不实现任何封禁判定。
 * 密钥全部来自环境变量，代码中零硬编码；日志不输出请求体、令牌与 webhook 地址。
 *
 * 端点：
 *   GET  /health            健康检查
 *   POST /v1/webhook        Discord 播报转发（需 Bearer 鉴权）
 *   POST /v1/game-report    GitHub game.json 更新（需 Bearer 鉴权）
 */

const http = require('node:http');
const crypto = require('node:crypto');

// ---------- 配置：一律从环境变量读取 ----------
const PORT = Number(process.env.PORT) || 10000;
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const DISCORD_WEBHOOKS = (process.env.DISCORD_WEBHOOKS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_OWNER = process.env.GITHUB_OWNER || '';
const GH_REPO = process.env.GITHUB_REPO || '';
const GH_FILE = process.env.GITHUB_FILE || 'game.json';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';

// ---------- 防轰炸阈值 ----------
const MAX_BODY = 64 * 1024;              // 请求体上限
const MAX_EMBEDS = 10;                   // 单次播报 embed 数上限（对齐客户端缓冲）
const MAX_FIELDS = 25;                   // Discord embed fields 上限
const MAX_TITLE = 256;
const MAX_DESC = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FOOTER = 2048;
const MAX_AUTHOR = 256;
const MAX_URL = 2048;
const MAX_USERNAME = 80;
const MAX_RECORD_STR = 512;
const MAX_REPORT_TEXT = 100 * 1024;      // game.json 最大体积，防无限膨胀

const WEBHOOK_LIMIT = { count: 20, windowMs: 60_000 };  // 播报：20 次/分钟
const REPORT_LIMIT = { count: 10, windowMs: 60_000 };   // 上报：10 次/分钟
const IP_LIMIT = { count: 90, windowMs: 60_000 };       // 全局：90 次/分钟/IP
const WEBHOOK_DEDUPE_MS = 60_000;        // 相同内容 60 秒内只发一次
const REPORT_MIN_INTERVAL_MS = 60_000;   // 同一 PlaceId 最快 60 秒写一次 GitHub

const rateBuckets = new Map();   // 限流滑动窗口
const seenHashes = new Map();    // 播报去重
const lastReportAt = new Map();  // 上报节流

/** 结构化日志：只记录状态码、耗时与计数，绝不记录请求体、令牌或 URL。 */
function log(event, fields) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
}

function send(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

/** 常量时间比较，避免通过响应耗时枚举令牌。 */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function allow(key, count, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= count) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

function dedupe(key, ttlMs) {
  const now = Date.now();
  const prev = seenHashes.get(key);
  if (prev && now - prev < ttlMs) return false;
  seenHashes.set(key, now);
  return true;
}

/** 定期清理内存表，避免长期运行内存增长。 */
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateBuckets) {
    const kept = arr.filter((t) => now - t < 120_000);
    if (kept.length) rateBuckets.set(k, kept); else rateBuckets.delete(k);
  }
  for (const [k, t] of seenHashes) if (now - t > 120_000) seenHashes.delete(k);
  for (const [k, t] of lastReportAt) if (now - t > 600_000) lastReportAt.delete(k);
}, 60_000).unref();

/** 读取并限制请求体大小；超限时继续消费完请求体再返回错误，保证能正常回 413。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('payload_too_large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function clip(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

/** 只放行 https 外链，防止把任意协议/内网地址塞进 Discord 拉取。 */
function safeUrl(v) {
  if (typeof v !== 'string' || v === '' || v.length > MAX_URL) return undefined;
  if (!/^https:\/\//i.test(v)) return undefined;
  return v;
}

/**
 * embed 白名单清洗：只保留 Discord 允许展示的字段，其余（content、attachments、
 * allowed_mentions 等）一律丢弃，杜绝 @everyone 轰炸与任意内容注入。
 */
function cleanEmbed(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  if (typeof input.title === 'string') out.title = clip(input.title, MAX_TITLE);
  if (typeof input.description === 'string') out.description = clip(input.description, MAX_DESC);
  if (Number.isInteger(input.color)) out.color = input.color;
  if (typeof input.timestamp === 'string') out.timestamp = clip(input.timestamp, 64);
  const u = safeUrl(input.url);
  if (u) out.url = u;

  if (input.author && typeof input.author === 'object' && !Array.isArray(input.author)) {
    const a = {};
    if (typeof input.author.name === 'string') a.name = clip(input.author.name, MAX_AUTHOR);
    const ai = safeUrl(input.author.icon_url);
    if (ai) a.icon_url = ai;
    const au = safeUrl(input.author.url);
    if (au) a.url = au;
    if (Object.keys(a).length) out.author = a;
  }
  if (input.footer && typeof input.footer === 'object' && !Array.isArray(input.footer)) {
    const f = {};
    if (typeof input.footer.text === 'string') f.text = clip(input.footer.text, MAX_FOOTER);
    const fi = safeUrl(input.footer.icon_url);
    if (fi) f.icon_url = fi;
    if (Object.keys(f).length) out.footer = f;
  }
  const img = safeUrl(input.image && input.image.url);
  if (img) out.image = { url: img };
  const th = safeUrl(input.thumbnail && input.thumbnail.url);
  if (th) out.thumbnail = { url: th };

  if (Array.isArray(input.fields)) {
    const fields = [];
    for (const f of input.fields.slice(0, MAX_FIELDS)) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
      const item = {};
      if (typeof f.name === 'string') item.name = clip(f.name, MAX_FIELD_NAME);
      if (typeof f.value === 'string') item.value = clip(f.value, MAX_FIELD_VALUE);
      if (typeof f.inline === 'boolean') item.inline = f.inline;
      if (item.name && item.value) fields.push(item);
    }
    if (fields.length) out.fields = fields;
  }
  return Object.keys(out).length ? out : null;
}

function cleanWebhookPayload(payload) {
  const embeds = Array.isArray(payload.embeds)
    ? payload.embeds.slice(0, MAX_EMBEDS).map(cleanEmbed).filter(Boolean)
    : [];
  return {
    username: clip(payload.username, MAX_USERNAME) || 'ROBLOX LUAU',
    embeds,
    allowed_mentions: { parse: [] }, // 强制关闭所有提及
  };
}

/** 并发转发到多个 Discord webhook，任一失败不影响其它。 */
async function forwardDiscord(payload) {
  if (!DISCORD_WEBHOOKS.length) return { sent: 0, failed: 0 };
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    DISCORD_WEBHOOKS.map((url) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      })
    )
  );
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) sent++; else failed++;
  }
  return { sent, failed };
}

function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'roblox-relay',
    'Content-Type': 'application/json',
  };
}

/** 上报记录字段白名单 + 长度限制，PlaceId 必须是正整数。 */
function cleanRecord(payload) {
  const placeId = Number(payload.PlaceId);
  if (!Number.isInteger(placeId) || placeId <= 0) return null;
  const players = Number(payload.PlayerCount);
  return {
    PlaceId: placeId,
    GameName: clip(payload.GameName, 200),
    PlayerCount: Number.isInteger(players) && players >= 0 && players <= 100000 ? players : 0,
    GameIcon: clip(payload.GameIcon, MAX_RECORD_STR),
    GameLink: clip(payload.GameLink, MAX_RECORD_STR),
    ServerName: clip(payload.ServerName, 200),
    ServerIcon: clip(payload.ServerIcon, MAX_RECORD_STR),
  };
}

/**
 * 把一条记录 upsert 进 GitHub 仓库的单个文件（沿用原脚本的 "|" 分隔格式）：
 * 1) 读取文件拿 sha 与旧内容；2) 剔除同 PlaceId 旧记录；3) 追加新记录；4) PUT 写回。
 * 文件不存在时 sha 省略，GitHub 会自动创建。
 */
async function githubUpsert(record) {
  const base = 'https://api.github.com/repos/'
    + encodeURIComponent(GH_OWNER) + '/' + encodeURIComponent(GH_REPO)
    + '/contents/' + encodeURIComponent(GH_FILE);

  const getRes = await fetch(base + '?ref=' + encodeURIComponent(GH_BRANCH), {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(10_000),
  });

  let sha = null;
  let oldText = '';
  if (getRes.status === 404) {
    sha = null;
  } else if (!getRes.ok) {
    return { ok: false, status: getRes.status };
  } else {
    const data = await getRes.json();
    sha = data.sha || null;
    oldText = Buffer.from(String(data.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  }

  const placeId = String(record.PlaceId);
  const kept = [];
  for (const seg of oldText.split('|')) {
    if (!seg.trim()) continue;
    try {
      const d = JSON.parse(seg);
      if (String(d.PlaceId ?? '') !== placeId) kept.push(seg);
    } catch (_) {
      // 解析失败的脏数据段直接丢弃，避免污染整个文件
    }
  }
  kept.push(JSON.stringify(record));
  const newText = kept.join('|').slice(0, MAX_REPORT_TEXT);

  const body = {
    message: 'Upsert ' + placeId + ' players=' + record.PlayerCount,
    content: Buffer.from(newText, 'utf8').toString('base64'),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(base, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: putRes.ok, status: putRes.status };
}

async function handle(req, res) {
  const started = Date.now();
  const reqId = crypto.randomUUID().slice(0, 8);
  let path = '';
  try {
    const url = new URL(req.url, 'http://localhost');
    path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
    if (!allow('ip:' + ip, IP_LIMIT.count, IP_LIMIT.windowMs)) {
      send(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' });
      return;
    }

    // 令牌未配置时拒绝一切请求，避免空令牌被比对通过
    if (!RELAY_TOKEN) {
      send(res, 503, { ok: false, error: 'server_not_configured' });
      return;
    }
    const auth = String(req.headers['authorization'] || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqual(token, RELAY_TOKEN)) {
      send(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (_) {
      send(res, 413, { ok: false, error: 'payload_too_large' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      send(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      send(res, 400, { ok: false, error: 'invalid_payload' });
      return;
    }

    if (path === '/v1/webhook') {
      if (!DISCORD_WEBHOOKS.length) {
        send(res, 503, { ok: false, error: 'server_not_configured' });
        return;
      }
      if (!allow('webhook:' + ip, WEBHOOK_LIMIT.count, WEBHOOK_LIMIT.windowMs)) {
        send(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' });
        return;
      }
      const clean = cleanWebhookPayload(payload);
      if (!clean.embeds.length) {
        send(res, 400, { ok: false, error: 'empty_embeds' });
        return;
      }
      const hash = crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex');
      if (!dedupe('webhook:' + hash, WEBHOOK_DEDUPE_MS)) {
        send(res, 200, { ok: true, deduped: true });
        return;
      }
      const result = await forwardDiscord(clean);
      log('webhook', { reqId, ip, embeds: clean.embeds.length, ...result, ms: Date.now() - started });
      send(res, result.sent ? 200 : 502, { ok: result.sent > 0, ...result });
      return;
    }

    if (path === '/v1/game-report') {
      if (!GH_TOKEN || !GH_OWNER || !GH_REPO) {
        send(res, 503, { ok: false, error: 'server_not_configured' });
        return;
      }
      if (!allow('report:' + ip, REPORT_LIMIT.count, REPORT_LIMIT.windowMs)) {
        send(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' });
        return;
      }
      const record = cleanRecord(payload);
      if (!record) {
        send(res, 400, { ok: false, error: 'invalid_record' });
        return;
      }
      const key = String(record.PlaceId);
      const now = Date.now();
      if (now - (lastReportAt.get(key) || 0) < REPORT_MIN_INTERVAL_MS) {
        send(res, 429, { ok: false, error: 'report_throttled' }, { 'Retry-After': '60' });
        return;
      }
      const result = await githubUpsert(record);
      if (result.ok) lastReportAt.set(key, now);
      log('game_report', {
        reqId, ip, placeId: key, status: result.status, ok: result.ok, ms: Date.now() - started,
      });
      send(res, result.ok ? 200 : 502, { ok: result.ok, status: result.status });
      return;
    }

    send(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    // 统一错误出口：不回显堆栈、不回显环境变量
    log('error', { reqId, path, name: e && e.name, ms: Date.now() - started });
    if (!res.headersSent) send(res, 500, { ok: false, error: 'internal_error' });
  }
}

http.createServer((req, res) => { handle(req, res); }).listen(PORT, '0.0.0.0', () => {
  log('startup', {
    port: PORT,
    webhooks: DISCORD_WEBHOOKS.length,
    ghConfigured: Boolean(GH_TOKEN && GH_OWNER && GH_REPO),
  });
});
