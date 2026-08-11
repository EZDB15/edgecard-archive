// Cloudflare Pages Function: receive the first-party event beacon.
//
// WHAT THIS IS ALLOWED TO KNOW
// /privacy/ states that we do "not attempt to identify individual readers".
// That is a promise about this file, so this file is written to make breaking it
// take a deliberate edit rather than an accident:
//
//   * No visitor id is accepted. The client generates a random localStorage id
//     to derive first-vs-return LOCALLY, and never puts it in the payload -- the
//     earlier draft of this function read `d.id` anyway, which would have
//     started storing one the moment anybody added it client-side. The field is
//     gone, so there is nothing to start.
//   * The exact visit counters are BUCKETED before storage. "day 37, 12 visits"
//     is not a name, but it is close to unique across a small readership and it
//     links a reader's events together. Coarse buckets answer the only question
//     we actually ask -- are people coming back -- and do not.
//   * No IP and no user agent are stored. The IP is hashed with a daily-rotating
//     salt for rate limiting ONLY, the hash never enters a record, and it stops
//     being linkable at midnight UTC.
//   * The referring SITE is stored (`ref`), the referring URL is not. A host
//     answers "did this reader come from TwinSpires"; a full URL can carry a
//     path or query the reader never meant to hand over. Host only, always.
//
// FAIL LOUD, NEVER SILENTLY SUCCEED
// Unbound namespace returns 503. A silent 204 that discards is worse than a
// visible error, because it looks like working instrumentation and we already
// shipped a month of pages that recorded nothing without noticing.

const MAX_BYTES = 2048;

// Bounded key space. An unbounded event name is an attacker-chosen KV key, and
// it also means a typo in a template quietly creates a new metric forever.
// DERIVED FROM THE CLIENT, not from what sounded plausible. The first version
// of this list was invented: it allowed card_view, race_expand,
// methodology_view, record_view and scroll_depth -- none of which the client
// emits -- while omitting glossary_expand and record_depth, which it does. Those
// two were rejected 400 and lost from the day the beacon deployed. A bounded key
// space is still right; a bounded key space that does not match the emitter is a
// silent filter that looks like a control.
//
// Source of truth: `_EVENTS_JS` in src/hre/render/common.py. If you add an event
// there, add it here in the same change, or it is dropped without a trace.
const ALLOWED_EVENTS = new Set([
  "first_visit",      // ev(isNew ? ... )
  "return_visit",     // ev( ... : "return_visit")
  "outbound_click",
  "glossary_expand",
  "record_depth",
]);

const ALLOWED_ORIGINS = new Set([
  "https://edgecardhq.com",
  "https://www.edgecardhq.com",
]);

// Per-IP ceiling inside a one-minute window. KV is eventually consistent, so
// this is a coarse brake on a public unauthenticated writer, not an exact quota
// -- a distributed flood can still exceed it. It exists to stop one client
// looping, which is the realistic case.
const RATE_LIMIT = 60;

// Exact day/visit counts are a quasi-identifier; the bucket is the answer we use.
function bucket(n, edges) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "0";
  for (const e of edges) if (v <= e) return String(e);
  return `${edges[edges.length - 1]}+`;
}

async function ipKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) return null;
  // Salted with the UTC date so yesterday's hashes cannot be joined to today's.
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`${day}:${ip}`));
  return [...new Uint8Array(buf)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  if (!env.EC_EVENTS) {
    return new Response("event store not bound", { status: 503 });
  }

  // Only our own pages. Beacons carry an Origin, so a missing one is not a
  // same-origin beacon.
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  // Cheap reject before reading a byte. Checked again after reading, because a
  // declared Content-Length is not a promise.
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  let raw;
  try {
    raw = await request.arrayBuffer();
  } catch (err) {
    return new Response("bad payload", { status: 400 });
  }
  if (raw.byteLength > MAX_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch (err) {
    return new Response("bad payload", { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return new Response("bad payload", { status: 400 });
  }

  const name = String(body.e || "").slice(0, 40);
  if (!ALLOWED_EVENTS.has(name)) {
    return new Response("unknown event", { status: 400 });
  }

  const rk = await ipKey(request);
  if (rk) {
    const minute = Math.floor(Date.now() / 60000);
    const key = `rl:${minute}:${rk}`;
    const seen = Number((await env.EC_EVENTS.get(key)) || 0);
    if (seen >= RATE_LIMIT) {
      return new Response("slow down", { status: 429 });
    }
    // TTL 60 is the KV minimum; the window is a minute, so this is exact enough.
    await env.EC_EVENTS.put(key, String(seen + 1), { expirationTtl: 60 });
  }

  const d = (body.d && typeof body.d === "object") ? body.d : {};
  const rec = {
    e: name,
    t: Date.now(),
    // NO `id`. See the header. Do not add one back without changing /privacy/.
    path: String(d.path || "").slice(0, 120),
    visit_days_bucket: bucket(d.visit_days, [1, 2, 5, 10, 20]),
    days_since_first_bucket: bucket(d.days_since_first, [0, 1, 7, 30, 90]),
    is_first_visit: !!d.is_first_visit,
    to: String(d.to || "").slice(0, 80),
    term: String(d.term || "").slice(0, 60),
    pct: Math.max(0, Math.min(100, Number(d.pct) || 0)),

    // ARRIVAL SOURCE. The CDI licence requires their display to link to
    // /record, and that referral traffic is the only engagement signal we will
    // ever get -- CDI keeps their own analytics. Traffic that arrives before
    // this field exists is unmeasurable forever, which is why it lands ahead of
    // their page going live rather than after.
    //
    // Inside the /privacy/ promise: `ref` is the referring SITE, not a reader.
    // It says how someone arrived; it does not follow anyone anywhere, and it
    // is strictly less than Cloudflare Web Analytics already records. The host
    // only -- never the full referring URL, whose path and query can carry
    // things a reader never meant to hand over (search terms, a private page
    // title, a session token someone put in a query string).
    //
    // Stored RAW, not bucketed into "twinspires"/"other". Classification is an
    // analysis-time decision that can be revised; a label applied at write time
    // cannot. The invented ALLOWED_EVENTS list above is the standing lesson --
    // a write-time filter that looks like a control silently destroys data.
    ref: String(d.ref || "").toLowerCase().slice(0, 80),

    // Explicit campaign tag from `?s=`. Load-bearing, and NOT redundant with
    // `ref`: a `Referrer-Policy: no-referrer` on the partner's own page zeroes
    // `ref` entirely, and we neither control that header nor get told when it
    // changes. A tagged link survives it. `?s=ts` is still the /record link the
    // licence requires, so asking for it costs nothing contractually.
    src: String(d.src || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 20),
  };

  // One key per event; the analysis job aggregates. Keys sort by time so a range
  // scan is cheap. `ev:` prefixes events so a list() never returns rate-limit
  // counters as if they were data.
  await env.EC_EVENTS.put(
    `ev:${rec.t}-${crypto.randomUUID().slice(0, 8)}`,
    JSON.stringify(rec),
    { expirationTtl: 60 * 60 * 24 * 400 }
  );
  return new Response(null, { status: 204 });
}

export async function onRequestGet() {
  // The beacon is write-only. There is no read path on the public site.
  return new Response("method not allowed", { status: 405 });
}
