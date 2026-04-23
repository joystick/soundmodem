# PRD Interview — Maritime LMS File Transfer over Radio

## Context

Building a file transfer capability on top of the soundmodem (Bell 202 AFSK, 1200 baud, AX.25 UI frames).
Use case: deliver Learning Management System (LMS) content packs to ocean-going vessels.

---

## What we know so far

### The vision (user-stated)

> "Optimising content delivery onboard of ocean going vessels — explore ad-hoc VHF-HF radio options."

Practical content: LMS update packs already stripped down to **Markdown + manifest + assets**.

**Rollout stages:**
1. Two laptops talking via soundmodem (loopback / audio cable)
2. Two walkie-talkies connected via 3.5mm jack
3. …
4. Final product: converged maritime solution combining HF + LTE + Starlink (or equivalent) for bidirectional data exchange

---

## Open questions (not yet answered)

### Content

- [ ] What is the typical size of one LMS update pack? (total bytes, number of files, asset types)
- [ ] Is the manifest a dependency graph (install file X before Y) or just a flat list?
- [ ] Do updates need to be applied atomically (all-or-nothing) or can partial updates be useful?

### Reliability

- [ ] What is the expected SNR / channel quality for the VHF use case (clear line-of-sight, or noisy ship-to-ship)?
- [ ] Is one-way broadcast acceptable (shore → fleet, no ACK), or is confirmed delivery required?
- [ ] If a frame is lost: retransmit (ARQ) or forward error correction (FEC / fountain codes)?

### Transport stack

- [ ] Bell 202 1200 baud for VHF — for HF do you want to swap the modem (e.g. drop to 300 baud, use Winlink/VARA) while keeping the file-transfer protocol modem-agnostic?
- [ ] "Converged" endpoint: transparent best-link selection (Starlink if available, HF otherwise), or a separate routing layer handled elsewhere?

### Receiver

- [ ] Is the receiver always a laptop/browser, or eventually an embedded device?
- [ ] Does the receiver display the LMS in-browser immediately, or store files to disk for a separate LMS player?

---

## Current soundmodem constraints (established)

| Parameter | Value |
|---|---|
| Modulation | Bell 202 AFSK |
| Baud rate | 1200 baud |
| Framing | AX.25 UI frames |
| Max data per frame | ~490 bytes |
| Max frame duration | ~3.5 seconds of audio |
| Implementation | Single-file browser app (`index.html`) |
| Multi-frame protocol | Not yet implemented |
| Error correction | None (CRC-16 detect only, no FEC) |
| Retransmit | None |
