import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { transition } from "../src/engine.mjs";
import {
  discountEnquiry, generalCatalogQuestion, enquiryIntent,
  requestedUnlistedTitle, messageLanguage,
} from "../src/language.mjs";
import { all } from "../src/service.mjs";

const db = database();
db.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
const products = await all(db, "SELECT * FROM products ORDER BY rowid");
db.close();

test("discount questions from the screenshot never turn into fictitious book titles", async () => {
  for (const [input, language, expected] of [
    ["Is there any discount?", "en", /No discounts are currently listed/],
    ["Do you have any discount?", "en", /No discounts are currently listed/],
    ["Any offers?", "en", /No discounts are currently listed/],
    ["Kono discount ache?", "bl", /kono discount listed nei/],
    ["Discount ache naki?", "bl", /kono discount listed nei/],
    ["কোনো ছাড় আছে?", "bn", /কোনো ছাড় তালিকাভুক্ত নেই/],
    ["ডিসকাউন্ট পাবো?", "bn", /কোনো ছাড় তালিকাভুক্ত নেই/],
  ]) {
    let aiCalled = false;
    const r = await transition(null, input, products, () => {
      aiCalled = true; throw Error("AI should not classify discounts");
    });
    assert.equal(r.state.language, language, input);
    assert.match(r.reply, expected, input);
    assert.ok(r.reply.length < 155, input + " was too verbose");
    assert.equal(r.order, undefined);
    assert.equal(r.state.product, undefined);
    assert.equal(aiCalled, false);
    assert.doesNotMatch(r.reply, /Any Discount|not listed right now|demo catalogue/i);
    assert.equal(enquiryIntent(input), "discount");
    assert.equal(requestedUnlistedTitle(input), null);
  }
});

test("discounts alongside named books or multiple books never start an order", async () => {
  const selected = (await transition(null, "Hobbit", products)).state;
  for (const t of [
    "Is there a discount on The Hobbit?",
    "Do you have a discount for Hobbit and Less?",
  ]) {
    const r = await transition(selected, t, products);
    assert.match(r.reply, /No discounts are currently listed/);
    assert.equal(r.state.step, "browse");
    assert.equal(r.state.product, "hobbit"); // last selection is not overwritten
    assert.equal(r.order, undefined);
  }
  const followup = await transition(selected, "price koto?", products);
  assert.equal(followup.state.product, "hobbit");
  assert.match(followup.reply, /650/);
});

test("a discount question during the review step does not confirm or change a quote", async () => {
  let r = await transition(null, "Order Hobbit", products);
  for (const t of ["2", "none", "Demo Reader", "01700000000", "House 1 Road 2 Mirpur Dhaka"]) {
    r = await transition(r.state, t, products);
  }
  assert.equal(r.state.step, "confirm");
  const pending = structuredClone(r.state.pending);
  const answer = await transition(r.state, "Any discounts?", products);
  assert.equal(answer.state.step, "confirm");
  assert.deepEqual(answer.state.pending, pending);
  assert.equal(answer.order, undefined);
  assert.match(answer.reply, /No discounts are currently listed/);
});

test("natural catalogue questions get a short overview instead of a fake title or huge list", async () => {
  for (const [input, lang] of [
    ["Tomar kase ki ki book available ache?", "bl"],
    ["Ki ki boi ache?", "bl"],
    ["What books do you have?", "en"],
    ["Can you show me your book list?", "en"],
    ["Do you have any books available?", "en"],
    ["কি কি বই আছে?", "bn"],
  ]) {
    let aiCalled = false;
    const old = { step: "browse", product: "hobbit", language: "en" };
    const r = await transition(old, input, products, () => {
      aiCalled = true; throw Error("AI should not classify basic catalog browsing");
    });
    assert.equal(r.state.language, lang, input);
    assert.equal(r.state.product, undefined, input);
    assert.equal(r.order, undefined, input);
    assert.equal(r.engine, "rules");
    assert.equal(aiCalled, false);
    assert.ok(r.reply.length < 240, input + " response too long");
    assert.match(r.reply, /BOOKS/);
    assert.match(r.reply, /MIS BOOKS/);
    assert.doesNotMatch(r.reply, /not listed|catalogue-e nei|ডেমো অর্ডার/);
    assert.equal(generalCatalogQuestion(input), true);
    assert.equal(requestedUnlistedTitle(input), null);
  }
});

test("unlisted titles remain correctly handled, even with available ache suffixes", async () => {
  for (const [input, title, lang] of [
    ["Do you have Atomic Habits?", "Atomic Habits", "en"],
    ["Zero to one..available ache?", "Zero To One", "bl"],
    ["Dune available ache?", "Dune", "bl"],
    ["ডিউন আছে?", "ডিউন", "bn"],
  ]) {
    const r = await transition({ step:"browse", language:"en", product:"hobbit" },
      input, products, () => { throw Error("Named unlisted title should not go to AI"); });
    assert.ok(r.reply.includes(title), input + ": " + r.reply);
    assert.equal(r.state.language, lang);
    assert.equal(r.state.product, undefined);
    assert.equal(r.order, undefined);
    assert.ok(r.reply.length < 125, input);
    assert.match(r.reply, /BOOKS/);
  }
  assert.equal(messageLanguage("Is there any discount?", "bl"), "en");
  assert.equal(requestedUnlistedTitle("Do you have Dune?"), "dune");
});

test("full catalog is still available on explicit BOOKS, and lists correct inventory", async () => {
  const r = await transition(null, "BOOKS", products);
  assert.match(r.reply, /^BOOKS\n/);
  assert.match(r.reply, /Management Information Systems: Managing the Digital Firm/);
  assert.match(r.reply, /Watch Me.*out of stock/);
  assert.doesNotMatch(r.reply, /No discounts/);
  assert.equal(r.state.product, undefined);
});

test("unsupported Messenger voice messages get a direct typing hint", async () => {
  const msg = "Unsupported attachment. Please type a book title.";
  const state = { step:"browse", language:"en", product:"hobbit" };
  const r = await transition(state, msg, products);
  assert.match(r.reply, /can't read voice notes or attachments/);
  assert.ok(r.reply.length < 115);
  assert.equal(r.state.product, "hobbit");
  assert.equal(r.order, undefined);
});

test("help, greeting, fallback and recommendations use brief natural copy", async () => {
  for (const [text, pattern] of [
    ["help", /recommend fantasy books/],
    ["Hello!", /Welcome to BookHarbor!/],
    ["Please explain astronomy", /I'm not sure/],
    ["recommend fantasy books", /The Hobbit — ৳650/],
  ]) {
    const r = await transition(null, text, products);
    assert.match(r.reply, pattern);
    if (text !== "recommend fantasy books") assert.ok(r.reply.length < 185, text);
    assert.equal(r.order, undefined);
  }
});
