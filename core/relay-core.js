'use strict';

/**
 * 与运行平台无关的核心中继逻辑。
 *
 * 平台无关点：只用标准 fetch / Web Crypto / TextEncoder，
 * 因此同一份核心可跑在 Node.js(Render) 与 Cloudflare Workers 上。
 *
 * 依赖注入的三个可替换组件：
 *   limiter.allow(key, count, windowMs)   -> boolean  限流判定
 *   store.dedupe(key, ttlMs)              -> boolean  去重（true=首次，放行）
 *   store.throttle(key, minIntervalMs)    -> boolean  节流（true=允许写入）
 */

const MAX_BODY = 64 * 1024;
const MAX_EMBEDS = 10;
const MAX_FIELDS = 25;
const MAX_TITLE = 256;
const MAX_DESC = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FOOTER = 2048;
const MAX_AUTHOR = 256;
const MAX_URL = 2048;
const MAX_USERNAME = 80;
const MAX_RECORD_STR = 512;
const MAX_REPORT_TEXT = 100 * 1024;

const WEBHOOK_LIMIT = { count: 20, windowMs: 60_000 };
const REPORT_LIMIT = { count: 10, windowMs: 60_000 };
const IP_LIMIT = { count: 90, windowMs: 60_000 };
const WEBHOOK_DEDUPE_MS = 60_000;
const REPORT_MIN_INTERVAL_MS = 60_000;

/** 结构化日志：只记录状态码、耗时与计数，绝不记录请求体、令牌或 webhook 地址。 */
export function log(event, fields) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields });
  if (typeof console !== 'undefined') console.log(line);
  else if (typeof write === 'function') write(line + '\n');
}

/** 跨平台 base64 编码（Node 与 Workers 均可用）。 */
export function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bytes).toString('base64');
}

/** 跨平台 base64 解码。 */
export function base64Decode(b64) {
  const clean = String(b64).replace(/\s/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(clean, 'base64').toString('utf8');
}

/**
 * 常量时间令牌比较。
 * 用 SHA-256 摘要比较，规避响应耗时枚举令牌；同时兼容没有 timingSafeEqual 的环境。
 */
export async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const ba = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
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
export function cleanEmbed(input) {
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

export function cleanWebhookPayload(payload) {
  const embeds = Array.isArray(payload.embeds)
    ? payload.embeds.slice(0, MAX_EMBEDS).map(cleanEmbed).filter(Boolean)
    : [];
  return {
    username: clip(payload.username, MAX_USERNAME) || 'ROBLOX LUAU',
    embeds,
    allowed_mentions: { parse: [] },
  };
}

/** 上报记录字段白名单 + 长度限制，PlaceId 必须是正整数。 */
export function cleanRecord(payload) {
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

/** GitHub 请求头 */
export function ghHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'roblox-relay',
    'Content-Type': 'application/json',
  };
}

/** 并发转发到多个 Discord webhook，任一失败不影响其它。 */
export async function forwardDiscord(webhooks, payload) {
  if (!webhooks.length) return { sent: 0, failed: 0 };
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    webhooks.map((url) =>
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

/**
 * 把一条记录 upsert 进 GitHub 仓库的单个文件（沿用原脚本的 "|" 分隔格式）：
 * 1) 读取文件拿 sha 与旧内容；2) 剔除同 PlaceId 旧记录；3) 追加新记录；4) PUT 写回。
 */
export async function githubUpsert(cfg, record) {
  const base = 'https://api.github.com/repos/'
    + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo)
    + '/contents/' + encodeURIComponent(cfg.file);

  const getRes = await fetch(base + '?ref=' + encodeURIComponent(cfg.branch), {
    headers: ghHeaders(cfg.token),
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
    oldText = base64Decode(String(data.content || '').replace(/\s/g, ''));
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
    content: base64Encode(newText),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(base, {
    method: 'PUT',
    headers: ghHeaders(cfg.token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: putRes.ok, status: putRes.status };
}

/**
 * 创建中继实例。
 *
 * @param {object} options
 * @param {object} options.config   从环境变量解析出的配置
 * @param {object} options.limiter  限流器：allow(key, count, windowMs) -> boolean|Promise<boolean>
 * @param {object} options.store    状态存储：dedupe(key, ttlMs) / throttle(key, minMs) -> boolean|Promise<boolean>
 */
export function createRelay({ config, limiter, store }) {
  /**
   * 处理一次请求。
   * @param {object} req { method, path, headers(小写键), ip, rawBody }
   * @returns {Promise<{status:number, body:object, headers?:object}>}
   */
  return async function handle(req) {
    const started = Date.now();
    const reqId = Math.random().toString(16).slice(2, 10);
    const path = req.path;

    try {
      if (req.method === 'GET' && path === '/health') {
        return { status: 200, body: { ok: true } };
      }
      if (req.method !== 'POST') {
        return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
      }

      const ip = req.ip || 'unknown';
      if (!(await limiter.allow('ip:' + ip, IP_LIMIT.count, IP_LIMIT.windowMs))) {
        return { status: 429, body: { ok: false, error: 'rate_limited' }, headers: { 'Retry-After': '60' } };
      }

      // 令牌未配置时拒绝一切请求，避免空令牌被比对通过
      if (!config.relayToken) {
        return { status: 503, body: { ok: false, error: 'server_not_configured' } };
      }
      const auth = String(req.headers['authorization'] || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!(await timingSafeEqual(token, config.relayToken))) {
        return { status: 401, body: { ok: false, error: 'unauthorized' } };
      }

      const raw = req.rawBody == null ? '' : req.rawBody;
      if (typeof raw === 'string' && raw.length > MAX_BODY) {
        return { status: 413, body: { ok: false, error: 'payload_too_large' } };
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        return { status: 400, body: { ok: false, error: 'invalid_json' } };
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { status: 400, body: { ok: false, error: 'invalid_payload' } };
      }

      if (path === '/v1/webhook') {
        if (!config.webhooks.length) {
          return { status: 503, body: { ok: false, error: 'server_not_configured' } };
        }
        if (!(await limiter.allow('webhook:' + ip, WEBHOOK_LIMIT.count, WEBHOOK_LIMIT.windowMs))) {
          return { status: 429, body: { ok: false, error: 'rate_limited' }, headers: { 'Retry-After': '60' } };
        }
        const clean = cleanWebhookPayload(payload);
        if (!clean.embeds.length) {
          return { status: 400, body: { ok: false, error: 'empty_embeds' } };
        }
        const hash = await sha256Hex(JSON.stringify(clean));
        if (!(await store.dedupe('webhook:' + hash, WEBHOOK_DEDUPE_MS))) {
          return { status: 200, body: { ok: true, deduped: true } };
        }
        const result = await forwardDiscord(config.webhooks, clean);
        log('webhook', { reqId, ip, embeds: clean.embeds.length, ...result, ms: Date.now() - started });
        return { status: result.sent ? 200 : 502, body: { ok: result.sent > 0, ...result } };
      }

      if (path === '/v1/game-report') {
        if (!config.ghToken || !config.ghOwner || !config.ghRepo) {
          return { status: 503, body: { ok: false, error: 'server_not_configured' } };
        }
        if (!(await limiter.allow('report:' + ip, REPORT_LIMIT.count, REPORT_LIMIT.windowMs))) {
          return { status: 429, body: { ok: false, error: 'rate_limited' }, headers: { 'Retry-After': '60' } };
        }
        const record = cleanRecord(payload);
        if (!record) {
          return { status: 400, body: { ok: false, error: 'invalid_record' } };
        }
        const key = String(record.PlaceId);
        const now = Date.now();
        if (!(await store.throttle(key, REPORT_MIN_INTERVAL_MS, now))) {
          return { status: 429, body: { ok: false, error: 'report_throttled' }, headers: { 'Retry-After': '60' } };
        }
        const result = await githubUpsert(config.gh, record);
        if (result.ok) await store.mark(key, now);
        log('game_report', {
          reqId, ip, placeId: key, status: result.status, ok: result.ok, ms: Date.now() - started,
        });
        return { status: result.ok ? 200 : 502, body: { ok: result.ok, status: result.status } };
      }

      return { status: 404, body: { ok: false, error: 'not_found' } };
    } catch (e) {
      // 统一错误出口：不回显堆栈、不回显环境变量
      log('error', { reqId, path, name: e && e.name, ms: Date.now() - started });
      return { status: 500, body: { ok: false, error: 'internal_error' } };
    }
  };
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 从环境变量对象解析配置（Node 的 process.env 与 Workers 的 env 均适用）。 */
export function readConfig(env) {
  const get = (k) => (env && typeof env[k] === 'string' ? env[k] : '');
  return {
    relayToken: get('RELAY_TOKEN'),
    webhooks: get('DISCORD_WEBHOOKS').split(',').map((s) => s.trim()).filter(Boolean),
    ghToken: get('GITHUB_TOKEN'),
    ghOwner: get('GITHUB_OWNER'),
    ghRepo: get('GITHUB_REPO'),
    ghFile: get('GITHUB_FILE') || 'game.json',
    ghBranch: get('GITHUB_BRANCH') || 'main',
  };
}
