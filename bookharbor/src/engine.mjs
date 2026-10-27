import {
  bnDigits, normalize, enquiryText, matchingProducts, wantsOrder,
  contextualOrder, enquiryIntent, negativeRequest, quantity,
  messageLanguage, requestedUnlistedTitle, appreciation,
} from "./language.mjs";
import { discoverBooks, discoveryReply } from "./discovery.mjs";
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
  s.language = messageLanguage(text, s.language);
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
      state: { step: "browse", language: l },
      reply: select(l,
        "Your conversation has been restarted. Type BOOKS to browse our demo catalogue. Please use fictional details.",
        "Conversation abar shuru hoyeche. Demo catalogue dekhte BOOKS likhun. Shudhu demo details din.",
        "কথোপকথন নতুন করে শুরু হয়েছে। নমুনা বইয়ের তালিকা দেখতে BOOKS লিখুন। শুধু কাল্পনিক তথ্য দিন।"),
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
      "Welcome to BookHarbor's academic demo. I can help you:\n• Browse all available titles: BOOKS\n• Get a recommendation: recommend fantasy books\n• Filter by price: books under 800\n• Check delivery charges: DELIVERY\n• Contact the owner: HUMAN\nSend any book title to see its price and stock. Please use fictional details for demo orders.",
      "BookHarbor demo-te ami help korte pari:\n• Sob boi: BOOKS\n• Recommendation: recommend fantasy books\n• Budget onujayi: books under 800\n• Delivery: DELIVERY\n• Owner-er help: HUMAN\nDam ebong stock jante boier naam likhun. Order-e shudhu fictional details din.",
      "BookHarbor-এর নমুনা সহকারী আপনাকে সাহায্য করতে পারে:\n• সব বই দেখতে: BOOKS\n• পরামর্শ পেতে: recommend fantasy books\n• বাজেট অনুযায়ী: books under 800\n• ডেলিভারি: DELIVERY\n• মালিকের সহায়তা: HUMAN\nদাম ও মজুত জানতে বইয়ের নাম লিখুন। অর্ডারে শুধু কাল্পনিক তথ্য দিন।",
    );
  }
  if (appreciation(text)) return say(
    "You're welcome! If you need book recommendations or further assistance, please let me know.",
    "Apnake shagotom! Boi niye aro proshno thakle janaben.",
    "আপনাকে স্বাগতম! বই সম্পর্কে আরও কিছু জানতে চাইলে জানাবেন।",
  );
  let found = matchingProducts(text, products);
  // Discovery uses only D1 rows. When a question mentions one identifiable
  // title (e.g. "Is Hobbit a fantasy book?"), prefer that exact book unless
  // the customer explicitly asked for recommendations or a collection filter.
  const discovery = discoverBooks(text, products);
  const explicitBrowse = /^(?:(?:can you |please )?(?:show|list|suggest|recommend)|which books|what books|any books|are there any|do you have any)/.test(enquiryText(t));
  if (discovery && (!found.length || discovery.author || discovery.budget ||
      discovery.cheap || discovery.recommend || explicitBrowse)) {
    delete s.product;
    return { state: s, reply: discoveryReply(discovery, l), engine };
  }
  if (found.length > 1)
    return say("Which book do you mean? Please send one title at a time.");
  let intent = enquiryIntent(text);
  const policy = ["delivery", "returns", "payment"].includes(intent);
  // A policy question mentioning a title must not start checkout.
  if (policy) found = [];
  // A specifically named but unlisted title must not fall back to the
  // previously selected book or be incorrectly assigned a price by AI.
  // Descriptive questions (e.g. "adventure about Bilbo") still reach the AI.
  const unlisted = !found.length && !policy && intent !== "catalog" && intent !== "greeting"
    ? requestedUnlistedTitle(text) : null;
  if (unlisted) {
    delete s.product;
    const title = unlisted.replace(/\b[a-z]/g, (char) => char.toUpperCase());
    return say(
      "Thank you for asking about " + title + ". This title is not listed in our current demo catalogue, so I can't confirm its price or availability. Type BOOKS to see available titles, or HUMAN to request help from the owner.",
      title + " amader current demo catalogue-e nei. Tai dam ba availability confirm korte parchi na. Available boi dekhte BOOKS, owner er help pete HUMAN likhun.",
      title + " আমাদের বর্তমান নমুনা বইয়ের তালিকায় নেই। তাই দাম বা প্রাপ্যতা নিশ্চিত করতে পারছি না। বইয়ের তালিকা দেখতে BOOKS অথবা মালিকের সহায়তার জন্য HUMAN লিখুন।",
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
  if (intent === "delivery")
    return say(
      "Demo delivery: Dhaka city ৳70 · suburbs ৳100 · outside Dhaka ৳130 per order. No extra COD charge. Illustrative shop policy, not a courier quote. No actual dispatch.",
      "Demo delivery: Dhaka city ৳70, suburbs ৳100, outside Dhaka ৳130. Extra COD charge nei. Real delivery hobe na.",
      "ডেমো ডেলিভারি: ঢাকা শহর ৳70, আশপাশ ৳100, ঢাকার বাইরে ৳130। অতিরিক্ত COD ফি নেই। এটি নমুনা নীতি; বাস্তব ডেলিভারি হবে না।",
    );
  if (intent === "returns")
    return say(
      "For this demo, damaged or incorrect books should be reported within 48 hours of delivery. Please send HUMAN for staff assistance. No real refunds are issued.",
      "Demo-te damaged ba wrong boi pele delivery-r 48 hours-er moddhe janaben. Staff-er help pete HUMAN likhun. Real refund deya hoy na.",
      "এই ডেমোতে ক্ষতিগ্রস্ত বা ভুল বই পেলে ডেলিভারির 48 hours-এর মধ্যে জানান। সহায়তার জন্য HUMAN লিখুন। বাস্তবে কোনো অর্থ ফেরত দেওয়া হয় না।",
    );
  if (intent === "payment")
    return say(
      "Our demo uses cash on delivery only. No payment is collected. Please do not share money, PINs, OTPs, or payment screenshots.",
      "Demo-te shudhu cash on delivery dekhano hoy. Kono payment neya hoy na. PIN, OTP, ba payment screenshot pathaben na.",
      "এই ডেমোতে শুধু ক্যাশ অন ডেলিভারি দেখানো হয়। কোনো অর্থ নেওয়া হয় না। PIN, OTP বা পেমেন্টের স্ক্রিনশট পাঠাবেন না।",
    );
  if (intent === "catalog") {
    const items = products.map((p) =>
      `${p.title} — ৳${p.price} · ${p.stock ? `${p.stock} available` : "out of stock"}`,
    ).join("\n");
    return say(
      "DEMO CATALOGUE\n" + items + "\nPlease send a book title for more details.",
      "DEMO CATALOGUE\n" + items + "\nDetails jante boier naam likhun.",
      "DEMO CATALOGUE\n" + items + "\nবিস্তারিত জানতে বইয়ের নাম লিখুন।",
    );
  }
  if (
    /^(hi|hello|hey|salam|assalamu alaikum|হ্যালো|সালাম)[!. ]*$/.test(t) ||
    intent === "greeting"
  )
    return say(
      "Hello! Welcome to BookHarbor. I'm the automated assistant for our academic bookshop demo. I can help with book availability, prices, and demo orders. " + help,
      "Assalamu alaikum! BookHarbor-e shagotom. Ami amader demo bookshop-er automated assistant. Boi, dam, stock, ebong demo order niye help korte pari. " + helpBanglish,
      "স্বাগতম! আমি BookHarbor-এর স্বয়ংক্রিয় সহকারী। বইয়ের দাম, মজুত ও নমুনা অর্ডার সম্পর্কে সাহায্য করতে পারি। " + helpBangla,
    );
  return say(
    "I'm not sure which book or request you mean. Please share a specific title, or choose BOOKS to browse our current catalogue. " + help,
    "Apnar proshno ta puro bujhte parini. Doya kore boier naam likhun, ba BOOKS diye available catalogue dekhun. " + helpBanglish,
    "আপনার প্রশ্নটি পুরোপুরি বুঝতে পারিনি। অনুগ্রহ করে বইয়ের নাম লিখুন অথবা BOOKS লিখে বর্তমান বইয়ের তালিকা দেখুন। " + helpBangla,
  );
}
