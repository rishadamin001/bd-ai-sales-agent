import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { transition, quote } from "../src/engine.mjs";
import { matchingProducts } from "../src/language.mjs";
import { all, first, run, handleEvent } from "../src/service.mjs";
import worker from "../src/worker.mjs";

const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/2026-10-27-add-mis-books.sql", import.meta.url), "utf8");
const existingIds = [
  "mis-digital-firm",
  "mis-business-driven",
  "mis-today",
  "mis-m-baltzan",
];
const env = () => {
  const DB = database();
  DB.exec(schema);
  return { DB, AI_ENABLED: "false", ADMIN_KEY: "test-owner" };
};
const noAI = () => { throw Error("Known MIS queries should not require AI"); };

test("four real MIS textbook titles are present as fictional demo inventory", async () => {
  const e = env();
  try {
    const products = await all(e.DB, "SELECT * FROM products ORDER BY rowid");
    assert.equal(products.length, 12);
    const mis = products.filter((p) => p.category === "Management Information Systems");
    assert.equal(mis.length, 4);
    assert.deepEqual(mis.map((p) => p.id), existingIds);
    assert.deepEqual(mis.map((p) => p.price), [1890, 1490, 1590, 1190]);
    assert.deepEqual(mis.map((p) => p.stock), [8, 10, 7, 12]);
    assert.ok(mis.every((p) => p.edition === "Sample paperback"));
    assert.ok(mis.every((p) => p.price > 0 && p.stock > 0 && p.aliases));
    for (const p of mis) {
      const matches = matchingProducts("Order " + p.title, products);
      assert.deepEqual(matches.map((p) => p.id), [p.id], p.title);
      const result = await transition(null, "Order " + p.title, products, noAI);
      assert.equal(result.state.product, p.id);
      assert.equal(result.state.step, "quantity");
      assert.equal(result.order, undefined);
      assert.match(result.reply, new RegExp(String(p.price)));
    }
  } finally { e.DB.close(); }
});

test("MIS enquiries browse the full category in English, Bengali and Banglish", async () => {
  const e = env();
  try {
    const products = await all(e.DB, "SELECT * FROM products");
    for (const [query,lang] of [
      ["MIS books", "en"],
      ["management information systems textbooks", "en"],
      ["MIS boi ache?", "bl"],
      ["ম্যানেজমেন্ট ইনফরমেশন সিস্টেমস বই দেখান", "bn"],
    ]) {
      const r = await transition({ step: "browse", language: "bn" }, query, products, noAI);
      assert.equal(r.state.language, lang, query);
      for (const id of existingIds) {
        const title = products.find((p) => p.id === id).title;
        assert.ok(r.reply.includes(title), `Missing ${title} for ${query}`);
      }
      assert.equal(r.state.product, undefined);
      assert.equal(r.state.step, "browse");
      assert.equal(r.order, undefined);
    }
    const below1500 = await transition(null, "mis books under 1500", products, noAI);
    assert.match(below1500.reply, /M: Information Systems — ৳1190/);
    assert.match(below1500.reply, /Business Driven Information Systems — ৳1490/);
    assert.doesNotMatch(below1500.reply, /Information Systems Today|Digital Firm/);
  } finally { e.DB.close(); }
});

test("book-specific questions take precedence over MIS category discovery", async () => {
  const e = env();
  try {
    const products = await all(e.DB, "SELECT * FROM products");
    for (const [q,id,price] of [
      ["How much is Management Information Systems: Managing the Digital Firm?", "mis-digital-firm", 1890],
      ["Information Systems Today price koto?", "mis-today", 1590],
      ["Business Driven Information Systems", "mis-business-driven", 1490],
      ["M: Information Systems", "mis-m-baltzan", 1190],
    ]) {
      const r = await transition(null, q, products, noAI);
      assert.equal(r.state.product, id, q);
      assert.equal(r.state.step, "browse");
      assert.match(r.reply, new RegExp(String(price)));
    }
    const tooMany = await transition(null, "Business Driven Information Systems or M: Information Systems", products, noAI);
    assert.equal(tooMany.state.product, undefined);
    assert.match(tooMany.reply, /one title/i);
  } finally { e.DB.close(); }
});

test("MIS seed migration is repeatable and never resets existing stock or orders", async () => {
  const e = env();
  try {
    e.DB.exec("DELETE FROM products WHERE category='Management Information Systems'");
    e.DB.exec("UPDATE products SET stock=5 WHERE id='hobbit'");
    assert.equal((await all(e.DB,"SELECT * FROM products")).length, 8);
    e.DB.exec(migration);
    assert.equal((await all(e.DB,"SELECT * FROM products")).length, 12);
    e.DB.exec("UPDATE products SET stock=2 WHERE id='mis-digital-firm'");
    e.DB.exec(migration);
    assert.equal((await all(e.DB,"SELECT * FROM products")).length, 12);
    assert.equal((await first(e.DB,"SELECT stock FROM products WHERE id='hobbit'")).stock, 5);
    assert.equal((await first(e.DB,"SELECT stock FROM products WHERE id='mis-digital-firm'")).stock, 2);
  } finally { e.DB.close(); }
});

test("complete MIS order uses verified price, stock and delivery, and stores only one order", async () => {
  const e = env();
  try {
    const cid = "demo:mis-course-order";
    const send = async (text,id=crypto.randomUUID()) => {
      const event = { id: "web:" + id, conversation_id: cid, text, created: Date.now() };
      await run(e.DB, "INSERT OR IGNORE INTO events(id,conversation_id,text,created) VALUES(?,?,?,?)",
        event.id,event.conversation_id,event.text,event.created);
      return handleEvent(e,event);
    };
    let result;
    for (const message of [
      "Order Management Information Systems: Managing the Digital Firm",
      "2", "blue", "Demo Reader", "01700000000", "House 1 Road 2 Mirpur Dhaka",
    ]) result=await send(message);
    assert.deepEqual(quote({price:1890},2,"dhaka"), {subtotal:3780,delivery:70,total:3850});
    assert.match(result.reply,/3850/);
    assert.equal((await all(e.DB,"SELECT * FROM orders")).length,0);
    const confirmed=await send("CONFIRM","mis-confirm-1");
    assert.ok(confirmed.orderId);
    assert.match(confirmed.reply,/3850|confirmed/i);
    const orders=await all(e.DB,"SELECT * FROM orders");
    assert.equal(orders.length,1);
    assert.equal(orders[0].product_id,"mis-digital-firm");
    assert.equal(orders[0].total,3850);
    assert.equal(orders[0].quantity,2);
    assert.equal((await first(e.DB,"SELECT stock FROM products WHERE id='mis-digital-firm'")).stock,6);
    await send("CONFIRM","mis-confirm-1");
    await send("CONFIRM","mis-confirm-2");
    assert.equal((await all(e.DB,"SELECT * FROM orders")).length,1);
  } finally { e.DB.close(); }
});

test("public catalogue API and browser storefront show MIS products without login", async () => {
  const e=env();
  try {
    const req=new Request("https://demo.test/api/catalog");
    const response=await worker.fetch(req,e,{waitUntil(){}});
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.filter(p=>p.category==="Management Information Systems").length,4);
    assert.ok(data.some(p=>p.id==="mis-today" && p.price===1590));
    const html=await readFile(new URL("../public/index.html",import.meta.url),"utf8");
    const js=await readFile(new URL("../public/app.js",import.meta.url),"utf8");
    assert.match(html,/data-filter="Management Information Systems"/);
    assert.match(html,/data-message="mis books"/);
    assert.match(js,/Start demo order/);
    assert.match(js,/send\("Order " \+ p\.title\)/);
    assert.match(js,/mis textbooks/);
  } finally { e.DB.close(); }
});
