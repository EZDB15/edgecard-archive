"""Upgrade OpenTimestamps proofs from calendar commitments to Bitcoin attestations.

WHY THIS EXISTS RATHER THAN THE `ots` CLI
-----------------------------------------
The upstream CLI cannot run on this operator's machine:

  * `otsclient` imports `bitcoin.rpc`, which imports `python-bitcoinlib`.
  * On Python 3.12 that raises `TypeError: argument of type 'NoneType' is not
    iterable` during import.
  * Pinned to Python 3.11 + python-bitcoinlib 0.11.0 it gets further, then fails
    with `FileNotFoundError: Could not find module 'libeay32'` — it wants a
    legacy OpenSSL DLL that modern Windows does not ship.

Neither failure is about OpenTimestamps. Upgrading a proof is an HTTP GET to each
pending calendar for the commitment, then merging the returned timestamp. That
needs `opentimestamps` (pure Python, works on 3.12) and nothing else, so this
script implements exactly that and skips the unusable dependency chain.

WHAT AN UPGRADE IS, AND IS NOT
------------------------------
An upgrade ENRICHES a detached proof: it adds attestation paths that the calendar
has since learned, up to a Bitcoin block header attestation. It does NOT create a
new timestamp and it does NOT change what the proof commits to.

The committed target digest is asserted unchanged before and after. If it ever
moved, that would mean the proof no longer refers to the same artifact, and this
script fails closed rather than writing.

Target artifacts (card.json, meta.json) are never opened for writing here.

    uv run python scripts/ots_upgrade.py --root ../edgecard-archive --dry-run
    uv run python scripts/ots_upgrade.py --root ../edgecard-archive --apply
"""

from __future__ import annotations

import argparse
import binascii
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from opentimestamps.calendar import RemoteCalendar  # noqa: E402
from opentimestamps.core.notary import (  # noqa: E402
    BitcoinBlockHeaderAttestation,
    PendingAttestation,
)
from opentimestamps.core.serialize import (  # noqa: E402
    BytesDeserializationContext,
    BytesSerializationContext,
)
from opentimestamps.core.timestamp import DetachedTimestampFile  # noqa: E402

# statuses
BITCOIN_CONFIRMED = "BITCOIN_CONFIRMED"
CALENDAR_PENDING = "CALENDAR_PENDING"
UPGRADE_NO_CHANGE = "UPGRADE_NO_CHANGE"
VERIFY_FAILED = "VERIFY_FAILED"
TARGET_MISMATCH = "TARGET_MISMATCH"
CLIENT_ERROR = "CLIENT_ERROR"


def load(p: Path) -> DetachedTimestampFile:
    with p.open("rb") as fh:
        return DetachedTimestampFile.deserialize(BytesDeserializationContext(fh.read()))


def dump(dtf: DetachedTimestampFile) -> bytes:
    ctx = BytesSerializationContext()
    dtf.serialize(ctx)
    return ctx.getbytes()


def walk(ts):
    """Yield every (timestamp, attestation) in the tree."""
    for a in ts.attestations:
        yield ts, a
    for _op, sub in ts.ops.items():
        yield from walk(sub)


def attestation_summary(ts) -> tuple[list[str], int | None]:
    kinds, height = [], None
    for _t, a in walk(ts):
        if isinstance(a, BitcoinBlockHeaderAttestation):
            kinds.append(f"bitcoin:{a.height}")
            height = a.height if height is None else min(height, a.height)
        elif isinstance(a, PendingAttestation):
            kinds.append(f"pending:{a.uri}")
        else:
            kinds.append(type(a).__name__)
    return kinds, height


def upgrade_timestamp(ts, *, timeout: int = 20) -> bool:
    """Fetch completions for every pending attestation. True if anything merged."""
    changed = False
    for sub_ts, att in list(walk(ts)):
        if not isinstance(att, PendingAttestation):
            continue
        uri = att.uri
        if not uri.startswith("https://"):
            continue
        try:
            cal = RemoteCalendar(uri)
            completed = cal.get_timestamp(sub_ts.msg, timeout=timeout)
        except Exception:  # noqa: BLE001 — a calendar being down is not fatal
            continue
        if completed is None:
            continue
        before = len(list(walk(sub_ts)))
        sub_ts.merge(completed)
        if len(list(walk(sub_ts))) != before:
            changed = True
    return changed


def process(ots_path: Path, *, apply: bool, timeout: int = 20) -> dict:
    rec: dict = {"ots_file": str(ots_path).replace("\\", "/")}
    try:
        pre_bytes = ots_path.read_bytes()
        rec["pre_proof_sha256"] = hashlib.sha256(pre_bytes).hexdigest()
        dtf = load(ots_path)
    except Exception as exc:  # noqa: BLE001
        rec.update(status=CLIENT_ERROR, error=str(exc)[:200])
        return rec

    target_digest = binascii.hexlify(dtf.timestamp.msg).decode()
    rec["committed_target_digest"] = target_digest

    target = ots_path.with_suffix("")            # card.json.ots -> card.json
    rec["target_file"] = str(target).replace("\\", "/")
    if target.exists():
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        rec["target_current_sha256"] = actual
        rec["proof_matches_current_target"] = (actual == target_digest)
    else:
        rec["target_current_sha256"] = None
        rec["proof_matches_current_target"] = None

    pre_kinds, pre_height = attestation_summary(dtf.timestamp)
    rec["pre_attestations"] = pre_kinds

    try:
        changed = upgrade_timestamp(dtf.timestamp, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        rec.update(status=CLIENT_ERROR, error=str(exc)[:200])
        return rec

    post_kinds, post_height = attestation_summary(dtf.timestamp)
    rec["post_attestations"] = post_kinds
    rec["bitcoin_block_height"] = post_height

    new_bytes = dump(dtf)
    # An upgrade may only ADD attestations. Verified before writing, so a
    # weakened proof is never persisted.
    try:
        from proof_monotonicity import MonotonicityError, check as mono_check
        rec['monotonicity'] = mono_check(pre_bytes, new_bytes)
    except MonotonicityError as exc:
        rec.update(status=VERIFY_FAILED, error=f'monotonicity: {exc}')
        return rec

    # The invariant that makes this safe: the commitment must not move.
    if binascii.hexlify(load_from_bytes(new_bytes).timestamp.msg).decode() != target_digest:
        rec.update(status=TARGET_MISMATCH,
                   error="committed target digest changed during upgrade — refusing to write")
        return rec

    if changed and apply:
        ots_path.write_bytes(new_bytes)
    rec["post_proof_sha256"] = hashlib.sha256(
        ots_path.read_bytes() if (changed and apply) else new_bytes).hexdigest()
    rec["proof_bytes_changed"] = changed

    if post_height is not None:
        rec["status"] = BITCOIN_CONFIRMED
    elif changed:
        rec["status"] = CALENDAR_PENDING
    else:
        rec["status"] = UPGRADE_NO_CHANGE
    return rec


def load_from_bytes(raw: bytes) -> DetachedTimestampFile:
    return DetachedTimestampFile.deserialize(BytesDeserializationContext(raw))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", type=Path, default=None, help="write a JSON status report")
    ap.add_argument("--timeout", type=int, default=20)
    a = ap.parse_args()
    if a.apply and a.dry_run:
        ap.error("--apply and --dry-run are mutually exclusive")

    proofs = sorted(Path(a.root).rglob("*.ots"))
    print(f"{len(proofs)} proof(s) under {a.root}"
          f"{'  [DRY RUN]' if not a.apply else '  [APPLYING]'}")
    recs = []
    for p in proofs:
        r = process(p, apply=a.apply, timeout=a.timeout)
        recs.append(r)
        flag = "" if r.get("proof_matches_current_target") is not False else "  TARGET!=CURRENT"
        print(f"  {r['status']:18s} {r['ots_file'][-46:]:46s} "
              f"btc={r.get('bitcoin_block_height')}{flag}")

    by = {}
    for r in recs:
        by[r["status"]] = by.get(r["status"], 0) + 1
    print("\nsummary:", json.dumps(by))
    print("target digest unchanged for all:",
          all(r.get("status") != TARGET_MISMATCH for r in recs))

    if a.out:
        from hre.io.canonical import write_json
        write_json(a.out, {"proofs": recs, "summary": by})
        print(f"status report -> {a.out}")
    return 0 if all(r["status"] != TARGET_MISMATCH for r in recs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
