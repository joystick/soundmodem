import { test, expect } from '@playwright/test';

test.describe('Phase 4 — OFDM AudioWorklet integration', () => {

  test.beforeEach(async ({ page }) => {
    const errors = [];
    // Filter CDN SRI failures — not our code's errors
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('cdn.jsdelivr.net'))
        errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/dist/index.html');
    // Attach errors array for later inspection
    page._collectedErrors = errors;
  });

  // ── UI presence ────────────────────────────────────────────────────────────

  test('modem mode selector is visible with Bell202 and OFDM-HF options', async ({ page }) => {
    const sel = page.locator('[data-testid="modem-mode-select"]');
    await expect(sel).toBeVisible();
    await expect(sel.locator('option[value="bell202"]')).toHaveCount(1);
    await expect(sel.locator('option[value="ofdm"]')).toHaveCount(1);
  });

  test('modem mode selector defaults to Bell 202', async ({ page }) => {
    await expect(page.locator('[data-testid="modem-mode-select"]')).toHaveValue('bell202');
  });

  // ── Window globals ─────────────────────────────────────────────────────────

  test('window.ofdmEncodeFrame is exposed', async ({ page }) => {
    const type = await page.evaluate(() => typeof window.ofdmEncodeFrame);
    expect(type).toBe('function');
  });

  test('window.createOfdmDemodulator is exposed', async ({ page }) => {
    const type = await page.evaluate(() => typeof window.createOfdmDemodulator);
    expect(type).toBe('function');
  });

  // ── Synthetic OFDM loopback (no audio hardware) ────────────────────────────

  test('ofdmEncodeFrame → createOfdmDemodulator loopback recovers message', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const audio = window.ofdmEncodeFrame('hello playwright');
      return new Promise(resolve => {
        const demod = window.createOfdmDemodulator({
          onMessage: text => resolve(text),
          onFilePacket: () => {},
        });
        demod.processChunk(audio);
        // Timeout fallback
        setTimeout(() => resolve(null), 3000);
      });
    });
    expect(result).toBe('hello playwright');
  });

  test('ofdmEncodeFrame produces a Float32Array', async ({ page }) => {
    const info = await page.evaluate(() => {
      const audio = window.ofdmEncodeFrame('test');
      return { type: audio.constructor.name, length: audio.length };
    });
    expect(info.type).toBe('Float32Array');
    expect(info.length).toBeGreaterThan(0);
  });

  // ── OFDM mode toggle wires correctly ──────────────────────────────────────

  test('switching to OFDM mode updates the selector value', async ({ page }) => {
    await page.evaluate(() => window.setModemMode('ofdm'));
    await expect(page.locator('[data-testid="modem-mode-select"]')).toHaveValue('ofdm');
  });

  test('switching back to Bell202 restores the selector value', async ({ page }) => {
    await page.evaluate(() => { window.setModemMode('ofdm'); window.setModemMode('bell202'); });
    await expect(page.locator('[data-testid="modem-mode-select"]')).toHaveValue('bell202');
  });

  // ── AudioWorklet init (fake mic, no real hardware needed) ─────────────────

  test('OFDM mode: Start Audio initialises AudioWorklet without console errors', async ({ page }) => {
    // Set callsign and switch to OFDM before starting
    await page.fill('[data-testid="callsign-input"]', 'TEST01');
    await page.selectOption('[data-testid="modem-mode-select"]', 'ofdm');
    await page.click('[data-testid="toggle-btn"]');

    // Wait for status to leave Stopped
    await expect(page.locator('[data-testid="status"]')).not.toHaveText('Stopped', { timeout: 5000 });

    // demod-mode label should say OFDM-CPU
    await expect(page.locator('[data-testid="demod-mode"]')).toHaveText('OFDM-CPU');

    // No JS errors
    expect(page._collectedErrors).toHaveLength(0);

    // Clean up
    await page.click('[data-testid="toggle-btn"]');
  });

  test('Bell202 mode: Start Audio still works after mode switch back', async ({ page }) => {
    await page.fill('[data-testid="callsign-input"]', 'TEST01');
    await page.selectOption('[data-testid="modem-mode-select"]', 'bell202');
    await page.click('[data-testid="toggle-btn"]');

    await expect(page.locator('[data-testid="status"]')).not.toHaveText('Stopped', { timeout: 5000 });
    // demod-mode shows GPU or CPU Goertzel label (set by initWebGpu), not OFDM-CPU
    await expect(page.locator('[data-testid="demod-mode"]')).not.toHaveText('OFDM-CPU');
    expect(page._collectedErrors).toHaveLength(0);

    await page.click('[data-testid="toggle-btn"]');
  });

});
