#!/usr/bin/env python3
"""Read and aggregate the first-party event store (A2b).

WHY THIS EXISTS
    `functions/_e.js` has accepted events since the KV binding landed, and
    nothing has ever read them. A store nothing can read is not measurement, so
    the referrer field A2 adds would have landed in a place no question could be
    asked of. This is the read path.

WHERE IT RUNS
    Operator machine, never the public site. `_e.js` says "the beacon is
    write-only. There is no read path on the public site" and that is the right
    call -- a public reader would expose the whole event stream to anyone who
    found the URL. This talks to the Cloudflare KV REST API with an operator
    token instead.

CREDENTIALS (all required for --live)
    CF_ACCOUNT_ID     Cloudflare account id
    CF_KV_NAMESPACE   the EC_EVENTS namespace id (the UUID, not the binding name)
    CF_API_TOKEN      token with "Workers KV Storage: Read"

    Read-only scope is deliberate. This script must never be able to write or
    delete: the event store is measurement evidence, and a reader that can
    mutate it is a reader that can quietly launder a bad number.

USAGE
    python scripts/read_events.py --live
    python scripts/read_events.py --live --dump events.jsonl   # keep a copy
    python scripts/read_events.py --from-file events.jsonl     # offline re-run

HONESTY RULES BAKED IN
    * Counts that cannot be computed print as "unknown", never as 0. An empty
      store and a failed fetch must not look alike.
    * Return rate is reported with its denominator. A percentage without an n is
      the kind of number CONSTRAINTS 4 exists to stop.
    * Partner classification happens HERE, at analysis time, from the raw host.
      Change the map and re-run; nothing at write time is destroyed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

API = "https://api.cloudflare.com/client/v4"

# Analysis-time classification. Deliberately NOT applied when the event is
# stored -- see the comment in functions/_e.js. Suffix match so
# "www.twinspires.com" and "m.twinspires.com" both land.
PARTNERS = {
    "twinspires.com": "twinspires",
    "brisnet.com": "brisnet",
}

# The tag the partner feed has handed out in `partner_links` since 2026-07-16.
PARTNER_TAGS = {"twinspires", "brisnet"}


def classify(host: str) -> str:
    if not host:
        return "(direct/none)"
    if host == "internal":
        return "internal"
    for suffix, label in PARTNERS.items():
        if host == suffix or host.endswith("." + suffix):
            return label
    return host


def _req(url: str, token: str) -> dict:
    r = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_live(account: str, namespace: str, token: str, prefix: str = "ev:"):
    """Yield event dicts. Raises on transport/auth failure -- never returns [].

    A silent empty list here would read downstream as "no traffic", which is the
    same failure mode as the beacon that returned 204 and discarded.
    """
    base = f"{API}/accounts/{account}/storage/kv/namespaces/{namespace}"
    cursor, pages, keys = "", 0, []
    while True:
        q = {"limit": "1000", "prefix": prefix}
        if cursor:
            q["cursor"] = cursor
        data = _req(f"{base}/keys?{urllib.parse.urlencode(q)}", token)
        if not data.get("success", False):
            raise RuntimeError(f"KV key list failed: {data.get('errors')}")
        keys.extend(k["name"] for k in data.get("result", []))
        info = data.get("result_info") or {}
        cursor = info.get("cursor") or ""
        pages += 1
        if not cursor:
            break
    print(f"  listed {len(keys)} keys in {pages} page(s)", file=sys.stderr)

    for i, name in enumerate(keys, 1):
        if i % 200 == 0:
            print(f"  fetched {i}/{len(keys)}", file=sys.stderr)
        url = f"{base}/values/{urllib.parse.quote(name, safe='')}"
        try:
            r = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(r, timeout=30) as resp:
                yield json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError) as e:
            # Report, do not swallow. A skipped record is a known unknown.
            print(f"  SKIPPED {name}: {e}", file=sys.stderr)


def summarise(events: list[dict]) -> None:
    if not events:
        print("\nNo events in the store.")
        print("That is a real answer only if the fetch succeeded -- check the")
        print("key count above. Zero keys with a clean fetch means no traffic;")
        print("an error above means unknown, not zero.")
        return

    by_event = Counter(e.get("e", "?") for e in events)
    arrivals = [e for e in events if e.get("e") in ("first_visit", "return_visit")]

    # Referrer / tag are absent from every record written before the A2 patch.
    # Distinguish "field not present" from "present and empty" -- otherwise a
    # pre-patch store looks exactly like a store full of direct traffic.
    has_ref_field = [e for e in arrivals if "ref" in e]
    missing = len(arrivals) - len(has_ref_field)

    print(f"\n{'='*62}\nEVENT STORE SUMMARY — {len(events)} records\n{'='*62}")
    print("\nBy event type:")
    for name, n in by_event.most_common():
        print(f"  {name:<18} {n:>6}")

    print(f"\nArrivals (first_visit + return_visit): {len(arrivals)}")
    if missing:
        print(f"  !! {missing} arrival(s) predate the referrer patch and carry")
        print("     no `ref` field at all. Those are UNKNOWN origin, not direct.")

    if has_ref_field:
        print(f"\nArrival source — {len(has_ref_field)} record(s) with the field:")
        src_counts = Counter(classify(e.get("ref", "")) for e in has_ref_field)
        for host, n in src_counts.most_common(15):
            pct = 100.0 * n / len(has_ref_field)
            mark = "  <-- PARTNER" if host in PARTNER_TAGS else ""
            print(f"  {host:<28} {n:>6}  {pct:5.1f}%{mark}")

        tags = Counter(e.get("src", "") for e in has_ref_field if e.get("src"))
        if tags:
            print("\nCampaign tag (utm_source / ?s=):")
            for tag, n in tags.most_common(10):
                mark = "  <-- PARTNER" if tag in PARTNER_TAGS else ""
                print(f"  {tag:<28} {n:>6}{mark}")
        else:
            print("\nCampaign tag: none seen.")
            print("  If CDI is live, this means their build used the untagged")
            print("  record_url rather than partner_links -- worth asking.")

    # Return rate, always with its denominator.
    first = sum(1 for e in arrivals if e.get("is_first_visit"))
    ret = len(arrivals) - first
    print("\nReturn behaviour:")
    print(f"  first visits   {first}")
    print(f"  return visits  {ret}")
    if arrivals:
        print(f"  return share   {100.0*ret/len(arrivals):.1f}%  (n={len(arrivals)})")
    print("  NB: cookieless and bucketed by design -- this is a share of visit")
    print("  EVENTS, not of unique people. No visitor id is stored, so a true")
    print("  per-person return rate is not recoverable and must not be claimed.")

    depth = Counter(e.get("pct") for e in events if e.get("e") == "record_depth")
    if depth:
        print("\n/record/ scroll depth:")
        for pct in sorted(x for x in depth if isinstance(x, (int, float))):
            print(f"  {pct:>3}% reached   {depth[pct]:>6}")

    out = Counter(e.get("to", "") for e in events if e.get("e") == "outbound_click")
    if out:
        print("\nOutbound clicks:")
        for host, n in out.most_common(10):
            print(f"  {host:<28} {n:>6}")

    paths = Counter(e.get("path", "") for e in arrivals)
    if paths:
        print("\nLanding paths:")
        for p, n in paths.most_common(10):
            print(f"  {p:<28} {n:>6}")

    days = defaultdict(int)
    for e in arrivals:
        t = e.get("t")
        if isinstance(t, (int, float)):
            import datetime
            days[datetime.datetime.utcfromtimestamp(t / 1000).strftime("%Y-%m-%d")] += 1
    if days:
        print("\nArrivals by UTC day:")
        for d in sorted(days):
            note = "   <-- includes 5 TOTE probe events" if d == "2026-08-07" else ""
            print(f"  {d}   {days[d]:>6}{note}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Read the EC_EVENTS store.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--live", action="store_true", help="fetch from Cloudflare KV")
    g.add_argument("--from-file", metavar="PATH", help="re-run on a saved dump")
    ap.add_argument("--dump", metavar="PATH", help="write fetched events as JSONL")
    args = ap.parse_args()

    if args.live:
        missing = [v for v in ("CF_ACCOUNT_ID", "CF_KV_NAMESPACE", "CF_API_TOKEN")
                   if not os.environ.get(v)]
        if missing:
            print("Missing environment variable(s): " + ", ".join(missing),
                  file=sys.stderr)
            print("\nCloudflare dashboard -> Workers & Pages -> KV: the EC_EVENTS",
                  file=sys.stderr)
            print("namespace id. Token needs 'Workers KV Storage: Read' ONLY.",
                  file=sys.stderr)
            return 2
        print("Fetching from Cloudflare KV...", file=sys.stderr)
        try:
            events = list(fetch_live(os.environ["CF_ACCOUNT_ID"],
                                     os.environ["CF_KV_NAMESPACE"],
                                     os.environ["CF_API_TOKEN"]))
        except (urllib.error.URLError, RuntimeError) as e:
            # Fail loud. Never fall through to a summary that would print zeros.
            print(f"\nFETCH FAILED: {e}", file=sys.stderr)
            print("Reporting nothing rather than reporting zero.", file=sys.stderr)
            return 1
        if args.dump:
            with open(args.dump, "w", encoding="utf-8") as fh:
                for e in events:
                    fh.write(json.dumps(e) + "\n")
            print(f"  wrote {len(events)} records to {args.dump}", file=sys.stderr)
    else:
        with open(args.from_file, encoding="utf-8") as fh:
            events = [json.loads(ln) for ln in fh if ln.strip()]

    summarise(events)
    return 0


if __name__ == "__main__":
    sys.exit(main())
