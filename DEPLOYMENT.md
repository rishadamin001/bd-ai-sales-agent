# Render deployment and Facebook Page testing

This repository includes a Render free-service Blueprint and a WSGI entrypoint for `gunicorn app:app`. Completing these steps requires access to your Render, Google AI Studio, and Meta accounts. Configuration files alone do not create a hosted service or connect a Page.

## 1. Prepare credentials

- In [Google AI Studio](https://aistudio.google.com/apikey), create a key for an authorized Google project. Set it as `GEMINI_API_KEY`; private keys cannot be fetched from public documentation. The requested model is `gemini-2.5-flash`. Google currently limits access to some older models, so check it with your actual key. Set `GEMINI_MODEL` to another approved available model only if needed. Free-tier eligibility and quotas depend on the account and model.
- In your Meta app, obtain a Page access token with `pages_messaging` and the applicable Page subscription permissions. Use the current App Secret and Page token as `FB_APP_SECRET` and `FB_PAGE_ACCESS_TOKEN`. Reissue credentials that were pasted into a chat before using them in a live deployment.
- Set `FB_PAGE_ID=61595323019908`.
- Set `FB_VERIFY_TOKEN` to the exact token entered during callback verification. The requested token is `my_custom_secret_verify_token_123`; a new private random token also works if both sides match. This token is separate from the App Secret used to verify signed POST requests.
- Set `META_GRAPH_VERSION` to a version currently supported by your Meta app. Use the same version for Page subscription and Send API requests.

Keep keys in Render's Environment settings. Do not commit them to Git, paste them into code, or send them in a webhook test body. `.env.example` contains placeholders only.

## 2. Create the free Render service

Use the [Render Blueprint deployment button](https://render.com/deploy?repo=https://github.com/rishadamin001/bd-ai-sales-agent), or sign in to Render and choose **New → Blueprint**, connecting `rishadamin001/bd-ai-sales-agent`. Review `render.yaml`, confirm **Free**, and enter the requested secret values. `sync: false` values are requested during initial Blueprint creation; later additions must be entered manually in the service's Environment settings.

The Blueprint sets these service fields:

| Field | Value |
| --- | --- |
| Name | `bd-ai-sales-agent` |
| Runtime | Python |
| Plan | Free |
| Build command | `pip install -r requirements.txt` |
| Start command | `gunicorn app:app` |
| Health check | `/health` |
| Fulfillment mode | `DELIVERY_MODE=dry_run` |
| Durable fulfillment state | `FULFILLMENT_STATE_DURABLE=false` |

Alternatively choose **New → Web Service**, connect this repository, and enter the same fields and all environment variables listed in `render.yaml`. Generate a private random `WEBHOOK_SECRET` when setting up manually. The Blueprint generates it automatically.

Gunicorn reads `gunicorn.conf.py` and binds to `0.0.0.0:$PORT`. Render supplies `PORT`; local serving defaults to 5000. The exact Procfile is `web: gunicorn app:app`. Keep **one Gunicorn worker** with four threads: the current Messenger queue and chat session implementation assumes one worker process. `MESSENGER_BACKGROUND_WORKER=true` enables the background processor.

After the deploy succeeds, copy the actual HTTPS service URL from Render. The service name does not guarantee a particular hostname. Open `https://YOUR_ACTUAL_RENDER_HOST/health` and check for HTTP 200 before continuing. Build/deploy duration varies.

## 3. Register the Meta callback

Wake the free service by opening `/health` immediately before verification. In [Meta for Developers](https://developers.facebook.com/), open the app that owns your Page integration, then its Messenger/Webhooks settings.

1. Set the callback URL to `https://YOUR_ACTUAL_RENDER_HOST/webhook`.
2. Enter the same `FB_VERIFY_TOKEN` stored in Render.
3. Choose **Verify and Save**. The server checks `hub.mode=subscribe`, verifies the token, and returns the `hub.challenge` as plain text. A mismatch returns 403.
4. Subscribe the app to **messages** and **messaging_postbacks**.
5. Connect Page `61595323019908` and enable its Page-level subscription to the app for the same fields. Both the app callback subscription and Page subscription are required. If the dashboard does not provide this, use Meta's supported `POST /{page_id}/subscribed_apps` endpoint with an authorized Page token and `subscribed_fields=messages,messaging_postbacks`.

The server validates POST bodies using `X-Hub-Signature-256` and the App Secret. A browser or unsigned curl POST cannot simulate a trusted Meta message. Do not weaken signature verification to pass a test.

An app in development mode normally needs testers/admins with the relevant app/Page roles for testing. Messaging with public customers may require Live mode, permission approval, and other requirements shown in your Meta dashboard.

## 4. Test a real Page conversation

Keep `DELIVERY_MODE=dry_run` and `FULFILLMENT_STATE_DURABLE=false` for the free-service test. Dry run disables courier booking, Sheets append, and order webhook notifications. Aura's inbound Messenger replies still use Gemini and the Meta Send API, so this is a real chat test.

Use an authorized test account to send your Page a message such as `bhaiya Rajshahi-te delivery charge koto?`. Check that Aura replies and that Render logs contain no credentials or customer message bodies. Check delivery information against `DELIVERY_RATES.md`.

Then test these behaviors with the sample catalog:

| Test | Expected behavior |
| --- | --- |
| Ask in Banglish, Bangla, and English | Replies match the customer's language |
| Negotiate below the listed floor | Discount stays within 10% and the product floor |
| Give only a city or an invalid phone | Aura requests missing/valid details; no fulfillment |
| Supply a complete address and cart | Aura presents the full COD total and an order draft |
| Confirm the reviewed draft using an advertised confirmation phrase | The application validates the confirmed order; fulfillment stays in dry run |
| Change details after the draft | Aura requests review of an updated draft |
| Meta retries the same message event | A duplicate does not create another reply/order |

Only test with details you are authorized to use. The bundled products are sample data, so replace and approve catalog prices/stock before accepting customer orders. A received webhook is acknowledged quickly and Gemini runs in the background. Provider failures or interrupted sending/dispatching can require reconciliation; the worker does not automatically replay ambiguous effects.

Messenger replies require a Page-scoped Messenger recipient ID and an eligible interaction within the standard 24-hour response window. Later tracking notifications need a currently approved Meta mechanism and any required consent. This project sends Messenger messages; actual SMS requires a separate provider or confirmed courier SMS service.

## 5. Understand free-host limits before fulfillment

Render free web services sleep after approximately 15 minutes without inbound traffic and can take about a minute to wake. This can delay webhook verification or Page replies. Free services have ephemeral filesystems and no persistent disks: SQLite state can be lost on deploy, restart, or sleep. That state contains order deduplication, Messenger jobs, and conversations.

The free Blueprint is therefore a **chat/fulfillment demo**, with live courier fulfillment disabled. The application refuses live fulfillment on Render while `FULFILLMENT_STATE_DURABLE` is false. Changing that flag does not create persistence.

For live orders, provision durable storage first. A single paid Render instance with a persistent disk can keep both databases on disk-mounted absolute paths, for example `ORDER_DB_PATH=/var/data/orders.sqlite3` and `MESSENGER_DB_PATH=/var/data/messenger.sqlite3`. Alternatively, implement shared external database/queue support before scaling to multiple hosts; the supplied code uses SQLite, so a database URL alone is insufficient. Verify state survives a restart/deploy, backups work, and no other worker handles the same queue. Then set `FULFILLMENT_STATE_DURABLE=true`, configure courier/Sheets credentials, and finally set `DELIVERY_MODE=live`.

Use a new order ID for a live order after dry-run testing. Authenticate courier tracking callbacks through your own trusted adapter before forwarding normalized tracking events. Preserve order state and reconcile ambiguous courier or notification outcomes before retrying.

## References

- [Render Flask deployment](https://render.com/docs/deploy-flask)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render port binding](https://render.com/docs/web-services#port-binding)
- [Render free-service limitations](https://render.com/docs/free)
- [Google Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)
- [Google model deprecations and access changes](https://ai.google.dev/gemini-api/docs/deprecations/)
- [Meta's signed Messenger webhook Python sample](https://github.com/fbsamples/messenger-platform-samples/blob/main/messenger-api/messenger-api-and-webhooks/app.py)
