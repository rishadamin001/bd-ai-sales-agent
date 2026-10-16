# Verification record

Date: 16 October 2026 (Asia/Dhaka).

## Verified locally

- 15 automated tests passed using the same Worker handler and business logic with a SQLite adapter for the D1 interface.
- Browser opened the catalogue, accepted a demo order, calculated 2 × ৳650 + ৳70 = ৳1,370, and saved the confirmed order in the dashboard.
- Browser order reference observed: BH-49D44A07 (fictional local test).
- Screenshot saved separately as `bookharbor-demo-order.png`.
- The UI clearly identifies local fixed-rule fallback. It does not claim the local session used AI.

## Requires account-connected verification

- Cloudflare deployment and live D1 binding.
- Real Cloudflare AI classification and quality in Bangla/Banglish.
- Rotated Meta credentials, permissions and webhook subscription.
- Actual Messenger send/receive from the intended test account.

Passing local and mocked tests does not establish the unverified external connections above.
