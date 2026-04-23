import { test, expect } from '@playwright/test';

test.describe('Phase 6 — OFDM Eb/N₀ + pilot phase stats', () => {

  test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('cdn.jsdelivr.net'))
        errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/dist/index.html');
    // Clear localStorage so Phase 7 test leftovers don't affect mode or callsign
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    page._errors = errors;
  });

  // ── Element presence ───────────────────────────────────────────────────────

  test('ofdm-snr badge is present in the DOM', async ({ page }) => {
    await expect(page.locator('[data-testid="ofdm-snr"]')).toHaveCount(1);
  });

  test('ofdm-phase-err badge is present in the DOM', async ({ page }) => {
    await expect(page.locator('[data-testid="ofdm-phase-err"]')).toHaveCount(1);
  });

  test('stat badges are hidden in Bell202 mode', async ({ page }) => {
    await expect(page.locator('[data-testid="ofdm-snr"]')).toBeHidden();
    await expect(page.locator('[data-testid="ofdm-phase-err"]')).toBeHidden();
  });

  // ── Stats appear after OFDM loopback ──────────────────────────────────────

  test('stat badges appear and show numeric values after OFDM frame is processed', async ({ page }) => {
    await page.fill('[data-testid="callsign-input"]', 'TEST01');
    await page.selectOption('[data-testid="modem-mode-select"]', 'ofdm');
    await page.click('[data-testid="toggle-btn"]');
    await expect(page.locator('[data-testid="demod-mode"]')).toHaveText(/^OFDM/, { timeout: 5000 });

    // Inject a loopback frame into the running demodulator
    await page.evaluate(async () => {
      const audio = window.ofdmEncodeFrame('stats test');
      window.ofdmProcessChunk(audio);
    });

    // Both badges should become visible with numeric content
    await expect(page.locator('[data-testid="ofdm-snr"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="ofdm-phase-err"]')).toBeVisible({ timeout: 3000 });

    const snrText = await page.locator('[data-testid="ofdm-snr"]').textContent();
    const phaseText = await page.locator('[data-testid="ofdm-phase-err"]').textContent();

    expect(snrText).toMatch(/\d/);   // contains a digit
    expect(phaseText).toMatch(/\d/); // contains a digit

    await page.click('[data-testid="toggle-btn"]');
    expect(page._errors).toHaveLength(0);
  });

  // ── Stats hidden after stop ────────────────────────────────────────────────

  test('stat badges are hidden again after audio stops', async ({ page }) => {
    await page.fill('[data-testid="callsign-input"]', 'TEST01');
    await page.selectOption('[data-testid="modem-mode-select"]', 'ofdm');
    await page.click('[data-testid="toggle-btn"]');
    await expect(page.locator('[data-testid="demod-mode"]')).toHaveText(/^OFDM/, { timeout: 5000 });
    await page.click('[data-testid="toggle-btn"]');
    await expect(page.locator('[data-testid="status"]')).toHaveText('Stopped', { timeout: 3000 });

    await expect(page.locator('[data-testid="ofdm-snr"]')).toBeHidden();
    await expect(page.locator('[data-testid="ofdm-phase-err"]')).toBeHidden();
  });

});
