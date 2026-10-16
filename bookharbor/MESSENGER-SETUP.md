# Messenger setup and test

Page: 61595323019908. Callback: https://bookharbor-mis465.bookharbor-mis465.workers.dev/webhook

## Latest verified state

- Live health returns HTTP 200. Database-backed owner status works; bot is not paused.
- Live synthetic webhook test: correct verification token returns the challenge; signed empty Page event returns 200; invalid signature returns 403. This does not prove a real Meta callback has arrived or that the stored app secret matches Meta.
- 17 local tests pass, including signature verification, message replay protection, and postback replay protection.
- Saved Page token rejected by Meta: HTTP 401, OAuth error 190, subcode 463. Subscription is blocked at token validation; no successful POST or GET subscription confirmation yet.
- No real Facebook events recorded at this check. No end-to-end Messenger success claimed.
- ADMIN_KEY and FB_VERIFY_TOKEN rotated in Cloudflare. Private local work/OWNER-ACCESS.txt updated. Reverify the callback in Meta using the NEW verify token.

## Finish rotation

1. In Meta Developers, open the correct app, Settings > Basic, and reset App Secret. Resetting is done by the account owner; do not paste it in chat.
2. In Messenger API Setup, generate a fresh Page access token for Page 61595323019908 using this app. Ensure the app has messaging and Page subscription permissions. Generating a replacement alone is not proof the old token was revoked; use Meta's token/integration controls to revoke old authorization where necessary, then reconnect and generate the replacement.
3. Run scripts/configure-facebook.ps1 in PowerShell. It checks access to the existing deployed Worker before hidden prompts. Correct Cloudflare account is rishhadamin01@gmail.com.
4. Open private work/OWNER-ACCESS.txt locally. In Meta's webhook configuration, keep the callback above, replace Verify Token with the new value, and select Verify and Save. Keep messages and messaging_postbacks selected.
5. Sign in to the app dashboard with the new password in the private file. Old dashboard sessions are invalidated.
6. Run node scripts/facebook-check.mjs subscribe from this project. It uses owner authentication and makes the Worker call Meta with the stored Page token, then GETs subscribed_apps. No token is exported. Confirm both requested fields in the response.
7. Run node scripts/facebook-check.mjs check for synthetic signature/challenge checks and subscription status.

## Real Messenger test

Use your personal Facebook profile that owns/created the Meta developer app and has its Admin role. While the app is in Development mode, another tester must have an accepted Admin, Developer, or Tester role on the app. Page administration alone does not establish an app role. Do not send as the Page persona.

Open https://m.me/61595323019908 and send, separately:

1. reset
2. Hobbit price koto?
3. delivery charge koto?

Wait for each reply. For an order demo, send Hobbit, then follow the bot's quantity, wrap, name, phone, delivery-address and confirmation questions. Use demonstration details, not real customer information. This is a simulated order; no courier or payment is booked.

Record the time and whether a reply appears. Run node scripts/facebook-check.mjs status to inspect durable event statuses without printing customer messages. `sent` means Meta's Send API accepted a reply, not a delivery/read receipt. `failed` contains a numeric Meta diagnostic where available; `ready` is waiting to send. No events means the issue is before durable message capture (subscription, app role, webhook signature, or routing).

Worker console logs emit facebook_received, facebook_send_accepted, and facebook_send_failed without customer message contents or access tokens. A live tail requires the appropriate Cloudflare permission. Do not share raw logs without reviewing them.

## Future project-key rotations

Run node scripts/rotate-demo-access.mjs ADMIN_KEY to invalidate dashboard sessions and replace the password. Run node scripts/rotate-demo-access.mjs FB_VERIFY_TOKEN to replace the verification token, then immediately update/reverify it in Meta. These commands save private values under ignored work/ and never print them.

Never commit work/, OWNER-ACCESS.txt, .dev.vars, real tokens, or customer records. All four credentials belong in Cloudflare secrets.
