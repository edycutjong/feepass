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
