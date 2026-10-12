"""Authenticated, durable, opt-in order delivery bridge.

Run ``python webhook.py``. Dry run is the default. The development HTTP server
binds to loopback; use a production WSGI server and HTTPS proxy for deployment.
"""

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import time

from flask import Flask, jsonify, request

import integrations
from orders import OrderValidationError, validate_order


CONFIG_KEYS = (
    "WEBHOOK_SECRET", "DELIVERY_MODE", "ORDER_DB_PATH", "API_TIMEOUT_SECONDS",
    "STEADFAST_API_KEY", "STEADFAST_SECRET_KEY", "STEADFAST_BASE_URL",
    "PATHAO_CLIENT_ID", "PATHAO_CLIENT_SECRET", "PATHAO_STORE_ID", "PATHAO_BASE_URL",
    "PATHAO_CITY_ID", "PATHAO_ZONE_ID", "PATHAO_AREA_ID", "PATHAO_ITEM_WEIGHT_KG",
    "GOOGLE_SHEETS_ACCESS_TOKEN", "GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SHEETS_RANGE", "GOOGLE_SHEETS_SERVICE_ACCOUNT_FILE",
    "SHEETS_WEBHOOK_URL", "META_PAGE_ACCESS_TOKEN", "META_PAGE_ID", "META_GRAPH_VERSION",
)
EFFECTS = ("courier", "sheets", "confirmation_messenger")
ORDER_EFFECTS = (*EFFECTS, "booking_tracking_messenger")


def _fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _connect(app):
    connection = sqlite3.connect(app.config["ORDER_DB_PATH"], timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def _initialize(app):
    path = Path(app.config["ORDER_DB_PATH"]).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    app.config["ORDER_DB_PATH"] = str(path)
    with _connect(app) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                payload TEXT NOT NULL,
                mode TEXT NOT NULL,
                created_at REAL NOT NULL,
                request_fingerprint TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS effects (
                order_id TEXT NOT NULL REFERENCES orders(order_id),
                name TEXT NOT NULL,
                fingerprint TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL,
                result TEXT NOT NULL DEFAULT '{}',
                updated_at REAL NOT NULL,
                PRIMARY KEY (order_id, name)
            );
        """)
        if "request_fingerprint" not in {row[1] for row in connection.execute("PRAGMA table_info(orders)")}:
            connection.execute("ALTER TABLE orders ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''")
    # The durable state contains customer PII; limit local access.
    try:
        path.chmod(0o600)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(path) + suffix)
            if sidecar.exists():
                sidecar.chmod(0o600)
    except OSError:
        pass


def _reserve_order(app, order, request_fingerprint):
    now = time.time()
    fingerprint = _fingerprint(order)
    with _connect(app) as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute("SELECT fingerprint, mode FROM orders WHERE order_id = ?", (order["order_id"],)).fetchone()
        if existing:
            if existing["fingerprint"] != fingerprint:
                return "order_id_payload_conflict"
            if existing["mode"] != app.config["DELIVERY_MODE"]:
                return "order_id_mode_conflict"
            return None
        connection.execute("INSERT INTO orders (order_id, fingerprint, payload, mode, created_at, request_fingerprint) VALUES (?, ?, ?, ?, ?, ?)", (order["order_id"], fingerprint, json.dumps(order, ensure_ascii=False), app.config["DELIVERY_MODE"], now, request_fingerprint))
        for name in EFFECTS:
            connection.execute("INSERT INTO effects (order_id, name, state, updated_at) VALUES (?, ?, 'pending', ?)", (order["order_id"], name, now))
    return None


def _lookup_replay(app, payload, request_fingerprint):
    """Use a previously validated request even if the merchant catalog changes."""
    order_id = payload.get("order_id")
    if not isinstance(order_id, str):
        return None, None
    with _connect(app) as connection:
        stored = connection.execute("SELECT * FROM orders WHERE order_id = ?", (order_id,)).fetchone()
    if not stored:
        return None, None
    if request_fingerprint not in (stored["request_fingerprint"], stored["fingerprint"]):
        return None, "order_id_payload_conflict"
    if stored["mode"] != app.config["DELIVERY_MODE"]:
        return None, "order_id_mode_conflict"
    return json.loads(stored["payload"]), None


def _reserve_effect(app, order_id, name, fingerprint=""):
    """Reserve before I/O; release the SQLite writer before calling a service."""
    with _connect(app) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM effects WHERE order_id = ? AND name = ?", (order_id, name)).fetchone()
        if row is None:
            connection.execute("INSERT INTO effects (order_id, name, fingerprint, state, updated_at) VALUES (?, ?, ?, 'pending', ?)", (order_id, name, fingerprint, time.time()))
            state = "pending"
        else:
            if fingerprint and row["fingerprint"] != fingerprint:
                return "conflict"
            state = row["state"]
        if state not in ("pending", "failed"):
            return "already_reserved"
        connection.execute("UPDATE effects SET state = 'in_progress', result = '{}', updated_at = ? WHERE order_id = ? AND name = ?", (time.time(), order_id, name))
    return "reserved"


def _finish_effect(app, order_id, name, state, result):
    with _connect(app) as connection:
        connection.execute("UPDATE effects SET state = ?, result = ?, updated_at = ? WHERE order_id = ? AND name = ?", (state, json.dumps(result), time.time(), order_id, name))


def _execute_effect(app, order_id, name, action, fingerprint=""):
    reservation = _reserve_effect(app, order_id, name, fingerprint)
    if reservation != "reserved":
        return reservation
    try:
        result = action()
        state = "skipped" if result.get("skipped") else "succeeded"
    except integrations.IntegrationError as error:
        state = "unknown" if error.ambiguous else "failed"
        result = {"error_code": error.code, "reconcile_required": error.ambiguous}
    except Exception:
        # Unexpected failures may occur after a remote mutation. Do not retry.
        state, result = "unknown", {"error_code": "unexpected_integration_error", "reconcile_required": True}
    _finish_effect(app, order_id, name, state, result)
    return "processed"


def _effect_snapshot(app, order_id, names=None):
    with _connect(app) as connection:
        rows = connection.execute("SELECT name, state, result, updated_at FROM effects WHERE order_id = ?", (order_id,)).fetchall()
    effects = {}
    now = time.time()
    for row in rows:
        if names is not None and row["name"] not in names:
            continue
        result = json.loads(row["result"])
        state = row["state"]
        if state == "in_progress" and now - row["updated_at"] > app.config["API_TIMEOUT_SECONDS"] * 3 + 60:
            result = {"error_code": "stale_in_progress", "reconcile_required": True}
            state = "unknown"
        effects[row["name"]] = {"state": state, **result}
    return effects


def _response_for_effects(order_id, mode, effects):
    states = {value["state"] for value in effects.values()}
    if "unknown" in states:
        status, code = "reconcile_required", 202
    elif "in_progress" in states or "pending" in states:
        status, code = "processing", 202
    elif "failed" in states:
        status, code = "partial_failure", 502
    else:
        status, code = ("dry_run" if mode == "dry_run" else "completed"), 200
    return jsonify({"order_id": order_id, "mode": mode, "status": status, "effects": effects}), code


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.update({key: os.environ[key] for key in CONFIG_KEYS if os.environ.get(key)})
    app.config.setdefault("DELIVERY_MODE", "dry_run")
    app.config.setdefault("ORDER_DB_PATH", str(Path(__file__).resolve().parent / "work" / "orders.sqlite3"))
    app.config.setdefault("API_TIMEOUT_SECONDS", 15)
    app.config.setdefault("GOOGLE_SHEETS_RANGE", "Orders!A:E")
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
    if test_config:
        app.config.update(test_config)
    if not isinstance(app.config.get("WEBHOOK_SECRET"), str) or not app.config["WEBHOOK_SECRET"]:
        raise RuntimeError("Set WEBHOOK_SECRET before starting the webhook server.")
    if app.config["DELIVERY_MODE"] not in ("dry_run", "live"):
        raise RuntimeError("DELIVERY_MODE must be dry_run or live.")
    try:
        app.config["API_TIMEOUT_SECONDS"] = float(app.config["API_TIMEOUT_SECONDS"])
        if not 0 < app.config["API_TIMEOUT_SECONDS"] <= 120:
            raise ValueError
    except (TypeError, ValueError):
        raise RuntimeError("API_TIMEOUT_SECONDS must be between 0 and 120 seconds.") from None
    _initialize(app)

    @app.before_request
    def authenticate():
        if request.path == "/health":
            return None
        if request.path == "/webhook" and app.config.get("MESSENGER_ROUTE_ENABLED"):
            # Meta has its own challenge and raw-body HMAC authentication.
            return None
        expected = ("Bearer " + app.config["WEBHOOK_SECRET"]).encode("utf-8")
        supplied = request.headers.get("Authorization", "").encode("utf-8")
        if not hmac.compare_digest(expected, supplied):
            return jsonify({"error": "unauthorized"}), 401

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify({"error": "payload_too_large"}), 413

    @app.get("/health")
    def health():
        return jsonify({"status": "ok", "mode": app.config["DELIVERY_MODE"]})

    @app.post("/webhooks/orders")
    def confirmed_order():
        if not request.is_json:
            return jsonify({"error": "application_json_required"}), 415
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or payload.get("order_event") != "ORDER_CONFIRMED":
            return jsonify({"error": "order_confirmed_payload_required"}), 400
        try:
            request_fingerprint = _fingerprint(payload)
        except (TypeError, ValueError):
            return jsonify({"error": "invalid_json_numbers"}), 400
        order, conflict = _lookup_replay(app, payload, request_fingerprint)
        if conflict:
            return jsonify({"error": conflict}), 409
        try:
            if order is None:
                order = validate_order(payload)
        except OrderValidationError:
            return jsonify({"error": "invalid_order", "detail": "Check order schema, catalog pricing, delivery zone and required customer fields."}), 400
        conflict = _reserve_order(app, order, request_fingerprint)
        if conflict:
            return jsonify({"error": conflict}), 409
        if app.config["DELIVERY_MODE"] == "dry_run":
            for name in ORDER_EFFECTS:
                if _reserve_effect(app, order["order_id"], name) == "reserved":
                    result = {"network_called": False}
                    if name == "booking_tracking_messenger":
                        result["conditional_on_courier_tracking"] = True
                    _finish_effect(app, order["order_id"], name, "planned", result)
        else:
            _execute_effect(app, order["order_id"], "courier", lambda: integrations.deliver_courier(order, app.config))
            _execute_effect(app, order["order_id"], "sheets", lambda: integrations.append_sheet(order, app.config))
            _execute_effect(app, order["order_id"], "confirmation_messenger", lambda: integrations.send_confirmation(order, app.config))
            courier = _effect_snapshot(app, order["order_id"], ("courier",)).get("courier", {})
            if courier.get("state") == "succeeded" and courier.get("tracking_code"):
                _execute_effect(app, order["order_id"], "booking_tracking_messenger", lambda: integrations.send_tracking(order, courier["tracking_code"], "booked", app.config))
        return _response_for_effects(order["order_id"], app.config["DELIVERY_MODE"], _effect_snapshot(app, order["order_id"], ORDER_EFFECTS))

    @app.get("/webhooks/orders/<order_id>")
    def order_status(order_id):
        with _connect(app) as connection:
            stored = connection.execute("SELECT mode FROM orders WHERE order_id = ?", (order_id,)).fetchone()
        if not stored:
            return jsonify({"error": "order_not_found"}), 404
        return _response_for_effects(order_id, stored["mode"], _effect_snapshot(app, order_id))

    @app.post("/webhooks/tracking")
    def tracking_update():
        if not request.is_json:
            return jsonify({"error": "application_json_required"}), 415
        payload = request.get_json(silent=True)
        expected_keys = {"order_event", "order_id", "tracking_code", "status"}
        if not isinstance(payload, dict) or set(payload) != expected_keys or payload.get("order_event") != "TRACKING_UPDATED":
            return jsonify({"error": "invalid_tracking_payload"}), 400
        if not all(isinstance(payload[key], str) for key in ("order_id", "tracking_code", "status")):
            return jsonify({"error": "invalid_tracking_payload"}), 400
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", payload["order_id"]) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", payload["tracking_code"]) or not re.fullmatch(r"[A-Za-z][A-Za-z _-]{0,79}", payload["status"]):
            return jsonify({"error": "invalid_tracking_payload"}), 400
        with _connect(app) as connection:
            stored = connection.execute("SELECT payload, mode FROM orders WHERE order_id = ?", (payload["order_id"],)).fetchone()
        if not stored:
            return jsonify({"error": "order_not_found"}), 404
        if stored["mode"] != app.config["DELIVERY_MODE"]:
            return jsonify({"error": "order_id_mode_conflict"}), 409
        order = json.loads(stored["payload"])
        fingerprint = _fingerprint(payload)
        name = "tracking_messenger:" + fingerprint
        if app.config["DELIVERY_MODE"] == "dry_run":
            if _reserve_effect(app, order["order_id"], name, fingerprint) == "reserved":
                _finish_effect(app, order["order_id"], name, "planned", {"network_called": False, "sms_sent": False})
        else:
            _execute_effect(app, order["order_id"], name, lambda: integrations.send_tracking(order, payload["tracking_code"], payload["status"], app.config), fingerprint)
        return _response_for_effects(order["order_id"], app.config["DELIVERY_MODE"], _effect_snapshot(app, order["order_id"], (name,)))

    return app


if __name__ == "__main__":
    from app import load_env

    load_env()
    try:
        application = create_app()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    application.run(host=os.environ.get("WEBHOOK_HOST", "127.0.0.1"), port=int(os.environ.get("WEBHOOK_PORT", "5000")), debug=False)
