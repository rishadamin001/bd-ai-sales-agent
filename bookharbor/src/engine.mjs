export const bnDigits = (text) =>
  String(text).replace(/[০-৯]/g, (c) => "০১২৩৪৫৬৭৮৯".indexOf(c));
export const normalize = (text) => bnDigits(text).toLowerCase().trim();
export function phone(text) {
  const p = bnDigits(text)
    .replace(/[\s()+-]/g, "")
    .replace(/^880/, "0");
  return /^01[3-9]\d{8}$/.test(p) ? p : null;
}
export function zone(text) {
  const t = normalize(text);
  if (
    /savar|ashulia|gazipur|narayanganj|keraniganj|সাভার|আশুলিয়া|গাজীপুর|নারায়ণগঞ্জ|কেরানীগঞ্জ/.test(
      t,
    )
  )
    return "suburbs";
  if (
    /mirpur|uttara|gulshan|banani|dhanmondi|badda|mohammadpur|motijheel|মিরপুর|উত্তরা|গুলশান|বনানী|ধানমন্ডি|বাড্ডা|মোহাম্মদপুর|মতিঝিল/.test(
      t,
    )
  )
    return "dhaka";
  if (/^(dhaka|ঢাকা)$/.test(t)) return null;
  if (
    /sylhet|chattogram|chittagong|cumilla|comilla|rajshahi|khulna|barishal|barisal|rangpur|mymensingh|bogura|noakhali|সিলেট|চট্টগ্রাম|কুমিল্লা|রাজশাহী|খুলনা|বরিশাল|রংপুর|ময়মনসিংহ|বগুড়া|নোয়াখালী/.test(
      t,
    )
  )
    return "outside";
  if (/^(inside dhaka|dhaka city|ঢাকা শহর|1)$/.test(t)) return "dhaka";
  if (/^(suburbs|2)$/.test(t)) return "suburbs";
  if (/^(outside dhaka|outside|ঢাকার বাইরে|3)$/.test(t)) return "outside";
  return null;
}
export function quote(product, qty, z) {
  if (
    !Number.isInteger(qty) ||
    qty < 1 ||
    qty > 10 ||
    !["dhaka", "suburbs", "outside"].includes(z)
  )
    throw Error("Invalid quote");
  const delivery = { dhaka: 70, suburbs: 100, outside: 130 }[z];
  return {
    subtotal: product.price * qty,
    delivery,
    total: product.price * qty + delivery,
  };
}
function lang(t, prev) {
  if (/[\u0980-\u09ff]/.test(t)) return "bn";
  if (
    /\b(koto|ache|ase|bhai|bhaiya|chai|lagbe|diben|korbo|amar|boi|den|korte|nibo|kinbo|kivabe|dorkar)\b/i.test(
      t,
    )
  )
    return "bl";
  return prev || "en";
}
const select = (l, en, bl, bn) => (l === "bn" ? bn : l === "bl" ? bl : en);
const help =
  "Try: books · Hobbit price koto? · delivery · order · human · reset";
export async function transition(previous, text, products, ai) {
  const s = structuredClone(previous || { step: "browse" });
  s.language = lang(text, s.language);
  const l = s.language,
    t = normalize(text);
  let engine = "rules";
  const say = (en, bl = en, bn = en) => ({
    state: s,
    reply: select(l, en, bl, bn),
    engine,
  });
  if (t === "reset" || t === "restart" || t === "নতুন") {
    return {
      state: { step: "browse", language: l },
      reply:
        "New demo conversation started. Type books to browse. Use fictional details only.",
      engine,
    };
  }
  if (
    /^(human|agent|owner|staff|মানুষ|মালিক)$/.test(t) ||
    /talk to (a )?(human|person)|complaint|অভিযোগ/.test(t)
  ) {
    s.handoff = true;
    return say(
      "I have paused automated replies. The shop owner can review this conversation in the dashboard.",
      "Auto reply pause korechi. Owner dashboard theke conversation dekhte parben.",
      "স্বয়ংক্রিয় উত্তর বন্ধ করেছি। দোকানের মালিক ড্যাশবোর্ড থেকে এই কথোপকথন দেখতে পারবেন।",
    );
  }
  if (s.handoff)
    return {
      ...say(
        "Waiting for the shop owner. Use the dashboard Resume button to enable the assistant.",
      ),
      silent: true,
    };
  if (/^(cancel|বাতিল)$/.test(t)) {
    s.step = "browse";
    delete s.pending;
    return say(
      "Draft cancelled. No order was placed. Type books to start again.",
    );
  }
  if (s.step === "quantity") {
    const match = t.match(/^(\d{1,2})(?:\s*(?:copies|copy|ta|টা|টি|pcs))?$/);
    const q = match ? Number(match[1]) : 0;
    const p = products.find((x) => x.id === s.product);
    if (!q || q > 10)
      return say(
        "How many copies? Enter a number from 1 to 10.",
        "Koy copy? 1 theke 10 er moddhe number din.",
        "কত কপি? ১ থেকে ১০-এর মধ্যে সংখ্যা লিখুন।",
      );
    if (q > p.stock)
      return say(`Only ${p.stock} copies available. Please choose fewer.`);
    s.quantity = q;
    s.step = "wrap";
    return say(
      "Gift wrap colour? Choose blue, red, or none (free).",
      "Gift wrap colour: blue, red, na none? Free.",
      "গিফট র‍্যাপ: blue, red, অথবা none লিখুন। বিনামূল্যে।",
    );
  }
  if (s.step === "wrap") {
    const wrap = /^(blue|নীল|nil)$/.test(t)
      ? "blue"
      : /^(red|লাল|lal)$/.test(t)
        ? "red"
        : /^(none|no|না|no wrap)$/.test(t)
          ? "none"
          : null;
    if (!wrap) return say("Please choose blue, red, or none.");
    s.wrap = wrap;
    s.step = "name";
    return say(
      "Your fictional customer name? This is an academic demo.",
      "Demo customer er naam din (real details diben na).",
      "ডেমোর জন্য কাল্পনিক ক্রেতার নাম লিখুন।",
    );
  }
  if (s.step === "name") {
    if (t.length < 2 || t.length > 80 || /\d/.test(t))
      return say(
        "Please enter a name between 2 and 80 characters, without numbers.",
      );
    s.name = text.trim();
    s.step = "phone";
    return say(
      "Demo phone number? Use 01700000000 for the presentation.",
      "Demo phone number din: 01700000000 use korte paren.",
      "ডেমো ফোন নম্বর দিন: 01700000000 ব্যবহার করতে পারেন।",
    );
  }
  if (s.step === "phone") {
    const p = phone(text);
    if (!p)
      return say(
        "Please enter an 11-digit Bangladesh mobile number, e.g. 01700000000.",
        "11 digit BD number din, jemon 01700000000.",
        "১১ সংখ্যার বাংলাদেশি মোবাইল নম্বর দিন, যেমন 01700000000।",
      );
    s.phone = p;
    s.step = "address";
    return say(
      "Fictional delivery address, including area and district? Example: House 1, Road 2, Mirpur, Dhaka.",
      "Demo address, area ar district din. Example: House 1, Road 2, Mirpur, Dhaka.",
      "এলাকা ও জেলাসহ কাল্পনিক ঠিকানা দিন। যেমন: House 1, Road 2, Mirpur, Dhaka.",
    );
  }
  if (s.step === "address") {
    if (text.trim().length < 10)
      return say("Please include house/road, area, and district.");
    s.address = text.trim();
    s.zone = zone(text);
    if (!s.zone) {
      s.step = "zone";
      return say(
        "Please choose delivery zone: 1 = Dhaka city (৳70), 2 = suburbs (৳100), 3 = outside Dhaka (৳130).",
      );
    }
    s.step = "summary";
  }
  if (s.step === "zone") {
    s.zone = zone(text);
    if (!s.zone)
      return say("Choose 1 = Dhaka city, 2 = suburbs, or 3 = outside Dhaka.");
    s.step = "summary";
  }
  if (s.step === "confirm") {
    if (/^(confirm|confirm order|yes|হ্যাঁ|কনফার্ম|নিশ্চিত|ji|ok)$/.test(t)) {
      const p = products.find((x) => x.id === s.product);
      if (!p || p.stock < s.quantity) {
        s.step = "browse";
        return say(
          "Sorry, stock changed. Please choose a different book or quantity.",
        );
      }
      const current = quote(p, s.quantity, s.zone);
      if (current.total !== s.pending.total) {
        s.step = "summary";
      } else {
        const order = {
          product_id: p.id,
          quantity: s.quantity,
          ...current,
          details: {
            name: s.name,
            phone: s.phone,
            address: s.address,
            zone: s.zone,
            wrap: s.wrap,
            title: p.title,
            edition: p.edition,
            payment: "Demo COD — no money collected",
          },
        };
        s.step = "browse";
        delete s.pending;
        return {
          ...say(
            "Demo order confirmed. No payment or courier booking will occur.",
            "Demo order confirmed! Kono payment ba real delivery hobe na.",
            "ডেমো অর্ডার নিশ্চিত হয়েছে। কোনো টাকা নেওয়া বা বাস্তব ডেলিভারি হবে না।",
          ),
          order,
        };
      }
    } else if (/^(edit address|change address|ঠিকানা বদল)$/.test(t)) {
      s.step = "address";
      return say(
        "Enter the corrected fictional address, including area and district.",
      );
    } else
      return say(
        "Reply CONFIRM to place this demo order, EDIT ADDRESS to change the address, or CANCEL.",
      );
  }
  if (s.step === "summary") {
    const p = products.find((x) => x.id === s.product);
    s.pending = quote(p, s.quantity, s.zone);
    s.step = "confirm";
    const q = s.pending;
    return say(
      `DEMO ORDER\n${p.title} (${p.edition}) × ${s.quantity}\nWrap: ${s.wrap}\nBooks: ৳${q.subtotal} + delivery: ৳${q.delivery}\nTOTAL: ৳${q.total} (demo COD; no extra fees)\n${s.name} · ${s.phone}\n${s.address}\nReply CONFIRM, EDIT ADDRESS, or CANCEL.`,
      `DEMO ORDER\n${p.title} × ${s.quantity}\nWrap: ${s.wrap}\nBoi ৳${q.subtotal} + delivery ৳${q.delivery}\nTotal ৳${q.total} (demo COD, extra charge nei)\n${s.name} · ${s.phone}\n${s.address}\nCONFIRM, EDIT ADDRESS, ba CANCEL likhun.`,
      `ডেমো অর্ডার\n${p.title} × ${s.quantity}\nর‍্যাপ: ${s.wrap}\nবই ৳${q.subtotal} + ডেলিভারি ৳${q.delivery}\nমোট ৳${q.total} (ডেমো COD; অতিরিক্ত ফি নেই)\n${s.name} · ${s.phone}\n${s.address}\nCONFIRM, EDIT ADDRESS অথবা CANCEL লিখুন।`,
    );
  }
  let found = products.filter((p) =>
    p.aliases
      .split(",")
      .some((a) =>
        a.length <= 4
          ? new RegExp(`(^|\\s)${a}($|\\s|[?!])`, "i").test(t)
          : t.includes(a),
      ),
  );
  if (found.length > 1)
    return say("Which book do you mean? Please send one title at a time.");
  let intent = null;
  if (
    !found.length &&
    ai &&
    !/^(books|catalog|list|hi|hello|hey|help|order|buy|delivery|return|payment|stock)$/.test(
      t,
    ) &&
    !/^\d+$/.test(t)
  ) {
    try {
      const result = await ai(text, products);
      if (
        result &&
        [
          "product",
          "catalog",
          "delivery",
          "returns",
          "payment",
          "order",
          "greeting",
          "unknown",
        ].includes(result.intent)
      ) {
        intent = result.intent;
        if (intent === "product")
          found = products.filter((p) => p.id === result.product_id);
        engine = "cloudflare-ai";
      }
    } catch {
      engine = "rules-fallback";
    }
  }
  if (found.length) {
    const p = found[0];
    s.product = p.id;
    if (!p.stock)
      return say(
        `${p.title} is currently out of stock. Type books for alternatives.`,
        `${p.title} stock e nei. Onno boi dekhte books likhun.`,
        `${p.title} এখন স্টকে নেই। অন্য বই দেখতে books লিখুন।`,
      );
    if (/order|buy|nibo|kinbo|chai|অর্ডার|কিনব|চাই/.test(t)) {
      s.step = "quantity";
      return say(
        `${p.title} — ৳${p.price}. How many copies?`,
        `${p.title} — ৳${p.price}. Koy copy niben?`,
        `${p.title} — ৳${p.price}। কত কপি নেবেন?`,
      );
    }
    return say(
      `${p.title}\n${p.author} · ${p.edition}\nPrice: ৳${p.price} · In stock: ${p.stock}\nReply ORDER to buy.`,
      `${p.title}\n${p.edition} · Dam ৳${p.price} · Stock ${p.stock} copy\nNite chaile ORDER likhun.`,
      `${p.title}\n${p.edition} · দাম ৳${p.price} · স্টক ${p.stock} কপি\nকিনতে ORDER লিখুন।`,
    );
  }
  if (/\b(order|buy|nibo|kinbo)\b|অর্ডার|কিনব/.test(t) || intent === "order") {
    if (!s.product)
      return say(
        "Which book would you like? Type its title or books for the catalogue.",
      );
    const p = products.find((p) => p.id === s.product);
    if (!p.stock)
      return say("That book is out of stock. Type books for alternatives.");
    s.step = "quantity";
    return say("How many copies?", "Koy copy niben?", "কত কপি নেবেন?");
  }
  if (
    /delivery|charge|shipping|ডেলিভারি|চার্জ/.test(t) ||
    intent === "delivery"
  )
    return say(
      "Demo delivery: Dhaka city ৳70 · suburbs ৳100 · outside Dhaka ৳130 per order. No extra COD charge. Illustrative shop policy, not a courier quote. No actual dispatch.",
      "Demo delivery: Dhaka city ৳70, suburbs ৳100, outside Dhaka ৳130. Extra COD charge nei. Real delivery hobe na.",
      "ডেমো ডেলিভারি: ঢাকা শহর ৳70, আশপাশ ৳100, ঢাকার বাইরে ৳130। অতিরিক্ত COD ফি নেই। এটি নমুনা নীতি; বাস্তব ডেলিভারি হবে না।",
    );
  if (/return|exchange|refund|ফেরত|বদল/.test(t) || intent === "returns")
    return say(
      "Demo policy: report a damaged or incorrect book within 48 hours of delivery. Staff review is required. Type HUMAN for help. This demo does not issue refunds.",
    );
  if (/payment|bkash|nagad|cod|পেমেন্ট|বিকাশ/.test(t) || intent === "payment")
    return say(
      "Demo cash on delivery only. Do not send money, PINs, OTPs, or payment screenshots. No payment is collected.",
    );
  if (/books|catalog|list|boi|বই|বুক/.test(t) || intent === "catalog")
    return say(
      "DEMO CATALOGUE\n" +
        products
          .map(
            (p) =>
              `${p.title} — ৳${p.price} · ${p.stock ? `${p.stock} available` : "out of stock"}`,
          )
          .join("\n") +
        "\nSend a title for details.",
    );
  if (
    /^(hi|hello|hey|salam|assalamu alaikum|হ্যালো|সালাম)[!. ]*$/.test(t) ||
    intent === "greeting"
  )
    return say(
      "Hello! I’m BookHarbor’s automated book assistant, an IUB MIS 465 demo. Please use fictional details only. " +
        help,
      "Assalamu alaikum! Ami BookHarbor er automated book assistant — IUB MIS 465 demo. Shudhu fictional details din. " +
        help,
      "স্বাগতম! আমি BookHarbor-এর স্বয়ংক্রিয় বই সহকারী — IUB MIS 465 ডেমো। শুধু কাল্পনিক তথ্য ব্যবহার করুন। " +
        help,
    );
  return say(
    "I’m not sure which book or request you mean. " + help,
    "Bujhte parini — boier naam ba books likhun. " + help,
    "বুঝতে পারিনি—বইয়ের নাম অথবা books লিখুন। " + help,
  );
}
