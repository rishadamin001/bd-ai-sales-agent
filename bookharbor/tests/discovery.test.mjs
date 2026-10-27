import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { transition } from "../src/engine.mjs";
import { all } from "../src/service.mjs";
import { discoverBooks, discoveryReply } from "../src/discovery.mjs";

const db = database();
db.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
const products = await all(db, "SELECT * FROM products");
db.close();
const noAI = () => { throw Error("Catalogue browse request should not use AI"); };

test("recommendations only list existing, in-stock D1 products with real prices", async () => {
  const r = await transition(null, "Can you recommend a book?", products, noAI);
  assert.match(r.reply, /Here are currently available books/);
  assert.match(r.reply, /Dead Poets Society — ৳520/);
  assert.match(r.reply, /The Hobbit — ৳650/);
  assert.doesNotMatch(r.reply, /Watch Me/); // stock = 0
  assert.doesNotMatch(r.reply, /bestseller|top rated/i);
  assert.equal(r.order, undefined);
  assert.equal(r.state.product, undefined);
  assert.equal(r.engine, "rules");
});

test("genre requests use actual catalogue categories and in-stock rows", async () => {
  const r = await transition(null, "Show me fantasy books", products, noAI);
  assert.match(r.reply, /The Hobbit — ৳650/);
  assert.match(r.reply, /Six of Crows — ৳780/);
  assert.doesNotMatch(r.reply, /Dead Poets Society|The Tolkien Treasury/);
  const manga = await transition(null, "Do you have manga books?", products, noAI);
  assert.match(manga.reply, /Hunter × Hunter Vol. 38 — ৳890/);
  const romance = await transition(null, "Do you have romance books?", products, noAI);
  assert.match(romance.reply, /couldn't find any currently available romance books/);
  assert.doesNotMatch(romance.reply, /Watch Me —/);
});

test("budget filters are grounded in numeric D1 prices and proper boundaries", async () => {
  const under = await transition(null, "show books under 650", products, noAI);
  assert.match(under.reply, /Dead Poets Society — ৳520/);
  assert.doesNotMatch(under.reply, /The Hobbit — ৳650/);
  const upTo = await transition(null, "fiction books up to 690", products, noAI);
  assert.match(upTo.reply, /Dead Poets Society — ৳520/);
  assert.match(upTo.reply, /Less — ৳690/);
  assert.doesNotMatch(upTo.reply, /The Hobbit/);
  const noMatch = await transition(null, "manga books under 500", products, noAI);
  assert.match(noMatch.reply, /couldn't find/);
  assert.doesNotMatch(noMatch.reply, /Hunter × Hunter Vol. 38 —/);
});

test("author catalogue filters do not hallucinate books or creators", async () => {
  const tolkien = await transition(null, "Do you have books by Tolkien?", products, noAI);
  assert.match(tolkien.reply, /The Hobbit — ৳650/);
  assert.match(tolkien.reply, /The Tolkien Treasury — ৳2400/);
  assert.doesNotMatch(tolkien.reply, /Six of Crows/);
  const unknown = await transition(null, "Do you have books by Stephen King?", products, noAI);
  assert.match(unknown.reply, /couldn't find/);
  assert.doesNotMatch(unknown.reply, /The Hobbit|Six of Crows|৳/);
});

test("Bangla and Banglish recommendations are localized and use catalog data", async () => {
  const bn = await transition(null, "ফ্যান্টাসি বই সাজেস্ট করেন", products, noAI);
  assert.equal(bn.state.language, "bn");
  assert.match(bn.reply, /আমাদের ডেমো তালিকা/);
  assert.match(bn.reply, /The Hobbit — ৳650/);
  const bl = await transition(null, "fantasy boi suggest koro", products, noAI);
  assert.equal(bl.state.language, "bl");
  assert.match(bl.reply, /Amader demo catalogue/);
  assert.match(bl.reply, /The Hobbit — ৳650/);
  const en = await transition({ step: "browse", language: "bn" }, "Show me fantasy books", products, noAI);
  assert.equal(en.state.language, "en");
  assert.match(en.reply, /Here are currently available/);
  const budget = await transition({ step: "browse", language: "bn" }, "books under 800", products, noAI);
  assert.equal(budget.state.language, "en");
});

test("browse requests cannot keep stale selections or start checkout", async () => {
  const selected = (await transition(null, "Hobbit", products)).state;
  const browse = await transition(selected, "recommend fantasy books", products, noAI);
  assert.equal(browse.state.product, undefined);
  assert.equal(browse.state.step, "browse");
  assert.equal(browse.order, undefined);
  const followup = await transition(browse.state, "buy it please", products, noAI);
  assert.equal(followup.state.step, "browse");
  assert.equal(followup.order, undefined);
  assert.match(followup.reply, /Which book/);
});

test("policy, specific titles, out-of-stock and exact confirmation behavior survive", async () => {
  const delivery = await transition(null, "delivery charge for fantasy books", products, noAI);
  assert.match(delivery.reply, /Dhaka city ৳70/);
  const title = await transition(null, "How much is The Hobbit?", products, noAI);
  assert.match(title.reply, /Price: ৳650/);
  const singleTitle = await transition(null, "Is Hobbit a fantasy book?", products, noAI);
  assert.equal(singleTitle.state.product, "hobbit");
  assert.match(singleTitle.reply, /Price: ৳650/);
  assert.doesNotMatch(singleTitle.reply, /Here are currently available fantasy books/);
  const unavailable = await transition(null, "Watch Me", products, noAI);
  assert.match(unavailable.reply, /out of stock/);
  const stale = await transition(null, "order Dune", products, noAI);
  assert.equal(stale.state.product, undefined);
  assert.equal(stale.order, undefined);
  const confirm = await transition({ step: "browse" }, "CONFIRM", products, noAI);
  assert.equal(confirm.order, undefined);
  assert.equal(confirm.state.step, "browse");
});

test("HELP offers a clear menu in the right language without interrupting checkout", async () => {
  const en = await transition(null, "help", products, noAI);
  assert.match(en.reply, /recommend fantasy books/);
  assert.match(en.reply, /HUMAN/);
  const bn = await transition(null, "সাহায্য", products, noAI);
  assert.match(bn.reply, /BookHarbor-এর নমুনা সহকারী/);
  const bl = await transition({ step: "browse", language: "bl" }, "menu", products, noAI);
  assert.match(bl.reply, /BookHarbor demo-te/);
  const duringOrder = await transition({ step: "quantity", product: "hobbit" }, "help", products, noAI);
  assert.equal(duringOrder.state.step, "quantity");
  assert.match(duringOrder.reply, /How many copies/);
});

test("discovery returns no result for nonbrowse messages or arbitrary descriptions", () => {
  for (const input of [
    "hello", "confirm", "Hobbit price koto?", "My favourite genre is fantasy",
    "How much delivery charge for fantasy books?", "I don't want to buy Hobbit",
    "Do you have the adventure about Bilbo?",
  ]) {
    const q = discoverBooks(input, products);
    assert.equal(q, null, input);
  }
  const q = discoverBooks("fantasy books", products);
  assert.equal(q.genre, "fantasy");
  assert.equal(q.totalMatches, 2);
  assert.match(discoveryReply(q, "en"), /lowest price first/);
});
