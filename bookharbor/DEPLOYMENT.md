# Deploy and connect Messenger — free course demo

Current deployment: https://bookharbor-mis465.bookharbor-mis465.workers.dev

The database and deployment are already provisioned in the owner's account. The website password and Meta verify token are in the ignored local file `work/OWNER-ACCESS.txt`. Do not upload this file to GitHub. The initial Cloudflare authorization succeeded using `wrangler login --device`, which avoids localhost callback failures.

To securely save rotated Meta secrets on this computer, run `scripts/configure-facebook.ps1` in PowerShell. Actual Messenger delivery still requires the Meta webhook setup below.

## Optional BookHarbor AI v2: private Gemini integration

This is an **opt-in** enhancement. Existing Cloudflare Workers AI continues
to work without any Gemini configuration. Do not create another Worker, D1
database, Facebook Page, or business portfolio.

**Model:** `gemini-3.5-flash-lite` (the current free-tier-first stable
option). Check the live model availability and free-tier quota for your own
Google AI Studio project before activating. Gemini 2.5 Flash may have
limited access for new projects. Google says free-tier content may be used to
improve its products. Do not send customer personal information or actual
orders to its free API.

### Setup without publishing an API key

1. Open <https://aistudio.google.com/api-keys> and create a dedicated Gemini
   API key in your own Google project; use a **Free** project if eligible.
   Do not enable paid billing merely for this academic demo. Check usage
   limits at <https://ai.google.dev/gemini-api/docs/pricing>.
2. In the existing Cloudflare dashboard, open **Workers & Pages** →
   **bookharbor-mis465** → **Settings** → **Variables and Secrets**.
   Add `GEMINI_API_KEY` as a **Secret**, entering the value privately.
   Do not paste it in GitHub, Messenger, a chat, `wrangler.jsonc`, or any
   repository file.
3. Keep the existing `AI_ENABLED=true` for Cloudflare Workers AI fallback.
   The application checks `GEMINI_ENABLED`; until it equals the literal
   string `true`, no Gemini requests are made. For the first deployment,
   leave it absent. After GitHub CI and a test message succeed, add
   `GEMINI_ENABLED` with value `true` as another Worker secret
   (or change its existing value).
4. Run the existing GitHub **BookHarbor controlled Cloudflare deploy**
   workflow on `main` (Worker and database names both
   `bookharbor-mis465`). The already-applied MIS migration uses
   `INSERT OR IGNORE` and does not reset stock.
5. Test with an authorized Messenger account: `Switch to English`,
   `Recommend me one`, `Why should I read it?`, `Auto language`,
   `Accha Banglay bolo`, and `Is there any discount?`.
   Also test an out-of-stock book and ensure `CONFIRM` is only effective
   inside an explicit order-confirmation step.
6. If Gemini fails or exhausts its free tier, BookHarbor should fall back to
   the existing Cloudflare classifier or local rules. To disable external
   Gemini calls immediately, set `GEMINI_ENABLED` to `false`; the
   existing Messenger, catalogue and order system keep working.

The Gemini request includes only a bounded bookstore question, the
preferred language, last selected catalogue ID (if any), and public
catalogue titles/genres/authors. A fail-closed filter rejects identifiable
phone numbers, emails, address-like details, order actions and other
sensitive inputs before calling Google. Checkout fields, actual order
details and confirmation are processed locally without Gemini. A structured
response must match an existing catalogue ID, and free-form model output
is accepted only for limited small talk (no prices, stock, discounts,
payment or checkout claims).

The Gemini model cannot alter prices, stock or orders. Do not claim the
new AI is live until you see a successful deployment **and** an actual
Messenger reply. Google API and Cloudflare costs/quotas can change:
monitor Google AI Studio usage and Cloudflare metrics.

## Option A: controlled deployment from GitHub (recommended)

The repository now includes a **manual-only GitHub Actions** workflow called
`BookHarbor controlled Cloudflare deploy`. It does **not** run automatically
when a pull request is merged. A successful GitHub code test is not proof
that Cloudflare was updated.

**One-time setup (performed in your own accounts, never in ChatGPT):**

1. In [Cloudflare dashboard](https://dash.cloudflare.com/), create a narrowly
   scoped account API token with enough permission to deploy your **existing**
   Worker (**Workers: Editor** for that Worker) and execute your existing
   database migration (**D1: Edit**, scoped as narrowly as available).
   See [Cloudflare's current GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
   and [access scopes](https://developers.cloudflare.com/workers/authorization/workers/).
   Do not share or commit the token.
2. Open the GitHub repository → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**. Save these **two** secret names:
   - `CLOUDFLARE_API_TOKEN`: the Cloudflare token from step 1
   - `CLOUDFLARE_ACCOUNT_ID`: the ID of the **existing** BookHarbor account;
     it must exactly match `account_id` in `wrangler.jsonc`
3. In GitHub, open **Actions** → **BookHarbor controlled Cloudflare deploy** →
   **Run workflow**. Select branch `main`, enter exactly
   `bookharbor-mis465` in both the **Worker name** and **Database name** inputs,
   and keep **Insert missing MIS demo titles** selected for your first run.
4. Follow the job logs. The workflow installs dependencies, runs all tests,
   confirms your Cloudflare account and existing D1 database ID, executes
   the four-row `INSERT OR IGNORE` MIS migration, verifies all four new
   records, deploys the Worker, and checks the public health/catalogue
   endpoints without generating any order.

The workflow **does not create or delete databases**, send customer messages,
reset stock, touch owner login secrets or collect payment. If identity checks
fail it stops before D1 changes. If migration succeeds but the deploy fails,
running the same workflow again safely skips existing MIS rows; it does not
overwrite current stock. To avoid introducing new permission problems, keep
the token scoped to the existing resources rather than all Cloudflare accounts.

**Important:** This workflow cannot run until both secrets are actually
configured in GitHub. Merely merging the workflow file has no effect on
Cloudflare. The connection available to a ChatGPT conversation and a
Cloudflare connector available in Codex can differ. Do not assume a plugin
was used for deployment unless the Cloudflare account or GitHub workflow
reports an accepted release. Full Messenger/public-account testing remains
a separate Meta approval and role-access milestone.

### Local Wrangler alternative

The original authenticated Wrangler instructions below are still valid if
you prefer not to store a deployment API token in GitHub. Never run the
full `schema.sql` as a routine production migration once the database has
real orders; use the additive MIS migration instead.

## 1. Cloudflare login

Use the Free plan. No custom domain or payment card is required by this project. Do not upgrade when a quota is exhausted.

In PowerShell, open the project folder, then:

```powershell
npm.cmd install
npx.cmd wrangler login --scopes account:read user:read workers:write workers_scripts:write d1:write ai:write
```

Complete sign-in and authorization yourself. Keep passwords and API tokens out of chat. If the authorization expires, rerun the command. This installs and uses Cloudflare's official Wrangler tool.

## 2. Database and initial deployment

```powershell
npx.cmd wrangler d1 create bookharbor-mis465 --location apac --binding DB --update-config
```

Check `wrangler.jsonc`: the DB binding must contain the returned database ID rather than `REPLACE_WITH_CREATED_DATABASE_ID`. If a database with that name already exists, use `npx.cmd wrangler d1 list` and its existing ID; do not create duplicates.

```powershell
npm.cmd run db:migrate
npx.cmd wrangler deploy
```

Keep the returned `https://bookharbor-mis465.<your-subdomain>.workers.dev` URL. The catalogue is public; the dashboard/chat tester require the owner password. Set the password immediately:

```powershell
npx.cmd wrangler secret put ADMIN_KEY
```

Enter a unique long demo password at the hidden prompt. It is the password you type in the website's login dialog. Do not reuse your Facebook/Google password. Wrangler stores it as a server secret. Do not paste it into a command argument.

Verify `/api/health`, sign into the site and repeat the sample checkout. The model is `@cf/qwen/qwen3-30b-a3b-fp8` through Cloudflare's AI binding; no separate OpenAI key is needed. If account-specific model terms require acceptance, review them in your account first. Do not select any paid model to resolve an error.

## Add the MIS demo textbooks to an existing D1 database

The four MIS textbooks are stored as new `products` rows. When the code is
merged, the existing live database **does not seed itself**: it needs this
specific one-time additive SQL migration. Do not delete or recreate D1, and
do not reset the products table. Run from the `bookharbor` directory
after you've reviewed the branch and connected Wrangler to the intended
Cloudflare account:

```powershell
npx.cmd wrangler d1 execute bookharbor-mis465 --remote --file=migrations/2026-10-27-add-mis-books.sql
```

The migration uses `INSERT OR IGNORE`. It adds the four new product IDs only
when absent, and leaves existing stock, prices, conversations, and order
records unchanged. It is safe to rerun after an interrupted session, but
does not refresh previously seeded demo stock.

Verify the resulting catalogue without touching any order records:

```powershell
npx.cmd wrangler d1 execute bookharbor-mis465 --remote --command="SELECT id,title,category,price,stock FROM products WHERE category='Management Information Systems' ORDER BY id"
```

All prices and stock counts are **fictional academic demo values**, not
verified retail inventory. Finally, deploy the tested code from the merged
branch:

```powershell
npx.cmd wrangler deploy
```

After migration **and** deployment, check the **MIS textbooks** category
filter on the site, and verify that `MIS books` and `Order M: Information
Systems` work through an authorized test Messenger account. Do not run the
migration or deployment against a different Cloudflare account or database.

## 3. Replace the exposed Facebook credentials

Open https://developers.facebook.com/apps/ and choose your app.

1. App settings → Basic: reset the exposed app secret yourself. Labels may vary with Meta's current dashboard.
2. Open the Messenger use case/product setup; connect the intended test Page and generate a replacement Page token with the required Page messaging permissions. Explicitly revoke the old token/access where Meta provides that control; generating a new token does not by itself prove the old one is invalid.
3. Check the configured Page ID is your intended Page. This project currently uses `1270406139500514`.
4. Store the NEW values directly in Cloudflare through hidden prompts:

```powershell
npx.cmd wrangler secret put FB_APP_SECRET
npx.cmd wrangler secret put FB_PAGE_ACCESS_TOKEN
npx.cmd wrangler secret put FB_VERIFY_TOKEN
```

For `FB_VERIFY_TOKEN`, choose another long random string. It is a matching phrase shared between your server and Meta's webhook setup, not your Page token. Keep it available for the next step.

## 4. Meta webhook setup

- Callback URL: your deployed URL plus `/webhook`.
- Verify token: exactly the same value you entered as `FB_VERIFY_TOKEN`.
- Verify and save.
- Subscribe to Page `messages` events and ensure the app is subscribed to the correct Page. The bot ignores message echoes, other Pages, stale messages, and unsigned requests.
- Use the supported Graph API version shown in your Meta app. The project defaults to `v24.0`; confirm support in the app and update `GRAPH_VERSION` if required, then redeploy.
- Add the tester/professor account to the appropriate permitted app role and have them accept the invitation, if Meta permits that testing arrangement. Check current app restrictions. Arbitrary public users may require Live mode, advanced access/app review or business verification, depending on the app.
- If asked for privacy/data-deletion instructions, the app provides `/privacy.html`; ensure it accurately describes your test setup. Fill any developer-dashboard contact fields yourself.

## 5. Prove the connection before presentation

From a permitted Facebook test account, open the actual Page in Messenger and send `hello`. Then `Hobbit price koto?`. Open the website Conversations panel: you should see Facebook events with status `sent`, and the reply should visibly arrive in Messenger. An event marked `ready` or a configured credential indicator is not evidence of successful sending.

Repeat the full order flow. Capture a screenshot showing the Messenger confirmation and the corresponding dashboard order ID. Test once again shortly before class using the exact intended tester account.

## Troubleshooting

| Symptom                              | Check                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Callback does not verify             | URL is deployed HTTPS; `/webhook` path; exact verify-token match                                                                      |
| No events in dashboard               | Correct app/Page subscription; test account role accepted; `messages` subscribed                                                      |
| Event ready with missing-token error | Set `FB_PAGE_ACCESS_TOKEN` using Wrangler                                                                                             |
| Failed/sending event                 | Check Page inbox first; then token expiry, Page permissions, Graph version, messaging window. Do not blindly replay an uncertain send |
| Replies stop after HUMAN             | Click Resume in Conversations                                                                                                         |
| AI error or quota limit              | Fixed rules handle known commands; wait for quota reset. Do not upgrade                                                               |
| Owner can test but professor cannot  | App mode, allowed test roles, invitations and access review; verify with professor's exact account                                    |
| Deploy errors about permissions      | Sign in again with the documented scopes and confirm selected account                                                                 |

## Before calling it complete

- Automated tests pass.
- Deployed website checkout works.
- Actual Cloudflare AI request tested and labelled, or clearly reported unavailable.
- Callback verification succeeds.
- Real incoming Page message reaches the app.
- Real reply arrives at the tester account.
- Order confirmation saves exactly one matching dashboard record.
- Old credentials revoked, new secrets excluded from Git.
- Free plan confirmed, no billing enabled.
