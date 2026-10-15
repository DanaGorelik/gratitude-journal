// Gratitude journal: a daily WhatsApp prompt, a webhook that saves replies,
// and a private journal page.
//
// Secrets (set with `wrangler secret put NAME`):
//   WA_TOKEN            permanent WhatsApp Cloud API access token
//   WA_PHONE_NUMBER_ID  the sending phone number's id from the Meta dashboard
//   APP_SECRET          the Meta app secret, used to verify webhook signatures
//   VERIFY_TOKEN        any string; typed into Meta when registering the webhook
//   MY_NUMBER           your WhatsApp number, digits only with country code (9725XXXXXXXX)
//   JOURNAL_KEY         a long random string; the journal lives at /j/<JOURNAL_KEY>

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/webhook" && request.method === "GET") return verifyWebhook(url, env);
    if (path === "/webhook" && request.method === "POST") return receiveWebhook(request, env);

    if (path === "/privacy") return privacyPage();

    const prefix = `/j/${env.JOURNAL_KEY}`;
    if (env.JOURNAL_KEY && (path === prefix || path.startsWith(prefix + "/"))) {
      const sub = path.slice(prefix.length) || "/";
      if (sub === "/") return journalPage(env, url.searchParams.get("q") || "");
      if (sub === "/export.csv") return exportCsv(env);
      if (sub === "/send-now") {
        const res = await sendPrompt(env);
        return new Response(res.ok ? "Sent. Check WhatsApp." : `Failed: ${res.error}`, {
          status: res.ok ? 200 : 502,
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Two crons cover both summer and winter time; only the one that lands on
    // SEND_HOUR in the configured timezone sends.
    const hour = Number(localParts(new Date(event.scheduledTime), env.TIMEZONE).hour);
    if (hour !== Number(env.SEND_HOUR)) return;
    ctx.waitUntil(sendPrompt(env));
  },
};

// ---------- WhatsApp ----------

async function graph(env, body) {
  const missing = ["WA_TOKEN", "WA_PHONE_NUMBER_ID", "MY_NUMBER"].filter((k) => !env[k]);
  if (missing.length) return { ok: false, error: `Missing setting(s) in Cloudflare: ${missing.join(", ")}` };
  let res;
  try {
    res = await fetch(
      `https://graph.facebook.com/${env.GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: env.MY_NUMBER, ...body }),
      },
    );
  } catch (err) {
    console.error("WhatsApp send failed", err);
    return { ok: false, error: String(err) };
  }
  if (!res.ok) {
    const error = await res.text();
    console.error("WhatsApp send failed", res.status, error);
    return { ok: false, error };
  }
  return { ok: true };
}

function sendPrompt(env) {
  // A template is required because this message starts the conversation.
  return graph(env, {
    type: "template",
    template: { name: env.TEMPLATE_NAME, language: { code: env.TEMPLATE_LANG } },
  });
}

function sendText(env, text) {
  // Free-form text is allowed here because it answers a message you just sent.
  return graph(env, { type: "text", text: { body: text } });
}

function verifyWebhook(url, env) {
  if (
    url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN
  ) {
    return new Response(url.searchParams.get("hub.challenge") || "");
  }
  return new Response("Forbidden", { status: 403 });
}

async function receiveWebhook(request, env) {
  const raw = await request.text();
  if (!(await validSignature(raw, request.headers.get("X-Hub-Signature-256"), env.APP_SECRET))) {
    console.error("Webhook rejected: signature doesn't match APP_SECRET");
    return new Response("Bad signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        if (msg.from !== env.MY_NUMBER) {
          console.warn(`Ignoring message from ${msg.from}; MY_NUMBER is ${env.MY_NUMBER}`);
          continue;
        }
        if (msg.type !== "text") continue;
        const items = splitItems(msg.text?.body || "");
        if (!items.length) continue;

        const when = new Date(Number(msg.timestamp) * 1000);
        const p = localParts(when, env.TIMEZONE);
        const day = `${p.year}-${p.month}-${p.day}`;

        const stmt = env.DB.prepare(
          "INSERT OR IGNORE INTO entries (day, text, created_at, wa_message_id, position) VALUES (?, ?, ?, ?, ?)",
        );
        const results = await env.DB.batch(
          items.map((text, i) => stmt.bind(day, text, when.toISOString(), msg.id, i)),
        );
        // Meta retries deliveries; only acknowledge the first time we save a message.
        if (!results.some((r) => r.meta?.changes > 0)) continue;

        const { count } = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM entries WHERE day = ?",
        ).bind(day).first();
        await sendText(env, count >= 3 ? "נשמר 🙏 שיהיה יום נפלא!" : `נשמר (${count}/3) ✨`);
      }
    }
  }
  // Always 200 so Meta doesn't keep retrying.
  return new Response("OK");
}

async function validSignature(raw, header, secret) {
  if (!header || !secret || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// "1. coffee\n2) sunshine\n- my sister" -> ["coffee", "sunshine", "my sister"]
export function splitItems(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+\s*[.)\-:]|[-*•])\s*/, "").trim())
    .filter(Boolean);
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

// ---------- Journal ----------

async function journalPage(env, q) {
  const { results } = q
    ? await env.DB.prepare(
        "SELECT day, text FROM entries WHERE text LIKE ? ORDER BY day DESC, created_at, position",
      ).bind(`%${q}%`).all()
    : await env.DB.prepare(
        "SELECT day, text FROM entries ORDER BY day DESC, created_at, position",
      ).all();

  const days = new Map();
  for (const r of results) {
    if (!days.has(r.day)) days.set(r.day, []);
    days.get(r.day).push(r.text);
  }

  const today = (() => {
    const p = localParts(new Date(), env.TIMEZONE);
    return `${p.year}-${p.month}-${p.day}`;
  })();

  const cards = [...days]
    .map(
      ([day, items]) => `
      <section class="day">
        <h2>${day === today ? "Today" : formatDay(day)}</h2>
        <ul>${items.map((t) => `<li dir="auto">${esc(t)}</li>`).join("")}</ul>
      </section>`,
    )
    .join("");

  const empty = q
    ? `<p class="empty">Nothing matches “${esc(q)}”.</p>`
    : `<p class="empty">No entries yet. Answer tomorrow's 9:00 WhatsApp message and they'll show up here.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Grateful">
<meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1a17" media="(prefers-color-scheme: dark)">
<title>Grateful</title>
<style>
  :root { --bg:#faf7f2; --card:#fff; --text:#2b2722; --muted:#8a8178; --accent:#c9783a; --line:#ece6dd; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1c1a17; --card:#26231f; --text:#f1ece4; --muted:#a39a8f; --accent:#e39a5e; --line:#36322c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: env(safe-area-inset-top) 16px calc(24px + env(safe-area-inset-bottom)); }
  main { max-width: 560px; margin: 0 auto; }
  header { padding: 24px 0 8px; }
  h1 { margin:0; font-size: 28px; }
  .stats { color: var(--muted); font-size: 15px; margin: 4px 0 16px; }
  form { display:flex; gap:8px; margin-bottom: 16px; }
  input[type=search] { flex:1; font: inherit; padding: 10px 12px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--card); color: var(--text); }
  .day { background: var(--card); border: 1px solid var(--line); border-radius: 16px;
    padding: 14px 16px; margin-bottom: 12px; }
  .day h2 { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--accent);
    text-transform: uppercase; letter-spacing: .04em; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 2px 0; }
  .empty { color: var(--muted); text-align: center; padding: 40px 0; }
  footer { text-align:center; font-size: 14px; margin-top: 16px; }
  a { color: var(--muted); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Grateful</h1>
    <p class="stats">${days.size} ${days.size === 1 ? "day" : "days"} · ${results.length} things${streakText(days, today)}</p>
  </header>
  <form method="get"><input type="search" dir="auto" name="q" placeholder="Search" value="${esc(q)}"></form>
  ${cards || empty}
  <footer><a href="export.csv">Download CSV</a></footer>
</main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function streakText(days, today) {
  let streak = 0;
  const d = new Date(today + "T12:00:00Z");
  // Today not answered yet doesn't break the streak.
  if (!days.has(today)) d.setUTCDate(d.getUTCDate() - 1);
  while (days.has(d.toISOString().slice(0, 10))) {
    streak++;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak > 1 ? ` · ${streak}-day streak 🔥` : "";
}

async function exportCsv(env) {
  const { results } = await env.DB.prepare(
    "SELECT day, text FROM entries ORDER BY day, created_at, position",
  ).all();
  const csv = ["day,text", ...results.map((r) => `${r.day},"${r.text.replace(/"/g, '""')}"`)].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="gratitude.csv"',
    },
  });
}

// Meta requires a privacy policy and data-deletion URL to publish the app.
function privacyPage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy policy</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#2b2722}</style>
</head><body>
<h1>Privacy policy</h1>
<p>This is a personal gratitude journal used by its owner only. It sends one WhatsApp message a day to the owner's own number and stores the owner's replies (the text and the date) in a private database so the owner can read them later.</p>
<p>No data is shared with or sold to anyone. Messages from any other number are ignored and not stored.</p>
<h2>Data deletion</h2>
<p>All data belongs to the owner, who can delete any or all entries directly from the database at any time. To ask for deletion, contact the owner of this app.</p>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function formatDay(day) {
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
