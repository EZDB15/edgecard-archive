# edgecard-archive

The public, tamper-evident record for **Edge Card** — transparent quantitative
race cards for the Saratoga and Del Mar meets. Live site: **https://edgecardhq.com**

This repository *is* the archive. It exists so that anyone can verify that every
published pick was committed **before** the race, and that nothing was edited or
removed after the fact.

## What's here

- `site/` — the static site served at edgecardhq.com (Cloudflare Pages). Includes
  `methodology/`, `record/`, `terms/`, `privacy/`, and per-card pages under `archive/`.
- `ledger.jsonl` — the append-only, hash-chained record. Each pick row links to the
  previous entry's hash, so any later edit to a past row breaks the chain.
- `cards/<date>-<track>/` — the locked `card.json` + `meta.json` for each published card
  (the exact bytes whose SHA-256 was posted to X before post time).
- `*.ots` — [OpenTimestamps](https://opentimestamps.org) proofs, added automatically by
  the `timestamp` GitHub Action, anchoring the ledger and cards to the Bitcoin blockchain.

## How to verify a card

1. Read the card's SHA-256 from its page (or the X post made before post time).
2. Recompute it: `sha256sum cards/<date>-<track>/card.json`.
3. Check the git commit timestamp — it predates the race's post time.
4. Verify the blockchain proof: `ots verify cards/<date>-<track>/card.json.ots`.

The three layers (pre-post X hash → git commit → OpenTimestamps) independently prove
the card existed, unedited, before the outcome was known.

## What this is not

This is an information publication, not a wagering service. It accepts no bets, holds
no funds, and awards no prizes. Analysis and opinion, not wagering advice. No outcome is
guaranteed; most bettors lose money over time. 18+ only (21+ where required by your
state). Gambling problem? Call or text 1-800-GAMBLER. Edge Card is independent and not
affiliated with NYRA, the Del Mar Thoroughbred Club, Equibase, or Brisnet.

© Edge Card. All rights reserved. The cards, probabilities, and ratings are original
works; no license to copy, redistribute, or build derivative products is granted.
