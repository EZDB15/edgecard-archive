"""Emit `proof_status.json` — per-proof OTS status, read from the proofs.

This is the artifact the card pages render from, so it must never be hand-edited
or optimistically filled in: every field here is parsed out of the `.ots` file
that is published beside the artifact it commits to.

    uv run python scripts/build_proof_status.py --root ../edgecard-archive \
        --out ../edgecard-archive/proof_status.json
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

from opentimestamps.core.notary import (  # noqa: E402
    BitcoinBlockHeaderAttestation,
    PendingAttestation,
)
from opentimestamps.core.serialize import BytesDeserializationContext  # noqa: E402
from opentimestamps.core.timestamp import DetachedTimestampFile  # noqa: E402

try:
    from hre.io.canonical import write_json  # noqa: E402
except ModuleNotFoundError:      # vendored copy: no edge-card src on path
    def write_json(path, obj, *, indent=2):
        raw = (json.dumps(obj, indent=indent, ensure_ascii=False,
                          allow_nan=False) + chr(10)).encode("utf-8")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with Path(path).open("wb") as fh:
            fh.write(raw)
        return hashlib.sha256(raw).hexdigest(), raw

CORRECTIONS = Path("card_hash_corrections.jsonl")


def parse(p: Path):
    with p.open("rb") as fh:
        d = DetachedTimestampFile.deserialize(BytesDeserializationContext(fh.read()))
    btc, pend = [], []

    def walk(ts):
        for a in ts.attestations:
            if isinstance(a, BitcoinBlockHeaderAttestation):
                btc.append(a.height)
            elif isinstance(a, PendingAttestation):
                pend.append(a.uri)
        for _o, s in ts.ops.items():
            walk(s)
    walk(d.timestamp)
    return binascii.hexlify(d.timestamp.msg).decode(), btc, pend


def load_corrections(path: Path) -> dict:
    reg = {}
    if not path.exists():
        return reg
    for ln in path.read_text(encoding="utf-8").splitlines():
        if not ln.strip():
            continue
        r = json.loads(ln)
        if r.get("entry_type") == "card_hash_correction" and r.get("artifact") == "card.json":
            reg[(r["date"], r["track"])] = r
    return reg


def build(root: Path, corrections: Path) -> dict:
    reg = load_corrections(corrections)
    cards: dict = {}
    for d in sorted((root / "cards").glob("*")):
        if not (d / "card.json").exists():
            continue
        date, track = d.name.rsplit("-", 1)
        track = track.upper()
        entry = {"date": date, "track": track, "artifacts": {}}
        for art in ("card.json", "meta.json", "meta.current.json"):
            ots = d / f"{art}.ots"
            if not ots.exists():
                continue
            # meta.current.json.ots commits to the CURRENT meta.json bytes.
            target = d / ("meta.json" if art == "meta.current.json" else art)
            digest, btc, pend = parse(ots)
            cur = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
            entry["artifacts"][art] = {
                "proof_file": ots.name,
                "committed_digest": digest,
                "current_downloadable_sha256": cur,
                "proof_targets_current_bytes": (digest == cur) if cur else None,
                "bitcoin_attestations": sorted(set(btc)),
                "bitcoin_block_height": min(btc) if btc else None,
                "pending_calendars": sorted(set(pend)),
                "status": "BITCOIN_CONFIRMED" if btc else "CALENDAR_PENDING",
            }
        c = reg.get((date, track))
        if c:
            entry["hash_correction"] = {
                "original_recorded_lock_sha256": c["original_recorded_sha"],
                "downloadable_artifact_sha256": c["downloadable_artifact_sha"],
                "newline_only_difference": c["newline_only_difference"],
                "semantic_equivalence": c["semantic_equivalence"],
                "correction_id": c["correction_id"],
            }
        cards[d.name] = entry
    return {
        "generated_by": "scripts/build_proof_status.py",
        "note": ("status is parsed from each .ots file; BITCOIN_CONFIRMED appears only when "
                 "that proof contains a BitcoinBlockHeaderAttestation"),
        "cards": cards,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--corrections", type=Path, default=CORRECTIONS)
    a = ap.parse_args()
    doc = build(a.root, a.corrections)
    sha, _ = write_json(a.out, doc)
    arts = [x for c in doc["cards"].values() for x in c["artifacts"].values()]
    print(f"proof_status.json -> {a.out}  sha256 {sha[:16]}")
    print(f"  cards {len(doc['cards'])}  artifacts {len(arts)}  "
          f"bitcoin_confirmed {sum(1 for x in arts if x['status'] == 'BITCOIN_CONFIRMED')}  "
          f"calendar_pending {sum(1 for x in arts if x['status'] == 'CALENDAR_PENDING')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
