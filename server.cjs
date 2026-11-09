'use strict';

/**
 * Node.js 适配层（用于 Render / 任意长驻 Node 主机）。
 *
 * 平台差异全部收敛在本文件：读取请求体、解析 IP、限流与状态存储用进程内存。
 * 核心逻辑在 core/relay-core.js，与平台无关。
 *
 * 内存态限流/去重的前提是单实例常驻进程；Render Free 会空闲休眠，
 * 唤醒后计数重置（对防刷而言可接受，冷启动窗口内仍受 IP 限流保护）。
 */

const http = require('node:http');

// 核心是 ES Module（与 Workers 端共用同一份），用动态 import 加载
// CJS 不支持顶层 await，因此整个启动流程包在 async IIFE 内
(async () => {
const { createRelay, readConfig, log } = await import('./core/relay-core.js');

const MAX_BODY = 64 * 1024;
const PORT = Number(process.env.PORT) || 10000;

const config = readConfig(process.env);

// ---------- 内存态限流器 ----------
const rateBuckets = new Map();
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

// ---------- 内存态去重 / 节流 ----------
const seenHashes = new Map();
const lastReportAt = new Map();

function dedupe(key, ttlMs) {
  const now = Date.now();
  const prev = seenHashes.get(key);
  if (prev && now - prev < ttlMs) return false;
  seenHashes.set(key, now);
  return true;
}

function throttle(key, minIntervalMs, now) {
  const prev = lastReportAt.get(key) || 0;
  if (now - prev < minIntervalMs) return false;
  return true;
}

function mark(key, now) {
  lastReportAt.set(key, now);
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

const relay = createRelay({
  config,
  limiter: { allow },
  store: { dedupe, throttle, mark },
});

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

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

http.createServer(async (req, res) => {
  let rawBody = '';
  let failed = false;

  try {
    rawBody = await readBody(req);
  } catch (_) {
    failed = true;
  }

  const url = new URL(req.url, 'http://localhost');
  const out = failed
    ? { status: 413, body: { ok: false, error: 'payload_too_large' } }
    : await relay({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      ip: clientIp(req),
      rawBody,
    });

  const payload = JSON.stringify(out.body);
  res.writeHead(out.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...(out.headers || {}),
  });
  res.end(payload);
}).listen(PORT, '0.0.0.0', () => {
  log('startup', {
    port: PORT,
    webhooks: config.webhooks.length,
    ghConfigured: Boolean(config.ghToken && config.ghOwner && config.ghRepo),
  });
});
})();
