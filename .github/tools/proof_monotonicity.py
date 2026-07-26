"""An upgraded proof may gain attestations. It may never lose them.

An OTS upgrade is enrichment: the calendars hand back paths they have since
learned, and those get merged into the detached proof. Nothing about that should
ever remove an attestation, change what the proof commits to, or take a proof
that already reached Bitcoin back to pending.

Without an explicit check, a partial calendar response, a truncated write, or a
library change could silently replace a rich proof with a poorer one — and the
result would still be a structurally valid `.ots` file, so nothing else would
notice.
"""

from __future__ import annotations

import binascii
import hashlib
from dataclasses import dataclass

from opentimestamps.core.notary import (
    BitcoinBlockHeaderAttestation,
    PendingAttestation,
)
from opentimestamps.core.serialize import BytesDeserializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile

BITCOIN_CONFIRMED = "BITCOIN_CONFIRMED"
CALENDAR_PENDING = "CALENDAR_PENDING"


class MonotonicityError(Exception):
    """Raised when an upgrade would weaken a proof."""


@dataclass(frozen=True)
class ProofFacts:
    target_digest: str
    bitcoin: frozenset          # block heights
    calendars: frozenset        # calendar URIs
    n_bitcoin: int
    n_calendar: int
    n_bytes: int
    sha256: str

    @property
    def status(self) -> str:
        return BITCOIN_CONFIRMED if self.bitcoin else CALENDAR_PENDING


def facts(raw: bytes) -> ProofFacts:
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
    return ProofFacts(
        target_digest=binascii.hexlify(d.timestamp.msg).decode(),
        bitcoin=frozenset(btc), calendars=frozenset(cal),
        n_bitcoin=len(btc), n_calendar=len(cal),
        n_bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
    )


def check(before: bytes, after: bytes) -> dict:
    """Compare a proof before and after an upgrade. Raises on any weakening.

    Returns a record describing what the upgrade actually added.
    """
    b, a = facts(before), facts(after)

    if a.target_digest != b.target_digest:
        raise MonotonicityError(
            f"target digest changed {b.target_digest[:16]} -> {a.target_digest[:16]}; "
            "a proof may never be repurposed to attest a different target")

    if not b.bitcoin <= a.bitcoin:
        raise MonotonicityError(
            f"Bitcoin attestations lost: {sorted(b.bitcoin - a.bitcoin)}")
    if a.n_bitcoin < b.n_bitcoin:
        raise MonotonicityError(
            f"Bitcoin attestation count fell {b.n_bitcoin} -> {a.n_bitcoin}")

    if b.status == BITCOIN_CONFIRMED and a.status == CALENDAR_PENDING:
        raise MonotonicityError(
            "proof downgraded from BITCOIN_CONFIRMED to CALENDAR_PENDING")

    # A calendar attestation may legitimately disappear when the library resolves
    # it into a stronger Bitcoin path. That is the ONLY acceptable loss, and only
    # when a Bitcoin attestation was actually gained.
    lost_cal = b.calendars - a.calendars
    if lost_cal:
        gained_btc = a.bitcoin - b.bitcoin
        if not gained_btc:
            raise MonotonicityError(
                f"calendar attestations lost with no Bitcoin attestation gained: "
                f"{sorted(lost_cal)}")

    if a.n_bytes < b.n_bytes and not (a.bitcoin - b.bitcoin):
        raise MonotonicityError(
            f"proof shrank {b.n_bytes} -> {a.n_bytes} bytes without gaining a "
            "Bitcoin attestation")

    return {
        "target_digest": a.target_digest,
        "status_before": b.status, "status_after": a.status,
        "bitcoin_gained": sorted(a.bitcoin - b.bitcoin),
        "calendars_resolved": sorted(lost_cal),
        "bytes_before": b.n_bytes, "bytes_after": a.n_bytes,
        "sha_before": b.sha256, "sha_after": a.sha256,
        "changed": b.sha256 != a.sha256,
    }
