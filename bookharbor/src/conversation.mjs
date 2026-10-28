import { enquiryText, negativeRequest } from "./language.mjs";

/** Explicit customer preferences override automatic language guessing. */
export function languagePreference(text) {
  const t = enquiryText(text);
  if (/^(?:auto language|detect language automatically|automatic language|language auto|use my language)$/.test(t))
    return "auto";
  if (/^(?:(?:please )?(?:switch|change)(?: (?:the|your))? language to|(?:please )?(?:switch|change) to|(?:please )?(?:speak|reply|talk|respond)(?: to me)? in|can you (?:please )?(?:speak|reply|talk|respond)(?: to me)? in|can you (?:please )?(?:speak|reply|talk|respond) in|(?:from now (?:on )?)?(?:use|speak)) english(?: (?:from now|from now on|only|please))?|english(?: from now on| only| please)?)$/.test(t) ||
      /^(?:can you|could you) (?:please )?(?:speak|reply|talk|respond) (?:in )?english(?: from now(?: on)?)?$/.test(t))
    return "en";
  if (/^(?:(?:please )?(?:switch|change)(?: (?:the|your))? language to|(?:please )?(?:switch|change) to|(?:please )?(?:speak|reply|talk|respond)(?: to me)? in|can you (?:please )?(?:speak|reply|talk|respond)(?: to me)? in) (?:bangla|bengali)|(?:speak|reply|talk|respond) (?:bangla|bengali)|(?:bangla|bengali)(?: from now on| only| please)?|(?:accha |acha |ekhon |please )?(?:banglay|bangla te|bengali te) (?:bolo|bolen|bolun|kotha bolo)|বাংলায় (?:বলুন|বলো|কথা বলুন|উত্তর দিন)|বাংলায় (?:বলুন|বলো|কথা বলুন|উত্তর দিন))$/.test(t))
    return "bn";
  if (/^(?:(?:please )?(?:switch|change)(?: (?:the|your))? language to|(?:please )?(?:switch|change) to|(?:please )?(?:speak|reply|talk|respond)(?: to me)? in) banglish|banglish(?: from now on| only| please)?|(?:banglish e|banglishe) (?:bolo|bolun|reply dao))$/.test(t))
    return "bl";
  return null;
}

/** Exactly one recommendation, not a full list or an arbitrary book named "One". */
export function wantsOneRecommendation(text) {
  if (negativeRequest(text)) return false;
  const t = enquiryText(text);
  return /\b(?:recommend|suggest|sajest)(?: me)? (?:just |only )?(?:one|1|a single)(?: book| title)?\b/.test(t) ||
    /\b(?:recommend|suggest)(?: me)? (?:a|one) (?:good |single |fantasy |fiction |mis )?book\b/.test(t) ||
    /\b(?:one|single) (?:book|title) (?:recommendation|suggestion)\b/.test(t) ||
    /\b(?:ekta|akta|ekti) boi (?:suggest|sajest|recommend)\b/.test(t) ||
    /(?:একটা|একটি) বই (?:সাজেস্ট|রিকমেন্ড|সুপারিশ)/.test(t);
}

export function recommendationFollowup(text) {
  const t = enquiryText(text);
  if (/^(?:why|why that|why this one|why should i read it|why recommend it|tell me more|more details|tell me about it|what is it about|who wrote it|who is the author|what genre is it|why this book)$/.test(t)) return t;
  return null;
}

const categoryReason = {
  fantasy: ["a fantasy title", "fantasy genre-er boi", "ফ্যান্টাসি ঘরানার বই"],
  fiction: ["a fiction title", "fiction genre-er boi", "ফিকশন ঘরানার বই"],
  manga: ["a manga title", "manga boi", "মাঙ্গা বই"],
  "management information systems": ["an MIS textbook", "MIS textbook", "এমআইএস পাঠ্যবই"],
  "box set": ["a box set", "box set", "বক্স সেট"],
  romance: ["a romance title", "romance genre-er boi", "রোমান্স ঘরানার বই"],
  comics: ["a comic book", "comics boi", "কমিকস বই"],
};
export function recommendedBookReply(product, language) {
  const kind = categoryReason[enquiryText(product.category)] || ["a book in our catalogue", "catalogue-er boi", "আমাদের তালিকার বই"];
  if (language === "bn") return `আমি ${product.title} সাজেস্ট করব। এটি ${kind[2]}, দাম ৳${product.price}। আরও জানতে চান?`;
  if (language === "bl") return `Ami ${product.title} suggest korbo. Eta ${kind[1]}, dam ৳${product.price}. Aro jante chan?`;
  return `I'd suggest ${product.title} (৳${product.price}). It's ${kind[0]} by ${product.author}. Want to know more?`;
}

export function bookFollowupReply(product, text, language) {
  const t = enquiryText(text);
  const who = /(?:who wrote|who is the author)/.test(t);
  if (who) return language === "bn"
    ? `লেখক: ${product.author}।`
    : language === "bl" ? `Lekhok: ${product.author}.`
      : `It's written by ${product.author}.`;
  const kind = categoryReason[enquiryText(product.category)] || ["a book in our catalogue", "catalogue-er boi", "আমাদের তালিকার বই"];
  if (language === "bn") return `${product.title} একটি ${kind[2]}। লেখক ${product.author}। বর্তমানে দাম ৳${product.price}।`;
  if (language === "bl") return `${product.title} ${kind[1]}. Lekhok ${product.author}. Dam ৳${product.price}.`;
  return `${product.title} is ${kind[0]} by ${product.author}. It's currently listed at ৳${product.price}.`;
}
