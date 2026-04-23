import { describe, it, expect } from 'vitest';
import { S, E, transition, isAudioActive } from '../src/fsm.js';

const CTX = { mode: 'bell202', errorMessage: null };
const t = (state, type, extra = {}) => transition(state, { type, ...extra }, CTX);

describe('FSM — idle', () => {
  it('START → requesting-mic', () => {
    expect(t(S.IDLE, E.START).state).toBe(S.REQUESTING_MIC);
  });

  it('MODE_CHANGE updates context.mode', () => {
    const r = transition(S.IDLE, { type: E.MODE_CHANGE, mode: 'ofdm' }, CTX);
    expect(r.state).toBe(S.IDLE);
    expect(r.context.mode).toBe('ofdm');
  });

  it('unknown event is a no-op', () => {
    expect(t(S.IDLE, E.STOP).state).toBe(S.IDLE);
  });
});

describe('FSM — requesting-mic', () => {
  it('MIC_GRANTED → initializing', () => {
    expect(t(S.REQUESTING_MIC, E.MIC_GRANTED).state).toBe(S.INITIALIZING);
  });

  it('MIC_DENIED → mic-denied', () => {
    expect(t(S.REQUESTING_MIC, E.MIC_DENIED).state).toBe(S.MIC_DENIED);
  });

  it('unknown event is a no-op', () => {
    expect(t(S.REQUESTING_MIC, E.STOP).state).toBe(S.REQUESTING_MIC);
  });
});

describe('FSM — mic-denied', () => {
  it('START → requesting-mic (retry)', () => {
    expect(t(S.MIC_DENIED, E.START).state).toBe(S.REQUESTING_MIC);
  });

  it('unknown event is a no-op', () => {
    expect(t(S.MIC_DENIED, E.STOP).state).toBe(S.MIC_DENIED);
  });
});

describe('FSM — initializing', () => {
  it('HARDWARE_READY → running', () => {
    expect(t(S.INITIALIZING, E.HARDWARE_READY).state).toBe(S.RUNNING);
  });

  it('HARDWARE_ERROR → error with message', () => {
    const r = transition(S.INITIALIZING, { type: E.HARDWARE_ERROR, message: 'GPU failed' }, CTX);
    expect(r.state).toBe(S.ERROR);
    expect(r.context.errorMessage).toBe('GPU failed');
  });

  it('unknown event is a no-op', () => {
    expect(t(S.INITIALIZING, E.STOP).state).toBe(S.INITIALIZING);
  });
});

describe('FSM — running', () => {
  it('STOP → stopping', () => {
    expect(t(S.RUNNING, E.STOP).state).toBe(S.STOPPING);
  });

  it('START_TX → tx', () => {
    expect(t(S.RUNNING, E.START_TX).state).toBe(S.TX);
  });

  it('unknown event is a no-op', () => {
    expect(t(S.RUNNING, E.START).state).toBe(S.RUNNING);
  });
});

describe('FSM — tx', () => {
  it('TX_DONE → running', () => {
    expect(t(S.TX, E.TX_DONE).state).toBe(S.RUNNING);
  });

  it('STOP → stopping (emergency stop during TX)', () => {
    expect(t(S.TX, E.STOP).state).toBe(S.STOPPING);
  });

  it('unknown event is a no-op', () => {
    expect(t(S.TX, E.START).state).toBe(S.TX);
  });
});

describe('FSM — stopping', () => {
  it('STOPPED → idle', () => {
    expect(t(S.STOPPING, E.STOPPED).state).toBe(S.IDLE);
  });

  it('STOPPED clears errorMessage', () => {
    const ctx = { mode: 'ofdm', errorMessage: 'stale' };
    const r = transition(S.STOPPING, { type: E.STOPPED }, ctx);
    expect(r.context.errorMessage).toBeNull();
  });

  it('unknown event is a no-op', () => {
    expect(t(S.STOPPING, E.START).state).toBe(S.STOPPING);
  });
});

describe('FSM — error', () => {
  it('START → requesting-mic (retry)', () => {
    expect(t(S.ERROR, E.START).state).toBe(S.REQUESTING_MIC);
  });

  it('START clears errorMessage', () => {
    const ctx = { mode: 'bell202', errorMessage: 'bad' };
    const r = transition(S.ERROR, { type: E.START }, ctx);
    expect(r.context.errorMessage).toBeNull();
  });

  it('unknown event is a no-op', () => {
    expect(t(S.ERROR, E.STOP).state).toBe(S.ERROR);
  });
});

describe('isAudioActive', () => {
  it('true for active states', () => {
    for (const s of [S.REQUESTING_MIC, S.INITIALIZING, S.RUNNING, S.TX, S.STOPPING])
      expect(isAudioActive(s)).toBe(true);
  });

  it('false for inactive states', () => {
    for (const s of [S.IDLE, S.MIC_DENIED, S.ERROR])
      expect(isAudioActive(s)).toBe(false);
  });
});

describe('FSM — full happy path', () => {
  it('idle → running via events', () => {
    let { state, context } = { state: S.IDLE, context: CTX };
    ({ state, context } = transition(state, { type: E.START },          context));
    expect(state).toBe(S.REQUESTING_MIC);
    ({ state, context } = transition(state, { type: E.MIC_GRANTED },    context));
    expect(state).toBe(S.INITIALIZING);
    ({ state, context } = transition(state, { type: E.HARDWARE_READY }, context));
    expect(state).toBe(S.RUNNING);
    ({ state, context } = transition(state, { type: E.STOP },           context));
    expect(state).toBe(S.STOPPING);
    ({ state, context } = transition(state, { type: E.STOPPED },        context));
    expect(state).toBe(S.IDLE);
  });
});
