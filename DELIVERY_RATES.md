# Bangladesh Delivery Rate Card

Rates are in BDT for this project's standard sample shipment. Delivery times are estimates. Replace or extend the rate card with verified store/courier rules before production use; do not assume that weight, parcel type, returns, or remote surcharges are included when they are not documented.

| Service zone | Covered locations | JSON zone | Delivery charge (BDT) | Estimated delivery | Courier |
| --- | --- | --- | --- | --- | --- |
| Inside Dhaka City | Confirmed locations within Dhaka City, excluding the listed suburbs | INSIDE_DHAKA | 70 | 24–48 hours | Configured supported partner |
| Dhaka Suburbs | Savar, Gazipur, Keraniganj, Narayanganj | DHAKA_SUBURBS | 100 | 2–3 days | Configured supported partner |
| Outside Dhaka — standard | Other districts and standard courier service areas | OUTSIDE_DHAKA | 130 | 2–4 days | Pathao / Steadfast |
| Outside Dhaka — verified remote | Only locations explicitly verified as remote by the store/courier | OUTSIDE_DHAKA | 150 | 2–4 days, subject to service availability | Pathao / Steadfast |

## Location matching

1. Match Savar, Gazipur, Keraniganj, or Narayanganj **before** testing for Dhaka City. Savar and Keraniganj may have district `Dhaka` but still cost ৳100.
2. Use ৳70 only when the detailed area is confirmed to be inside Dhaka City. A bare `Dhaka` district is not enough.
3. Outside Dhaka, use ৳130 by default. Use ৳150 only when a remote designation is verified; do not invent a remote-area list. A later verified change requires a revised total and fresh customer confirmation.
4. Normalize common spellings such as `ctg`/`Chittagong` to `Chattogram` and `Jessore` to `Jashore`; confirm ambiguous locations.
5. When zone or service availability cannot be determined from the customer-provided thana/upazila and district, ask for clarification before issuing a complete order review.

## Mandatory phone and address validation

- Normalize Bangla numerals, remove formatting spaces/hyphens/parentheses, and convert valid `+8801...` or `8801...` numbers to local format.
- The saved phone number must contain exactly **11 ASCII digits** and match `^01[3-9][0-9]{8}$`. Accepted prefixes: `013`, `014`, `015`, `016`, `017`, `018`, `019`.
- Store the phone number as a string so its leading zero is preserved. Format validation does not verify ownership or reachability.
- Require full name, a usable street-level or rural address, thana/upazila, and district. Urban addresses need house/building/holding and road/block/area details. Rural addresses can use village, landmark, and local area/union or post office when house numbers do not exist.
- A district or city name alone is insufficient for fulfillment.

## Incentives and confirmation

An authorized free-delivery incentive changes the customer-facing delivery charge to ৳0 and must not be combined with a product discount. Otherwise charge the applicable rate above. Show the complete calculation **Subtotal − Product Discount + Delivery = Grand Total** and obtain explicit confirmation of that total before `ORDER_CONFIRMED`.

RedX may be selected only if separately configured and its applicable service/rate has been verified. Creating an order record does not prove a courier accepted a booking or sent an SMS. Give customers tracking information only after a verified fulfillment result.
