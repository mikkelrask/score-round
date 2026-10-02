import { test, expect } from '@playwright/test';
import { freshState } from '../data.js';

const exportBout = {
  id: 'sample-export', red: { name: 'Pili' }, blue: { name: 'Katie Taylor' }, weightClass: '',
  roundsTotal: 10, roundLen: 120, rounds: [{ winner: 'blue', kd: { red: 0, blue: 0 }, ded: { red: 0, blue: 0 } }],
  status: 'done', result: { type: 'UD', winner: 'blue', round: null, note: '' },
  date: '2026-09-05T21:10:17.761Z', startedAt: '2026-09-05T21:10:17.763Z', endedAt: '2026-09-08T21:39:45.277Z', draft: null,
};
test.beforeEach(async ({ request }) => {
  const { user } = await (await request.get('/api/me')).json();
  const headers = { 'X-Scorecard-User': user.id };
  const current = await (await request.get('/api/state', { headers })).json();
  const response = await request.put('/api/state', { headers: { ...headers, Origin: 'http://localhost:8788' }, data: { revision: current.revision, state: freshState() } });
  expect(response.ok()).toBeTruthy();
});

test('legacy browser import, repeat import, and a fresh browser recover the same cloud history', async ({ page, browser }) => {
  const legacy = { ...freshState(), history: [exportBout] };
  await page.addInitScript((state) => localStorage.setItem('boxing-scorecard.v1', JSON.stringify(state)), legacy);
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.getByRole('button', { name: 'Import old browser data' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await expect(page.getByText('Pili', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Import old browser data' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.history.length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('boxing-scorecard.v1')).history.length)).toBe(1);
  const other = await browser.newContext(); const fresh = await other.newPage();
  await fresh.goto('http://localhost:8788/');
  await expect(fresh.getByText('Pili', { exact: false }).first()).toBeVisible();
  await other.close();
});

test('JSON import preserves existing fields and duplicates do not create another scorecard', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  const file = { name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ exportedAt: '2026-10-02', bouts: [exportBout] })) };
  await page.locator('#history-file').setInputFiles(file);
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.locator('#history-file').setInputFiles(file);
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.history)).toEqual([exportBout]);
});

test('score an active fight offline, reconnect, and recover the draft after a reload', async ({ page, context }) => {
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.locator('[data-model="redName"]').fill('Red test');
  await page.locator('[data-model="blueName"]').fill('Blue test');
  await page.getByRole('button', { name: 'Start the bout' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await context.setOffline(true);
  await page.locator('[data-action="set-winner"][data-side="red"]').click();
  await expect(page.locator('#sync-status')).toHaveText('Cloud unavailable — changes saved on device');
  await context.setOffline(false);
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.reload(); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.draft().winner)).toBe('red');
  await page.getByRole('button', { name: 'End bout', exact: true }).click();
  await page.getByRole('button', { name: 'Record result' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.history.length)).toBe(1);
});

test('two open devices prompt for a conflict instead of overwriting a scorecard', async ({ page, browser }) => {
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  const other = await browser.newContext(); const second = await other.newPage();
  await second.goto('http://localhost:8788/'); await expect(second.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.locator('[data-model="rounds"]').selectOption('12');
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await second.locator('[data-model="rounds"]').selectOption('4');
  await expect(second.locator('#sync-status')).toHaveText('Changed on another device — review saves');
  await second.locator('#sync-status').click();
  await expect(second.getByText('Two devices have different saves')).toBeVisible();
  expect(await second.evaluate(() => window.__scorecard.state.prefs.rounds)).toBe(4);
  second.on('dialog', (dialog) => dialog.accept());
  await second.getByRole('button', { name: 'Use cloud copy' }).click();
  expect(await second.evaluate(() => window.__scorecard.state.prefs.rounds)).toBe(12);
  await other.close();
});
