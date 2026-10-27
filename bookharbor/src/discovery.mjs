import { enquiryText, hasPhrase } from "./language.mjs";

/**
 * Catalogue discovery reads D1 product rows only. It never changes the cart,
 * prices, stock, or any order authorization decision.
 */
const GENRES = [
  // MIS is an academic category, not a generic title alias: one request
  // should list all matching books instead of arbitrarily selecting one.
  { id: "management information systems", labels: [
    "mis", "mis books", "mis textbooks", "management information systems",
    "management information system", "information systems",
    "information systems books", "information systems textbooks",
    "management information systems books", "ম্যানেজমেন্ট ইনফরমেশন সিস্টেমস",
    "ম্যানেজমেন্ট ইনফরমেশন সিস্টেম", "এমআইএস", "এম আই এস", "mis boi",
  ] },
  { id: "fantasy", labels: ["fantasy", "ফ্যান্টাসি"] },
  { id: "fiction", labels: ["fiction", "ফিকশন"] },
  { id: "manga", labels: ["manga", "মাঙ্গা"] },
  { id: "comics", labels: ["comic", "comics", "কমিক", "কমিকস"] },
  { id: "romance", labels: ["romance", "রোমান্স"] },
  { id: "box set", labels: ["box set", "box sets", "boxed set", "বক্স সেট"] },
];

function budgetCriterion(text) {
  const t = enquiryText(text);
  const patterns = [
    /(?:^| )(under|below|less than|within|up to|maximum(?: price)?(?: of)?|max(?: price)?(?: of)?) (?:bdt |tk |taka )?(\d{1,6})(?: |$)/,
    /(?:^| )(?:my |our )?budget(?: is| of| around)? (?:bdt |tk |taka )?(\d{1,6})(?: |$)/,
    /(?:^| )(?:books?|titles?) (?:for|within) (?:bdt |tk |taka )?(\d{1,6})(?: |$)/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (!m) continue;
    const amount = Number(m[i === 0 ? 2 : 1]);
    if (amount < 1 || amount > 100000) return null;
    return { amount, strict: i === 0 && ["under", "below", "less than"].includes(m[1]) };
  }
  return null;
}

function authorCriterion(text) {
  const t = enquiryText(text);
  const match = t.match(/(?:^| )(?:books?|titles?) (?:written )?by (.+)$/u);
  if (!match) return null;
  const author = match[1].trim();
  // Don't interpret vague phrases as specific author names.
  return author && author.length <= 70 ? author : null;
}

export function discoverBooks(text, products) {
  const t = enquiryText(text);
  const genre = GENRES.find((g) => hasPhrase(t, g.labels))?.id || null;
  const author = authorCriterion(text);
  const budget = budgetCriterion(text);
  const cheap = hasPhrase(t, ["cheap", "cheapest", "affordable", "low price", "কম দাম", "সস্তা"]);
  const recommend = hasPhrase(t, [
    "recommend", "recommendation", "recommendations", "suggest", "suggestion",
    "suggestions", "what should i read", "what should i buy",
    "good book", "good books", "ভালো বই", "বই সাজেস্ট", "সুপারিশ", "পরামর্শ",
    "sajest", "sajest koro", "suggest koro", "recommend koro",
  ]);
  // If someone asks for a quality or theme absent from catalogue metadata
  // ("suggest something mysterious"), do not pretend generic cheap books fit.
  // Keep the existing constrained AI/fallback path for such open-ended requests.
  const thematicRequest = recommend && !genre && !author && !budget && !cheap &&
    /(?:suggest|recommend)(?: me)? (?:something|anything|a book|books?)(?: [a-z]+){1,}/.test(t);
  if (thematicRequest) return null;

  // An explicit title should normally take precedence. These tokens indicate
  // the customer is asking for browsing/filtering, not a single title's price.
  const browse = genre || author || budget || cheap || recommend;
  if (!browse) return null;

  // Never turn payment/delivery/return questions into a book recommendation.
  const isPolicy = hasPhrase(t, [
    "delivery", "shipping", "charge", "ডেলিভারি", "চার্জ",
    "return", "returns", "refund", "ফেরত", "বদল",
    "payment", "pay", "bkash", "bikash", "nagad", "পেমেন্ট", "বিকাশ", "নগদ",
  ]);
  if (isPolicy) return null;

  // Ignore sentences that merely mention a genre without asking about books.
  if (genre && !author && !budget && !recommend && !cheap &&
      !hasPhrase(t, ["book", "books", "textbook", "textbooks", "boi", "বই", "বইগুলো", "available",
        "have", "show", "list", "read", "title", "titles"]) &&
      t !== genre && !GENRES.some((g) => g.labels.some((label) => t === enquiryText(label)))) {
    return null;
  }

  const authorTokens = author?.split(" ").filter(Boolean) || [];
  const matches = products
    .filter((p) => Number(p.stock) > 0)
    .filter((p) => !genre || enquiryText(p.category) === genre)
    .filter((p) => !author || authorTokens.every((token) =>
      (" " + enquiryText(p.author) + " ").includes(" " + token + " ")))
    .filter((p) => !budget || (budget.strict ? Number(p.price) < budget.amount
      : Number(p.price) <= budget.amount))
    .sort((a, b) => Number(a.price) - Number(b.price) || a.title.localeCompare(b.title));

  return {
    matches: matches.slice(0, genre || author || budget ? 5 : 3),
    totalMatches: matches.length,
    genre, author, budget, cheap, recommend,
  };
}

export function discoveryReply(discovery, language) {
  const { matches, totalMatches, genre, author, budget } = discovery;
  const filters = [
    genre ? `${genre} books` : null,
    author ? `books by ${author}` : null,
    budget ? `priced ${budget.strict ? "under" : "up to"} ৳${budget.amount}` : null,
  ].filter(Boolean);
  const criteria = filters.length ? filters.join(", ") : "books";
  if (!totalMatches) {
    if (language === "bn")
      return `আমাদের নমুনা তালিকায় এখন মজুত থাকা ${criteria} পাওয়া যায়নি। সব বই দেখতে BOOKS অথবা সহায়তার জন্য HUMAN লিখুন।`;
    if (language === "bl")
      return `Amader demo catalogue-e ekhon available ${criteria} nei. Sob boi dekhte BOOKS, help-er jonno HUMAN likhun.`;
    return `I couldn't find any currently available ${criteria} in our demo catalogue. Type BOOKS to browse the full list or HUMAN for help from the owner.`;
  }
  const items = matches.map((p) => `• ${p.title} — ৳${p.price} (${p.stock} available)`).join("\n");
  const more = totalMatches > matches.length
    ? `\n${totalMatches - matches.length} additional matching titles are not shown here.`
    : "";
  if (language === "bn")
    return `আমাদের ডেমো তালিকা থেকে মজুত থাকা ${criteria} (দাম অনুযায়ী):\n${items}${more}\nডেলিভারি চার্জ আলাদা। বিস্তারিত জানতে একটি বইয়ের নাম লিখুন।`;
  if (language === "bl")
    return `Amader demo catalogue-er available ${criteria} (kom dam age):\n${items}${more}\nDelivery charge alada. Details jante boier naam likhun.`;
  return `Here are currently available ${criteria} from our demo catalogue (lowest price first):\n${items}${more}\nDelivery is charged separately. Send an exact title for details; these are catalogue options, not popularity rankings.`;
}
