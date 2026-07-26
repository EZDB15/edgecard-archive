"""Canonical proof-identity registry.

Counting `.ots` files on disk is not the same as counting proofs, and conflating
them is how the earlier inventory failed to reconcile. A byte-identical copy of a
proof kept at an old path for URL compatibility is the SAME commitment; it must
never be reported as a second confirmed artifact.

Metrics kept separate, deliberately:

    physical .ots file paths        every file on disk
    unique proof byte hashes        identical copies collapse to one
    unique target digests           what is actually committed to
    canonical proof identities      one per unique commitment
    compatibility aliases           extra paths for the same proof bytes

Public confirmed/pending totals are computed from canonical identities, never
from filesystem paths.

    uv run python scripts/build_proof_registry.py --root ../edgecard-archive \
        --out ../edgecard-archive/proof_registry.json
"""

from __future__ import annotations

import argparse
import binascii
import hashlib
import json
import sys
from collections import defaultdict
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
except ModuleNotFoundError:      # vendored copy
    def write_json(path, obj, *, indent=2):
        raw = (json.dumps(obj, indent=indent, ensure_ascii=False,
                          allow_nan=False) + chr(10)).encode("utf-8")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with Path(path).open("wb") as fh:
            fh.write(raw)
        return hashlib.sha256(raw).hexdigest(), raw

BITCOIN_CONFIRMED = "BITCOIN_CONFIRMED"
CALENDAR_PENDING = "CALENDAR_PENDING"
UNSTAMPED = "UNSTAMPED"


def parse(p: Path):
    with p.open("rb") as fh:
        raw = fh.read()
    d = DetachedTimestampFile.deserialize(BytesDeserializationContext(raw))
    btc, cal = [], []

    def walk(ts):
        for a in ts.attestations:
            if isinstance(a, BitcoinBlockHeaderAttestation):
                btc.append(a.height)
            elif isinstance(a, PendingAttestation):
                cal.append(a.uri)
        for _o, s in ts.ops.items():
            walk(s)
    walk(d.timestamp)
    return (raw, binascii.hexlify(d.timestamp.msg).decode(),
            sorted(set(btc)), sorted(set(cal)), len(btc), len(cal))


def classify(path: Path, root: Path) -> tuple[str, Path, Path | None, str]:
    """(target_type, target_path, preserved_target_path, target_revision)."""
    rel = path.relative_to(root)
    name = path.name
    if name == "card.json.ots":
        return "locked_card", path.parent / "card.json", None, "original"
    if name == "meta.json.ots":
        return "metadata", path.parent / "meta.json", None, "original_publication"
    if name == "meta.current.json.ots":
        return "metadata", path.parent / "meta.json", None, "current_revision"
    if rel.parts[:2] == ("proofs", "ledger"):
        t = path.parent / "ledger.jsonl"
        return "ledger_snapshot", t, t, f"snapshot:{rel.parts[2][:16]}"
    if name == "ledger.jsonl.ots":
        return "ledger_root", root / "ledger.jsonl", None, "root_alias"
    return "unknown", path.with_suffix(""), None, "unknown"


def build(root: Path) -> dict:
    files = sorted(root.rglob("*.ots"))
    parsed = {}
    for p in files:
        parsed[p] = parse(p)

    # Collapse byte-identical proofs into one identity. Canonical path preference:
    # a versioned snapshot beats a root alias, otherwise the shortest path.
    by_bytes: dict[str, list[Path]] = defaultdict(list)
    for p, (raw, *_rest) in parsed.items():
        by_bytes[hashlib.sha256(raw).hexdigest()].append(p)

    def canonical_of(paths: list[Path]) -> Path:
        snap = [q for q in paths if "proofs" in q.parts and "ledger" in q.parts]
        return snap[0] if snap else sorted(paths, key=lambda q: len(str(q)))[0]

    entries = []
    for proof_sha, paths in sorted(by_bytes.items(), key=lambda kv: str(canonical_of(kv[1]))):
        canon = canonical_of(paths)
        aliases = [q for q in paths if q != canon]
        raw, digest, btc, cal, n_btc, n_cal = parsed[canon]
        ttype, tpath, preserved, trev = classify(canon, root)
        cur = hashlib.sha256(tpath.read_bytes()).hexdigest() if tpath.exists() else None
        entries.append({
            "proof_id": f"{ttype}:{digest[:16]}",
            "canonical_path": str(canon.relative_to(root)).replace("\\", "/"),
            "alias_paths": [str(a.relative_to(root)).replace("\\", "/") for a in aliases],
            "proof_sha256": proof_sha,
            "target_digest": digest,
            "target_type": ttype,
            "target_path": str(tpath.relative_to(root)).replace("\\", "/"),
            "preserved_target_path": (str(preserved.relative_to(root)).replace("\\", "/")
                                      if preserved else None),
            "target_revision": trev,
            "target_current_sha256": cur,
            "proof_targets_current_bytes": (digest == cur) if cur else None,
            "status": BITCOIN_CONFIRMED if btc else CALENDAR_PENDING,
            "bitcoin_block_heights": btc,
            "bitcoin_attestation_count": n_btc,
            "calendar_attestation_count": n_cal,
            "superseded_target": (cur is not None and digest != cur),
            "compatibility_alias": bool(aliases),
            # Exactly one row per unique commitment counts publicly. An alias is
            # the same commitment reachable at another URL, never a second proof.
            "counts_toward_public_total": True,
        })

    # Ledger snapshots with a manifest but no proof.
    unstamped = []
    for d in sorted((root / "proofs" / "ledger").glob("*")):
        if d.is_dir() and (d / "manifest.json").exists() and not (d / "ledger.jsonl.ots").exists():
            unstamped.append(str(d.relative_to(root)).replace("\\", "/"))

    conf = [e for e in entries if e["status"] == BITCOIN_CONFIRMED]
    pend = [e for e in entries if e["status"] == CALENDAR_PENDING]
    snaps = [d for d in (root / "proofs" / "ledger").glob("*") if d.is_dir()]

    return {
        "registry_version": "proof-registry-1.0.0",
        "counting_rules": {
            "public_totals_source": "canonical proof identities, not filesystem paths",
            "alias_rule": ("a byte-identical proof kept at another path is the SAME "
                           "commitment and is never counted as a second confirmed artifact"),
            "snapshot_rule": "each ledger snapshot is a distinct commitment with its own proof",
            "metadata_rule": ("original-publication and current-revision metadata proofs are "
                              "distinct identities because they commit to different digests"),
        },
        "metrics": {
            "physical_ots_file_paths": len(files),
            "unique_proof_byte_hashes": len(by_bytes),
            "unique_target_digests": len({e["target_digest"] for e in entries}),
            "canonical_proof_identities": len(entries),
            "compatibility_aliases": sum(len(e["alias_paths"]) for e in entries),
            "bitcoin_confirmed_unique_commitments": len(conf),
            "calendar_pending_unique_commitments": len(pend),
            "unproven_targets": len(unstamped),
            "by_target_type": {
                t: sum(1 for e in entries if e["target_type"] == t)
                for t in sorted({e["target_type"] for e in entries})
            },
            "superseded_metadata_proofs": sum(
                1 for e in entries if e["target_type"] == "metadata" and e["superseded_target"]),
            "ledger_snapshots_total": len(snaps),
            "ledger_snapshots_with_proof": len(snaps) - len(unstamped),
            "ledger_snapshots_without_proof": len(unstamped),
            "total_bitcoin_attestation_objects": sum(e["bitcoin_attestation_count"] for e in entries),
            "total_calendar_attestation_objects": sum(e["calendar_attestation_count"] for e in entries),
        },
        "unstamped_snapshots": unstamped,
        "proofs": entries,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    doc = build(a.root)
    m = doc["metrics"]
    for k, v in m.items():
        if not isinstance(v, dict):
            print(f"  {k:44s} {v}")
    print(f"  by_target_type: {m['by_target_type']}")
    # Arithmetic that must hold.
    assert m["physical_ots_file_paths"] == m["canonical_proof_identities"] + m["compatibility_aliases"]
    assert m["canonical_proof_identities"] == (m["bitcoin_confirmed_unique_commitments"]
                                              + m["calendar_pending_unique_commitments"])
    print("  RECONCILES: physical == identities + aliases; identities == confirmed + pending")
    if a.out:
        sha, _ = write_json(a.out, doc)
        print(f"  registry -> {a.out}  sha256 {sha[:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
