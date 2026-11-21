import { expect, test } from '@playwright/test';

// The core journey starts with "connect a wallet" over WizardConnect. Without a wallet the app must offer the connect
// action and must never claim a send happened.
test('core flow entry: a connect action is offered and no receipt is shown before signing', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /connect/i }).first()).toBeVisible();
  await expect(page.getByText(/txid/i)).toHaveCount(0);
});

test('footer links to the source, covenant and release', async ({ page }) => {
  await page.goto('/');
  const footer = page.locator('footer');
  await expect(footer.getByRole('link', { name: 'Source' })).toHaveAttribute('href', /^https:\/\/github\.com\/edycutjong\/feepass$/);
  await expect(footer.getByRole('link', { name: 'Covenant' })).toHaveAttribute('href', /^https:\/\/github\.com\/edycutjong\/feepass\/blob\/main\/contracts\/FeePassPool\.cash$/);
  await expect(footer.getByRole('link', { name: /release/i })).toHaveAttribute('href', /^https:\/\/github\.com\/edycutjong\/feepass\/releases\/tag\/v\d+\.\d+\.\d+$/);
});
