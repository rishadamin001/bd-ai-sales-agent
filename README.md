# Aura — Bangladesh AI Sales Agent

Aura runs a Banglish, Bangla, or English sales chat using `gemini-2.5-flash`. It reads the merchant's Markdown prompt, delivery rates, and catalog, validates orders in Python, and supports Facebook Page conversations plus an authenticated order webhook.

The bundled inventory is **sample data**. The default fulfillment mode is **dry run**, which makes no courier, Sheets, or order-notification API calls. Inbound Messenger replies still use Gemini and Meta when configured. Replace the sample catalog with approved prices and stock before using real customer orders.

For cloud hosting and Page testing, follow [DEPLOYMENT.md](DEPLOYMENT.md). It covers the free Render Blueprint, `/webhook` verification and signed message handling, required credentials, and the storage upgrade needed before live fulfillment.

## Project files

| File | Purpose |
| --- | --- |
| `SYSTEM_PROMPT.md` | Aura's role, language matching, workflows, negotiation rules, address parser, order JSON, and examples |
| `DELIVERY_RATES.md` | Dhaka City ৳70/24–48 hours; suburbs ৳100/2–3 days; outside Dhaka ৳130–150/2–4 days; phone validation |
| `PRODUCT_CATALOG.md` | Six sample products with IDs, prices, discount floors, stock, and alternatives |
| `app.py` | Interactive Gemini chat, confirmation gating, and Render WSGI entrypoint |
| `messenger.py` | Signed Meta webhook, durable local jobs, and background Aura replies |
| `orders.py`, `order.schema.json` | Validation, catalog loading, JSON extraction, and payload schema |
| `webhook.py`, `integrations.py` | Durable courier, Sheets, Messenger, and tracking bridge |
| `.env.example`, `requirements.txt` | Configuration template and dependencies |
| `Procfile`, `gunicorn.conf.py`, `render.yaml`, `DEPLOYMENT.md` | Gunicorn serving and Render/Page deployment guide |
| `examples/order_confirmed.json` | Synthetic order for dry-run testing |
| `tests/` | Behavioral tests with fake Gemini and mocked provider calls |

## Start a chat

Use Python 3.11 or newer:

```bash
git clone https://github.com/rishadamin001/bd-ai-sales-agent.git
cd bd-ai-sales-agent
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` locally. Set `GEMINI_API_KEY` using a key from [Google AI Studio](https://aistudio.google.com/apikey). Gemini's free tier has eligibility, rate, and quota limits; it is not unlimited free usage. Model access depends on your account; `GEMINI_MODEL` can select an approved available model if the requested 2.5 Flash model is unavailable. Review [Google's current pricing](https://ai.google.dev/gemini-api/docs/pricing) and [model access/deprecation notes](https://ai.google.dev/gemini-api/docs/deprecations/).

```bash
python app.py
```

Use `/new` for another order and `/quit` to exit. A single-message demo also works:

```bash
python app.py --message "bhaiya Rajshahi-te delivery charge koto?"
```

The CLI loads `.env` without shell execution and reads all three merchant documents. It defaults to `gemini-2.5-flash` with temperature `0.3`; `GEMINI_MODEL` may override it. Model output cannot set courier routes, Messenger identities, or a verified remote-area flag.

## Review and confirmation

Aura emits `ORDER_DRAFT` after collecting the cart, name, valid BD phone, detailed address, thana, district, and full COD breakdown. A draft never executes a courier call. After reviewing, reply with an advertised whole-message confirmation such as `confirm`, `yes confirm`, `ha confirm koren`, or `কনফার্ম করুন`.

The application checks that the validated `ORDER_CONFIRMED` matches the previous draft and session ID. Changed details require a fresh review. Longer free-form replies are treated as amendments/questions rather than automatic confirmation.

Prices and stock come from the catalog. Discounts cannot exceed 10%, breach a product's proportional price floor, or stack with free delivery. Phone numbers normalize to exactly 11 ASCII digits matching `01[3-9][0-9]{8}`. Suburbs take priority over a Dhaka district match. Unknown Dhaka localities require clarification. Geographic/address checks are practical rules, not an official address-verification service.

The JSON format retains customer, pricing, and logistics fields and adds stable `order_id` and `items` for validation and duplicate protection. Unit prices are regular catalog prices; subtract the merchandise discount once in `pricing_summary`. Trusted merchant metadata can add verified `customer.remote_area: true` for ৳150 delivery, Pathao route IDs, and Messenger identity/window data; the chat model cannot supply them.

## Run the webhook

The combined production service starts with `gunicorn app:app`; Gunicorn binds to `0.0.0.0:$PORT` using `gunicorn.conf.py`. It serves the order routes below plus signed Facebook Messenger `GET/POST /webhook`. Use one worker until the queue and state are moved to a shared implementation. For local development, `python app.py --serve` starts the combined Flask server. See [DEPLOYMENT.md](DEPLOYMENT.md) for the Render setup.

Generate a long random secret and put it in `.env` as `WEBHOOK_SECRET`:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
python webhook.py
```

The development server listens on `127.0.0.1:5000`. In another terminal, run `python app.py --dispatch` to forward validated confirmed events. `ORDER_WEBHOOK_URL` defaults to the local endpoint. Both processes must use the same secret.

| Route | Behavior |
| --- | --- |
| `GET /health` | Health and delivery mode |
| `GET /webhook` | Meta callback verification using `FB_VERIFY_TOKEN` |
| `POST /webhook` | Meta message/postback events; requires a valid App Secret signature |
| `POST /webhooks/orders` | Receive a validated `ORDER_CONFIRMED` object |
| `GET /webhooks/orders/<order_id>` | Inspect saved effect states without replaying an order |
| `POST /webhooks/tracking` | Receive a trusted normalized `TRACKING_UPDATED` event |

The `/webhooks/orders` and `/webhooks/tracking` routes require `Authorization: Bearer <WEBHOOK_SECRET>`. Meta `/webhook` uses its verification token for GET and App Secret signature for POST. Courier callbacks must first be authenticated and transformed by your own trusted adapter; provider callback formats are not accepted directly. The order endpoint trusts its authenticated sender to have obtained customer consent. Text generated in a Codex conversation is not automatically intercepted: this chat bridge or another authorized integration must POST the JSON.

Submit the synthetic example **while the webhook is in dry-run mode**:

```bash
python - <<'PY'
import json
from pathlib import Path
from app import load_env, dispatch_order
load_env()
order = json.loads(Path('examples/order_confirmed.json').read_text())
print(json.dumps(dispatch_order(order), indent=2))
PY
```

SQLite records each order and each external effect. An identical retry resumes only safely failed effects; it does not rebook an accepted shipment or resend successful notifications. Reusing an ID for different details or changing its dry-run/live mode returns a conflict. Ambiguous timeouts or provider responses require reconciliation and are not retried automatically. Preserve the database: deleting it removes duplicate protection. Customer records and runtime databases are excluded from Git.

To enable delivery, configure the providers below and set `DELIVERY_MODE=live`. Use new IDs for live orders after testing. Deploy behind HTTPS with a production WSGI server, durable state, and injected environment variables; do not expose the Flask development server. The combined WSGI entrypoint is `app:app`; the standalone order-only entrypoint remains `webhook:create_app()`. Render live fulfillment also requires `FULFILLMENT_STATE_DURABLE=true` after durable storage is actually provisioned and verified. The free Blueprint keeps that setting false and fulfillment in dry run. For multiple hosts, replace local SQLite with a shared database/job queue.

## Courier setup

**Steadfast:** Set `STEADFAST_API_KEY` and `STEADFAST_SECRET_KEY`. The adapter uses `https://portal.steadfast.com.bd/api/v1/create_order`, the order ID as invoice, and the full grand total as COD. Verify the endpoint and credentials in your merchant account before live use. A consignment ID is required before the bridge records acceptance.

**Pathao:** Set `PATHAO_CLIENT_ID`, `PATHAO_CLIENT_SECRET`, and `PATHAO_STORE_ID`. The adapter authenticates through `/aladdin/api/v1/external/login`, then creates an order through `/aladdin/api/v1/orders`. Supply verified numeric route IDs and actual parcel weight through trusted per-order metadata:

```json
{
  "courier_metadata": {
    "recipient_city": 1,
    "recipient_zone": 123,
    "recipient_area": 456,
    "item_weight_kg": 0.5
  }
}
```

These IDs are illustrative; replace them with the customer's actual IDs. The adapter requires routes rather than guessing from district text. `PATHAO_CITY_ID`, `PATHAO_ZONE_ID`, `PATHAO_AREA_ID`, and `PATHAO_ITEM_WEIGHT_KG` are optional merchant defaults; use them only for a route/product with verified matching details. Sandbox: `https://courier-api-sandbox.pathao.com`. RedX is a future schema option and currently returns `unsupported_courier`.

## Customer Orders BD in Google Sheets

Google Drive/Sheets is not connected in this workspace. The append code is prepared; creating the spreadsheet and authorizing write access still require your Google account.

1. Create a spreadsheet titled **Customer Orders BD**, with a tab named **Orders**.
2. Add headers in A1:E1: `full_name`, `phone_number`, `address_line`, `district`, `grand_total_bdt`.
3. Set `GOOGLE_SHEETS_SPREADSHEET_ID` from its URL and keep `GOOGLE_SHEETS_RANGE=Orders!A:E`.
4. For ongoing use, set `GOOGLE_SHEETS_SERVICE_ACCOUNT_FILE` to a private service-account JSON key, enable Sheets API, and share the spreadsheet with the account's `client_email` as Editor. The bridge renews the token for API calls. Keep the key outside Git.
5. For temporary testing, set `GOOGLE_SHEETS_ACCESS_TOKEN` to a Google OAuth token with Sheets write scope; renew it before expiry.

Rows contain the requested five values. REST append uses `RAW`, preserving phone leading zeros and preventing names/addresses from being interpreted as formulas. A row is reported saved only when Google confirms one updated row.

Alternatively, configure `SHEETS_WEBHOOK_URL`. In Zapier create **Catch Hook → Filter `order_event` equals `ORDER_CONFIRMED` → Google Sheets Create Spreadsheet Row**, select **Customer Orders BD / Orders**, and map the five same-named top-level fields. The adapter sends flattened fields plus `order_id`. A hook acknowledgement means forwarded, not proof the row was written. [Webhooks by Zapier currently requires a paid plan](https://help.zapier.com/hc/en-us/articles/8496083355661-How-to-get-started-with-Webhooks-by-Zapier).

## Messenger confirmations and tracking

For Page conversations, set `FB_APP_SECRET`, `FB_VERIFY_TOKEN`, `FB_PAGE_ACCESS_TOKEN`, `FB_PAGE_ID`, `META_GRAPH_VERSION`, and `GEMINI_API_KEY`, then register the real Render `/webhook` URL and subscribe the Page as described in [DEPLOYMENT.md](DEPLOYMENT.md). The worker records incoming message IDs, processes messages in the background, and sends Aura replies. Local SQLite state must be preserved for durable deduplication.

The order/notification bridge also accepts `META_PAGE_ACCESS_TOKEN` and `META_PAGE_ID`; the combined server maps `FB_*` credentials to these outbound settings. Your app/Page needs `pages_messaging`. The trusted channel supplies top-level `messenger_psid` and timezone-aware ISO `messenger_last_interaction_at`; a phone number is not a Messenger ID. An optional trusted `confirmation_message` can use the shopper's language.

The order endpoint sends confirmation and, when an accepted booking returns a tracking code, a separate tracking alert. A later courier adapter can send:

```json
{
  "order_event": "TRACKING_UPDATED",
  "order_id": "YOUR_EXISTING_ORDER_ID",
  "tracking_code": "ACTUAL_COURIER_TRACKING_CODE",
  "status": "IN_TRANSIT"
}
```

Identical tracking events are deduplicated. Ordinary Messenger responses send only within the customer's 24-hour response window; missing identity/window data or later updates are recorded as skipped. For later notifications, integrate a currently approved Meta mechanism and its consent rules. Deprecated message tags are not used.

These are **Messenger messages**, not SMS. Actual SMS requires a separate SMS provider or verified courier notification service. Authenticated courier tracking callbacks and Shopify/WooCommerce connectors remain deployment-specific additions.

## Validation and provider references

```bash
python -m unittest discover -s tests -v
python -m compileall -q app.py orders.py webhook.py integrations.py
```

All 96 tests passed during deployment preparation. A local Gunicorn HTTP smoke test verified Render-style port binding, Meta callback verification, signed message intake, and authentication with zero external API calls. Automated tests use fake Gemini and mocked provider calls to cover consent timing, prices, stock, addresses, phones, JSON parsing, dry run, idempotency, failures, tracking, and adapter payloads. Live integrations require credentials, network access, and authorized accounts; these tests do not establish a live Page deployment.

- [Google Gen AI Python SDK](https://github.com/googleapis/python-genai)
- [Steadfast create-order contract](https://github.com/steadfast-it/SteadFast-Courier-Laravel-Package)
- [Pathao official integration](https://github.com/pathao-eng/courier-woocommerce-plugin/blob/main/pathao-bridge.php)
- [Google Sheets append API](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append)
- [Meta Messenger API collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api)

API accounts, credentials, hosting, and provider charges remain separate from this code. Check each provider's current requirements before live activation.
