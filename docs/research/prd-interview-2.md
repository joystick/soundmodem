# PRD Interview — Round 2

## Questions pending user answers

### On the incremental format

- Is the manifest content-addressed (SHA256 hashes of chunks, like a torrent's .torrent file)? Or version-number based?
- What's the target chunk size you're designing around — and is it fixed or variable?
- When an update arrives, does the receiver diff against what it already has (only download missing/changed chunks), or is each "pack" self-contained?

### On the radio link

- Half-duplex (PTT walkie-talkie style) or full-duplex? This determines whether ARQ can interleave with data or needs a strict send/ACK/send cycle.
- For HF specifically — are you targeting NVIS (ship-to-shore within ~500 nm) or long-range skywave? This sets SNR expectations dramatically.
- Is there a "session" concept (ship connects, downloads what it needs, disconnects) or continuous broadcast (shore station keeps repeating new content)?

### On the converged router (RPi)

- Does the RPi need to run the same browser-based soundmodem, or is native Linux code fine for the onboard device?
- Link priority: is it always "use best available" (Starlink > LTE > HF), or do you sometimes *prefer* HF (e.g. cost, coverage outside Starlink footprint)?
- Does the shore side also run a RPi, or is shore a full server?

### On FEC specifically

- Fountain codes (Raptor/LT) would let the receiver reconstruct from *any* N-of-M chunks regardless of which ones arrived — ideal for broadcast. Is that the direction, or do you want classic Reed-Solomon per-frame?

---

## Answers so far

| Question | Answer |
|---|---|
| Content size | Hundreds of MB (SCORM origin); being reformatted as incremental Markdown + manifest + assets |
| Update model | BitTorrent-like incremental updates for HAM-radio constrained environment |
| Two-way comms | Yes — RPi onboard with HF/VHF audio jack + LTE modem + iDirect/Starlink Ethernet |
| Error handling | Both FEC and ARQ required |
| Shore setup | TBD |
| Receiver device | RPi (onboard vessel) + browser for display |
