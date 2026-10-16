import { all, first, run, handleEvent, locked, drain } from "./service.mjs";
const encoder = new TextEncoder();
export async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(data)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
async function auth(req, env) {
  if (!env.ADMIN_KEY) return false;
  const value = (req.headers.get("cookie") || "").match(
    /(?:^|; )bh_session=([^;]+)/,
  )?.[1];
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return equal(sig || "", await hmac(env.ADMIN_KEY, exp));
}
async function login(env, local = false) {
  const exp = String(Date.now() + 8 * 3600000),
    sig = await hmac(env.ADMIN_KEY, exp);
  return json({ ok: true }, 200, {
    "Set-Cookie": `bh_session=${exp}.${sig}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${local ? "" : "; Secure"}`,
  });
}
export async function webhook(req, env) {
  const u = new URL(req.url);
  if (req.method === "GET") {
    return env.FB_VERIFY_TOKEN &&
      u.searchParams.get("hub.mode") === "subscribe" &&
      equal(u.searchParams.get("hub.verify_token") || "", env.FB_VERIFY_TOKEN)
      ? new Response(u.searchParams.get("hub.challenge") || "")
      : new Response("Verification failed", { status: 403 });
  }
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (!env.FB_APP_SECRET)
    return new Response("Not configured", { status: 503 });
  const raw = await req.text();
  if (raw.length > 100000) return new Response("Too large", { status: 413 });
  if (
    !equal(
      req.headers.get("x-hub-signature-256") || "",
      "sha256=" + (await hmac(env.FB_APP_SECRET, raw)),
    )
  )
    return new Response("Invalid signature", { status: 403 });
  let body;
  try { body = JSON.parse(raw); } catch { return new Response("Invalid JSON", {status:400}); }
  if (body.object !== "page") return new Response("Ignored");
  for (const entry of body.entry || []) {
    if (String(entry.id) !== env.FB_PAGE_ID) continue;
    for (const e of entry.messaging || []) {
      if (
        (!e.message?.mid && !e.postback) ||
        e.message?.is_echo ||
        !e.sender?.id ||
        e.sender.id === env.FB_PAGE_ID
      )
        continue;
      if (e.recipient?.id !== env.FB_PAGE_ID) continue;
      const commands = { GET_STARTED: "hello", CATALOG: "catalog", DELIVERY: "delivery", HUMAN: "human" };
      const text = e.postback
        ? commands[e.postback.payload] || "help"
        : e.message.text || "Unsupported attachment. Please type a book title.";
      // Future/stale callbacks do not start new responses outside the allowed window.
      const created = Number(e.timestamp);
      if (
        !Number.isFinite(created) ||
        created > Date.now() + 60000 ||
        Date.now() - created > 23 * 3600000
      )
        continue;
      await run(
        env.DB,
        "INSERT OR IGNORE INTO events(id,conversation_id,text,created) VALUES(?,?,?,?)",
        "fb:" + (e.message?.mid || e.postback.mid || await hmac(env.FB_APP_SECRET, JSON.stringify([e.sender.id, created, e.postback.payload]))),
        "fb:" + e.sender.id,
        String(text).slice(0, 1500),
        created,
      );
      console.log(JSON.stringify({event:"facebook_received",kind:e.postback ? "postback" : "message",at:created}));
    }
  }
  return new Response("EVENT_RECEIVED");
}
async function route(req, env, ctx) {
  const u = new URL(req.url),
    p = u.pathname;
  if (p === "/webhook") {
    const r = await webhook(req, env);
    if (r.ok && req.method === "POST") ctx.waitUntil(drain(env));
    return r;
  }
  if (p === "/api/health") return json({ ok: true, demo: true });
  if (p === "/api/catalog")
    return json(await all(env.DB, "SELECT * FROM products ORDER BY rowid"));
  if (
    p === "/api/local-login" &&
    req.method === "POST" &&
    env.LOCAL_DEMO === "true" &&
    u.hostname === "127.0.0.1"
  )
    return login(env, true);
  if (p === "/api/login" && req.method === "POST") {
    if (!env.ADMIN_KEY)
      return json({ error: "Owner password not configured" }, 503);
    const ip = req.headers.get("cf-connecting-ip") || "local";
    const bucket =
      "login:" +
      (await hmac(env.ADMIN_KEY, ip)) +
      ":" +
      Math.floor(Date.now() / 60000);
    await run(
      env.DB,
      "INSERT INTO settings VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
      bucket,
    );
    const attempts = await first(
      env.DB,
      "SELECT value FROM settings WHERE key=?",
      bucket,
    );
    if (Number(attempts.value) > 10)
      return json({ error: "Too many attempts. Wait a minute." }, 429);
    const body = await req.json();
    if (
      typeof body.password !== "string" ||
      !equal(
        await hmac(env.ADMIN_KEY, body.password),
        await hmac(env.ADMIN_KEY, env.ADMIN_KEY),
      )
    )
      return json({ error: "Incorrect password" }, 401);
    return login(env, env.LOCAL_DEMO === "true");
  }
  if (p.startsWith("/api/")) {
    if (!(await auth(req, env)))
      return json({ error: "Sign in to the private demo dashboard" }, 401);
    if (req.method !== "GET" && req.headers.get("origin") !== u.origin)
      return json({ error: "Origin not allowed" }, 403);
    if (p === "/api/facebook/subscription" && ["GET", "POST"].includes(req.method)) {
      if (!env.FB_PAGE_ACCESS_TOKEN) return json({error:"Page token missing"},503);
      const graph = async (path, method="GET") => {
        const response = await fetch(`https://graph.facebook.com/${env.GRAPH_VERSION}/${path}`, {
          method, headers:{Authorization:"Bearer " + env.FB_PAGE_ACCESS_TOKEN}, signal:AbortSignal.timeout(10000),
          ...(method === "POST" ? {body:new URLSearchParams({subscribed_fields:"messages,messaging_postbacks"})} : {}),
        });
        const data = await response.json();
        if (!response.ok || data.error) return {ok:false,http:response.status,code:data.error?.code,subcode:data.error?.error_subcode,type:data.error?.type,message:String(data.error?.message || '').replaceAll(env.FB_PAGE_ACCESS_TOKEN,'[REDACTED]').replaceAll(env.FB_APP_SECRET || '__unused__','[REDACTED]').replace(/EAA[A-Za-z0-9]+/g,'[REDACTED]').slice(0,500)};
        return {ok:true,data};
      };
      const identity = await graph("me?fields=id,name");
      if (!identity.ok || String(identity.data.id) !== env.FB_PAGE_ID) return json({ok:false,stage:"page-token",identity},400);
      const write = req.method === "POST" ? await graph(`${env.FB_PAGE_ID}/subscribed_apps`, "POST") : null;
      const read = await graph(`${env.FB_PAGE_ID}/subscribed_apps`);
      return json({ok:read.ok && (!write || write.ok),page:identity.data,write,subscription:read});
    }
    if (p === "/api/facebook/webhook-check" && req.method === "POST") {
      if (!env.FB_APP_SECRET || !env.FB_VERIFY_TOKEN) return json({error:"Webhook secrets missing"},503);
      const raw = JSON.stringify({object:"page",entry:[]});
      const check = signature => webhook(new Request(u.origin + "/webhook", {method:"POST",headers:{"x-hub-signature-256":signature},body:raw}),env);
      const good = await check("sha256=" + await hmac(env.FB_APP_SECRET,raw));
      const bad = await check("sha256=invalid");
      const verify = new URL(u.origin + "/webhook");
      verify.search = new URLSearchParams({"hub.mode":"subscribe","hub.verify_token":env.FB_VERIFY_TOKEN,"hub.challenge":"bookharbor-check"});
      const verification = await webhook(new Request(verify),env);
      return json({signedPost:good.status,invalidSignature:bad.status,verificationGet:verification.status,challengeMatches:(await verification.text()) === "bookharbor-check",synthetic:true});
    }
    if (p === "/api/ai-check" && req.method === "POST") {
      if (!env.AI) return json({ ok: false, error: "AI binding missing" });
      try {
        const result = await env.AI.run(env.AI_MODEL, {
          messages: [{role: "user", content: 'Return only this JSON: {"intent":"product","product_id":"hobbit"} /no_think'}],
          max_tokens: 256,
          temperature: 0,
        });
        return json({ok:true, model:env.AI_MODEL, result});
      } catch (error) {
        return json({ok:false, model:env.AI_MODEL, error:String(error.message).slice(0,500)});
      }
    }
    if (p === "/api/status")
      return json({
        local: env.LOCAL_DEMO === "true",
        ai: !!env.AI && env.AI_ENABLED === "true",
        facebookConfigured: !!(
          env.FB_APP_SECRET &&
          env.FB_PAGE_ACCESS_TOKEN &&
          env.FB_VERIFY_TOKEN
        ),
        paused:
          (await first(env.DB, "SELECT value FROM settings WHERE key='paused'"))
            ?.value === "true",
        pageId: env.FB_PAGE_ID,
      });
    if (p === "/api/chat" && req.method === "POST") {
      const b = await req.json();
      if (
        typeof b.text !== "string" ||
        !b.text.trim() ||
        b.text.length > 1500 ||
        !/^demo:[\w-]{8,80}$/.test(b.conversation_id || "") ||
        !/^web:[\w-]{8,80}$/.test(b.id || "")
      )
        return json({ error: "Invalid message" }, 400);
      const event = {
        id: b.id,
        conversation_id: b.conversation_id,
        text: b.text.trim(),
        created: Date.now(),
      };
      await run(
        env.DB,
        "INSERT OR IGNORE INTO events(id,conversation_id,text,created) VALUES(?,?,?,?)",
        event.id,
        event.conversation_id,
        event.text,
        event.created,
      );
      const result = await locked(env, async () => {
        const stored = await first(
          env.DB,
          "SELECT * FROM events WHERE id=?",
          event.id,
        );
        if (stored.conversation_id !== event.conversation_id)
          throw Error("Event mismatch");
        return handleEvent(env, stored);
      });
      return result
        ? json(result)
        : json(
            {
              error:
                "Another message is being processed. Retry in a moment with the same message.",
            },
            409,
          );
    }
    if (p === "/api/dashboard")
      return json({
        orders: await all(
          env.DB,
          "SELECT * FROM orders ORDER BY created DESC LIMIT 100",
        ),
        conversations: await all(
          env.DB,
          "SELECT * FROM conversations ORDER BY updated DESC LIMIT 50",
        ),
        messages: await all(
          env.DB,
          "SELECT * FROM messages ORDER BY id DESC LIMIT 150",
        ),
        events: await all(
          env.DB,
          "SELECT id,status,engine,error,created FROM events ORDER BY created DESC LIMIT 50",
        ),
      });
    if (p === "/api/pause" && req.method === "POST") {
      const b = await req.json();
      await run(
        env.DB,
        "UPDATE settings SET value=? WHERE key='paused'",
        b.paused ? "true" : "false",
      );
      return json({ ok: true });
    }
    if (p === "/api/resume" && req.method === "POST") {
      const b = await req.json();
      const result = await locked(env, async () => {
        const c = await first(
          env.DB,
          "SELECT state FROM conversations WHERE id=?",
          b.id,
        );
        if (c) {
          const s = JSON.parse(c.state);
          s.handoff = false;
          await run(
            env.DB,
            "UPDATE conversations SET state=? WHERE id=?",
            JSON.stringify(s),
            b.id,
          );
        }
        return { ok: true };
      });
      return json(result || { error: "Busy, try again" }, result ? 200 : 409);
    }
    if (p === "/api/logout" && req.method === "POST")
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "bh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
    return json({ error: "Not found" }, 404);
  }
  return env.ASSETS.fetch(req);
}
export default {
  async fetch(req, env, ctx) {
    try {
      if (Number(req.headers.get("content-length") || 0) > 100000)
        return json({ error: "Request too large" }, 413);
      const r = await route(req, env, ctx);
      const out = new Response(r.body, r);
      out.headers.set("X-Content-Type-Options", "nosniff");
      out.headers.set("Referrer-Policy", "no-referrer");
      out.headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      return out;
    } catch {
      return json(
        {
          error:
            "Request could not be completed. No payment has been taken. Check the dashboard and retry later.",
        },
        500,
      );
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await drain(env);
        await run(
          env.DB,
          "DELETE FROM settings WHERE key LIKE 'login:%' AND CAST(substr(key,instr(substr(key,7),':')+7) AS INTEGER)<?",
          Math.floor(Date.now() / 60000) - 60,
        );
      })(),
    );
  },
};
