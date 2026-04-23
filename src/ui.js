// ── UI helpers ────────────────────────────────────────────────────────────

export function addChat(chatEl, text, cls) {
  const div = document.createElement('div');
  div.className = cls; div.dataset.testid = `chat-entry-${cls}`;
  div.textContent = `${new Date().toLocaleTimeString()}: ${text}`;
  chatEl.appendChild(div); chatEl.scrollTop = chatEl.scrollHeight;
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
