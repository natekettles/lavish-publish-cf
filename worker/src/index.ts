/**
 * publish-cloudflare — self-hosted htmlship clone on Cloudflare Workers + KV.
 *
 * One file by design. Endpoints:
 *   POST   /api/v1/pages
 *   GET    /api/v1/pages/:slug
 *   PATCH  /api/v1/pages/:slug
 *   DELETE /api/v1/pages/:slug
 *   GET    /v/:slug              (and POST for password gate)
 *   GET    /                     (landing page)
 */

export interface Env {
  PAGES: KVNamespace;
  VIEW_BASE_URL?: string;
}

interface PageRecord {
  slug: string;
  html: string;
  title: string;
  owner_key_hash: string;
  password_hash: string | null;
  created_at: number;
  expires_at: number | null;
  size_bytes: number;
  // Optional for backwards-compatibility with records written before this field
  // existed. Treat `undefined` as `true` everywhere that reads it.
  comments_enabled?: boolean;
}

interface Comment {
  id: string;
  slug: string;
  anchor: {
    quote: string;
    prefix: string;
    suffix: string;
  } | null;
  body: string;
  author: string;
  status: "open" | "resolved";
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_EXPIRES_MINUTES = 60 * 24 * 30; // 30 days
const SLUG_LEN = 8;
const OWNER_KEY_LEN = 32;
const COMMENT_ID_LEN = 10;
const MAX_COMMENT_BODY = 2000;
const MAX_COMMENT_AUTHOR = 60;
const MAX_ANCHOR_QUOTE = 200;
const MAX_ANCHOR_CONTEXT = 64;
const MAX_RESOLUTION_NOTE = 500;
const PAGE_CSP =
  "default-src 'self' data: blob: https:; " +
  "script-src 'none'; " +
  "style-src 'self' 'unsafe-inline' https:; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data: https:; " +
  "frame-ancestors 'self'; " +
  "base-uri 'none';";
const WRAPPER_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data: https:; " +
  "frame-src 'self'; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none';";

// ---------- favicon ----------
// Editorial pilcrow (¶) in a rounded slate square. Self-contained SVG —
// no fonts, no external assets — served at /favicon.svg and /favicon.ico
// and referenced by the wrapper + landing pages via <link rel="icon">.
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="6" fill="#111827"/>' +
  '<path d="M22 6H13a5 5 0 0 0 0 10h4v10h2V16h1v10h2V6z" fill="#fbfaf7"/>' +
  "</svg>";

function serveFavicon(): Response {
  return new Response(FAVICON_SVG, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=604800, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

// ---------- helpers ----------

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomString(len: number, alphabet = ALPHA): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// constant-time hex compare
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

function err(status: number, message: string, code?: string): Response {
  return json({ error: { code: code ?? `http_${status}`, message } }, status);
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type, x-owner-key, x-resolved-by",
      "access-control-max-age": "86400",
    },
  });
}

function viewBase(env: Env, request: Request): string {
  if (env.VIEW_BASE_URL) return env.VIEW_BASE_URL.replace(/\/$/, "");
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function viewUrl(env: Env, request: Request, slug: string): string {
  const base = viewBase(env, request);
  // If VIEW_BASE_URL is a dedicated view host (no path), use root /<slug>; otherwise /v/<slug>.
  if (env.VIEW_BASE_URL) return `${base}/v/${slug}`;
  return `${base}/v/${slug}`;
}

async function getPage(env: Env, slug: string): Promise<PageRecord | null> {
  const raw = await env.PAGES.get(`page:${slug}`, "json");
  if (!raw) return null;
  const rec = raw as PageRecord;
  if (rec.expires_at && Date.now() > rec.expires_at) {
    // best-effort cleanup
    await env.PAGES.delete(`page:${slug}`);
    return null;
  }
  return rec;
}

function commentKey(slug: string, id: string): string {
  return `comment:${slug}:${id}`;
}

async function getComment(env: Env, slug: string, id: string): Promise<Comment | null> {
  const raw = await env.PAGES.get(commentKey(slug, id), "json");
  if (!raw) return null;
  return raw as Comment;
}

async function listComments(env: Env, slug: string): Promise<Comment[]> {
  const prefix = `comment:${slug}:`;
  const out: Comment[] = [];
  let cursor: string | undefined;
  // KV list pagination: tens per artifact expected, but be safe.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res: KVNamespaceListResult<unknown, string> = await env.PAGES.list({ prefix, cursor });
    for (const k of res.keys) {
      const c = await env.PAGES.get(k.name, "json");
      if (c) out.push(c as Comment);
    }
    if (res.list_complete) break;
    cursor = res.cursor;
    if (!cursor) break;
  }
  out.sort((a, b) => a.created_at - b.created_at);
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- handlers ----------

async function handleCreate(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const html = typeof body?.html === "string" ? body.html : null;
  if (!html) return err(400, "Field 'html' is required and must be a string");

  const size = new TextEncoder().encode(html).byteLength;
  if (size > MAX_HTML_BYTES) {
    return err(413, `HTML exceeds limit of ${MAX_HTML_BYTES} bytes (got ${size})`);
  }

  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Untitled";
  const password = typeof body?.password === "string" && body.password ? String(body.password) : null;
  const commentsEnabled = body?.comments_enabled === false ? false : true;

  let expiresAt: number | null = null;
  if (body?.expires_in != null) {
    const mins = Number(body.expires_in);
    if (!Number.isFinite(mins) || mins <= 0) return err(400, "expires_in must be a positive number of minutes");
    if (mins > MAX_EXPIRES_MINUTES) return err(400, `expires_in cannot exceed ${MAX_EXPIRES_MINUTES} minutes`);
    expiresAt = Date.now() + mins * 60 * 1000;
  }

  // generate slug with collision retry
  let slug = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomString(SLUG_LEN);
    const exists = await env.PAGES.get(`page:${candidate}`);
    if (!exists) {
      slug = candidate;
      break;
    }
  }
  if (!slug) return err(500, "Could not allocate unique slug, please retry");

  const ownerKey = `ws_${randomString(OWNER_KEY_LEN)}`;
  const ownerKeyHash = await sha256(ownerKey);
  const passwordHash = password ? await sha256(password) : null;

  const record: PageRecord = {
    slug,
    html,
    title,
    owner_key_hash: ownerKeyHash,
    password_hash: passwordHash,
    created_at: Date.now(),
    expires_at: expiresAt,
    size_bytes: size,
    comments_enabled: commentsEnabled,
  };

  const putOpts: KVNamespacePutOptions = {};
  if (expiresAt) {
    const ttl = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
    putOpts.expirationTtl = ttl;
  }
  await env.PAGES.put(`page:${slug}`, JSON.stringify(record), putOpts);

  return json(
    {
      slug,
      url: viewUrl(env, request, slug),
      owner_key: ownerKey,
      expires_at: expiresAt,
      size_bytes: size,
      comments_enabled: commentsEnabled,
    },
    201,
  );
}

function commentsOn(rec: PageRecord): boolean {
  // Backwards-compat: records created before the field existed default to ON.
  return rec.comments_enabled !== false;
}

function metaFor(rec: PageRecord, env: Env, request: Request) {
  return {
    slug: rec.slug,
    title: rec.title,
    url: viewUrl(env, request, rec.slug),
    has_password: rec.password_hash !== null,
    created_at: rec.created_at,
    expires_at: rec.expires_at,
    size_bytes: rec.size_bytes,
    comments_enabled: commentsOn(rec),
  };
}

async function handleGetMeta(env: Env, request: Request, slug: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return err(404, "Page not found");
  return json(metaFor(rec, env, request));
}

async function requireOwner(request: Request, rec: PageRecord): Promise<Response | null> {
  const provided = request.headers.get("x-owner-key");
  if (!provided) return err(401, "Missing X-Owner-Key header");
  const providedHash = await sha256(provided);
  if (!timingSafeEqualHex(providedHash, rec.owner_key_hash)) return err(403, "Invalid owner_key");
  return null;
}

async function handlePatch(request: Request, env: Env, slug: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return err(404, "Page not found");
  const authErr = await requireOwner(request, rec);
  if (authErr) return authErr;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  if (typeof body?.html === "string") {
    const size = new TextEncoder().encode(body.html).byteLength;
    if (size > MAX_HTML_BYTES) return err(413, `HTML exceeds limit of ${MAX_HTML_BYTES} bytes (got ${size})`);
    rec.html = body.html;
    rec.size_bytes = size;
  }
  if (typeof body?.title === "string" && body.title.trim()) {
    rec.title = body.title.trim().slice(0, 200);
  }
  if (typeof body?.comments_enabled === "boolean") {
    rec.comments_enabled = body.comments_enabled;
  }
  if (body && "password" in body) {
    if (body.password === null) {
      rec.password_hash = null;
    } else if (typeof body.password === "string" && body.password) {
      rec.password_hash = await sha256(body.password);
    }
  }

  const putOpts: KVNamespacePutOptions = {};
  if (rec.expires_at) {
    const ttl = Math.max(60, Math.ceil((rec.expires_at - Date.now()) / 1000));
    putOpts.expirationTtl = ttl;
  }
  await env.PAGES.put(`page:${slug}`, JSON.stringify(rec), putOpts);
  return json(metaFor(rec, env, request));
}

async function handleDelete(request: Request, env: Env, slug: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return err(404, "Page not found");
  const authErr = await requireOwner(request, rec);
  if (authErr) return authErr;
  await env.PAGES.delete(`page:${slug}`);
  return json({ slug, deleted: true });
}

// ---------- view ----------

function passwordCookieName(slug: string): string {
  return `hp_${slug}`;
}

function cookieAuthorized(request: Request, slug: string): boolean {
  const cookie = request.headers.get("cookie") || "";
  const name = passwordCookieName(slug);
  const re = new RegExp(`(?:^|;\\s*)${name}=ok(?:;|$)`);
  return re.test(cookie);
}

function passwordPrompt(slug: string, error?: string): Response {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Password required</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
  form { display: grid; gap: .75rem; }
  input { padding: .6rem .75rem; font-size: 1rem; border: 1px solid #888; border-radius: .4rem; }
  button { padding: .6rem .75rem; font-size: 1rem; border: 0; border-radius: .4rem; background: #2563eb; color: white; cursor: pointer; }
  .err { color: #b91c1c; }
</style>
<h1>Password required</h1>
<p>This page is protected.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="POST" action="/v/${escapeHtml(slug)}">
  <input type="password" name="password" autofocus required autocomplete="current-password" placeholder="Password" />
  <button type="submit">Unlock</button>
</form>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function servePage(rec: PageRecord): Response {
  return new Response(rec.html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PAGE_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

// Returns null when the viewer is authorized; otherwise returns a Response
// (either a password prompt for HTML clients or a 401 JSON for API clients).
async function requireViewerAccess(
  rec: PageRecord,
  request: Request,
  opts: { json?: boolean } = {},
): Promise<Response | null> {
  if (!rec.password_hash) return null;
  if (cookieAuthorized(request, rec.slug)) return null;

  // Owner key is strictly more privileged than the viewer password.
  // If the caller can prove ownership, skip the password gate.
  const ownerKey = request.headers.get("x-owner-key");
  if (ownerKey) {
    const providedHash = await sha256(ownerKey);
    if (timingSafeEqualHex(providedHash, rec.owner_key_hash)) return null;
  }

  if (opts.json) {
    return json({ error: { code: "password_required", message: "Password required" } }, 401);
  }
  return passwordPrompt(rec.slug);
}

async function handleViewRaw(request: Request, env: Env, slug: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return new Response("Not found", { status: 404 });
  const gate = await requireViewerAccess(rec, request);
  if (gate) return gate;
  return servePage(rec);
}

async function handleViewWrapper(request: Request, env: Env, slug: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return new Response("Not found", { status: 404 });

  if (request.method === "POST" && rec.password_hash) {
    // password submission
    const ct = request.headers.get("content-type") || "";
    let provided = "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      provided = String(form.get("password") || "");
    } else {
      try {
        const body: any = await request.json();
        provided = String(body?.password || "");
      } catch {}
    }
    if (!provided) return passwordPrompt(slug, "Enter a password");
    const ph = await sha256(provided);
    if (!timingSafeEqualHex(ph, rec.password_hash)) return passwordPrompt(slug, "Incorrect password");
    // set cookie + redirect to GET
    return new Response(null, {
      status: 303,
      headers: {
        location: `/v/${slug}`,
        "set-cookie": `${passwordCookieName(slug)}=ok; Max-Age=3600; Path=/v/${slug}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  const gate = await requireViewerAccess(rec, request);
  if (gate) return gate;

  // When comments are disabled, the wrapper UI is dead weight: serve the
  // artifact directly under the strict PAGE_CSP. Same result as /v/:slug/raw,
  // but at the canonical view URL so links don't have to change.
  if (!commentsOn(rec)) return servePage(rec);

  return serveWrapper(rec);
}

function serveWrapper(rec: PageRecord): Response {
  const slug = rec.slug;
  const title = rec.title || "Untitled";
  const html = wrapperHtml(slug, title);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": WRAPPER_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function wrapperHtml(slug: string, title: string): string {
  const safeSlug = escapeHtml(slug);
  const safeTitle = escapeHtml(title);
  // JSON-encoded slug for safe inline JS embedding.
  const slugJson = JSON.stringify(slug);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${safeTitle}</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: #111; --muted: #666; --bg: #fff; --panel: #fafafa; --border: #e5e7eb;
    --accent: #2563eb; --danger: #b91c1c; --highlight: rgba(250,204,21,.45);
    --highlight-flash: rgba(250,204,21,.85);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg:#eaeaea; --muted:#9ca3af; --bg:#0b0b0c; --panel:#121214; --border:#27272a;
      --accent:#3b82f6; --danger:#f87171; --highlight: rgba(250,204,21,.35);
      --highlight-flash: rgba(250,204,21,.7);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  header.bar { display: flex; align-items: center; gap: .75rem; padding: .55rem .9rem; border-bottom: 1px solid var(--border); background: var(--panel); }
  header.bar h1 { font-size: .95rem; margin: 0; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header.bar .who { font-size: .8rem; color: var(--muted); }
  header.bar button { font-size: .8rem; padding: .35rem .6rem; border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: .35rem; cursor: pointer; }
  .main { display: grid; grid-template-columns: 1fr 360px; min-height: 0; }
  .stage { position: relative; min-height: 0; overflow: hidden; background: var(--bg); }
  .stage iframe { border: 0; width: 100%; height: 100%; display: block; background: white; }
  .overlay { position: absolute; inset: 0; pointer-events: none; }
  .hl { position: absolute; background: var(--highlight); border-radius: 2px; transition: background .25s; }
  .hl.flash { background: var(--highlight-flash); }
  .gutter { position: absolute; top: 0; right: 0; bottom: 0; width: 14px; pointer-events: none; }
  .gutter .dot { position: absolute; right: 3px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); opacity: .75; pointer-events: auto; cursor: pointer; }
  .gutter .dot.resolved { background: var(--muted); opacity: .35; }
  #commentBtn { position: absolute; z-index: 20; padding: .35rem .6rem; font-size: .8rem; border-radius: .35rem; border: 0; background: var(--accent); color: white; cursor: pointer; box-shadow: 0 1px 6px rgba(0,0,0,.25); display: none; }
  aside.side { border-left: 1px solid var(--border); background: var(--panel); display: flex; flex-direction: column; min-height: 0; }
  .side-head { display: flex; align-items: center; gap: .5rem; padding: .6rem .8rem; border-bottom: 1px solid var(--border); font-size: .85rem; }
  .side-head label { display: flex; align-items: center; gap: .35rem; color: var(--muted); cursor: pointer; }
  .side-list { flex: 1; overflow-y: auto; padding: .5rem; }
  .empty { padding: 1rem; color: var(--muted); font-size: .9rem; text-align: center; }
  .c { padding: .55rem .65rem; border: 1px solid var(--border); border-radius: .45rem; background: var(--bg); margin-bottom: .5rem; cursor: pointer; }
  .c.resolved { opacity: .55; }
  .c .meta { display: flex; gap: .4rem; font-size: .75rem; color: var(--muted); margin-bottom: .25rem; }
  .c .meta .author { color: var(--fg); font-weight: 600; }
  .c .quote { font-size: .78rem; color: var(--muted); border-left: 2px solid var(--border); padding-left: .5rem; margin: .25rem 0; font-style: italic; max-height: 2.6em; overflow: hidden; }
  .c .body { font-size: .87rem; white-space: pre-wrap; word-wrap: break-word; }
  .c .badge { font-size: .65rem; padding: .05rem .35rem; border-radius: .25rem; background: var(--border); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .c .badge.orphan { background: var(--danger); color: white; }
  .c .note { font-size: .78rem; color: var(--muted); margin-top: .35rem; border-top: 1px dashed var(--border); padding-top: .35rem; }
  .composer { border-top: 1px solid var(--border); padding: .6rem .7rem; display: none; flex-direction: column; gap: .4rem; }
  .composer.active { display: flex; }
  .composer .ctx { font-size: .75rem; color: var(--muted); border-left: 2px solid var(--accent); padding-left: .5rem; max-height: 4em; overflow: hidden; }
  .composer textarea { width: 100%; min-height: 4.5rem; padding: .4rem; font: inherit; font-size: .85rem; border: 1px solid var(--border); border-radius: .35rem; background: var(--bg); color: var(--fg); resize: vertical; }
  .composer .row { display: flex; gap: .4rem; justify-content: flex-end; }
  .composer button { font-size: .8rem; padding: .35rem .65rem; border-radius: .35rem; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  .composer button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  dialog { border: 1px solid var(--border); border-radius: .5rem; padding: 1rem; max-width: 22rem; color: var(--fg); background: var(--bg); }
  dialog::backdrop { background: rgba(0,0,0,.4); }
  dialog input { width: 100%; padding: .45rem; margin-top: .35rem; border: 1px solid var(--border); border-radius: .35rem; font: inherit; background: var(--bg); color: var(--fg); }
  dialog .row { margin-top: .75rem; display: flex; gap: .4rem; justify-content: flex-end; }
  dialog button { font-size: .85rem; padding: .35rem .75rem; border-radius: .35rem; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  dialog button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  #mobToggle {
    display: none;
    position: fixed; bottom: 1.1rem; right: 1.1rem; z-index: 110;
    align-items: center; gap: .4rem;
    padding: .5rem .85rem; border: 0; border-radius: 2rem;
    background: var(--accent); color: white;
    font-size: .85rem; font-weight: 600; cursor: pointer;
    box-shadow: 0 2px 10px rgba(0,0,0,.3);
  }
  @media (max-width: 720px) {
    .main { grid-template-columns: 1fr; }
    aside.side {
      display: none;
      position: fixed; inset: 0; z-index: 100;
      border-left: 0; border-top: 0;
    }
    aside.side.mob-open {
      display: flex;
    }
    #mobToggle {
      display: flex;
    }
  }
</style>
</head>
<body>
<div class="app">
  <header class="bar">
    <h1>${safeTitle}</h1>
    <span class="who" id="whoLabel"></span>
    <button id="renameBtn" type="button">Rename</button>
  </header>
  <div class="main">
    <div class="stage" id="stage">
      <iframe id="art" src="/v/${safeSlug}/raw" title="${safeTitle}"></iframe>
      <div class="overlay" id="overlay"></div>
      <div class="gutter" id="gutter"></div>
      <button id="commentBtn" type="button">Comment</button>
    </div>
    <aside class="side" id="side">
      <div class="side-head">
        <strong style="flex:1">Comments</strong>
        <label><input type="checkbox" id="showResolved"> show resolved</label>
        <a href="/v/${safeSlug}/raw" title="View without comments sidebar" style="font-size:.75rem;color:var(--muted);text-decoration:none;padding:.2rem .4rem;border:1px solid var(--border);border-radius:.3rem;white-space:nowrap">bare view</a>
      </div>
      <div class="side-list" id="list"><div class="empty">Loading…</div></div>
      <form class="composer" id="composer">
        <div class="ctx" id="composerCtx"></div>
        <textarea id="composerBody" maxlength="${MAX_COMMENT_BODY}" placeholder="Add a comment…" required></textarea>
        <div class="row">
          <button type="button" id="composerCancel">Cancel</button>
          <button type="submit" class="primary">Post</button>
        </div>
      </form>
    </aside>
  </div>
</div>
<button id="mobToggle" type="button" aria-label="Toggle comments">Comments</button>

<dialog id="nameDlg">
  <form method="dialog" id="nameForm">
    <strong>Your display name</strong>
    <p style="margin:.3rem 0 0; color:var(--muted); font-size:.85rem">Shown next to your comments.</p>
    <input id="nameInput" maxlength="${MAX_COMMENT_AUTHOR}" required placeholder="e.g. Alex" autocomplete="off">
    <div class="row">
      <button value="cancel" type="button" id="nameCancel">Cancel</button>
      <button value="ok" type="submit" class="primary">Save</button>
    </div>
  </form>
</dialog>

<script>
(function(){
  const SLUG = ${slugJson};
  const MAX_BODY = ${MAX_COMMENT_BODY};
  const MAX_AUTHOR = ${MAX_COMMENT_AUTHOR};
  const MAX_QUOTE = ${MAX_ANCHOR_QUOTE};
  const MAX_CTX = ${MAX_ANCHOR_CONTEXT};

  const iframe = document.getElementById('art');
  const stage = document.getElementById('stage');
  const overlay = document.getElementById('overlay');
  const gutter = document.getElementById('gutter');
  const listEl = document.getElementById('list');
  const commentBtn = document.getElementById('commentBtn');
  const composer = document.getElementById('composer');
  const composerBody = document.getElementById('composerBody');
  const composerCtx = document.getElementById('composerCtx');
  const composerCancel = document.getElementById('composerCancel');
  const showResolvedEl = document.getElementById('showResolved');
  const renameBtn = document.getElementById('renameBtn');
  const whoLabel = document.getElementById('whoLabel');
  const nameDlg = document.getElementById('nameDlg');
  const nameForm = document.getElementById('nameForm');
  const nameInput = document.getElementById('nameInput');
  const nameCancel = document.getElementById('nameCancel');
  const side = document.getElementById('side');
  const mobToggle = document.getElementById('mobToggle');

  // Mobile sidebar toggle.
  function isMobile() { return window.innerWidth <= 720; }
  function updateMobToggleLabel(count) {
    if (!mobToggle) return;
    mobToggle.textContent = 'Comments' + (count > 0 ? ' (' + count + ')' : '');
  }
  if (mobToggle && side) {
    mobToggle.addEventListener('click', function() {
      const open = side.classList.toggle('mob-open');
      mobToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Close sidebar when tapping outside of it on mobile.
    document.addEventListener('click', function(e) {
      if (!isMobile()) return;
      if (side.classList.contains('mob-open') &&
          !side.contains(e.target) && e.target !== mobToggle) {
        side.classList.remove('mob-open');
        mobToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  let comments = [];
  let pendingAnchor = null;
  let resolvedAnchors = new Map(); // id -> {rects, found, topY}

  function getName() { return localStorage.getItem('pcf_name') || ''; }
  function setName(n) { localStorage.setItem('pcf_name', n); refreshWho(); }
  function refreshWho() {
    const n = getName();
    whoLabel.textContent = n ? ('as ' + n) : '(no name yet)';
  }
  refreshWho();

  function askName() {
    return new Promise(function(resolve){
      nameInput.value = getName();
      const onCancel = function(){ nameDlg.close('cancel'); };
      nameCancel.onclick = onCancel;
      nameForm.onsubmit = function(e){
        const v = (nameInput.value || '').trim().slice(0, MAX_AUTHOR);
        if (!v) { e.preventDefault(); return; }
        setName(v);
        // Let the dialog close naturally via method="dialog"
      };
      nameDlg.addEventListener('close', function once(){
        nameDlg.removeEventListener('close', once);
        resolve(getName());
      });
      try { nameDlg.showModal(); } catch(_) { /* fallback */ const v = prompt('Your display name', getName() || ''); if (v) setName(v.trim().slice(0, MAX_AUTHOR)); resolve(getName()); }
    });
  }

  renameBtn.addEventListener('click', function(){ askName(); });

  function escapeText(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\'':'&#39;'})[c]; }); }

  async function fetchComments() {
    try {
      const r = await fetch('/v/' + SLUG + '/comments?status=all', { credentials: 'same-origin' });
      if (!r.ok) {
        if (r.status === 401) { listEl.innerHTML = '<div class="empty">Password required to view comments.</div>'; return; }
        throw new Error('HTTP ' + r.status);
      }
      const data = await r.json();
      const fresh = Array.isArray(data.comments) ? data.comments : [];
      // Merge: trust the server for any comment it returns, but keep
      // optimistic locals (created in this session) that haven't propagated
      // to KV's list view yet. Reconciles within ~1min.
      const byId = new Map();
      for (const c of fresh) byId.set(c.id, c);
      for (const c of comments) if (!byId.has(c.id)) byId.set(c.id, c);
      comments = Array.from(byId.values()).sort(function(a,b){ return a.created_at - b.created_at; });
      renderList();
      resolveAnchors();
    } catch (e) {
      listEl.innerHTML = '<div class="empty">Failed to load comments.</div>';
    }
  }

  function renderList() {
    const showR = showResolvedEl.checked;
    const visible = comments.filter(function(c){ return showR || c.status === 'open'; });
    updateMobToggleLabel(comments.filter(function(c){ return c.status === 'open'; }).length);
    if (!visible.length) { listEl.innerHTML = '<div class="empty">No comments yet. Select text in the page to add one.</div>'; return; }
    const parts = visible.map(function(c){
      const orphan = c.anchor && resolvedAnchors.get(c.id) && resolvedAnchors.get(c.id).found === false;
      const badge = c.status === 'resolved'
        ? '<span class="badge">resolved</span>'
        : (orphan ? '<span class="badge orphan">orphaned</span>' : '');
      const time = new Date(c.created_at).toLocaleString();
      const quote = c.anchor && c.anchor.quote ? '<div class="quote">"' + escapeText(c.anchor.quote) + '"</div>' : '';
      const note = c.resolution_note ? '<div class="note">' + escapeText(c.resolution_note) + '</div>' : '';
      return '<div class="c ' + (c.status === 'resolved' ? 'resolved' : '') + '" data-id="' + escapeText(c.id) + '">' +
        '<div class="meta"><span class="author">' + escapeText(c.author) + '</span>' +
        '<span>' + escapeText(time) + '</span>' + badge + '</div>' +
        quote +
        '<div class="body">' + escapeText(c.body) + '</div>' +
        note +
      '</div>';
    });
    listEl.innerHTML = parts.join('');
    Array.from(listEl.querySelectorAll('.c')).forEach(function(el){
      el.addEventListener('click', function(){ scrollToComment(el.getAttribute('data-id')); });
    });
  }

  showResolvedEl.addEventListener('change', function(){ renderList(); paintOverlays(); });

  function getIframeDoc() {
    try { return iframe.contentDocument; } catch(_) { return null; }
  }
  function getIframeWin() {
    try { return iframe.contentWindow; } catch(_) { return null; }
  }

  function findRangeForAnchor(anchor) {
    const doc = getIframeDoc();
    if (!doc || !anchor) return null;
    const body = doc.body;
    if (!body) return null;
    const fullText = body.innerText;
    const target = anchor.prefix + anchor.quote + anchor.suffix;
    let idx = fullText.indexOf(target);
    let offset = anchor.prefix.length;
    if (idx < 0) {
      // fallback: just quote
      idx = fullText.indexOf(anchor.quote);
      offset = 0;
      if (idx < 0) return null;
    }
    const start = idx + offset;
    const end = start + anchor.quote.length;
    return rangeFromTextOffsets(doc, body, start, end);
  }

  function rangeFromTextOffsets(doc, root, start, end) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let pos = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue || '';
      const len = t.length;
      if (!startNode && pos + len >= start) { startNode = n; startOff = start - pos; }
      if (!endNode && pos + len >= end) { endNode = n; endOff = end - pos; break; }
      pos += len;
    }
    if (!startNode || !endNode) return null;
    try {
      const r = doc.createRange();
      r.setStart(startNode, startOff);
      r.setEnd(endNode, endOff);
      return r;
    } catch(_) { return null; }
  }

  function resolveAnchors() {
    resolvedAnchors = new Map();
    const doc = getIframeDoc();
    if (!doc) { paintOverlays(); return; }
    for (const c of comments) {
      if (!c.anchor) { resolvedAnchors.set(c.id, { rects: [], found: false, topY: 0 }); continue; }
      const r = findRangeForAnchor(c.anchor);
      if (!r) { resolvedAnchors.set(c.id, { rects: [], found: false, topY: 0 }); continue; }
      const rects = Array.from(r.getClientRects());
      const topY = rects.length ? rects[0].top : 0;
      resolvedAnchors.set(c.id, { rects, found: true, topY, range: r });
    }
    paintOverlays();
    renderList();
  }

  function paintOverlays() {
    const showR = showResolvedEl.checked;
    overlay.innerHTML = '';
    gutter.innerHTML = '';
    const stageH = stage.getBoundingClientRect().height || 1;
    const iframeRect = iframe.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const offX = iframeRect.left - stageRect.left;
    const offY = iframeRect.top - stageRect.top;
    const iwin = getIframeWin();
    const idoc = getIframeDoc();
    // Total document height inside the iframe — used to map gutter dot to
    // the artifact's full scroll range, not just the visible window.
    const docH = (idoc && idoc.documentElement)
      ? Math.max(
          idoc.documentElement.scrollHeight,
          (idoc.body && idoc.body.scrollHeight) || 0,
          idoc.documentElement.clientHeight
        )
      : 0;
    const scrollY = (iwin && iwin.scrollY) || 0;
    for (const c of comments) {
      if (c.status === 'resolved' && !showR) continue;
      const info = resolvedAnchors.get(c.id);
      if (!info || !info.found) continue;
      // Recompute rects live from the resolved Range. getClientRects() on a
      // Range inside the iframe returns rects relative to the iframe window
      // viewport, which already accounts for the iframe's internal scroll.
      // Cached rects (from resolveAnchors) would not move when the iframe
      // scrolls, so we always read fresh ones here.
      let rects = info.rects;
      if (info.range) {
        try {
          const live = Array.from(info.range.getClientRects());
          if (live.length) rects = live;
        } catch(_) {}
      }
      for (const rect of rects) {
        const div = document.createElement('div');
        div.className = 'hl';
        if (c.status === 'resolved') div.style.opacity = '.4';
        div.style.left = (offX + rect.left) + 'px';
        div.style.top = (offY + rect.top) + 'px';
        div.style.width = rect.width + 'px';
        div.style.height = rect.height + 'px';
        div.setAttribute('data-id', c.id);
        overlay.appendChild(div);
      }
      // gutter dot — map the anchor's document-space Y to the gutter's
      // visible height. Document-space Y is rect.top + scrollY at the time
      // we measured. Using the live rects keeps it accurate after scroll.
      const firstRect = rects[0];
      const docY = firstRect ? (firstRect.top + scrollY) : 0;
      const yFrac = docH > 0 ? Math.max(0, Math.min(1, docY / docH)) : 0;
      const dot = document.createElement('div');
      dot.className = 'dot' + (c.status === 'resolved' ? ' resolved' : '');
      dot.style.top = (yFrac * stageH) + 'px';
      dot.title = c.author + ': ' + c.body.slice(0, 80);
      dot.addEventListener('click', function(){ scrollToComment(c.id); });
      gutter.appendChild(dot);
    }
  }

  function scrollToComment(id) {
    const info = resolvedAnchors.get(id);
    const win = getIframeWin();
    if (info && info.found && info.range && win) {
      const rect = info.range.getBoundingClientRect();
      const targetY = (win.scrollY || 0) + rect.top - 80;
      try { win.scrollTo({ top: targetY, behavior: 'smooth' }); } catch(_) { win.scrollTo(0, targetY); }
      // flash highlight
      setTimeout(function(){
        resolveAnchors();
        const els = overlay.querySelectorAll('[data-id="' + id + '"]');
        els.forEach(function(el){ el.classList.add('flash'); });
        setTimeout(function(){ els.forEach(function(el){ el.classList.remove('flash'); }); }, 900);
      }, 300);
    }
  }

  function buildAnchorFromSelection() {
    const doc = getIframeDoc();
    const win = getIframeWin();
    if (!doc || !win) return null;
    const sel = win.getSelection && win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    let quote = String(sel.toString() || '').trim();
    if (!quote) return null;
    if (quote.length > MAX_QUOTE) quote = quote.slice(0, MAX_QUOTE);
    const full = doc.body.innerText;
    const idx = full.indexOf(quote);
    let prefix = '', suffix = '';
    if (idx >= 0) {
      prefix = full.slice(Math.max(0, idx - MAX_CTX), idx);
      suffix = full.slice(idx + quote.length, idx + quote.length + MAX_CTX);
    }
    const rect = range.getBoundingClientRect();
    return { anchor: { quote, prefix, suffix }, rect };
  }

  function showCommentButtonForSelection() {
    const sel = buildAnchorFromSelection();
    if (!sel) { commentBtn.style.display = 'none'; return; }
    const iframeRect = iframe.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const x = (iframeRect.left - stageRect.left) + sel.rect.left + sel.rect.width;
    const y = (iframeRect.top - stageRect.top) + sel.rect.top - 30;
    commentBtn.style.left = Math.max(4, x - 70) + 'px';
    commentBtn.style.top = Math.max(4, y) + 'px';
    commentBtn.style.display = 'block';
    commentBtn._pending = sel.anchor;
  }

  commentBtn.addEventListener('click', async function(){
    let name = getName();
    if (!name) { await askName(); name = getName(); }
    if (!name) return;
    pendingAnchor = commentBtn._pending || null;
    composerCtx.textContent = pendingAnchor ? ('"' + pendingAnchor.quote + '"') : '(no anchor)';
    composer.classList.add('active');
    composerBody.focus();
    commentBtn.style.display = 'none';
  });

  composerCancel.addEventListener('click', function(){
    composer.classList.remove('active');
    composerBody.value = '';
    pendingAnchor = null;
  });

  composer.addEventListener('submit', async function(e){
    e.preventDefault();
    const body = (composerBody.value || '').trim();
    if (!body) return;
    const author = getName();
    if (!author) { await askName(); }
    const payload = { anchor: pendingAnchor, body: body.slice(0, MAX_BODY), author: getName() };
    try {
      const r = await fetch('/v/' + SLUG + '/comments', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const created = await r.json();
      composer.classList.remove('active');
      composerBody.value = '';
      pendingAnchor = null;
      // Optimistic insert — KV list() is eventually consistent and may not
      // reflect this comment for up to ~60s. Show it immediately, then let
      // the next poll reconcile.
      if (created && created.id && !comments.some(function(c){ return c.id === created.id; })) {
        comments.push(created);
        renderList();
        resolveAnchors();
      }
      // Clear the iframe selection so the next selection re-triggers the button.
      try { getIframeWin().getSelection().removeAllRanges(); } catch(_) {}
      commentBtn.style.display = 'none';
    } catch (err) {
      alert('Failed to post comment: ' + err);
    }
  });

  let listenersAttached = false;
  let scrollPaintScheduled = false;
  function schedulePaint() {
    if (scrollPaintScheduled) return;
    scrollPaintScheduled = true;
    requestAnimationFrame(function(){
      scrollPaintScheduled = false;
      paintOverlays();
      // Also re-show or re-position the floating comment button if a
      // selection is active, so it tracks the text while scrolling.
      try { showCommentButtonForSelection(); } catch(_) {}
    });
  }
  function attachIframeListeners() {
    const doc = getIframeDoc();
    const win = getIframeWin();
    if (!doc || !win) return;
    if (listenersAttached) return;
    listenersAttached = true;
    doc.addEventListener('selectionchange', function(){
      // Debounce-ish: defer to next frame so the rect is final.
      requestAnimationFrame(showCommentButtonForSelection);
    });
    doc.addEventListener('mouseup', function(){
      requestAnimationFrame(showCommentButtonForSelection);
    });
    win.addEventListener('scroll', schedulePaint, { passive: true });
    win.addEventListener('resize', function(){ resolveAnchors(); });
  }

  function tryAttachNow() {
    const doc = getIframeDoc();
    if (doc && doc.readyState && doc.readyState !== 'loading') {
      attachIframeListeners();
      resolveAnchors();
    }
  }

  iframe.addEventListener('load', function(){
    listenersAttached = false; // re-attach to the new contentWindow on reload
    attachIframeListeners();
    resolveAnchors();
  });
  // The iframe may already be loaded by the time this script runs (same-origin
  // /raw fetch can complete before the wrapper script executes). Without this,
  // the 'load' listener above never fires and scroll/resize handlers are
  // never wired up — so highlights would not track iframe scrolling.
  tryAttachNow();
  window.addEventListener('resize', function(){ resolveAnchors(); });
  // Wrapper-window scroll (e.g. mobile chrome bar / overflow) should also
  // repaint, since overlay coordinates are stage-relative.
  window.addEventListener('scroll', schedulePaint, { passive: true });

  // Initial load + poll.
  fetchComments();
  setInterval(fetchComments, 5000);

  // Prompt for name on first interaction if missing.
  document.addEventListener('click', function once(){
    if (!getName()) askName();
    document.removeEventListener('click', once);
  }, { once: true });
})();
</script>
</body>
</html>`;
}

// ---------- comment handlers ----------

const COMMENT_ID_ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateAnchor(raw: unknown): { ok: true; anchor: Comment["anchor"] } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, anchor: null };
  if (!isPlainObject(raw)) return { ok: false, message: "anchor must be null or an object" };
  const quote = raw.quote;
  const prefix = raw.prefix;
  const suffix = raw.suffix;
  if (typeof quote !== "string" || typeof prefix !== "string" || typeof suffix !== "string") {
    return { ok: false, message: "anchor.quote, anchor.prefix, anchor.suffix must be strings" };
  }
  if (quote.length === 0) return { ok: false, message: "anchor.quote must be non-empty" };
  if (quote.length > MAX_ANCHOR_QUOTE) return { ok: false, message: `anchor.quote exceeds ${MAX_ANCHOR_QUOTE} chars` };
  if (prefix.length > MAX_ANCHOR_CONTEXT)
    return { ok: false, message: `anchor.prefix exceeds ${MAX_ANCHOR_CONTEXT} chars` };
  if (suffix.length > MAX_ANCHOR_CONTEXT)
    return { ok: false, message: `anchor.suffix exceeds ${MAX_ANCHOR_CONTEXT} chars` };
  return { ok: true, anchor: { quote, prefix, suffix } };
}

async function handleCommentList(env: Env, request: Request, slug: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return err(404, "Page not found");
  if (!commentsOn(rec)) return err(403, "Comments are disabled for this page", "comments_disabled");
  const gate = await requireViewerAccess(rec, request, { json: true });
  if (gate) return gate;

  const url = new URL(request.url);
  const statusFilter = (url.searchParams.get("status") || "open").toLowerCase();
  if (statusFilter !== "open" && statusFilter !== "all") {
    return err(400, "status must be 'open' or 'all'");
  }

  let all = await listComments(env, slug);
  if (statusFilter === "open") all = all.filter((c) => c.status === "open");
  return json({ slug, comments: all });
}

async function handleCommentCreate(env: Env, request: Request, slug: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return err(404, "Page not found");
  if (!commentsOn(rec)) return err(403, "Comments are disabled for this page", "comments_disabled");
  const gate = await requireViewerAccess(rec, request, { json: true });
  if (gate) return gate;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const text = typeof body?.body === "string" ? body.body : null;
  if (!text || !text.trim()) return err(400, "Field 'body' is required");
  if (text.length > MAX_COMMENT_BODY) return err(400, `body exceeds ${MAX_COMMENT_BODY} chars`);

  const author = typeof body?.author === "string" ? body.author.trim() : "";
  if (!author) return err(400, "Field 'author' is required");
  if (author.length > MAX_COMMENT_AUTHOR) return err(400, `author exceeds ${MAX_COMMENT_AUTHOR} chars`);

  const anchorResult = validateAnchor(body?.anchor);
  if (!anchorResult.ok) return err(400, anchorResult.message);

  const id = `c_${randomString(COMMENT_ID_LEN, COMMENT_ID_ALPHA)}`;
  const comment: Comment = {
    id,
    slug,
    anchor: anchorResult.anchor,
    body: text,
    author,
    status: "open",
    created_at: Date.now(),
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
  };

  const putOpts: KVNamespacePutOptions = {};
  if (rec.expires_at) {
    const ttl = Math.max(60, Math.ceil((rec.expires_at - Date.now()) / 1000));
    putOpts.expirationTtl = ttl;
  }
  await env.PAGES.put(commentKey(slug, id), JSON.stringify(comment), putOpts);

  return json(comment, 201);
}

async function handleCommentPatch(request: Request, env: Env, slug: string, id: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return err(404, "Page not found");
  const authErr = await requireOwner(request, rec);
  if (authErr) return authErr;

  const comment = await getComment(env, slug, id);
  if (!comment) return err(404, "Comment not found");

  let body: any;
  try {
    body = await request.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  if (body?.status !== undefined) {
    if (body.status !== "open" && body.status !== "resolved") {
      return err(400, "status must be 'open' or 'resolved'");
    }
    if (body.status === "resolved" && comment.status !== "resolved") {
      comment.status = "resolved";
      comment.resolved_at = Date.now();
      const by = request.headers.get("x-resolved-by");
      comment.resolved_by = by && by.toLowerCase() === "agent" ? "agent" : "owner";
    } else if (body.status === "open" && comment.status !== "open") {
      comment.status = "open";
      comment.resolved_at = null;
      comment.resolved_by = null;
    }
  }

  if (body?.resolution_note !== undefined) {
    if (body.resolution_note === null) {
      comment.resolution_note = null;
    } else if (typeof body.resolution_note === "string") {
      if (body.resolution_note.length > MAX_RESOLUTION_NOTE) {
        return err(400, `resolution_note exceeds ${MAX_RESOLUTION_NOTE} chars`);
      }
      comment.resolution_note = body.resolution_note;
    } else {
      return err(400, "resolution_note must be a string or null");
    }
  }

  const putOpts: KVNamespacePutOptions = {};
  if (rec.expires_at) {
    const ttl = Math.max(60, Math.ceil((rec.expires_at - Date.now()) / 1000));
    putOpts.expirationTtl = ttl;
  }
  await env.PAGES.put(commentKey(slug, id), JSON.stringify(comment), putOpts);
  return json(comment);
}

async function handleCommentDelete(request: Request, env: Env, slug: string, id: string): Promise<Response> {
  const rec = await getPage(env, slug);
  if (!rec) return err(404, "Page not found");
  const authErr = await requireOwner(request, rec);
  if (authErr) return authErr;

  const existing = await getComment(env, slug, id);
  if (!existing) return err(404, "Comment not found");
  await env.PAGES.delete(commentKey(slug, id));
  return json({ slug, id, deleted: true });
}

// ---------- landing ----------

function landing(request: Request): Response {
  const u = new URL(request.url);
  const base = `${u.protocol}//${u.host}`;
  const html = `<!doctype html>
<meta charset="utf-8">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>publish-cloudflare</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#555; --bg:#fff; --code:#f4f4f5; --border:#e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --muted:#aaa; --bg:#0b0b0c; --code:#1a1a1d; --border:#27272a; } }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; color: var(--fg); background: var(--bg); line-height: 1.55; }
  code, pre { background: var(--code); border-radius: .35rem; }
  code { padding: .1rem .35rem; font-size: .92em; }
  pre { padding: .9rem 1rem; overflow-x: auto; border: 1px solid var(--border); }
  h1 { margin-bottom: .25rem; }
  .muted { color: var(--muted); }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--border); font-size: .92rem; }
</style>
<h1>publish-cloudflare</h1>
<p class="muted">A self-hosted clone of htmlship.com on Cloudflare Workers + KV.</p>

<h2>Quick publish</h2>
<pre><code>publish-cf publish report.html</code></pre>

<h2>API</h2>
<table>
  <tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
  <tr><td>POST</td><td><code>/api/v1/pages</code></td><td>Create page (returns slug + owner_key)</td></tr>
  <tr><td>GET</td><td><code>/api/v1/pages/:slug</code></td><td>Metadata only</td></tr>
  <tr><td>PATCH</td><td><code>/api/v1/pages/:slug</code></td><td>Update html/title/comments_enabled/password (X-Owner-Key)</td></tr>
  <tr><td>DELETE</td><td><code>/api/v1/pages/:slug</code></td><td>Delete (X-Owner-Key)</td></tr>
  <tr><td>GET</td><td><code>/v/:slug</code></td><td>View rendered page (CSP enforced). Password-gated pages can be unlocked by viewer cookie or by sending <code>X-Owner-Key</code>.</td></tr>
  <tr><td>GET</td><td><code>/v/:slug/comments</code></td><td>List comments. Same auth: viewer cookie or <code>X-Owner-Key</code>.</td></tr>
</table>

<p class="muted">Endpoint: <code>${escapeHtml(base)}</code></p>
`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

// ---------- router ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return corsPreflight();

    // Treat HEAD like GET (return same headers, no body — Workers strip body automatically).
    const effectiveMethod = method === "HEAD" ? "GET" : method;

    // GET /
    if (pathname === "/" && effectiveMethod === "GET") return landing(request);

    // GET /favicon.svg  and  GET /favicon.ico — both serve the same SVG.
    // Browsers default-request /favicon.ico, so we honor it with image/svg+xml.
    if ((pathname === "/favicon.svg" || pathname === "/favicon.ico") && effectiveMethod === "GET") {
      return serveFavicon();
    }

    // /api/v1/pages and /api/v1/pages/:slug
    if (pathname === "/api/v1/pages" && method === "POST") return handleCreate(request, env);
    const apiMatch = pathname.match(/^\/api\/v1\/pages\/([a-z0-9]+)\/?$/);
    if (apiMatch) {
      const slug = apiMatch[1];
      if (effectiveMethod === "GET") return handleGetMeta(env, request, slug);
      if (method === "PATCH") return handlePatch(request, env, slug);
      if (method === "DELETE") return handleDelete(request, env, slug);
      return err(405, `Method ${method} not allowed`);
    }

    // /v/:slug/comments and /v/:slug/comments/:id (must come before /v/:slug)
    const commentItemMatch = pathname.match(/^\/v\/([a-z0-9]+)\/comments\/(c_[a-z0-9]+)\/?$/);
    if (commentItemMatch) {
      const slug = commentItemMatch[1];
      const id = commentItemMatch[2];
      if (method === "PATCH") return handleCommentPatch(request, env, slug, id);
      if (method === "DELETE") return handleCommentDelete(request, env, slug, id);
      return err(405, `Method ${method} not allowed`);
    }

    const commentListMatch = pathname.match(/^\/v\/([a-z0-9]+)\/comments\/?$/);
    if (commentListMatch) {
      const slug = commentListMatch[1];
      if (effectiveMethod === "GET") return handleCommentList(env, request, slug);
      if (method === "POST") return handleCommentCreate(env, request, slug);
      return err(405, `Method ${method} not allowed`);
    }

    // /v/:slug/raw — original artifact under strict CSP
    const rawMatch = pathname.match(/^\/v\/([a-z0-9]+)\/raw\/?$/);
    if (rawMatch) {
      const slug = rawMatch[1];
      if (effectiveMethod === "GET") return handleViewRaw(request, env, slug);
      return new Response("Method not allowed", { status: 405 });
    }

    // /v/:slug — wrapper page
    const viewMatch = pathname.match(/^\/v\/([a-z0-9]+)\/?$/);
    if (viewMatch) {
      const slug = viewMatch[1];
      if (effectiveMethod === "GET" || method === "POST") return handleViewWrapper(request, env, slug);
      return new Response("Method not allowed", { status: 405 });
    }

    if (pathname === "/healthz" && effectiveMethod === "GET") return new Response("ok", { status: 200 });

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
