# BookHarbor BD — MIS 465 assignment

A working academic bookshop demo for IUB Web Development & E-commerce. It includes a responsive catalogue, multilingual chat workflow, validated demo orders, private owner dashboard, and an official Facebook Messenger webhook. No payment or courier booking is performed.

## Current deployment — 17 October 2026

- Website: https://bookharbor-mis465.bookharbor-mis465.workers.dev
- Messenger: https://m.me/1270406139500514 (Page for testing).
- Real admin-profile messages and replies verified, including a Cloudflare AI response; 17 automated tests pass.
- Meta accepted the Page subscription for messages and messaging_postbacks. Reading the subscription list still requires pages_manage_metadata permission.
- Public-user access and token expiry have not been verified. For a classroom demo, use the tested admin profile or an accepted app Tester role.
- See [MESSENGER-SETUP.md](MESSENGER-SETUP.md) and [VERIFICATION.md](VERIFICATION.md) for setup and evidence.

## Start on this computer

Requires Node.js 22.13+ (Node 24 recommended). No packages are required for the local demo.

```powershell
npm.cmd start
```

Open http://127.0.0.1:8787. The local-only server automatically authenticates the browser and binds only to loopback. Do not expose it publicly. Local state is saved in ignored `work/demo.sqlite`. Cloudflare AI is intentionally unavailable locally; the interface labels the fixed-rule fallback honestly.

## Run verification

```powershell
npm.cmd test
```

Tests cover totals, language lookup, number validation, stock, explicit confirmation, edited quotes, duplicate events, transaction rollback, handover, signature verification, protected routes, AI failure and the durable inbox. AI tests use mocks; passing them does not prove live AI quality or Meta permissions.

Conversation regression tests also cover Bangla title suffixes (`হবিটটার দাম কত?`),
punctuation and Unicode variants, Banglish follow-ups (`dam koto?`, `eta nibo`),
and quantities written as words (`দুই কপি`, `dui copy`, `two copies`). Short price
and stock follow-ups refer to the last selected title. Unknown titles and multiple
titles require clarification; matching is intentionally not fuzzy. Delivery,
payment and return enquiries use fixed shop policies, including when a title is
mentioned. Negated purchase requests do not start checkout. Confirmation still
requires an existing summary and one of the original exact confirmation commands;
conversational normalization never authorizes an order. These tests run entirely
locally with in-memory databases and no live AI or Messenger requests.

## Customer-language and unavailable-title responses

The assistant responds in English to clearly English enquiries, even after a
Bangla or Banglish exchange. Bengali-script messages receive Bengali replies,
and conversational Banglish messages receive Banglish replies. Bare title
selections, quantities, colours and exact confirmation commands preserve the
previous conversation language. Greetings, payment and returns guidance, and
catalogue prompts have language-appropriate copy.

For a specifically named book absent from the D1 catalogue (for example,
`Do you have Atomic Habits?` or `Dune kinbo`), the assistant explains that the
title is not listed and offers BOOKS or HUMAN. It does **not** claim to know a
missing book's price or stock, invent inventory, or reuse a previously selected
title for an unlisted request. Descriptive book enquiries may still be
classified by the constrained Workers AI classifier. A real book request,
order, payment or availability cannot be fulfilled for unlisted inventory.

Use `npm test` inside `bookharbor/` to run the existing regression suite
plus `tests/customer-communication.test.mjs`. This does not contact Meta or
Cloudflare. No automatic deployment is configured in CI.

## Present to your professor

1. Open Bookshop. Explain that all prices and inventory are fictional, inspired by book titles in the reference screenshots. The shop is not affiliated with Book Ocean BD.
2. Send `Hobbit price koto?`, `হবিট দাম কত?`, then `order Hobbit`.
3. Answer `2`, `blue`, `Demo Reader`, `01700000000`, `House 1, Road 2, Mirpur, Dhaka`.
4. Check the summary: books ৳1,300 + delivery ৳70 = ৳1,370. No order exists until confirmation.
5. Send `CONFIRM`; open Orders and show the saved order reference and reduced stock.
6. Try `Watch Me` (out of stock), an invalid phone, and `human` (pauses the conversation). Resume from Conversations.
7. Once deployed and connected, repeat on Messenger using a permitted Meta test account. Show Facebook events in Conversations.
7. Repeat on the connected testing Page using a permitted Meta test account. Show Facebook events in Conversations.
8. To demonstrate genuine AI interpretation after deployment, ask `Do you have the adventure about Bilbo?`. Check the message engine label. If unavailable, report the fallback rather than claiming AI ran.

## Architecture in plain language

The website is the shop window. The Worker is the server that receives messages and enforces rules. D1 is the order notebook. Cloudflare Workers AI classifies unfamiliar general enquiries into a small list of allowed intents; it cannot set prices, modify inventory, or place orders. Fixed application code collects personal order fields and calculates totals. Messenger delivers signed events to `/webhook`; a durable inbox and scheduled processor handle them.

Demo shop rules: Dhaka city ৳70, suburbs ৳100, outside Dhaka ৳130 per order, free blue/red/no gift wrap, demo COD, no added COD fees. This is an intentionally simplified sample policy, not an actual courier quotation. Each order contains one title/edition with 1–10 copies. Multi-title carts and arbitrary free-form amendments are not implemented.

## Free-only deployment

See [DEPLOYMENT.md](DEPLOYMENT.md). Stay on Cloudflare Workers Free; do not enable a paid plan or AI Gateway credits. The app never calls OpenAI's paid API. ChatGPT Plus is used for development, not as an API credential. Workers AI has a daily allowance and can stop at its limit; fixed-rule fallback remains available while hosting/database allowances remain available. No free service guarantees uninterrupted availability.

## Data and operational limitations

- Fictional test data only. Dashboard access uses an owner password with signed, HttpOnly sessions; share the password only with intended testers.
- Fictional test data only. Dashboard access uses an owner password with signed, HttpOnly sessions. Messenger testers do not need this password; keep it private to the owner.
- General unfamiliar enquiries may be sent to Cloudflare AI. Phone-like text is masked, but this is not a universal personal-data filter. Do not submit real private information.
- The Page app secret and Page token belong only in Cloudflare secrets, never GitHub or browser JavaScript. Previously exposed credentials must be rotated.
- Inbox replay is deduplicated; order state, order insert and inventory update share one database transaction. A global expiring lock serializes short demo workloads. This is suitable for a tiny course demo, not high-volume production.
- Facebook delivery after a network failure can be uncertain. Such messages appear as failed/sending for owner review and are not blindly resent. A crash can delay pending work until the next scheduled run.
- Bot handover pauses this bot's replies. The owner replies in Meta Business Suite; this is not a full shared-inbox product. Reset starts a new automated session.
- Accounts, quotas, model availability, token validity and Meta review are external dependencies. Before grading, perform a real send-and-receive test from the exact account the professor will use.
- A development-mode app may work only for permitted app roles/testers. A successful webhook challenge does not prove arbitrary members of the public can message the app.
- No real checkout, payment, courier, Daraz, Foodpanda, Uber, SWAP or Bikroy integration is claimed.

## Deleting a test conversation

The owner can execute the following in the database console, replacing the example with the exact conversation ID shown in the private dashboard. Delete only the requested test conversation. Deleting its orders does not restore stock; reset inventory separately only after checking the demo records.

```sql
DELETE FROM messages WHERE conversation_id = 'demo:REPLACE';
DELETE FROM orders WHERE conversation_id = 'demo:REPLACE';
DELETE FROM events WHERE conversation_id = 'demo:REPLACE';
DELETE FROM conversations WHERE id = 'demo:REPLACE';
```

After grading, remove the demo's customer records and revoke the testing credentials. Retain source code and fictional catalogue separately.

## Sources checked 16 October 2026

- Workers AI free allocation: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Qwen model and binding: https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/
- Messenger Send API: https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api
- Actual courier-rate comparison (not the demo tariff): https://help.pathao.com/what-is-the-delivery-charge-inside-or-outside-the-city/
