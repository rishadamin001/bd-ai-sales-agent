# Verification record

Updated: 17 October 2026 (Asia/Dhaka).

## Verified locally

- 17 automated tests passed using the same Worker handler and business logic with a SQLite adapter for the D1 interface, including postback deduplication.
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

## Verified Messenger integration

- Correct Page: Page for testing, ID 1270406139500514.
- Existing Worker bookharbor-mis465 redeployed on account bfd0afa1d5021b7538f589b10180d31a.
- Saved Page token identity matched this Page. POST subscribed_apps for messages,messaging_postbacks returned success:true.
- Live synthetic verification challenge succeeded; correctly signed POST returned 200 and invalid signature returned 403.
- Real POST /webhook logged facebook_received and facebook_send_accepted. Two durable Facebook events had status sent and no error, using rules and cloudflare-ai respectively.
- Owner confirmed the reply arrived when messaging from the personal admin profile.
- ADMIN_KEY and FB_VERIFY_TOKEN were rotated; owner reported uploading replacement Meta credentials. No private values are included in this repository.

## Remaining limits and unverified scenarios

- Broad real-model language-quality evaluation in Bangla/Banglish.
- GET subscribed_apps is denied with code 200: requires pages_manage_metadata permission. The successful POST and real conversation do not remove this read-back limitation.
- Public users outside accepted app roles and the professor's own profile have not been tested.
- New Page token expiry and revocation of every older token have not been independently verified.
- Complete order capture was tested on the deployed website; the complete Messenger order flow still needs a presentation rehearsal.

Passing local and mocked tests does not establish the unverified external connections above.
