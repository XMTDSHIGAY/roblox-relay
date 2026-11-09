'use strict';

/**
 * Cloudflare Workers 适配层（完全不需要信用卡的免费承载）。
 *
 * 免费额度：每天 10 万次请求，单次 10ms CPU —— 本服务只是转发 + 校验，CPU 占用极低。
 * 密钥不写进代码，通过 wrangler secret / Dashboard 的 Secret 变量注入。
 *
 * 注意：Workers 的 env 只在 fetch 处理器作用域内可用，模块顶层不能引用，
 * 因此配置与 relay 实例都在首次请求时惰性初始化。
 */

import { createRelay, readConfig, log } from './core/relay-core.js';

const MAX_BODY = 64 * 1024;

/** 内存态计数（单 isolate 内有效，作为补充防线）。 */
const rateBuckets = new Map();
const seenHashes = new Map();
const lastReportAt = new Map();

function memAllow(key, count, windowMs) {
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

function memDedupe(key, ttlMs) {
  const now = Date.now();
  const prev = seenHashes.get(key);
  if (prev && now - prev < ttlMs) return false;
  seenHashes.set(key, now);
  return true;
}

function memThrottle(key, minIntervalMs, now) {
  const prev = lastReportAt.get(key) || 0;
  if (now - prev < minIntervalMs) return false;
  return true;
}

function memMark(key, now) {
  lastReportAt.set(key, now);
}

/**
 * 惰性初始化：env 在 Workers 中随请求注入，不能在模块顶层访问。
 */
let cached = null;

function getRelay(env) {
  if (cached) return cached;
  const config = readConfig(env);

  const allow = async (key, count, windowMs) => {
    // 若绑定了 Cloudflare Rate Limiting（env.RATE_LIMITER），优先走平台级限流，
    // 它跨 isolate 生效，比内存计数可靠得多；未绑定时回退到内存计数。
    const limiter = env.RATE_LIMITER;
    if (limiter && typeof limiter.limit === 'function') {
      const { success } = await limiter.limit({ key });
      if (!success) return false;
    }
    return memAllow(key, count, windowMs);
  };

  cached = createRelay({
    config,
    limiter: { allow },
    store: {
      dedupe: async (k, ttl) => memDedupe(k, ttl),
      throttle: async (k, min, now) => memThrottle(k, min, now),
      mark: async (k, now) => { memMark(k, now); },
    },
  });
  return cached;
}

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
  });
}

export default {
  async fetch(request, env) {
    try {
      const relay = getRelay(env);
      const url = new URL(request.url);
      let rawBody = '';
      let tooLarge = false;

      if (request.method === 'POST') {
        const text = await request.text();
        if (text.length > MAX_BODY) tooLarge = true;
        else rawBody = text;
      }

      if (tooLarge) return json(413, { ok: false, error: 'payload_too_large' });

      const out = await relay({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        ip: request.headers.get('cf-connecting-ip') || 'unknown',
        rawBody,
      });

      return json(out.status, out.body, out.headers);
    } catch (e) {
      // 统一错误出口：不回显堆栈、不回显环境变量
      log('error', { name: e && e.name });
      return json(500, { ok: false, error: 'internal_error' });
    }
  },
};
