# Plan: Reliable File Transfer with ARQ

> Source PRD: `docs/research/file-transfer-arq.md`

## Architectural decisions

- **ACK_MAGIC**: `[0xFE, 0xFD]` — adjacent to FILE_MAGIC `[0xFE, 0xFF]`, dispatched the same way through `tryDecodeFrame` / `dispatchFrame`
- **ACK packet**: 6 bytes: `ACK_MAGIC (2B) + xferId (2B) + seq (2B)` — small enough for fast TX
- **Timers**: T1 = 5s (Bell 202) / 2s (OFDM), N2 = 5 retransmits — configurable per mode
- **Wire format**: ACK packets are AX.25 UI frames, encrypted if passphrase is set, same as data packets
- **Half-duplex**: Strictly alternating TX/RX — sender listens after each fragment, receiver listens after each ACK
- **Duplicate handling**: Receiver tracks `(xferId, seq)` pairs already stored; duplicates trigger re-ACK but no re-store

---

## Phase 1: ACK Packet Encode/Decode

**User stories**: Foundation for all subsequent phases — define the wire format and prove it round-trips.

### What to build

Add `ACK_MAGIC`, `encodeAck({ xferId, seq })`, and `decodeAck(bytes)` to the packet module. An ACK packet is 6 bytes: magic (2B) + xferId (2B) + seq (2B, big-endian). Unit test the encode/decode round-trip and verify ACK_MAGIC is at offset 0–1.

### Acceptance criteria

- [ ] `encodeAck` produces a 6-byte Uint8Array with `[0xFE, 0xFD]` at offset 0
- [ ] `decodeAck(encodeAck({ xferId, seq }))` recovers the original xferId and seq
- [ ] `decodeAck` returns null for non-ACK packets (wrong magic, too short)
- [ ] Unit tests pass under `npm test`

---

## Phase 2: RX Sends ACK on Fragment Receipt

**User stories**: US5 — receiver automatically sends an ACK when a valid file fragment arrives.

### What to build

When `receiveFilePacket` successfully decodes and stores a fragment, it transmits an ACK packet back over audio. The ACK is encrypted (if passphrase is set), wrapped in an AX.25 UI frame, and played through the speaker. This proves the RX→TX turnaround path works end-to-end. The existing `playFrame` / `playOfdmFrame` helpers handle the audio output. Add an `onAck` callback to the demodulator dispatch so the sender side can receive ACKs in a later phase.

### Acceptance criteria

- [ ] Receiving a valid file fragment triggers an ACK transmission (visible in chat log as "ACK sent")
- [ ] ACK packet is encrypted and framed the same way as data packets
- [ ] ACK is routed correctly through `dispatchFrame` (both Bell 202 and OFDM demodulators)
- [ ] Loopback test: send a file fragment → demodulate → ACK is transmitted → ACK audio can be demodulated back

---

## Phase 3: TX Stop-and-Wait with T1/N2

**User stories**: US1, US2, US4 — sender waits for ACK, retransmits on timeout, aborts after N2 failures.

### What to build

Refactor `sendFile` so that after transmitting each fragment, it switches to listening mode and waits for an ACK (or T1 timeout). On receiving a matching ACK (correct xferId + seq), it proceeds to the next fragment. On T1 timeout, it retransmits the same fragment and decrements N2. If N2 reaches zero, it aborts with an error message. The FSM transitions are: `TX (send fragment) → RUNNING (listen for ACK) → TX (send next or retransmit)`. T1 values: 5s for Bell 202, 2s for OFDM.

### Acceptance criteria

- [ ] After sending a fragment, sender waits up to T1 seconds for an ACK
- [ ] Matching ACK (xferId + seq) causes sender to proceed to next fragment
- [ ] T1 timeout triggers retransmission of the same fragment
- [ ] After N2 failed retransmissions, transfer aborts with error message in chat
- [ ] Successful transfer completes with all fragments ACK'd
- [ ] End-to-end loopback test: multi-fragment file transfers reliably with ACKs

---

## Phase 4: Duplicate Fragment Handling

**User stories**: US6 — duplicate fragments from retransmissions are silently ignored, ACK is re-sent.

### What to build

The receiver tracks which `(xferId, seq)` pairs have already been stored. If a duplicate fragment arrives (because the original ACK was lost and the sender retransmitted), the receiver re-sends the ACK but does not store the fragment again. This prevents data corruption from double-stored fragments.

### Acceptance criteria

- [ ] Receiving the same (xferId, seq) twice does not duplicate the stored fragment
- [ ] Duplicate fragment triggers a fresh ACK transmission
- [ ] Fragment count in `incomingTransfers` remains correct after duplicates
- [ ] Unit test: send same fragment twice → only one stored, two ACKs sent

---

## Phase 5: Progress UI + Status Line

**User stories**: US3, US7 — per-fragment delivery status and channel quality summary.

### What to build

Extend the progress panel to show per-fragment status below the progress bar: "waiting for ACK...", "ACK received", "retransmitting (attempt 2/5)", "failed". After transfer completes, show a summary line in the chat log: fragment count, retransmit count, and average round-trip time. RTT is measured from fragment TX start to ACK RX.

### Acceptance criteria

- [ ] Progress panel shows current fragment status (sent / waiting / ACK'd / retransmitting)
- [ ] Retransmit attempt count is visible (e.g., "attempt 2/5")
- [ ] Completion summary in chat: total fragments, retransmits, avg RTT
- [ ] Failed transfer shows clear error with retransmit count
- [ ] All new elements have `data-testid` attributes

---

## Phase 6: Pause/Resume Interaction with ARQ

**User stories**: Interaction between pause/resume and the ARQ timer.

### What to build

When the transfer is paused while waiting for an ACK: T1 continues running, and if the ACK arrives it is stored. However, the next fragment is not sent until resumed. If T1 expires while paused, the retransmit is deferred until resume. On resume, if an ACK was received during the pause, proceed to the next fragment; if T1 expired, retransmit immediately. Cancel still abandons the transfer regardless of ACK state.

### Acceptance criteria

- [ ] Pausing while waiting for ACK does not lose the ACK if it arrives
- [ ] Resuming after ACK received during pause proceeds to next fragment
- [ ] Resuming after T1 expired during pause triggers immediate retransmit
- [ ] Cancel during ACK wait aborts cleanly (no stale timers)
- [ ] Chat messages sent while paused do not interfere with pending ACK detection
