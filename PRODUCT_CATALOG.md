# Sample Product Catalog

**Demonstration data only.** These sample item names, prices, and stock statuses are not verified inventory from a real store. Replace them with approved product data before accepting real customer orders. No size chart, return policy, warranty, product specifications, or actual stock counts are supplied here.

| Item Name | Product ID | Regular Price (BDT) | Minimum Negotiable Price (10% max discount) | Stock Status | Alternative Suggested Item |
| --- | --- | --- | --- | --- | --- |
| Sample Classic T-Shirt | AURA-TEE-001 | 1000 | 900 | IN_STOCK | AURA-POLO-002 |
| Sample Cotton Polo | AURA-POLO-002 | 1500 | 1350 | IN_STOCK | AURA-TEE-001 |
| Sample Wireless Earbuds | AURA-EARBUDS-003 | 2000 | 1800 | IN_STOCK | AURA-HEADPHONE-004 |
| Sample Over-Ear Headphones | AURA-HEADPHONE-004 | 2500 | 2250 | IN_STOCK | AURA-EARBUDS-003 |
| Sample Casual Hoodie | AURA-HOODIE-005 | 2000 | 1800 | OUT_OF_STOCK | AURA-SWEATSHIRT-006 |
| Sample Crewneck Sweatshirt | AURA-SWEATSHIRT-006 | 1800 | 1620 | IN_STOCK | AURA-POLO-002 |

## Catalog and negotiation rules

- `Product ID` is the stable order identifier. Use the exact ID in the order's `items` array.
- Prices are integer BDT per unit. The minimum is the ceiling of 90% of the regular unit price; discounts may never exceed 10% or breach this floor.
- Stage negotiations: offer 5% off or free delivery first; a continued negotiation may reach 10% off. Free delivery and merchandise discounts cannot be combined.
- `IN_STOCK` and `OUT_OF_STOCK` are the supported status values. In this file they describe sample records only. Real stock must be verified before fulfillment.
- If an item is out of stock, offer the listed relevant in-stock alternative after checking its record. Do not silently substitute an item; obtain the customer's choice and review the updated total.
- Keep the table headings and numeric price cells unchanged in format when updating this catalog, because the backend reads this Markdown table. Add verified store details outside the table or extend the backend deliberately.
- Quantities must be positive integers. Variant and stock-count restrictions require verified data; do not invent them.
