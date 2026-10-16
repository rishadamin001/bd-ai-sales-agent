const $ = (id) => document.getElementById(id);
let products = [],
  filter = "All",
  status = {},
  busy = false,
  pending = null;
let conversation = "demo:" + crypto.randomUUID();
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed");
  return data;
}
function node(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function bubble(text, role = "assistant") {
  const e = node("div", "message " + role);
  if (role === "assistant") e.append(node("small", "", "HARBOR ASSISTANT"));
  e.append(document.createTextNode(text));
  $("messages").append(e);
  $("messages").scrollTop = $("messages").scrollHeight;
}
function welcome() {
  $("messages").replaceChildren();
  bubble(
    "Hi, reader! 👋\nI’m your automated book assistant. Ask about a title, check delivery, or place a demo order.\n\nবাংলা, Banglish, or English—your choice. Please use fictional details only.",
  );
}
function renderCatalog() {
  const query = $("search").value.toLowerCase();
  $("catalog").replaceChildren();
  for (const p of products.filter(
    (p) =>
      (filter === "All" ||
        p.category === filter ||
        (filter === "Manga" && p.category === "Comics")) &&
      (p.title + " " + p.author).toLowerCase().includes(query),
  )) {
    const card = node("article", "book-card"),
      stage = node("div", "cover-stage"),
      cover = node("div", "cover " + p.color);
    cover.append(
      node("small", "", p.author),
      node("b", "", p.title),
      node(
        "span",
        "ornament",
        p.category === "Fantasy" ? "◇" : p.category === "Comics" ? "ϟ" : "✦",
      ),
    );
    stage.append(
      cover,
      node(
        "span",
        "stock" + (!p.stock ? " out" : ""),
        p.stock ? `${p.stock} in stock` : "Sold out",
      ),
    );
    card.append(
      stage,
      node("h3", "", p.title),
      node("div", "author", p.author + " · " + p.edition),
    );
    const bottom = node("div", "card-bottom"),
      ask = node("button", "ask", "Ask about it ↗");
    ask.onclick = () => send(p.title + " price koto?");
    bottom.append(node("span", "price", "৳" + p.price.toLocaleString()), ask);
    card.append(bottom);
    $("catalog").append(card);
  }
  if (!$("catalog").children.length)
    $("catalog").append(
      node("p", "muted", "No matching titles. Try a different search."),
    );
  $("titleStat").replaceChildren(
    document.createTextNode(products.length + " "),
    node("span", "", "books to discover"),
  );
}
async function refresh() {
  try {
    products = await api("catalog");
    renderCatalog();
    status = await api("status");
    $("engineStat").textContent = status.ai ? "AI + rules" : "Rules fallback";
    $("chatStatus").textContent = status.paused
      ? "Paused by owner"
      : status.ai
        ? "Cloudflare AI + verified shop rules"
        : "Local preview · rules fallback";
    $("pause").textContent = status.paused
      ? "Resume assistant"
      : "Pause assistant";
    $("connection").replaceChildren();
    for (const [label, value] of [
      ["Hosting", status.local ? "Local preview" : "Deployed"],
      [
        "AI binding",
        status.ai ? "Available — check chat result" : "Offline / fallback",
      ],
      [
        "Facebook secrets",
        status.facebookConfigured
          ? "Configured — test delivery"
          : "Not configured",
      ],
      ["Payments", "Disabled — demo only"],
    ]) {
      const row = node("div", "status-line", label);
      row.append(node("b", "", value));
      $("connection").append(row);
    }
    await dashboard();
  } catch (e) {
    if (e.message.includes("Sign in")) $("login").showModal();
    else $("notice").textContent = e.message;
  }
}
async function dashboard() {
  const data = await api("dashboard");
  $("orderCount").textContent = data.orders.length;
  $("ordersList").replaceChildren();
  if (!data.orders.length)
    $("ordersList").append(
      node(
        "div",
        "empty",
        "No orders yet. Try “Order Hobbit” in the assistant, then confirm the summary.",
      ),
    );
  for (const o of data.orders) {
    const d = JSON.parse(o.details),
      card = node("article", "record");
    card.append(
      node("h3", "", o.id + " · Demo confirmed"),
      node("p", "", d.title + " × " + o.quantity + " · " + d.edition),
      node("p", "", `৳${o.subtotal} + ৳${o.delivery} delivery = ৳${o.total}`),
      node("p", "", `${d.name} · ${d.phone}\n${d.address}`),
      node(
        "p",
        "muted",
        `Wrap: ${d.wrap} · ${new Date(o.created).toLocaleString()} · No real dispatch`,
      ),
    );
    $("ordersList").append(card);
  }
  $("conversations").replaceChildren();
  if (!data.conversations.length)
    $("conversations").append(
      node(
        "div",
        "empty",
        "Messages from the simulator and connected Facebook Page will appear here.",
      ),
    );
  for (const c of data.conversations) {
    const state = JSON.parse(c.state),
      card = node("article", "record");
    card.append(
      node(
        "h3",
        "",
        (c.id.startsWith("fb:") ? "Facebook" : "Browser demo") +
          " · " +
          (state.handoff ? "Waiting for owner" : state.step),
      ),
      node("p", "muted", c.id),
    );
    for (const m of data.messages
      .filter((m) => m.conversation_id === c.id)
      .slice(0, 8)
      .reverse())
      card.append(
        node(
          "p",
          "",
          (m.role === "customer" ? "Customer: " : "Assistant: ") + m.text,
        ),
      );
    if (state.handoff) {
      const b = node("button", "button", "Resume assistant");
      b.onclick = async () => {
        await api("resume", { id: c.id });
        refresh();
      };
      card.append(b);
    }
    $("conversations").append(card);
  }
  $("events").replaceChildren();
  for (const e of data.events.slice(0, 12)) {
    const row = node("div", "record");
    row.append(
      node(
        "p",
        "",
        `${e.id.startsWith("fb:") ? "Facebook" : "Browser"} · ${e.status} · ${e.engine || "pending"}`,
      ),
    );
    if (e.error) row.append(node("p", "", e.error));
    $("events").append(row);
  }
}
async function send(text) {
  if (busy) return;
  busy = true;
  $("send").disabled = true;
  const payload =
    pending && pending.text === text
      ? pending
      : {
          text,
          conversation_id: conversation,
          id: "web:" + crypto.randomUUID(),
        };
  if (payload !== pending) bubble(text, "customer");
  pending = payload;
  $("message").value = "";
  const thinking = node("div", "message", "Checking the bookshelf…");
  $("messages").append(thinking);
  try {
    const r = await api("chat", payload);
    thinking.remove();
    bubble(r.reply || "Message received.");
    $("engineLabel").textContent =
      r.engine === "cloudflare-ai"
        ? "This message: Cloudflare AI interpretation + verified rules"
        : r.engine === "rules-fallback"
          ? "AI unavailable · fixed-rule fallback used"
          : "This message: verified shop rules";
    pending = null;
    await refresh();
  } catch (e) {
    thinking.remove();
    bubble(
      e.message + " Send the same message again to retry safely.",
      "error",
    );
    $("message").value = text;
  } finally {
    busy = false;
    $("send").disabled = false;
    $("message").focus();
  }
}
$("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (text) send(text);
};
$("quick").onclick = (e) => {
  if (e.target.dataset.message) send(e.target.dataset.message);
};
$("newChat").onclick = () => {
  if (busy) return;
  conversation = "demo:" + crypto.randomUUID();
  pending = null;
  welcome();
};
$("search").oninput = renderCatalog;
$("filters").onclick = (e) => {
  if (!e.target.dataset.filter) return;
  filter = e.target.dataset.filter;
  document
    .querySelectorAll("#filters button")
    .forEach((b) => b.classList.toggle("selected", b === e.target));
  renderCatalog();
};
document.querySelectorAll("[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      document
        .querySelectorAll(".page,.nav")
        .forEach((e) => e.classList.remove("active"));
      $(b.dataset.tab).classList.add("active");
      b.classList.add("active");
      $("breadcrumb").textContent =
        "Workspace / " + b.textContent.replace(/[^a-zA-Z ]/g, "").trim();
      refresh();
    }),
);
$("refresh").onclick = refresh;
$("pause").onclick = async () => {
  try {
    await api("pause", { paused: !status.paused });
    await refresh();
  } catch (e) {
    $("notice").textContent = e.message;
  }
};
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("login", { password: $("password").value });
    $("password").value = "";
    $("login").close();
    refresh();
  } catch (e) {
    $("loginError").textContent = e.message;
  }
};
$("login").addEventListener("cancel", (e) => e.preventDefault());
$("logout").onclick = async () => {
  await api("logout", {});
  $("login").showModal();
};
welcome();
if (location.hostname === "127.0.0.1") {
  await api("local-login", {}).catch(() => {});
}
await refresh();
setInterval(() => {
  if (!$("login").open && !busy) refresh();
}, 15000);
