# Verification record

Date: 16 October 2026 (Asia/Dhaka).

## Verified locally

- 15 automated tests passed using the same Worker handler and business logic with a SQLite adapter for the D1 interface.
- Browser opened the catalogue, accepted a demo order, calculated 2 × ৳650 + ৳70 = ৳1,370, and saved the confirmed order in the dashboard.
- Browser order reference observed: BH-49D44A07 (fictional local test).
- Screenshot saved separately as `bookharbor-demo-order.png`.
- The UI clearly identifies local fixed-rule fallback. It does not claim the local session used AI.

## Verified on deployed Cloudflare app

- URL: https://bookharbor-mis465.bookharbor-mis465.workers.dev
- Real Cloudflare AI interpreted “Do you have the adventure about Bilbo?” as The Hobbit; response labelled `cloudflare-ai`.
- Fixed a live response-format mismatch: Workers AI may supply already-parsed JSON. Added a regression test; 16 automated tests now pass.
- Live D1 checkout saved a fictional order; the total was ৳1,370 for two Hobbit copies delivered within Dhaka.
- Signed owner login and webhook GET challenge passed against the deployed server.
- Dashboard password and webhook verification token are server secrets; an ignored local owner-access file contains the owner's private copy.

## Still requires account-connected verification

- Broad real-model language-quality evaluation in Bangla/Banglish.
- Rotated Meta credentials, permissions and webhook subscription.
- Actual Messenger send/receive from the intended test account.

Passing local and mocked tests does not establish the unverified external connections above.
