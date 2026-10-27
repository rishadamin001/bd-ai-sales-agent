# BookHarbor project status — 28 October 2026

This file records confirmed engineering state, not a claim of public Facebook availability. Read it before creating a new Cloudflare Worker, D1 database, or Meta application.

## Canonical project
- GitHub: `rishadamin001/bd-ai-sales-agent`; active application is `bookharbor/`. The Python prototype at repository root is not this deployment.
- Academic scope: IUB MIS 465 multilingual English/Bengali/Banglish bookshop demo, with **simulated** COD orders, fictional customer data, sample prices and stock. No actual payments or courier integration.
- Existing Worker: `bookharbor-mis465`; intended public URL: `https://bookharbor-mis465.bookharbor-mis465.workers.dev/`.
- Existing D1: `bookharbor-mis465`; immutable database ID is recorded in `bookharbor/wrangler.jsonc`. Do **not** recreate it or reset production stock.
- Meta Page for role-authorized testing: `1270406139500514`; webhook: `/webhook`. Meta app ID: `2463702974155193`.
- Configured Workers AI handles intent classification only. Deterministic code and live D1 rows control all book prices, stock, delivery charges, and order confirmation.
- Test delivery charges: Dhaka ৳70, suburbs ৳100, outside Dhaka ৳130 per order.

## What has been verified
- 17 October 2026: Messenger messages and replies were observed from an authorized administrator profile; webhook and some Cloudflare AI interpretation worked. That does **not** establish public customer access today.
- 27 October 2026: PR #4 merged multilingual replies and unlisted-title handling.
- 27 October 2026: PR #5 merged grounded catalogue discovery and four MIS sample textbook listings; the safe additive migration file is `bookharbor/migrations/2026-10-27-add-mis-books.sql`.
- 27 October 2026: PR #6 merged safe quantity/wrap changes in unconfirmed orders. GitHub Actions passed **88 tests** for that version.
- The GitHub-to-Cloudflare manual deployment workflow was subsequently prepared to verify target account/Worker/D1 identity before release. CI tests validate logic, not Cloudflare execution.

## What remains unverified or blocked
- **Cloudflare deployment:** GitHub merges do not automatically update the Worker. The four MIS products require the additive D1 migration on the existing remote database. The updated Worker must then be deployed and `/api/catalog` checked.
- **Cloudflare credentials:** This repository never contains Cloudflare API tokens or Facebook Page tokens. The `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub Actions secrets must be set by the account owner before the manual deployment workflow can run.
- **Meta access:** Ordinary non-role Facebook Messenger customers have not been verified. App review, `pages_messaging` Advanced Access, and applicable authentic business verification may still be required. Do not fabricate business documents or assume Live mode grants permission.
- **Security:** Prior screenshots may have exposed a Page token. Ensure exposed tokens are revoked or rotated in Meta and Cloudflare Worker secrets updated as appropriate.

## Safe next actions
1. Open `bookharbor/DEPLOYMENT.md` and review the new **manual GitHub Actions deployment** procedure; use only the existing Worker and database.
2. Set the two Cloudflare Actions secrets privately in GitHub and manually run `BookHarbor controlled Cloudflare deploy` from `main`.
3. Inspect its checks and verify the live site exposes the original eight plus four MIS sample book listings. Do not place demo orders merely to verify a deploy.
4. Use an **authorized Meta tester** for end-to-end Messenger checks. Separate source-code success, accepted Meta API sends, visible replies, and public-user access in reports.
5. For further product refinements, create a branch/PR, run tests, and deploy the approved main branch only after target verification.

## Guardrails
- Never recreate the original Cloudflare Worker or D1 to work around account mismatch.
- Never run broad destructive SQL or full schema resets against remote D1.
- Never store real tokens, owner passwords, phones, addresses or conversations in GitHub.
- Avoid enrolling unnecessary services or enabling billing; this project was designed for a small academic demo.
- Do not conflate the old Python `Aura` project with the current JavaScript Cloudflare `bookharbor` application.
