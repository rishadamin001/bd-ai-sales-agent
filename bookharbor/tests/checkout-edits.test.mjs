import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { transition } from "../src/engine.mjs";
import { all, first, run, handleEvent } from "../src/service.mjs";

const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
function fixture() {
  const DB = database();
  DB.exec(schema);
  return { DB, AI_ENABLED: "false" };
}
async function books(e) {
  return all(e.DB, "SELECT * FROM products ORDER BY rowid");
}
async function draft(products, book = "hobbit") {
  let r = await transition(null, "Order " + products.find(p => p.id === book).title, products);
  const text = ["2", "blue", "Demo Reader", "01700000000", "House 1 Road 2 Mirpur Dhaka"];
  for (const t of text) r = await transition(r.state, t, products);
  assert.equal(r.state.step, "confirm");
  return r.state;
}

test("editing quantity refreshes the total and requires new confirmation", async () => {
  const e = fixture();
  try {
    const products = await books(e);
    const initial = await draft(products, "mis-digital-firm");
    assert.equal(initial.pending.total, 3850);
    let r = await transition(initial, "EDIT QUANTITY", products);
    assert.equal(r.state.step, "quantity");
    assert.equal(r.state.editing, "quantity");
    assert.equal(r.state.pending, undefined);
    assert.equal(r.order, undefined);
    let attempted = await transition(r.state, "CONFIRM", products);
    assert.equal(attempted.order, undefined);
    assert.equal(attempted.state.step, "quantity");
    r = await transition(r.state, "3", products);
    assert.equal(r.state.step, "confirm");
    assert.equal(r.state.editing, undefined);
    assert.equal(r.state.quantity, 3);
    assert.equal(r.state.pending.total, 5740); // 3 * 1890 + 70
    assert.equal(r.state.address, initial.address);
    assert.equal(r.state.phone, initial.phone);
    assert.equal(r.state.wrap, "blue");
    assert.match(r.reply, /5740/);
    assert.match(r.reply, /EDIT WRAP/);
    assert.equal(r.order, undefined);
    const confirmed = await transition(r.state, "CONFIRM", products);
    assert.equal(confirmed.order.total, 5740);
    assert.equal(confirmed.order.quantity, 3);
  } finally {
    e.DB.close();
  }
});

test("changing gift wrapping preserves delivery details and reconfirms", async () => {
  const e = fixture();
  try {
    const products = await books(e);
    const initial = await draft(products);
    let r = await transition(initial, "change wrap", products);
    assert.equal(r.state.step, "wrap");
    assert.equal(r.state.pending, undefined);
    assert.equal(r.order, undefined);
    for (const invalid of ["purple", "CONFIRM", "red or blue"]) {
      const result = await transition(r.state, invalid, products);
      assert.equal(result.state.step, "wrap");
      assert.equal(result.order, undefined);
    }
    r = await transition(r.state, "none", products);
    assert.equal(r.state.step, "confirm");
    assert.equal(r.state.wrap, "none");
    assert.equal(r.state.quantity, 2);
    assert.equal(r.state.name, initial.name);
    assert.equal(r.state.address, initial.address);
    assert.equal(r.state.pending.total, 1370);
    assert.match(r.reply, /Wrap: none/);
    assert.equal(r.order, undefined);
  } finally {
    e.DB.close();
  }
});

test("invalid edited quantities and unavailable stock do not submit an order", async () => {
  const e = fixture();
  try {
    const products = await books(e);
    const initial = await draft(products, "mis-digital-firm");
    const state = (await transition(initial, "change copies", products)).state;
    for (const qty of ["0", "11", "two or three", "CONFIRM", "9"]) {
      const r = await transition(state, qty, products);
      assert.equal(r.state.step, "quantity", qty);
      assert.equal(r.order, undefined);
    }
    const valid = await transition(state, "8", products);
    assert.equal(valid.state.pending.total, 15190);
    assert.equal(valid.order, undefined);
    products.find(p => p.id === "mis-digital-firm").stock = 0;
    const changed = await transition(valid.state, "CONFIRM", products);
    assert.equal(changed.order, undefined);
    assert.equal(changed.state.step, "browse");
  } finally {
    e.DB.close();
  }
});

test("cancelled checkout removes incomplete personal details and stale title", async () => {
  const e = fixture();
  try {
    const products = await books(e);
    const original = await draft(products);
    const edited = (await transition(original, "EDIT QUANTITY", products)).state;
    const cancel = await transition(edited, "CANCEL", products);
    assert.equal(cancel.state.step, "browse");
    for (const key of ["pending", "editing", "product", "quantity", "wrap",
      "name", "phone", "address", "zone"]) {
      assert.equal(cancel.state[key], undefined, key);
    }
    const following = await transition(cancel.state, "buy it please", products);
    assert.equal(following.order, undefined);
    assert.equal(following.state.step, "browse");
  } finally {
    e.DB.close();
  }
});

test("address changes after edits require a new summary and reprice delivery", async () => {
  const e = fixture();
  try {
    const products = await books(e);
    let r = await transition(await draft(products), "EDIT QUANTITY", products);
    r = await transition(r.state, "3", products);
    assert.equal(r.state.pending.total, 2020);
    r = await transition(r.state, "EDIT WRAP", products);
    r = await transition(r.state, "red", products);
    assert.equal(r.state.wrap, "red");
    assert.equal(r.state.pending.total, 2020);
    r = await transition(r.state, "EDIT ADDRESS", products);
    assert.equal(r.state.pending, undefined);
    assert.equal(r.state.step, "address");
    r = await transition(r.state, "House 1 Road 2 Sylhet", products);
    assert.equal(r.state.step, "confirm");
    assert.equal(r.state.pending.total, 2080);
    assert.equal(r.order, undefined);
    r = await transition(r.state, "CONFIRM", products);
    assert.equal(r.order.total, 2080);
    assert.equal(r.order.details.zone, "outside");
  } finally {
    e.DB.close();
  }
});

test("safe checkout edits persist through actual database event handling", async () => {
  const e = fixture();
  try {
    const cid = "demo:edit-quantities";
    const send = async (text, id = crypto.randomUUID()) => {
      const ev = { id: "web:" + id, conversation_id: cid, text, created: Date.now() };
      await run(e.DB,
        "INSERT OR IGNORE INTO events(id,conversation_id,text,created) VALUES(?,?,?,?)",
        ev.id, ev.conversation_id, ev.text, ev.created);
      return handleEvent(e, ev);
    };
    let r;
    for (const t of [
      "Order Business Driven Information Systems", "2", "blue", "Demo Reader",
      "01700000000", "House 1 Road 2 Mirpur Dhaka",
    ]) r = await send(t);
    assert.match(r.reply, /3050/); // 2*1490 + 70
    for (const t of ["EDIT QUANTITY", "3", "EDIT WRAP", "none"]) {
      r = await send(t);
      assert.equal(r.orderId, undefined);
      assert.equal((await all(e.DB,"SELECT * FROM orders")).length, 0);
    }
    assert.match(r.reply, /4540/); // 3*1490 + 70
    assert.match(r.reply, /Wrap: none/);
    let event=await send("confirm","confirm-edited");
    assert.ok(event.orderId);
    assert.equal((await all(e.DB,"SELECT * FROM orders")).length, 1);
    assert.equal((await first(e.DB,"SELECT stock FROM products WHERE id='mis-business-driven'")).stock, 7);
    await send("confirm","confirm-edited");
    assert.equal((await all(e.DB,"SELECT * FROM orders")).length, 1);
  } finally {
    e.DB.close();
  }
});

test("Bangla commands can edit quantity and wrap with localized prompts", async () => {
  const e = fixture();
  try {
    const products = await books(e);
    const initial = await draft(products);
    let r = await transition({ ...initial, language: "bn" }, "পরিমাণ বদল", products);
    assert.equal(r.state.language, "bn");
    assert.equal(r.state.step, "quantity");
    assert.match(r.reply, /কত কপি/);
    r = await transition(r.state, "৩", products);
    assert.equal(r.state.quantity, 3);
    assert.equal(r.state.pending.total, 2020);
    r = await transition(r.state, "র‍্যাপ বদল", products);
    assert.equal(r.state.step, "wrap");
    assert.match(r.reply, /র‍্যাপ/);
    r = await transition(r.state, "লাল", products);
    assert.equal(r.state.step, "confirm");
    assert.equal(r.state.wrap, "red");
  } finally {
    e.DB.close();
  }
});

test("missing product during quantity step is a friendly recovery, never a crash", async () => {
  const e = fixture();
  try {
    const products = await books(e);
    const r = await transition({
      step: "quantity", product: "removed-book", editing: "quantity",
      name: "Demo Reader", phone: "01700000000",
    }, "2", products);
    assert.equal(r.state.step, "browse");
    assert.equal(r.order, undefined);
    assert.match(r.reply, /no longer listed/);
    assert.equal(r.state.editing, undefined);
  } finally {
    e.DB.close();
  }
});
