import fs from 'node:fs';
import { expect, it } from 'vitest';

it('backfill лотов использует ows только как резерв', () => {
  expect(fs.readFileSync('scripts/bitrix-backfill-gz-lot-dates.mts', 'utf8'))
    .not.toMatch(/if\s*\(![\w.]*token\)\s*throw new Error\("GOSZAKUP_TOKEN is required"\)/);
});
it('выгрузка лотов запрашивает сроки и без токена', () => {
  const source = fs.readFileSync('scripts/bitrix-push-gz-lots.mts', 'utf8');
  expect(source.slice(source.indexOf('async function lookupBidWindow'))).not.toContain('if (!token) return null');
});
