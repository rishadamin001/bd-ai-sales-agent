import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { transition } from "../src/engine.mjs";
import { all, first, run, handleEvent } from "../src/service.mjs";
import { webhook, hmac } from "../src/worker.mjs";

const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
function fixture() {
  const DB = database();
  DB.exec(schema);
  return { DB, AI_ENABLED: "false" };
}
const fixtureEnv = fixture();
const products = await all(fixtureEnv.DB, "SELECT * FROM products");
fixtureEnv.DB.close();
const noAI = () => { throw Error("Known enquiry should not call AI"); };

test("signed Messenger events still enforce Page, recipient and time boundaries", async () => {
  const e = { ...fixture(), FB_PAGE_ID: "12345", FB_APP_SECRET: "test-secret" };
  try {
    for (const change of [
      { page: "other-page" }, { recipient: "other-page" }, { sender: "12345" },
      { timestamp: Date.now() - 24 * 3600000 }, { timestamp: Date.now() + 120000 },
      { tamper: true },
    ]) {
      const raw = JSON.stringify({ object: "page", entry: [{ id: change.page || e.FB_PAGE_ID, messaging: [{
        sender: { id: change.sender || "customer" }, recipient: { id: change.recipient || e.FB_PAGE_ID },
        timestamp: change.timestamp || Date.now(), message: { mid: crypto.randomUUID(), text: "হবিট কিনবো" },
      }] }] });
      const response = await webhook(new Request("https://demo.test/webhook", {
        method: "POST", headers: { "x-hub-signature-256": "sha256=" + await hmac(e.FB_APP_SECRET, raw) },
        body: change.tamper ? raw.replace("হবিট", "লেস") : raw,
      }), e);
      assert.equal(response.status, change.tamper ? 403 : 200);
      assert.equal((await all(e.DB, "SELECT * FROM events")).length, 0);
    }
  } finally { e.DB.close(); }
});

test("failed order insertion rolls back stock, conversation and event changes", async () => {
  const e = fixture();
  try {
    const state = { step: "confirm", product: "hobbit", quantity: 2, zone: "dhaka",
      name: "Demo Reader", phone: "01700000000", address: "House 1 Mirpur Dhaka", wrap: "blue", pending: { total: 1370 } };
    await run(e.DB, "INSERT INTO conversations VALUES(?,?,?)", "demo:rollback", JSON.stringify(state), Date.now());
    await run(e.DB, "INSERT INTO events(id,conversation_id,text,created) VALUES(?,?,?,?)", "rollback", "demo:rollback", "confirm", Date.now());
    e.DB.exec("CREATE TRIGGER reject_order BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    await assert.rejects(handleEvent(e, { id: "rollback", conversation_id: "demo:rollback", text: "confirm" }), /test failure/);
    assert.equal((await first(e.DB, "SELECT stock FROM products WHERE id='hobbit'")).stock, 12);
    assert.equal((await all(e.DB, "SELECT * FROM orders")).length, 0);
    assert.equal((await first(e.DB, "SELECT status FROM events WHERE id='rollback'")).status, "pending");
    assert.deepEqual(JSON.parse((await first(e.DB, "SELECT state FROM conversations WHERE id='demo:rollback'")).state), state);
  } finally { e.DB.close(); }
});

for (const [text, id] of [
  ["হবিটটার দাম কত?", "hobbit"], ["হবি\u200bট দাম কত?", "hobbit"],
  ["‘Less’, please", "less"], ["SIX   OF CROWS?", "six-crows"],
  ["ওয়াচ মি আছে?".normalize("NFD"), "watch-me"],
  ["Hobbit-er dam koto?", "hobbit"], ["হবিটের দাম?", "hobbit"],
]) test(`catalogue lookup: ${text}`, async () => {
  const r = await transition(null, text, products, noAI);
  assert.equal(r.state.product, id);
  assert.equal(r.engine, "rules");
  assert.equal(r.order, undefined);
  assert.equal(r.state.step, "browse");
});

for (const text of ["flashing", "hunterish", "blessed", "hopeless", "booklistened"])
  test(`no substring title or intent: ${text}`, async () => {
    const r = await transition(null, text, products);
    assert.equal(r.state.product, undefined);
    assert.match(r.reply, /not sure/);
  });

for (const text of ["Hobbit / Less", "হবিট আর লেস", "Six of Crows, Hobbit"])
  test(`ambiguous titles need clarification: ${text}`, async () => {
    const r = await transition(null, text, products, noAI);
    assert.match(r.reply, /one title/);
    assert.equal(r.state.product, undefined);
  });

for (const [text, expected] of [
  ["Hobbit order er delivery charge koto?", /70.*100.*130/],
  ["হবিট অর্ডার করলে ডেলিভারি চার্জ কত?", /70.*100.*130/],
  ["Can I pay for Hobbit with bKash?", /No payment is collected/],
  ["boi ferot deya jabe?", /48 hours/],
  ["বই ফেরত দেওয়া যাবে?", /48 hours/],
  ["ki ki boi ache?", /DEMO CATALOGUE/],
  ["বইগুলো দেখান", /DEMO CATALOGUE/],
  ["assalamualaikum!", /BookHarbor/],
]) test(`local enquiry: ${text}`, async () => {
  const r = await transition(null, text, products, noAI);
  assert.match(r.reply, expected);
  assert.equal(r.engine, "rules");
  assert.equal(r.state.step, "browse");
});

test("short follow-ups reuse the selected book, unknown titles never order it", async () => {
  const previous = (await transition(null, "Hobbit", products)).state;
  for (const text of ["দাম কত?", "dam koto?", "How much is it?", "is it available?"]) {
    const r = await transition(previous, text, products, noAI);
    assert.match(r.reply, /650/);
    assert.equal(r.engine, "rules");
  }
  for (const text of ["order Dune", "Dune kinbo", "Dune কিনব"]) {
    const r = await transition(previous, text, products, noAI);
    assert.equal(r.state.step, "browse");
    assert.match(r.reply, /Which book/);
  }
  for (const text of ["buy it please", "eta nibo", "এটা নেবো"]) {
    assert.equal((await transition(previous, text, products, noAI)).state.step, "quantity");
  }
});

test("negation cannot start checkout even with a malicious AI classifier", async () => {
  for (const text of ["I don't want to buy Hobbit", "Hobbit kinbo na", "হবিট কিনবো না", "do not order", "order na"]) {
    const r = await transition({ step: "browse", product: "hobbit" }, text, products,
      async () => ({ intent: "order", price: 1, order: true }));
    assert.equal(r.state.step, "browse", text);
    assert.equal(r.order, undefined);
  }
});

for (const [text, count] of [["দুই কপি", 2], ["দুইটা", 2], ["dui copy", 2], ["two copies", 2], ["২ কপি", 2], ["ten", 10]])
  test(`quantity: ${text}`, async () => {
    const r = await transition({ step: "quantity", product: "hobbit" }, text, products, noAI);
    assert.equal(r.state.quantity, count);
    assert.equal(r.state.step, "wrap");
  });

test("quantities remain bounded and unambiguous", async () => {
  for (const text of ["0", "১১", "eleven", "2 or 3", "দুই বা তিন", "-2", "1.5", "2 copies please 3", "two hundred"]) {
    assert.equal((await transition({ step: "quantity", product: "hobbit" }, text, products, noAI)).state.step, "quantity", text);
  }
  const r = await transition({ step: "quantity", product: "tolkien" }, "four", products, noAI);
  assert.equal(r.state.step, "quantity");
  assert.match(r.reply, /Only 3/);
});

test("wrap synonyms stay within the existing free wrap choices", async () => {
  for (const [text, wrap] of [["neel", "blue"], ["lagbe na", "none"], ["র‍্যাপ লাগবে না", "none"]]) {
    const r = await transition({ step: "wrap" }, text, products, noAI);
    assert.equal(r.state.wrap, wrap);
    assert.equal(r.state.step, "name");
  }
  for (const text of ["blue or red", "neel na", "নীল না"]) {
    assert.equal((await transition({ step: "wrap" }, text, products, noAI)).state.step, "wrap");
  }
});

test("confirmation vocabulary is unchanged; punctuation, negation and amendments cannot confirm", async () => {
  const s = { step: "confirm", product: "hobbit", quantity: 2, zone: "dhaka",
    name: "Demo Reader", phone: "01700000000", address: "House 1 Mirpur Dhaka", wrap: "none", pending: { total: 1370 } };
  for (const text of ["yes but change quantity", "confirm na", "কনফার্ম না", "confirm?", "not ok", "yes, use a different address", "confirm for 1 taka"]) {
    const r = await transition(s, text, products, noAI);
    assert.equal(r.order, undefined, text);
    assert.equal(r.state.step, "confirm");
    assert.equal(r.state.pending.total, 1370);
  }
  for (const text of ["confirm", "confirm order", "yes", "হ্যাঁ", "কনফার্ম", "নিশ্চিত", "ji", "ok"]) {
    const r = await transition(s, text, products, noAI);
    assert.equal(r.order.total, 1370, text);
  }
  assert.equal(s.step, "confirm", "caller state must not be mutated");
});

test("Bangla and Banglish cancellation and handover remain local", async () => {
  for (const text of ["অর্ডার বাতিল", "cancel korun"]) {
    const r = await transition({ step: "confirm", pending: { total: 1370 } }, text, products, noAI);
    assert.equal(r.state.step, "browse");
    assert.equal(r.state.pending, undefined);
    assert.equal(r.order, undefined);
  }
  for (const text of ["মালিকের সাথে কথা বলতে চাই", "owner er sathe kotha bolbo"]) {
    const r = await transition(null, text, products, noAI);
    assert.equal(r.state.handoff, true);
    assert.equal((await transition(r.state, "Hobbit kinbo", products, noAI)).silent, true);
  }
});

test("unfamiliar product enquiries still reach constrained AI fallback", async () => {
  const r = await transition(null, "Is the adventure about Bilbo available?", products,
    async () => ({ intent: "product", product_id: "hobbit", price: 1 }));
  assert.equal(r.engine, "cloudflare-ai");
  assert.match(r.reply, /650/);
  assert.equal(r.order, undefined);
});

for (const [start, count, wrap] of [
  ["হবিট কিনবো", "দুই কপি", "নীল"], ["Hobbit nibo", "dui copy", "nil"], ["buy Hobbit", "two copies", "blue"],
]) test(`persisted multilingual checkout: ${start}`, async () => {
  const e = fixture();
  try {
    const send = async (text, id = crypto.randomUUID()) => {
      const event = { id, conversation_id: "demo:multilingual", text, created: Date.now() };
      await run(e.DB, "INSERT OR IGNORE INTO events(id,conversation_id,text,created) VALUES(?,?,?,?)", id, event.conversation_id, text, event.created);
      return handleEvent(e, event);
    };
    for (const text of [start, count, wrap, "Demo Reader", "০১৭০০০০০০০০", "House 1 Road 2 Mirpur Dhaka"]) await send(text);
    assert.equal((await all(e.DB, "SELECT * FROM orders")).length, 0);
    await send("confirm na");
    assert.equal((await all(e.DB, "SELECT * FROM orders")).length, 0);
    const confirmation = await send("confirm", "confirmed-event");
    assert.ok(confirmation.orderId);
    await send("confirm", "confirmed-event");
    await send("confirm");
    const orders = await all(e.DB, "SELECT * FROM orders");
    assert.equal(orders.length, 1);
    assert.equal(orders[0].total, 1370);
    assert.equal(orders[0].quantity, 2);
    assert.equal((await first(e.DB, "SELECT stock FROM products WHERE id='hobbit'")).stock, 10);
  } finally { e.DB.close(); }
});
