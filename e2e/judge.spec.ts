import { expect, test } from '@playwright/test';

// The judge page must load with no wallet, no session and no API (vite preview serves no function).
test('judge page loads with no credentials and states the claim, the path and a real mainnet receipt', async ({ browser }) => {
  const ctx = await browser.newContext(); // fresh: no cookies, no storage
  const page = await ctx.newPage();
  const res = await page.goto('/judge/');
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/for judges/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('No spendable BCH');
  await expect(page.getByText('exactly 0.01 PUSD', { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId('judge-mainnet-send')).toHaveAttribute('href', /^https:\/\/bchexplorer\.info\/tx\/d59f120b[0-9a-f]{56}$/);
  await expect(page.getByTestId('judge-live')).not.toHaveText(/Reading the pool/); // resolves to live status or the fallback, never hangs
  await ctx.close();
});
