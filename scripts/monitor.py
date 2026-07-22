"""Morning health check for the TwinSpires-facing surfaces.

Reliability is the most controllable part of the audition: a broken or late feed
makes Edge Card feel like a hobby, not a product. Run this each morning after
the cards lock to confirm, from outside, that every partner-facing URL loads and
carries a well-formed, current card — before TwinSpires (or anyone) pulls it.

For each track it checks:
  - the feed JSON loads (HTTP 200, parses as JSON, not the HTML age gate),
  - the schema is intact (required keys, a read for every race, the Edge of the
    Day pointer, win-bet payloads),
  - the card is CURRENT (feed date == the date requested), and
  - the human card page loads.

Exit code 0 = all pass, 1 = any failure (so it can drive a cron alert).

Usage:
  monitor.py                         # today, SAR + DMR, live site
  monitor.py --date 2026-07-22 --tracks SAR
  monitor.py --base-url http://localhost:8000
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
import urllib.error
import urllib.request

# A non-bot User-Agent — Cloudflare's bot filter 403s the default urllib UA.
_UA = "EdgeCardMonitor/1.0 (+https://edgecardhq.com; health check)"

# Top-level feed keys that must be present and non-null.
_REQUIRED_FEED_KEYS = (
    "product", "track", "date", "model_version", "generated_ts_utc",
    "n_races", "n_flags", "flags", "card_reads", "multi_race", "url", "attribution",
)
_REQUIRED_FLAG_KEYS = ("race", "program", "horse", "model_win_pct", "fair_odds", "bet")


def _get(url: str, timeout: int = 20) -> tuple[int, str, str]:
    """(status, content_type, body). status 0 on a network error."""
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", "") if e.headers else "", ""
    except Exception as e:  # noqa: BLE001 — any network failure is a monitor failure
        return 0, "", str(e)


def _check_feed(base: str, track: str, date: str) -> list[tuple[bool, str]]:
    url = f"{base}/archive/{date}-{track.lower()}/feed.json"
    status, ctype, body = _get(url)
    if status != 200:
        return [(False, f"{track} feed: HTTP {status or 'network error'} — {url}")]
    if "html" in ctype.lower() or body.lstrip().startswith("<"):
        return [(False, f"{track} feed: served HTML, not JSON (age gate / redirect?)")]
    try:
        d = json.loads(body)
    except json.JSONDecodeError as e:
        return [(False, f"{track} feed: invalid JSON — {e}")]

    out: list[tuple[bool, str]] = []
    missing = [k for k in _REQUIRED_FEED_KEYS if d.get(k) in (None, "")]
    out.append((not missing, f"{track} feed schema" + (f": missing {missing}" if missing else " ok")))
    out.append((d.get("date") == date, f"{track} feed date {d.get('date')} == {date}"))
    out.append((str(d.get("track")).upper() == track.upper(), f"{track} feed track tag ok"))

    reads = d.get("card_reads") or []
    n_races = d.get("n_races") or 0
    out.append((len(reads) == n_races, f"{track} reads: {len(reads)} for {n_races} races"))

    flags = d.get("flags") or []
    bad = [f for f in flags if any(f.get(k) in (None, "") for k in _REQUIRED_FLAG_KEYS)]
    out.append((not bad, f"{track} flags: {len(flags)} flag(s)" + (f", {len(bad)} malformed" if bad else " well-formed")))
    for f in flags:
        bet = f.get("bet") or {}
        if bet.get("pool") != "WIN" or "to win" not in (bet.get("instruction") or ""):
            out.append((False, f"{track} R{f.get('race')} bet payload malformed"))
            break
    else:
        out.append((True, f"{track} win-bet payloads ok"))

    if flags:  # only expect an Edge of the Day when there ARE flags
        eod = d.get("edge_of_day")
        ok = bool(eod and eod.get("race") and eod.get("program") and eod.get("horse"))
        out.append((ok, f"{track} edge_of_day " + ("present" if ok else "MISSING")))
    return out


def _check_page(base: str, track: str, date: str) -> tuple[bool, str]:
    url = f"{base}/archive/{date}-{track.lower()}/"
    status, _ctype, body = _get(url)
    ok = status == 200 and "Edge Card" in body
    return ok, f"{track} card page: HTTP {status or 'network error'}" + ("" if ok else " — not loading")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", default=datetime.date.today().isoformat(), help="YYYY-MM-DD")
    ap.add_argument("--tracks", default="SAR,DMR", help="comma-separated (e.g. SAR,DMR)")
    ap.add_argument("--base-url", default="https://edgecardhq.com")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")
    tracks = [t.strip().upper() for t in args.tracks.split(",") if t.strip()]

    print(f"EDGE CARD MONITOR — {args.date} — {base}")
    results: list[tuple[bool, str]] = []
    for track in tracks:
        results.extend(_check_feed(base, track, args.date))
        results.append(_check_page(base, track, args.date))

    for ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {detail}")
    n_fail = sum(1 for ok, _ in results if not ok)
    print(f"SUMMARY: {len(results) - n_fail} pass, {n_fail} fail")
    return 1 if n_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
