#!/usr/bin/env node
/**
 * publish-cf — CLI client for the publish-cloudflare worker.
 * Pure Node, zero deps. Mirrors htmlship's command surface.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const HOME = os.homedir();
const DIR = path.join(HOME, ".publish-cloudflare");
const KEYS_PATH = path.join(DIR, "keys.json");
const CONFIG_PATH = path.join(DIR, "config.json");
const DEFAULT_API = "http://localhost:8787";

// ---------- config / keys ----------

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(p, obj) {
  ensureDir();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function getApiBase() {
  if (process.env.PUBLISH_CF_API) return process.env.PUBLISH_CF_API.replace(/\/$/, "");
  const cfg = loadJson(CONFIG_PATH, {});
  if (cfg.api_base) return String(cfg.api_base).replace(/\/$/, "");
  return DEFAULT_API;
}

function loadKeys() {
  return loadJson(KEYS_PATH, {});
}

function saveKey(slug, entry) {
  const keys = loadKeys();
  keys[slug] = entry;
  saveJson(KEYS_PATH, keys);
}

function removeKey(slug) {
  const keys = loadKeys();
  delete keys[slug];
  saveJson(KEYS_PATH, keys);
}

function getOwnerKey(slug) {
  const keys = loadKeys();
  return keys[slug]?.owner_key || null;
}

function getSourcePath(slug) {
  const keys = loadKeys();
  return keys[slug]?.source_path || null;
}

function updateKey(slug, patch) {
  const keys = loadKeys();
  if (!keys[slug]) return;
  keys[slug] = { ...keys[slug], ...patch };
  saveJson(KEYS_PATH, keys);
}

// ---------- http ----------

async function api(method, pathStr, { body, ownerKey, extraHeaders } = {}) {
  const base = getApiBase();
  const url = `${base}${pathStr}`;
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (ownerKey) headers["x-owner-key"] = ownerKey;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`Network error talking to ${base}: ${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const msg = data?.error?.message || text || `HTTP ${res.status}`;
    fail(`${method} ${pathStr} → ${res.status}: ${msg}`);
  }
  return data;
}

// ---------- io ----------

function readInput(file) {
  if (file === "-" || file === "/dev/stdin") {
    return fs.readFileSync(0, "utf8");
  }
  if (!fs.existsSync(file)) fail(`File not found: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function copyToClipboard(text) {
  if (process.platform !== "darwin") return false;
  try {
    const r = spawnSync("pbcopy", { input: text });
    return r.status === 0;
  } catch {
    return false;
  }
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitleFromHtml(html) {
  const sample = ["— sample", "untitled", "the quiet architecture"];
  const isSample = (s) => {
    const lc = s.toLowerCase();
    return sample.some((p) => lc.includes(p));
  };
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const t = decodeEntities(titleMatch[1]).trim();
    if (t && !isSample(t)) return t;
  }
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const t = decodeEntities(h1Match[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (t && !isSample(t)) return t;
  }
  return null;
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------- commands ----------

async function cmdPublish(args) {
  const { positional, flags } = parseArgs(args);
  const file = positional[0];
  if (!file) fail("usage: publish-cf publish <file> [--password X] [--title X] [--expires-in MINUTES] [--no-comments]");
  const html = readInput(file);
  const body = { html };
  if (flags.title) {
    body.title = String(flags.title);
  } else {
    const extracted = extractTitleFromHtml(html);
    if (extracted) body.title = extracted;
  }
  if (flags.password) body.password = String(flags.password);
  if (flags["expires-in"]) {
    const n = Number(flags["expires-in"]);
    if (!Number.isFinite(n) || n <= 0) fail("--expires-in must be a positive number of minutes");
    body.expires_in = n;
  }
  if (flags["no-comments"]) body.comments_enabled = false;
  const res = await api("POST", "/api/v1/pages", { body });
  // Resolve to an absolute path for later /address-comments lookups.
  // Stdin publishes are ephemeral — no source path to remember.
  const sourcePath = file === "-" || file === "/dev/stdin" ? null : path.resolve(file);
  saveKey(res.slug, {
    owner_key: res.owner_key,
    url: res.url,
    title: body.title || null,
    created_at: Date.now(),
    expires_at: res.expires_at || null,
    api_base: getApiBase(),
    comments_enabled: res.comments_enabled !== false,
    source_path: sourcePath,
  });
  const copied = copyToClipboard(res.url);
  process.stdout.write(`${res.url}\n`);
  process.stderr.write(`slug:      ${res.slug}\n`);
  process.stderr.write(`owner_key: ${res.owner_key}  (saved to ${KEYS_PATH})\n`);
  if (sourcePath) process.stderr.write(`source:    ${sourcePath}\n`);
  if (res.comments_enabled === false) process.stderr.write(`comments:  off\n`);
  if (res.expires_at) {
    process.stderr.write(`expires:   ${new Date(res.expires_at).toISOString()}\n`);
  }
  if (copied) process.stderr.write(`(URL copied to clipboard)\n`);
}

async function cmdGet(args) {
  const slug = args[0];
  if (!slug) fail("usage: publish-cf get <slug>");
  const meta = await api("GET", `/api/v1/pages/${slug}`);
  process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
}

async function cmdUpdate(args) {
  const { positional, flags } = parseArgs(args);
  const slug = positional[0];
  const file = positional[1];
  if (!slug || !file) fail("usage: publish-cf update <slug> <file> [--title X]");
  const ownerKey = getOwnerKey(slug);
  if (!ownerKey) fail(`No owner_key on file for ${slug}. Did you publish from this machine?`);
  const html = readInput(file);
  const body = { html };
  if (flags.title) body.title = String(flags.title);
  const res = await api("PATCH", `/api/v1/pages/${slug}`, { body, ownerKey });
  // Refresh the remembered source so /address-comments finds the right file.
  if (file !== "-" && file !== "/dev/stdin") {
    updateKey(slug, { source_path: path.resolve(file) });
  }
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
}

async function cmdDelete(args) {
  const slug = args[0];
  if (!slug) fail("usage: publish-cf delete <slug>");
  const ownerKey = getOwnerKey(slug);
  if (!ownerKey) fail(`No owner_key on file for ${slug}.`);
  await api("DELETE", `/api/v1/pages/${slug}`, { ownerKey });
  removeKey(slug);
  process.stdout.write(`deleted ${slug}\n`);
}

// ---------- comments ----------

function formatRelativeTime(ts) {
  if (!ts || !Number.isFinite(Number(ts))) return "?";
  const now = Date.now();
  const diff = Math.max(0, now - Number(ts));
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function printCommentsPretty(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    process.stdout.write("no comments\n");
    return;
  }
  const lines = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const badge = c.status === "resolved" ? "[RESOLVED]" : "[OPEN]";
    const author = c.author || "anonymous";
    const when = formatRelativeTime(c.created_at);
    lines.push(`${badge} ${c.id}  ${author} · ${when}`);
    if (c.anchor && c.anchor.quote) {
      const q = String(c.anchor.quote).replace(/\s+/g, " ").trim();
      lines.push(`  > "${q}"`);
    } else {
      lines.push(`  > (no anchor — free-floating note)`);
    }
    const bodyLines = String(c.body || "").split("\n");
    for (const bl of bodyLines) lines.push(`    ${bl}`);
    if (c.status === "resolved") {
      const rWhen = c.resolved_at ? formatRelativeTime(c.resolved_at) : "?";
      const rBy = c.resolved_by || "?";
      lines.push(`  resolved by ${rBy} · ${rWhen}`);
      if (c.resolution_note) lines.push(`  note: ${c.resolution_note}`);
    }
    if (i < comments.length - 1) lines.push("---");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdCommentsList(slug, flags) {
  const status = flags.status ? String(flags.status) : "open";
  if (status !== "open" && status !== "all") {
    fail("--status must be 'open' or 'all'");
  }
  const format = flags.format ? String(flags.format) : "pretty";
  if (format !== "pretty" && format !== "json") {
    fail("--format must be 'pretty' or 'json'");
  }
  const ownerKey = getOwnerKey(slug);
  const qs = `?status=${encodeURIComponent(status)}`;
  const res = await api("GET", `/v/${encodeURIComponent(slug)}/comments${qs}`, {
    ownerKey: ownerKey || undefined,
  });
  const comments = res && Array.isArray(res.comments) ? res.comments : [];
  if (format === "json") {
    process.stdout.write(JSON.stringify(comments, null, 2) + "\n");
  } else {
    printCommentsPretty(comments);
  }
}

async function cmdCommentsResolve(slug, id, flags) {
  if (!slug || !id) {
    fail('usage: publish-cf comments resolve <slug> <id> [--note "..."]');
  }
  const ownerKey = getOwnerKey(slug);
  if (!ownerKey) fail(`No owner_key on file for ${slug}. Did you publish from this machine?`);
  const body = { status: "resolved" };
  if (flags.note !== undefined && flags.note !== true) {
    body.resolution_note = String(flags.note);
  }
  await api("PATCH", `/v/${encodeURIComponent(slug)}/comments/${encodeURIComponent(id)}`, {
    body,
    ownerKey,
    extraHeaders: { "x-resolved-by": "agent" },
  });
  process.stdout.write(`Resolved ${id}\n`);
}

function promptYesNo(question) {
  process.stderr.write(`${question} [y/N] `);
  let input = "";
  const buf = Buffer.alloc(1);
  // Read from stdin synchronously until newline; tolerate non-TTY by returning false.
  try {
    while (true) {
      const n = fs.readSync(0, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n" || ch === "\r") break;
      input += ch;
    }
  } catch {
    return false;
  }
  return /^y(es)?$/i.test(input.trim());
}

async function cmdCommentsToggle(slug, flags) {
  if (!slug) fail("usage: publish-cf comments toggle <slug> [--on | --off]");
  if (!flags.on && !flags.off) fail("specify --on or --off");
  if (flags.on && flags.off) fail("specify only one of --on / --off");
  const ownerKey = getOwnerKey(slug);
  if (!ownerKey) fail(`No owner_key on file for ${slug}.`);
  const enabled = !!flags.on;
  const res = await api("PATCH", `/api/v1/pages/${slug}`, {
    body: { comments_enabled: enabled },
    ownerKey,
  });
  updateKey(slug, { comments_enabled: enabled });
  process.stdout.write(`comments ${enabled ? "on" : "off"} for ${slug}\n`);
  process.stderr.write(JSON.stringify(res, null, 2) + "\n");
}

async function cmdCommentsDelete(slug, id, flags) {
  if (!slug || !id) {
    fail("usage: publish-cf comments delete <slug> <id> [--yes]");
  }
  const ownerKey = getOwnerKey(slug);
  if (!ownerKey) fail(`No owner_key on file for ${slug}.`);
  if (!flags.yes) {
    const ok = promptYesNo(`Delete comment ${id} on ${slug}?`);
    if (!ok) {
      process.stderr.write("aborted\n");
      return;
    }
  }
  await api("DELETE", `/v/${encodeURIComponent(slug)}/comments/${encodeURIComponent(id)}`, {
    ownerKey,
  });
  process.stdout.write(`deleted ${id}\n`);
}

function commentsHelp() {
  process.stdout.write(`publish-cf comments — read and manage inline comments on a published page

usage:
  publish-cf comments <slug> [--status open|all] [--format json|pretty]
  publish-cf comments resolve <slug> <id> [--note "..."]
  publish-cf comments delete <slug> <id> [--yes]
  publish-cf comments toggle <slug> --on | --off

flags:
  --status open|all     filter comments (default: open)
  --format json|pretty  output format (default: pretty)
  --note "..."          resolution note to attach when resolving
  --yes                 skip the confirmation prompt on delete
  --on | --off          enable or disable the comment UI for a page

examples:
  publish-cf comments abc12345
  publish-cf comments abc12345 --status all --format json
  publish-cf comments resolve abc12345 c_a1b2c3d4e5 --note "fixed in latest update"
  publish-cf comments delete abc12345 c_a1b2c3d4e5 --yes
  publish-cf comments toggle abc12345 --off
`);
}

async function cmdComments(args) {
  const { positional, flags } = parseArgs(args);
  if (flags.help || flags.h || positional[0] === "help") {
    commentsHelp();
    return;
  }
  const first = positional[0];
  if (!first) {
    commentsHelp();
    fail("missing <slug>");
  }
  if (first === "resolve") {
    await cmdCommentsResolve(positional[1], positional[2], flags);
    return;
  }
  if (first === "delete") {
    await cmdCommentsDelete(positional[1], positional[2], flags);
    return;
  }
  if (first === "toggle") {
    await cmdCommentsToggle(positional[1], flags);
    return;
  }
  // default: list comments for slug
  await cmdCommentsList(first, flags);
}

function cmdListMine() {
  const keys = loadKeys();
  const slugs = Object.keys(keys).sort();
  if (slugs.length === 0) {
    process.stdout.write("no pages saved on this machine\n");
    return;
  }
  for (const slug of slugs) {
    const e = keys[slug];
    const expires = e.expires_at ? new Date(e.expires_at).toISOString() : "—";
    const src = e.source_path || "—";
    const comments = e.comments_enabled === false ? "off" : "on";
    process.stdout.write(
      `${slug}\t${e.url}\t(title: ${e.title || "—"}, expires: ${expires}, comments: ${comments}, source: ${src})\n`,
    );
  }
}

function cmdConfig(args) {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];
  const cfg = loadJson(CONFIG_PATH, {});
  if (!sub || sub === "show") {
    process.stdout.write(JSON.stringify({ ...cfg, _resolved_api_base: getApiBase() }, null, 2) + "\n");
    return;
  }
  if (sub === "set") {
    if (flags["api-base"]) cfg.api_base = String(flags["api-base"]).replace(/\/$/, "");
    saveJson(CONFIG_PATH, cfg);
    process.stdout.write(`saved ${CONFIG_PATH}\n`);
    return;
  }
  fail("usage: publish-cf config show | publish-cf config set --api-base <url>");
}

async function cmdPassword(args) {
  const { positional, flags } = parseArgs(args);
  const slug = positional[0];
  if (!slug) fail("usage: publish-cf password <slug> --set <pw> | --clear");
  const ownerKey = getOwnerKey(slug);
  if (!ownerKey) fail(`No owner_key on file for ${slug}.`);

  let payload;
  if (flags.clear) {
    payload = { password: null };
  } else if (typeof flags.set === "string" && flags.set) {
    payload = { password: flags.set };
  } else {
    fail("specify --set <pw> or --clear");
  }

  const res = await api("PATCH", `/api/v1/pages/${slug}`, { body: payload, ownerKey });
  process.stdout.write(`password ${flags.clear ? "cleared" : "set"} for ${slug}\n`);
  process.stderr.write(JSON.stringify(res, null, 2) + "\n");
}

function help() {
  process.stdout.write(`publish-cf — CLI for self-hosted publish-cloudflare

usage:
  publish-cf publish <file> [--password X] [--title X] [--expires-in MINUTES] [--no-comments]
  publish-cf get <slug>
  publish-cf update <slug> <file> [--title X]
  publish-cf delete <slug>
  publish-cf password <slug> --set <pw> | --clear
  publish-cf comments <slug> [--status open|all] [--format json|pretty]
  publish-cf comments resolve <slug> <id> [--note "..."]
  publish-cf comments delete <slug> <id> [--yes]
  publish-cf comments toggle <slug> --on | --off
  publish-cf list-mine
  publish-cf config show
  publish-cf config set --api-base <url>

config:
  ~/.publish-cloudflare/config.json   { "api_base": "https://..." }
  ~/.publish-cloudflare/keys.json     owner_keys keyed by slug
  PUBLISH_CF_API env var              overrides config

current api_base: ${getApiBase()}
`);
}

// ---------- entry ----------

(async () => {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case "publish":
        await cmdPublish(rest);
        break;
      case "get":
        await cmdGet(rest);
        break;
      case "update":
        await cmdUpdate(rest);
        break;
      case "delete":
        await cmdDelete(rest);
        break;
      case "password":
        await cmdPassword(rest);
        break;
      case "comments":
        await cmdComments(rest);
        break;
      case "list-mine":
        cmdListMine();
        break;
      case "config":
        cmdConfig(rest);
        break;
      case "--help":
      case "-h":
      case "help":
      case undefined:
        help();
        break;
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n`);
        help();
        process.exit(1);
    }
  } catch (e) {
    fail(e?.message || String(e));
  }
})();
