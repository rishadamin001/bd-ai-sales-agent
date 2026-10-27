// These helpers interpret enquiries only. Confirmation remains an exact command
// in the order state machine; fuzzy matches must never authorize an order.
export const bnDigits = (text) =>
  String(text).replace(/[০-৯]/g, (c) => "০১২৩৪৫৬৭৮৯".indexOf(c));
export const normalize = (text) => bnDigits(text).toLowerCase().trim();
export const enquiryText = (text) => normalize(text).normalize("NFC")
  .replace(/[\u200b-\u200d\ufeff]/g, "")
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");

export function hasPhrase(text, phrases) {
  const t = ` ${enquiryText(text)} `;
  return phrases.some((phrase) => t.includes(` ${enquiryText(phrase)} `));
}

export function matchingProducts(text, products) {
  const t = enquiryText(text);
  return products.filter((p) => p.aliases.split(",").some((alias) => {
    const a = enquiryText(alias);
    if (!a) return false;
    // Bengali title suffixes are explicit; arbitrary substrings are not titles.
    const suffixes = /[\u0980-\u09ff]/.test(a) ? ["", "টা", "টি", "টার", "টির", "এর", "ের"] : [""];
    return suffixes.some((suffix) => (` ${t} `).includes(` ${a}${suffix} `));
  }));
}

export const negativeRequest = (text) => hasPhrase(text, [
  "no", "not", "don't", "dont", "do not", "never", "na", "nai", "না", "নাই", "নয়", "নয়", "নেই",
]);
export const wantsOrder = (text) => !negativeRequest(text) && hasPhrase(text, [
  "order", "buy", "nibo", "nebo", "kinbo", "chai", "nite chai", "অর্ডার", "কিনব", "কিনবো", "নেব", "নেবো", "চাই",
]);
export const contextualOrder = (text) => /^(?:(?:i want to|i would like to|please) )?(?:order|buy)(?: (?:it|this|this book))?(?: please)?$/.test(enquiryText(text)) ||
  /^(?:eta |eita |এই বইটা |এটা )?(?:nibo|nebo|kinbo|nite chai|অর্ডার|কিনব|কিনবো|নেব|নেবো|চাই)$/.test(enquiryText(text));

export function enquiryIntent(text) {
  if (hasPhrase(text, ["delivery", "shipping", "charge", "ডেলিভারি", "ডেলিভারির", "চার্জ", "পাঠাতে", "পৌঁছাতে"])) return "delivery";
  if (hasPhrase(text, ["return", "returns", "exchange", "refund", "ferot", "ফেরত", "বদল"])) return "returns";
  if (hasPhrase(text, ["payment", "pay", "bkash", "bikash", "nagad", "cod", "পেমেন্ট", "বিকাশ", "নগদ"])) return "payment";
  if (hasPhrase(text, ["books", "catalog", "catalogue", "list", "boi", "বই", "বইগুলো", "বুক"])) return "catalog";
  if (hasPhrase(text, ["price", "cost", "dam", "daam", "koto", "দাম", "কত", "stock", "available", "availability", "ache", "ase", "আছে", "স্টক"])) return "product";
  if (/^(hi|hello|hey|salam|assalamu alaikum|assalamualaikum|হ্যালো|সালাম|আসসালামু আলাইকুম)$/.test(enquiryText(text))) return "greeting";
  return null;
}

export function quantity(text) {
  const t = normalize(text).normalize("NFC");
  const words = [
    ["one", "ek", "এক"], ["two", "dui", "দুই"], ["three", "tin", "তিন"],
    ["four", "char", "চার"], ["five", "pach", "panch", "পাঁচ"],
    ["six", "choy", "ছয়", "ছয়"], ["seven", "sat", "সাত"],
    ["eight", "at", "aat", "আট"], ["nine", "noy", "নয়", "নয়"], ["ten", "dosh", "দশ"],
  ];
  const match = t.match(/^(\d{1,2}|[\p{L}\p{M}]+?)(?:\s*(?:copies|copy|ta|টি|টা|কপি|pcs))?$/u);
  if (!match) return 0;
  return /^\d+$/.test(match[1]) ? Number(match[1]) : words.findIndex((group) => group.some((word) => normalize(word).normalize("NFC") === match[1])) + 1;
}


/**
 * Detect explicit language changes without changing languages for a book title,
 * number, colour, or the fixed confirmation command.
 */
export function messageLanguage(text, previous = "en") {
  const t = enquiryText(text);
  if (/[\u0980-\u09ff]/.test(t)) return "bn";
  if (hasPhrase(t, [
    "koto", "ache", "ase", "bhai", "bhaiya", "chai", "lagbe", "diben",
    "korbo", "amar", "boi", "den", "korte", "nibo", "nebo", "kinbo",
    "kivabe", "dorkar", "dam", "daam", "dui", "nil", "lal", "ferot",
    "ki", "kemon", "eta", "eita", "hobe", "paowa jabe", "ki ki", "dhonnobad",
  ])) return "bl";
  // These messages are selections/commands, not evidence of language preference.
  if (/^(?:\d+|confirm(?: order)?|yes|ok|cancel(?: order)?|reset|restart|blue|red|none|no wrap|human|agent|owner|staff|books|catalog|catalogue|order|buy|help|[\p{L}\p{M}]+(?: [\p{L}\p{M}]+){0,2})$/u.test(t) &&
      !hasPhrase(t, ["hello", "hi", "hey", "thanks", "thank you", "price", "cost", "stock", "available", "delivery", "shipping", "payment", "return", "refund"])) {
    return previous || "en";
  }
  if (hasPhrase(t, [
    "hello", "hi", "hey", "thank you", "thanks", "please", "how much", "how many",
    "what", "where", "when", "do you", "can i", "could you", "i want",
    "i would", "i need", "is it", "is there", "are you", "price", "cost",
    "available", "availability", "in stock", "delivery", "shipping",
    "payment", "refund", "return", "buy", "recommend", "looking for",
  ])) return "en";
  return previous || "en";
}

/**
 * Extract only a specifically named, unlisted title; never guess a price,
 * inventory or substitute a previously selected product.
 */
export function requestedUnlistedTitle(text) {
  const t = enquiryText(text);
  const patterns = [
    /^(?:do you (?:have|sell|stock|carry)|have you got|do you carry|is there|can i (?:buy|order)|i (?:want|would like) to (?:buy|order)|(?:please )?(?:order|buy)) (.+?)(?: (?:available|in stock|please))?$/,
    /^is (.+?) (?:available|in stock)$/,
    /^(?:what is (?:the )?price of|how much (?:is|does) (?:the book )?|price (?:of|for)) (.+?)(?: cost)?$/,
    /^(.+?) (?:available|in stock|price|stock|kinbo|nibo|nebo|ache|ase|আছে|কিনবো|কিনব|দাম কত)$/,
    /^(?:আপনাদের কাছে|তোমাদের কাছে) (.+?) (?:আছে|পাওয়া যাবে)$/,
    /^(.+?) (?:পাওয়া যাবে|আছে কি|কিনতে চাই)$/,
    /^(?:looking for|do you have the book called|have the book called) (.+)$/,
  ];
  let title = patterns.map((p) => t.match(p)?.[1]).find(Boolean);
  if (!title && /^[\p{Lu}][\p{L}\p{M}]+(?: [\p{Lu}][\p{L}\p{M}]+){0,5}$/u.test(String(text).trim())) {
    title = t; // e.g. "Dune" or "Atomic Habits", not arbitrary lowercase commands.
  }
  if (!title) return null;
  title = title.replace(/^(?:a copy of|the book called|the book named|the book|book called|book named) /, "").trim();
  const common = /^(?:it|this|that|this book|the book|a book|any book|any books|more books|books|book|anything|something|everything|one|two|help|hello|thanks|thank you|price|delivery|payment|a recommendation|recommendations)$/;
  // Descriptions are not book titles. Pass them to the constrained AI classifier.
  if (/^(?:the |an? )?(?:adventure|story|novel|book|fantasy|mystery|romance) (?:about|with|like|by)\b/.test(title) ||
      /\b(?:something about|a book about|books like|similar to|recommend|suggest)\b/.test(title)) return null;
  if (!title || title.length > 85 || title.split(" ").length > 9 || common.test(title)) return null;
  return title;
}

export const appreciation = (text) => /^(?:thanks|thank you|thank you very much|thanks a lot|thank u|dhonnobad|ধন্যবাদ|অনেক ধন্যবাদ)$/u.test(enquiryText(text));
