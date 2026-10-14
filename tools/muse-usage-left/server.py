#!/usr/bin/env python3
"""Muse usage-left viewer (stdlib only, no installs).

Serves one page that shows:
  - real tokens spent today / last 7 days, summed from Muse session logs
    (~/.local/share/muse/sessions/**/session.jsonl, goal_usage_attribution
    records with reported=true, deduped by usage_id -- same rule as
    src/main/museUsage.ts)
  - "usage left" = 100 - used_percent for the subscription window and the
    week, from a snapshot you paste in from the TUI's /usage command.
    Muse publishes that percent only live in the TUI; it is not written
    to any local file, so this tool stores your last pasted snapshot in
    snapshot.json next to this file and shows its age.

Run:  python3 server.py          (opens http://127.0.0.1:8917)
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SNAPSHOT_FILE = HERE / "snapshot.json"
PORT = int(os.environ.get("PORT", "8917"))


def sessions_root() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "muse" / "sessions"


def tally_tokens(now_ms: float) -> dict:
    today = {"input": 0, "output": 0}
    last7 = {"input": 0, "output": 0}
    root = sessions_root()
    if not root.exists():
        return {"today": today, "last7Days": last7, "sessionsFound": False}
    day_start = time.localtime(now_ms / 1000)
    today_ms = time.mktime((day_start.tm_year, day_start.tm_mon, day_start.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000
    week_ms = now_ms - 7 * 24 * 60 * 60 * 1000
    seen = set()

    def visit(obj, recorded_at_us):
        if not isinstance(obj, dict):
            return
        children = obj.get("children")
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict) and isinstance(child.get("record_json"), str):
                    try:
                        visit(json.loads(child["record_json"]), recorded_at_us)
                    except Exception:
                        pass
        payload = obj.get("payload")
        if not isinstance(payload, dict):
            return
        event = payload.get("event")
        if not isinstance(event, dict) or event.get("kind") != "goal_usage_attribution":
            return
        record = event.get("record")
        if not isinstance(record, dict):
            return
        q = record.get("quantity")
        uid = record.get("usage_id")
        if not isinstance(q, dict) or q.get("reported") is not True or not uid or uid in seen:
            return
        seen.add(uid)
        at_ms = (recorded_at_us / 1000) if isinstance(recorded_at_us, (int, float)) else 0
        inp = q.get("input_tokens") if isinstance(q.get("input_tokens"), (int, float)) else 0
        out = q.get("output_tokens") if isinstance(q.get("output_tokens"), (int, float)) else 0
        if at_ms >= week_ms:
            last7["input"] += inp
            last7["output"] += out
        if at_ms >= today_ms:
            today["input"] += inp
            today["output"] += out

    for path in root.rglob("*.jsonl"):
        try:
            if path.stat().st_mtime * 1000 < week_ms:
                continue
            text = path.read_text(errors="ignore")
        except Exception:
            continue
        for line in text.split("\n"):
            if "goal_usage_attribution" not in line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            visit(obj, obj.get("recorded_at") if isinstance(obj, dict) else None)
    return {"today": today, "last7Days": last7, "sessionsFound": True}


def load_snapshot():
    try:
        return json.loads(SNAPSHOT_FILE.read_text())
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the terminal quiet
        pass

    def _send(self, code, body, ctype):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(200, (HERE / "index.html").read_text(), "text/html; charset=utf-8")
        elif self.path == "/api/today":
            now = time.time() * 1000
            payload = tally_tokens(now)
            payload["snapshot"] = load_snapshot()
            payload["generatedAt"] = int(now)
            self._send(200, json.dumps(payload), "application/json")
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path != "/api/snapshot":
            self._send(404, "not found", "text/plain")
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, json.dumps({"error": "bad json"}), "application/json")
            return
        snap = {
            "windowUsedPct": body.get("windowUsedPct"),
            "weeklyUsedPct": body.get("weeklyUsedPct"),
            "windowResetsAt": body.get("windowResetsAt"),
            "weeklyResetsAt": body.get("weeklyResetsAt"),
            "tier": body.get("tier") or "",
            "savedAt": int(time.time() * 1000),
        }
        SNAPSHOT_FILE.write_text(json.dumps(snap, indent=2))
        self._send(200, json.dumps({"ok": True, "snapshot": snap}), "application/json")


if __name__ == "__main__":
    print(f"Muse usage-left viewer: http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
