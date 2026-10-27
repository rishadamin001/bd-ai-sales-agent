import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { transition } from "../src/engine.mjs";
import { all } from "../src/service.mjs";
import { messageLanguage, requestedUnlistedTitle } from "../src/language.mjs";

const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const db = database();
db.exec(schema);
const products = await all(db, "SELECT * FROM products");
db.close();

test("explicit English replies in English after Bangla or Banglish", async () => {
  for (const previous of ["bn", "bl"]) {
    const r = await transition({ step: "browse", language: previous }, "How much is The Hobbit?", products);
    assert.equal(r.state.language, "en");
    assert.match(r.reply, /Price: ৳650/);
    assert.match(r.reply, /In stock: 12/);
    assert.doesNotMatch(r.reply, /দাম|Dam ৳/);
  }
  const greeting = await transition({ step: "browse", language: "bn" }, "Hello!", products);
  assert.equal(greeting.state.language, "en");
  assert.match(greeting.reply, /Welcome to BookHarbor/);
});

test("Bangla and Banglish responses remain in the customer's language", async () => {
  const bn = await transition({ step: "browse", language: "en" }, "হবিট দাম কত?", products);
  assert.equal(bn.state.language, "bn");
  assert.match(bn.reply, /দাম ৳650/);
  const bl = await transition({ step: "browse", language: "en" }, "Hobbit dam koto?", products);
  assert.equal(bl.state.language, "bl");
  assert.match(bl.reply, /Dam ৳650/);
  const switched = await transition(bn.state, "Can you tell me the delivery charges?", products);
  assert.equal(switched.state.language, "en");
  assert.match(switched.reply, /Demo delivery: Dhaka city ৳70/);
});

test("short choices and confirmation do not arbitrarily switch language", () => {
  for (const text of ["2", "blue", "confirm", "books", "Hobbit"]) {
    assert.equal(messageLanguage(text, "bn"), "bn", text);
  }
  assert.equal(messageLanguage("Do you have Dune?", "bn"), "en");
  assert.equal(messageLanguage("Dune kinbo", "en"), "bl");
});

test("unknown named titles get a helpful response without invented availability", async () => {
  for (const [text, expression] of [
    ["Do you have Atomic Habits?", /not listed in our current demo catalogue/],
    ["Can I buy Dune?", /not listed in our current demo catalogue/],
    ["What is the price of Dune?", /not listed in our current demo catalogue/],
    ["Dune", /not listed in our current demo catalogue/],
    ["Dune kinbo", /catalogue-e nei/],
    ["ডিউন আছে?", /তালিকায় নেই/],
  ]) {
    let aiCalled = false;
    const r = await transition({ step: "browse", language: "en", product: "hobbit" }, text, products, async () => {
      aiCalled = true;
      return { intent: "product", product_id: "hobbit", price: 1 };
    });
    assert.match(r.reply, expression, text);
    assert.equal(r.state.product, undefined, text);
    assert.equal(r.state.step, "browse", text);
    assert.equal(r.order, undefined, text);
    assert.equal(aiCalled, false, text);
    assert.doesNotMatch(r.reply, /৳650|[Pp]rice:|[Ss]tock: 12/, text);
  }
});

test("descriptions still use constrained AI to find listed books", async () => {
  assert.equal(requestedUnlistedTitle("Do you have the adventure about Bilbo?"), null);
  let called = false;
  const r = await transition(null, "Do you have the adventure about Bilbo?", products, async () => {
    called = true;
    return { intent: "product", product_id: "hobbit" };
  });
  assert.equal(called, true);
  assert.equal(r.state.product, "hobbit");
  assert.equal(r.engine, "cloudflare-ai");
  assert.match(r.reply, /650/);
});

test("professional responses support thanks, payment, returns, and catalogue in each language", async () => {
  const thankYou = await transition(null, "Thank you!", products);
  assert.match(thankYou.reply, /You're welcome/);
  const englishPayment = await transition({ step: "browse", language: "bn" }, "Can I pay with bKash?", products);
  assert.equal(englishPayment.state.language, "en");
  assert.match(englishPayment.reply, /No payment is collected/);
  const banglaReturn = await transition(null, "বই ফেরত দেওয়া যাবে?", products);
  assert.match(banglaReturn.reply, /ক্ষতিগ্রস্ত/);
  const banglishCatalog = await transition(null, "ki ki boi ache?", products);
  assert.match(banglishCatalog.reply, /DEMO CATALOGUE/);
  assert.match(banglishCatalog.reply, /Details jante boier naam likhun/);
});

test("an unlisted title cannot authorize checkout or reuse an earlier book", async () => {
  const previous = (await transition(null, "Hobbit", products)).state;
  const unlisted = await transition(previous, "order Dune", products);
  assert.equal(unlisted.state.product, undefined);
  assert.equal(unlisted.order, undefined);
  const followup = await transition(unlisted.state, "buy it please", products);
  assert.equal(followup.state.step, "browse");
  assert.equal(followup.order, undefined);
});
