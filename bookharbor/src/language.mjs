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
