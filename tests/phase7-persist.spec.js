import { test, expect } from '@playwright/test';

test.describe('Phase 7 — localStorage persistence', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/dist/index.html');
    // Start each test with a clean slate
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // ── Callsign ───────────────────────────────────────────────────────────────

  test('callsign is saved to localStorage on input', async ({ page }) => {
    await page.fill('[data-testid="callsign-input"]', 'W1TEST');
    const stored = await page.evaluate(() => localStorage.getItem('callsign'));
    expect(stored).toBe('W1TEST');
  });

  test('callsign is restored from localStorage on page reload', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('callsign', 'VK2ABC'));
    await page.reload();
    await expect(page.locator('[data-testid="callsign-input"]')).toHaveValue('VK2ABC');
  });

  // ── Passphrase ─────────────────────────────────────────────────────────────

  test('passphrase is saved to localStorage on input', async ({ page }) => {
    await page.fill('[data-testid="passphrase-input"]', 'opensesame');
    const stored = await page.evaluate(() => localStorage.getItem('passphrase'));
    expect(stored).toBe('opensesame');
  });

  test('passphrase is restored from localStorage on page reload', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('passphrase', 'mysecret'));
    await page.reload();
    await expect(page.locator('[data-testid="passphrase-input"]')).toHaveValue('mysecret');
  });

  test('clearing passphrase removes it from localStorage', async ({ page }) => {
    await page.fill('[data-testid="passphrase-input"]', 'temp');
    await page.fill('[data-testid="passphrase-input"]', '');
    const stored = await page.evaluate(() => localStorage.getItem('passphrase'));
    expect(stored).toBeNull();
  });

  // ── Modem mode ─────────────────────────────────────────────────────────────

  test('modem mode is saved to localStorage when changed', async ({ page }) => {
    await page.selectOption('[data-testid="modem-mode-select"]', 'ofdm');
    const stored = await page.evaluate(() => localStorage.getItem('modemMode'));
    expect(stored).toBe('ofdm');
  });

  test('modem mode is restored from localStorage on page reload', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('modemMode', 'ofdm'));
    await page.reload();
    await expect(page.locator('[data-testid="modem-mode-select"]')).toHaveValue('ofdm');
  });

  test('switching back to bell202 is persisted', async ({ page }) => {
    await page.selectOption('[data-testid="modem-mode-select"]', 'ofdm');
    await page.selectOption('[data-testid="modem-mode-select"]', 'bell202');
    const stored = await page.evaluate(() => localStorage.getItem('modemMode'));
    expect(stored).toBe('bell202');
  });

});
