# PRD: Reliable File Transfer with ARQ

## Problem

File transfer currently sends fragments blindly over audio with no acknowledgement. If any fragment is lost (noise, interference, device out of range), the receiver cannot reassemble the file. There is no way for the sender to know whether delivery succeeded.

This is acceptable for text chat (short, stateless, human-readable) but unacceptable for file transfer where every fragment must arrive intact.

## Goal

Implement stop-and-wait ARQ (Automatic Repeat reQuest) at the file transfer layer so that each fragment is acknowledged before the next is sent. Lost fragments are retransmitted automatically. The sender gets clear feedback on delivery success or failure.

Design the protocol so it can naturally evolve into full AX.25 connected mode (SABM/UA/I-frames/RR/REJ) in a future phase.

## User stories

1. **As a sender**, I want each file fragment to be acknowledged by the receiver so I know it arrived.
2. **As a sender**, I want lost fragments to be automatically retransmitted so I don't have to manually resend the file.
3. **As a sender**, I want to see per-fragment delivery status (sent, waiting for ACK, ACK received, retransmitting) in the progress UI.
4. **As a sender**, I want the transfer to abort with a clear error after N failed retransmissions so I'm not stuck waiting forever.
5. **As a receiver**, I want to automatically send an ACK when I receive a valid file fragment so the sender can proceed.
6. **As a receiver**, I want duplicate fragments (from retransmissions) to be silently ignored so I don't get corrupted data.
7. **As a user**, I want to see the round-trip reliability (ACK rate, retransmit count) so I can assess channel quality.

## Protocol design

### ACK packet format

Reuse the existing packet infrastructure. ACK packets are distinguished by a new magic prefix:

```
Bytes 0–1:   0xFE 0xFD              ACK_MAGIC (distinguishes from FILE_MAGIC 0xFE 0xFF)
Bytes 2–3:   xferId                 transfer ID being acknowledged
Bytes 4–5:   seq                    big-endian uint16, fragment number being ACKed
```

ACK packets are sent as standard AX.25 UI frames (same as file data), modulated and transmitted over audio. They are small (6 bytes + AX.25 overhead) and transmit quickly.

### Stop-and-wait sequence

```
SENDER                                    RECEIVER
──────                                    ────────
fragment 0 ──────────────────────────────►
           start T1 timer
                                          ◄── receive fragment 0
                                          ──► validate + store
                                          ACK(xferId, seq=0) ──────►
           ◄── receive ACK 0
           stop T1 timer
fragment 1 ──────────────────────────────►
           start T1 timer
                                          ...

[timeout — no ACK received]
fragment 1 (retransmit) ─────────────────►
           restart T1 timer, N2--
                                          ◄── receive fragment 1
                                          ACK(xferId, seq=1) ──────►
           ...

[N2 exhausted]
           abort transfer, report failure
```

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| T1 (retransmit timeout) | 5 seconds (Bell 202), 2 seconds (OFDM) | Covers TX time + propagation + RX processing + ACK TX time |
| N2 (max retransmits) | 5 | Gives 25s / 10s total before giving up per fragment |
| ACK_MAGIC | `[0xFE, 0xFD]` | Adjacent to FILE_MAGIC `[0xFE, 0xFF]`, easy to distinguish |

T1 should be configurable — over-the-air at distance needs longer timeouts than loopback.

### Duplicate handling

The receiver tracks which (xferId, seq) pairs have been received. If a duplicate arrives (from a retransmission), it:
1. Re-sends the ACK (the original ACK may have been lost)
2. Does NOT store the fragment again

### Half-duplex constraint

Both sender and receiver share the speaker. The sequence is strictly alternating:

1. Sender transmits fragment (speaker busy)
2. Sender switches to listening (speaker idle)
3. Receiver transmits ACK (speaker busy on receiver side)
4. Receiver switches to listening
5. Sender receives ACK, transmits next fragment

The FSM must handle: `RUNNING → TX (send fragment) → RUNNING (listen for ACK) → TX (send next or retransmit)`. The existing `S.TX` state already covers the "speaker busy" phase; the "waiting for ACK" phase is a new sub-state within the file transfer logic (not necessarily a new FSM state).

### Interaction with pause/resume

When paused (`S.TX_PAUSED`):
- If currently waiting for an ACK, the T1 timer continues running. If ACK arrives, it's stored but the next fragment is not sent until resumed.
- If T1 expires while paused, retransmit does NOT happen until resumed.
- Cancel still works — abandons the transfer regardless of ACK state.

## UI changes

### Progress panel updates

The existing progress panel gains per-fragment status:

```
CLAUDE.md                    2 / 3        ⏸ Pause  ✕ Cancel
████████████████░░░░░░░░ 66%
Fragment 2: waiting for ACK... (attempt 1/5)
```

Status line shows: `sent → waiting for ACK → ACK received → retransmitting (attempt N/5) → failed`

### Channel quality indicator

After transfer completes, show summary:
```
TX FILE CLAUDE.md — 3/3 fragments, 1 retransmit, avg RTT 1.2s
```

## Future: AX.25 connected mode (Phase 2)

The stop-and-wait ARQ protocol above is a stepping stone to full AX.25 connected mode:

| Current (UI + app-layer ARQ) | Future (AX.25 connected) |
|------------------------------|--------------------------|
| UI frames only | SABM → UA → I-frames → DISC |
| App-layer ACK packet | RR/REJ supervisory frames |
| Stop-and-wait (window=1) | Sliding window (window=7) |
| File transfer only | Any reliable data exchange |
| Custom ACK_MAGIC | Standard AX.25 frame types |
| No connection state | Connection state machine |

The migration path:
1. **Phase 1 (this PRD)**: Stop-and-wait over UI frames. Proves the timing, retransmit logic, and UI work correctly.
2. **Phase 2**: Replace UI frames with AX.25 I-frames. Add SABM/UA connection setup. Replace ACK_MAGIC with RR frames. Add sliding window (modulo-8 sequence numbers).
3. **Phase 3**: Add REJ (selective reject) for faster recovery. Add RNR for flow control. Implement T2 (ACK delay for piggybacking) and T3 (idle keepalive).

The key insight: the sender-side logic (timeout, retransmit, abort) and the UI (progress, status, RTT display) are identical between Phase 1 and Phase 2. Only the wire format changes.

## Out of scope

- Sliding window (more than 1 fragment in flight) — future
- FEC at the OFDM symbol level (complementary to ARQ, not a replacement)
- Carrier detect / squelch (would help but is independent)
- Encryption changes (ACK packets are encrypted the same way as data packets)
