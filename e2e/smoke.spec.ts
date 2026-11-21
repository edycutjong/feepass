import { expect, test } from '@playwright/test';

const pageErrors = (page: import('@playwright/test').Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};

test('front page renders the pitch and meta tags without script errors', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/FeePass/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('The lane');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /og-image\.png/);
  expect(errors).toEqual([]);
});

test('pool page renders its board', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('/pool');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The pool');
  expect(errors).toEqual([]);
});

test('pitch deck and wallet gate are served', async ({ page }) => {
  await page.goto('/deck/');
  await expect(page).toHaveTitle(/pitch deck/);
  await page.goto('/gate.html');
  await expect(page).toHaveTitle(/wallet compatibility check/);
});

test('BLAZE eligibility banner at the top of the home page: Widget Factory slides, repo, EMBER2026 address', async ({ page }) => {
  await page.goto('/');
  const banner = page.getByTestId('blaze-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('blaze-slides')).toHaveAttribute('href', /^https:\/\/docs\.google\.com\/presentation\/d\/1cqIM2GuEVrLRrAz3gNQu9_Uvzr4C1IgKN67-z_rSNao\//);
  await expect(page.getByTestId('blaze-repo')).toHaveAttribute('href', /^https:\/\/github\.com\/edycutjong\/feepass$/);
  await expect(page.getByTestId('blaze-ember')).toHaveText(/^bitcoincash:z[0-9a-z]{41}$/);
  const top = await banner.boundingBox();
  expect(top?.y).toBeLessThan(5); // it is the first thing on the page
});
