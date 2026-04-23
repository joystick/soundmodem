// Finite state machine for SoundModem audio lifecycle.
//
// States
// ──────
//   idle            page loaded; no audio running
//   requesting-mic  getUserMedia in flight
//   mic-denied      microphone permission denied (user can retry)
//   initializing    AudioContext + GPU/worklet setup in progress
//   running         audio active and demodulating
//   tx              transmitting (speaker busy — RX suspended)
//   stopping        teardown in progress
//   error           unrecoverable hardware failure
//
// Context (immutable value carried alongside state)
// ─────────────────────────────────────────────────
//   mode           'bell202' | 'ofdm'
//   errorMessage   string | null
//
// transition(state, event, context) is a pure function — no side effects.
// Callers apply side effects by examining the returned next state.

export const S = {
  IDLE:           'idle',
  REQUESTING_MIC: 'requesting-mic',
  MIC_DENIED:     'mic-denied',
  INITIALIZING:   'initializing',
  RUNNING:        'running',
  TX:             'tx',
  STOPPING:       'stopping',
  ERROR:          'error',
};

export const E = {
  START:          'START',
  MIC_GRANTED:    'MIC_GRANTED',
  MIC_DENIED:     'MIC_DENIED',
  HARDWARE_READY: 'HARDWARE_READY',
  HARDWARE_ERROR: 'HARDWARE_ERROR',
  STOP:           'STOP',
  STOPPED:        'STOPPED',
  MODE_CHANGE:    'MODE_CHANGE',
  START_TX:       'START_TX',
  TX_DONE:        'TX_DONE',
};

/**
 * transition(state, event, context) → { state, context }
 *
 * Returns the next machine state given the current state, an event object,
 * and the current context.  Unknown transitions are silent no-ops.
 */
export function transition(state, event, context = { mode: 'bell202', errorMessage: null }) {
  switch (state) {
    case S.IDLE:
      if (event.type === E.START)
        return { state: S.REQUESTING_MIC, context };
      if (event.type === E.MODE_CHANGE)
        return { state: S.IDLE, context: { ...context, mode: event.mode } };
      break;

    case S.REQUESTING_MIC:
      if (event.type === E.MIC_GRANTED)
        return { state: S.INITIALIZING, context };
      if (event.type === E.MIC_DENIED)
        return { state: S.MIC_DENIED, context };
      break;

    case S.MIC_DENIED:
      if (event.type === E.START)
        return { state: S.REQUESTING_MIC, context };
      break;

    case S.INITIALIZING:
      if (event.type === E.HARDWARE_READY)
        return { state: S.RUNNING, context };
      if (event.type === E.HARDWARE_ERROR)
        return { state: S.ERROR, context: { ...context, errorMessage: event.message } };
      break;

    case S.RUNNING:
      if (event.type === E.STOP)
        return { state: S.STOPPING, context };
      if (event.type === E.START_TX)
        return { state: S.TX, context };
      break;

    case S.TX:
      if (event.type === E.TX_DONE)
        return { state: S.RUNNING, context };
      if (event.type === E.STOP)
        return { state: S.STOPPING, context };
      break;

    case S.STOPPING:
      if (event.type === E.STOPPED)
        return { state: S.IDLE, context: { ...context, errorMessage: null } };
      break;

    case S.ERROR:
      if (event.type === E.START)
        return { state: S.REQUESTING_MIC, context: { ...context, errorMessage: null } };
      break;
  }

  // Unknown / ignored transition — return current state unchanged
  return { state, context };
}

/** Returns true if the given state is one where audio hardware is active or being set up. */
export function isAudioActive(state) {
  return state === S.REQUESTING_MIC
      || state === S.INITIALIZING
      || state === S.RUNNING
      || state === S.TX
      || state === S.STOPPING;
}
