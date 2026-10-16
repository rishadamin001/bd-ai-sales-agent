# Deploy and connect Messenger — free course demo

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

## 3. Replace the exposed Facebook credentials

Open https://developers.facebook.com/apps/ and choose your app.

1. App settings → Basic: reset the exposed app secret yourself. Labels may vary with Meta's current dashboard.
2. Open the Messenger use case/product setup; connect the intended test Page and generate a replacement Page token with the required Page messaging permissions. Explicitly revoke the old token/access where Meta provides that control; generating a new token does not by itself prove the old one is invalid.
3. Check the configured Page ID is your intended Page. This project currently uses `61595323019908`.
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
