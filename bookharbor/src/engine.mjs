import {
  bnDigits, normalize, enquiryText, matchingProducts, wantsOrder,
  contextualOrder, enquiryIntent, negativeRequest, quantity,
  messageLanguage, requestedUnlistedTitle, appreciation, discountEnquiry,
} from "./language.mjs";
import { discoverBooks, discoveryReply } from "./discovery.mjs";
import { languagePreference, wantsOneRecommendation, recommendationFollowup,
  recommendedBookReply, bookFollowupReply } from "./conversation.mjs";
export { bnDigits, normalize } from "./language.mjs";
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
const select = (l, en, bl, bn) => (l === "bn" ? bn : l === "bl" ? bl : en);
const help = "Try BOOKS, DELIVERY, or HUMAN for help.";
const helpBanglish = "BOOKS, DELIVERY, ba HUMAN likhte paren.";
const helpBangla = "বইয়ের তালিকার জন্য BOOKS, ডেলিভারির জন্য DELIVERY, বা সহায়তার জন্য HUMAN লিখুন.";
export async function transition(previous, text, products, ai) {
  const s = structuredClone(previous || { step: "browse" });
  // Explicit language choice survives follow-ups and reset. Customer language
  // switches must not change a pending checkout or confirm any order.
  const choice = languagePreference(text);
  if (choice === "auto") {
    delete s.languageLock;
    s.language = messageLanguage(text, s.language);
  } else if (choice) {
    s.language = choice;
    s.languageLock = choice;
  } else {
    s.language = s.languageLock || messageLanguage(text, s.language);
  }
  const l = s.language,
    t = normalize(text);
  let engine = "rules";
  const say = (en, bl = en, bn = en) => ({
    state: s,
    reply: select(l, en, bl, bn),
    engine,
  });
  const summarize = () => {
    const p = products.find((x) => x.id === s.product);
    s.pending = quote(p, s.quantity, s.zone);
    s.step = "confirm";
    const q = s.pending;
    return say(
      `DEMO ORDER\n${p.title} (${p.edition}) × ${s.quantity}\nWrap: ${s.wrap}\nBooks: ৳${q.subtotal} + delivery: ৳${q.delivery}\nTOTAL: ৳${q.total} (demo COD; no extra fees)\n${s.name} · ${s.phone}\n${s.address}\nReply CONFIRM, EDIT QUANTITY, EDIT WRAP, EDIT ADDRESS, or CANCEL.`,
      `DEMO ORDER\n${p.title} × ${s.quantity}\nWrap: ${s.wrap}\nBoi ৳${q.subtotal} + delivery ৳${q.delivery}\nTotal ৳${q.total} (demo COD, extra charge nei)\n${s.name} · ${s.phone}\n${s.address}\nCONFIRM, EDIT QUANTITY, EDIT WRAP, EDIT ADDRESS, ba CANCEL likhun.`,
      `ডেমো অর্ডার\n${p.title} × ${s.quantity}\nর‍্যাপ: ${s.wrap}\nবই ৳${q.subtotal} + ডেলিভারি ৳${q.delivery}\nমোট ৳${q.total} (ডেমো COD; অতিরিক্ত ফি নেই)\n${s.name} · ${s.phone}\n${s.address}\nCONFIRM, EDIT QUANTITY, EDIT WRAP, EDIT ADDRESS অথবা CANCEL লিখুন।`,
    );
  };

  if (t === "reset" || t === "restart" || t === "নতুন") {
    return {
      state: { step: "browse", language: l, ...(s.languageLock ? { languageLock: s.languageLock } : {}) },
      reply: select(l,
        "Conversation reset. Type BOOKS to browse.",
        "Conversation reset hoyeche. Boi dekhte BOOKS likhun.",
        "কথোপকথন নতুন করে শুরু হয়েছে। বই দেখতে BOOKS লিখুন।"),
      engine,
    };
  }
  if (
    /^(human|agent|owner|staff|মানুষ|মালিক)$/.test(t) ||
    /talk to (a )?(human|person)|complaint|অভিযোগ/.test(t) ||
    /^(?:মানুষের সাথে কথা বলতে চাই|মালিকের সাথে কথা বলতে চাই|owner er sathe kotha bolbo|human please)$/.test(enquiryText(t))
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
  if (choice) {
    if (choice === "auto") return say(
      "I'll follow the language of your next message.",
      "Ekhon theke apnar message-er language follow korbo.",
      "এখন থেকে আপনার বার্তার ভাষা অনুযায়ী উত্তর দেব।",
    );
    return say(
      "Sure! I'll reply in English from now on.",
      "Thik ache! Ekhon theke Banglish-e reply dibo.",
      "অবশ্যই! এখন থেকে বাংলায় উত্তর দেব।",
    );
  }

  // Common sales questions must never be mistaken for book names.
  // Handle discounts while browsing or reviewing an order without changing
  // any price, stock, selection, or pending confirmation.
  if (["browse", "confirm"].includes(s.step) && discountEnquiry(text))
    return say(
      "No discounts are currently listed. Book prices are as shown; delivery is extra.",
      "Ekhon kono discount listed nei. Boier dam deya ache; delivery charge alada.",
      "এখন কোনো ছাড় তালিকাভুক্ত নেই। বইয়ের দাম দেওয়া আছে; ডেলিভারি চার্জ আলাদা।",
    );

  if (t === "unsupported attachment. please type a book title.")
    return say(
      "I can't read voice notes or attachments yet. Please type your question.",
      "Voice note ba attachment bujhte pari na ekhono. Proshno ta likhe pathan.",
      "এখনো ভয়েস নোট বা সংযুক্তি পড়তে পারি না। অনুগ্রহ করে প্রশ্নটি লিখে পাঠান।",
    );

  if (/^(cancel|বাতিল|cancel order|cancel korun|অর্ডার বাতিল|বাতিল করুন)$/.test(t)) {
    s.step = "browse";
    // Clear incomplete personal details and selection from cancelled drafts.
    for (const key of ["pending", "editing", "product", "quantity", "wrap",
      "name", "phone", "address", "zone"]) delete s[key];
    return say(
      "Your draft order has been cancelled. No order was placed. Type BOOKS to browse again.",
      "Draft order cancel kora hoyeche. Kono order place hoyni. BOOKS likhe abar shuru korun.",
      "আপনার খসড়া অর্ডার বাতিল করা হয়েছে। কোনো অর্ডার দেওয়া হয়নি। আবার শুরু করতে BOOKS লিখুন।",
    );
  }
  if (s.step === "quantity") {
    const q = quantity(t);
    const p = products.find((x) => x.id === s.product);
    if (!p) {
      s.step = "browse";
      for (const key of ["editing", "pending", "product"]) delete s[key];
      return say(
        "That book is no longer listed. Please choose a title from BOOKS.",
        "Ei boi ekhon catalogue-e nei. BOOKS theke arekti boi bachun.",
        "বইটি এখন তালিকায় নেই। অনুগ্রহ করে BOOKS থেকে অন্য বই বেছে নিন।",
      );
    }
    if (!q || q > 10)
      return say(
        "How many copies? Enter a number from 1 to 10.",
        "Koy copy? 1 theke 10 er moddhe number din.",
        "কত কপি? ১ থেকে ১০-এর মধ্যে সংখ্যা লিখুন।",
      );
    if (q > p.stock)
      return say(`Only ${p.stock} copies available. Please choose fewer.`);
    s.quantity = q;
    if (s.editing === "quantity") {
      delete s.editing;
      s.step = "summary";
      return summarize();
    }
    s.step = "wrap";
    return say(
      "Gift wrap colour? Choose blue, red, or none (free).",
      "Gift wrap colour: blue, red, na none? Free.",
      "গিফট র‍্যাপ: blue, red, অথবা none লিখুন। বিনামূল্যে।",
    );
  }
  if (s.step === "wrap") {
    const wrap = /^(blue|নীল|nil|neel)$/.test(t)
      ? "blue"
      : /^(red|লাল|lal)$/.test(t)
        ? "red"
        : /^(none|no|না|no wrap|lagbe na|র‍্যাপ লাগবে না)$/.test(t)
          ? "none"
          : null;
    if (!wrap) return say("Please choose blue, red, or none.");
    s.wrap = wrap;
    if (s.editing === "wrap") {
      delete s.editing;
      s.step = "summary";
      return summarize();
    }
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
    } else if (/^(edit quantity|change quantity|edit copies|change copies|পরিমাণ বদল|কপি বদল)$/.test(t)) {
      s.step = "quantity";
      s.editing = "quantity";
      delete s.pending;
      return say(
        "How many copies would you like instead? Enter a number from 1 to 10. I'll show an updated total for approval.",
        "Ebar koy copy niben? 1 theke 10-er moddhe number din. Updated total dekhabo.",
        "এবার কত কপি নিতে চান? ১ থেকে ১০-এর মধ্যে সংখ্যা লিখুন। এরপর নতুন মোট মূল্য দেখাব।",
      );
    } else if (/^(edit wrap|change wrap|edit wrapping|change wrapping|র‍্যাপ বদল|মোড়ক বদল)$/.test(t)) {
      s.step = "wrap";
      s.editing = "wrap";
      delete s.pending;
      return say(
        "Choose your new free gift-wrap option: BLUE, RED, or NONE. I'll show the updated summary for approval.",
        "Notun gift wrap bachun: BLUE, RED, ba NONE. Updated summary dekhabo.",
        "বিনামূল্যের নতুন র‍্যাপ বেছে নিন: BLUE, RED অথবা NONE। এরপর নতুন সারাংশ দেখাব।",
      );
    } else if (/^(edit address|change address|ঠিকানা বদল)$/.test(t)) {
      s.step = "address";
      delete s.pending;
      return say(
        "Enter the corrected fictional address, including area and district.",
        "Notun fictional address, area ebong district likhun.",
        "এলাকা ও জেলাসহ সংশোধিত কাল্পনিক ঠিকানা লিখুন।",
      );
    } else
      return say(
        "Please reply CONFIRM, EDIT QUANTITY, EDIT WRAP, EDIT ADDRESS, or CANCEL. Your order has not been placed yet.",
        "CONFIRM, EDIT QUANTITY, EDIT WRAP, EDIT ADDRESS, ba CANCEL likhun. Ekhono order place hoyni.",
        "অনুগ্রহ করে CONFIRM, EDIT QUANTITY, EDIT WRAP, EDIT ADDRESS অথবা CANCEL লিখুন। এখনো অর্ডার দেওয়া হয়নি।",
      );
  }
  if (s.step === "summary") return summarize();
  if (/^(help|menu|সাহায্য|হেল্প|help me)$/.test(enquiryText(t))) {
    return say(
      "Try BOOKS, MIS BOOKS, 'recommend fantasy books', 'books under 800', DELIVERY or HUMAN. Orders are simulated.",
      "BOOKS, MIS BOOKS, 'recommend fantasy books', 'books under 800', DELIVERY ba HUMAN likhte paren. Order shudhu sample.",
      "বই দেখতে BOOKS বা MIS BOOKS লিখুন। পরামর্শের জন্য 'recommend fantasy books', বাজেটের জন্য 'books under 800', অথবা DELIVERY/HUMAN লিখুন। অর্ডারগুলো নমুনা।",
    );
  }
  if (appreciation(text)) return say(
    "You're welcome! Need help with anything else?",
    "Shagotom! Aro kichu jante chan?",
    "আপনাকে স্বাগতম! আর কিছু জানতে চান?",
  );
  // A recommendation for ONE book should pick ONE available D1 title and
  // preserve it as conversational context (never authorize checkout).
  if (wantsOneRecommendation(text)) {
    const discovered = discoverBooks(text, products);
    const candidates = discovered?.matches?.length
      ? discovered.matches
      : discovered && discovered.totalMatches === 0
        ? []
        : products.filter((p) => Number(p.stock) > 0)
          .sort((a, b) => Number(a.price) - Number(b.price) || a.title.localeCompare(b.title));
    if (!candidates.length) {
      delete s.product;
      delete s.recommendedProduct;
      return say(
        "I couldn't find a suitable in-stock book. Type BOOKS to see what is available.",
        "Matching boi stock-e nei. BOOKS likhe available boi dekhun.",
        "উপযুক্ত বই মজুত নেই। BOOKS লিখে অন্য বইগুলো দেখুন।",
      );
    }
    const p = candidates[0];
    s.product = p.id;
    s.recommendedProduct = p.id;
    return { state: s, reply: recommendedBookReply(p, l), engine };
  }
  if (s.recommendedProduct && recommendationFollowup(text)) {
    const p = products.find((p) => p.id === s.recommendedProduct && Number(p.stock) > 0);
    if (p) return { state: s, reply: bookFollowupReply(p, text, l), engine };
    delete s.recommendedProduct;
    delete s.product;
    return say("That title is unavailable now. Type BOOKS to browse.");
  }

  let conversationReply = null;
  let intent = enquiryIntent(text);
  const policy = ["delivery", "returns", "payment", "discount"].includes(intent);
  let found = policy ? [] : matchingProducts(text, products);
  // Discovery uses only D1 rows. When a question mentions one identifiable
  // title (e.g. "Is Hobbit a fantasy book?"), prefer that exact book unless
  // the customer explicitly asked for recommendations or a collection filter.
  const discovery = policy ? null : discoverBooks(text, products);
  const explicitBrowse = /^(?:(?:can you |please )?(?:show|list|suggest|recommend)|which books|what books|any books|are there any|do you have any)/.test(enquiryText(t));
  if (discovery && (!found.length || discovery.author || discovery.budget ||
      discovery.cheap || discovery.recommend || explicitBrowse)) {
    delete s.product;
    delete s.recommendedProduct;
    return { state: s, reply: discoveryReply(discovery, l), engine };
  }
  if (found.length > 1)
    return say("Which book do you mean? Please send one title at a time.");
  // A specifically named but unlisted title must not fall back to the
  // previously selected book or be incorrectly assigned a price by AI.
  // Descriptive questions (e.g. "adventure about Bilbo") still reach the AI.
  const unlisted = !found.length && !policy && intent !== "catalog" && intent !== "greeting"
    ? requestedUnlistedTitle(text) : null;
  if (unlisted) {
    delete s.product;
    delete s.recommendedProduct;
    const title = unlisted.replace(/\b[a-z]/g, (char) => char.toUpperCase());
    return say(
      title + " is not listed right now. Type BOOKS to see available titles.",
      title + " amader catalogue-e nei. Available boi dekhte BOOKS likhun.",
      title + " এখন আমাদের তালিকায় নেই। অন্য বই দেখতে BOOKS লিখুন।",
    );
  }
  // Only short, unambiguous follow-ups reuse the last explicitly selected title.
  if (!found.length && s.product && /^(?:price|price koto|dam koto|daam koto|দাম কত|দাম|stock|stock ache|স্টক আছে|is it available|how much is it)$/.test(enquiryText(t))) {
    found = products.filter((p) => p.id === s.product);
  }
  if (
    !found.length &&
    (!intent || intent === "product") &&
    !wantsOrder(t) &&
    !negativeRequest(t) &&
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
          "smalltalk",
          "explain_book",
          "unknown",
        ].includes(result.intent)
      ) {
        intent = result.intent;
        if (intent === "product")
          found = products.filter((p) => p.id === result.product_id);
        if (result.intent === "smalltalk" && typeof result.reply === "string") {
          conversationReply = result.reply;
        }
        if (result.intent === "explain_book") {
          const chosen = products.find((p) =>
            p.id === (result.product_id || s.recommendedProduct || s.product));
          if (chosen) {
            s.product = chosen.id;
            s.recommendedProduct = chosen.id;
            return { state: s, reply: bookFollowupReply(chosen, text, l), engine: result.provider || "cloudflare-ai" };
          }
        }
        engine = result.provider || "cloudflare-ai";
      }
    } catch {
      engine = "rules-fallback";
    }
  }
  if (found.length) {
    const p = found[0];
    s.product = p.id;
    s.recommendedProduct = p.id;
    if (!p.stock)
      return say(
        `${p.title} is currently out of stock. Type books for alternatives.`,
        `${p.title} stock e nei. Onno boi dekhte books likhun.`,
        `${p.title} এখন স্টকে নেই। অন্য বই দেখতে books লিখুন।`,
      );
    if (wantsOrder(t)) {
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
  if (!policy && (wantsOrder(t) || intent === "order")) {
    if (!s.product || !contextualOrder(t))
      return say(
        "Which book would you like? Type its title or books for the catalogue.",
      );
    const p = products.find((p) => p.id === s.product);
    if (!p || !p.stock)
      return say("That book is out of stock. Type books for alternatives.");
    s.step = "quantity";
    return say("How many copies?", "Koy copy niben?", "কত কপি নেবেন?");
  }
  if (intent === "smalltalk" && typeof conversationReply === "string") {
    return { state: s, reply: conversationReply, engine };
  }
  if (intent === "delivery")
    return say(
      "Demo delivery: Dhaka city ৳70 · suburbs ৳100 · outside Dhaka ৳130. No extra COD fee.",
      "Delivery charge: Dhaka ৳70, suburbs ৳100, baire ৳130. Extra COD fee nei.",
      "ডেলিভারি চার্জ: ঢাকা শহর ৳70, আশপাশ ৳100, ঢাকার বাইরে ৳130। অতিরিক্ত COD ফি নেই।",
    );
  if (intent === "returns")
    return say(
      "For damaged or incorrect books, contact HUMAN within 48 hours of delivery. This is a sample policy; no real refunds are issued.",
      "Wrong ba damaged boi hole 48 hours-er moddhe HUMAN likhun. Eta sample policy.",
      "ভুল বা ক্ষতিগ্রস্ত বই পেলে 48 hours-এর মধ্যে HUMAN লিখুন। এটি নমুনা নীতি।",
    );
  if (intent === "payment")
    return say(
      "Cash on delivery is simulated. No payment is collected. Please don't send PINs or OTPs.",
      "Cash on delivery shudhu sample. Kono payment neya hoy na; PIN/OTP pathaben na.",
      "ক্যাশ অন ডেলিভারি শুধু নমুনা। টাকা নেওয়া হয় না; PIN/OTP পাঠাবেন না।",
    );
  // Conversational "what books do you have?" merits a brief answer,
  // not a 12-item dump. Explicit BOOKS still lists the full collection.
  if (intent === "catalog_overview") {
    delete s.product;
    const stocked = products.filter((p) => p.stock > 0);
    const names = stocked.slice(0, 3).map((p) => p.title).join(", ");
    return say(
      `We have ${stocked.length} titles in stock, including ${names}. Type BOOKS for the full list or MIS BOOKS for textbooks.`,
      `Amader ${stocked.length} ta boi stock-e ache, jemon ${names}. Sob dekhte BOOKS, MIS boi dekhte MIS BOOKS likhun.`,
      `আমাদের ${stocked.length}টি বই মজুত আছে, যেমন ${names}। সব বই দেখতে BOOKS বা MIS বইয়ের জন্য MIS BOOKS লিখুন।`,
    );
  }
  if (intent === "catalog") {
    const items = products.map((p) =>
      `${p.title} — ৳${p.price} · ${p.stock ? `${p.stock} available` : "out of stock"}`,
    ).join("\n");
    return say(
      "BOOKS\n" + items + "\nSend a title for details.",
      "BOOKS\n" + items + "\nDetails jante boier naam likhun.",
      "বইয়ের তালিকা\n" + items + "\nবিস্তারিত জানতে বইয়ের নাম লিখুন।",
    );
  }
  if (
    /^(hi|hello|hey|salam|assalamu alaikum|হ্যালো|সালাম)[!. ]*$/.test(t) ||
    intent === "greeting"
  )
    return say(
      "Welcome to BookHarbor! Ask about a book or type BOOKS to browse. Orders are simulated.",
      "BookHarbor-e shagotom! Boi niye proshno korun, ba BOOKS likhun. Order sample hishebe save hoy.",
      "BookHarbor-এ স্বাগতম! বই সম্পর্কে জিজ্ঞেস করুন বা BOOKS লিখুন। অর্ডারগুলো নমুনা হিসেবে সংরক্ষিত হয়।",
    );
  return say(
    "I'm not sure I understood. Try asking again or type BOOKS to browse.",
    "Bujhte parini. Abar proshno korun, ba BOOKS likhun.",
    "বুঝতে পারিনি। আবার জিজ্ঞেস করুন অথবা BOOKS লিখুন।",
  );
}
