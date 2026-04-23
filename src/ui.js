// ── UI helpers ────────────────────────────────────────────────────────────

export function addChat(chatEl, text, cls) {
  const div = document.createElement('div');
  div.className = `chat-line ${cls}`;
  div.dataset.testid = `chat-entry-${cls}`;
  div.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

export async function populateMicList(selEl) {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audioinput')
      .forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId; opt.textContent = d.label || d.deviceId;
        if (d.label.toLowerCase().includes('webcam') || d.label.toLowerCase().includes('general'))
          opt.selected = true;
        selEl.appendChild(opt);
      });
  } catch { /* no permission yet */ }
}

/** Update the status badge and toggle button to reflect running/stopped/error state. */
export function setAudioState(state /* 'running' | 'stopped' | 'error' */) {
  const statusEl = document.getElementById('status');
  const toggleBtn = document.getElementById('toggleBtn');
  if (!statusEl || !toggleBtn) return;

  const cfg = {
    running: { label: 'Running',  badgeCls: 'bg-success text-light', btnTxt: '⏹ Stop Audio',  btnCls: 'btn-outline-danger' },
    stopped: { label: 'Stopped',  badgeCls: 'bg-warning text-dark',  btnTxt: '▶ Start Audio', btnCls: 'btn-outline-success' },
    error:   { label: 'Error',    badgeCls: 'bg-danger  text-light', btnTxt: '▶ Start Audio', btnCls: 'btn-outline-success' },
  }[state] ?? { label: state, badgeCls: 'bg-secondary text-light', btnTxt: '▶ Start Audio', btnCls: 'btn-outline-success' };

  statusEl.textContent = cfg.label;
  statusEl.className   = `badge rounded-pill ${cfg.badgeCls}`;
  toggleBtn.textContent = cfg.btnTxt;
  toggleBtn.className   = `btn btn-sm ${cfg.btnCls}`;
}
