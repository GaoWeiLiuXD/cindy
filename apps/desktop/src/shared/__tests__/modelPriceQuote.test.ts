import { describe, expect, it } from 'vitest';

import type { ModelAccessGatewayModel } from '../modelAccess.js';
import {
  gatewayPricingCatalog,
  resolveGatewayCatalogCurrency,
} from '../modelPriceQuote.js';

function model(
  id: string,
  overrides: Partial<ModelAccessGatewayModel> = {},
): ModelAccessGatewayModel {
  return {
    id,
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000008,
    ...overrides,
  };
}

describe('resolveGatewayCatalogCurrency', () => {
  it('defaults to gateway-native USD when nothing is declared', () => {
    expect(resolveGatewayCatalogCurrency([model('a'), model('b')])).toBe('USD');
    expect(resolveGatewayCatalogCurrency([])).toBe('USD');
  });

  it('applies a uniform declared currency to the whole catalog', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('b', { currency: 'CNY' }),
        model('c'),
      ]),
    ).toBe('CNY');
  });

  it('treats mixed declarations as undeclared — local ledgers are single-currency', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('b', { currency: 'USD' }),
      ]),
    ).toBe('USD');
  });

  it('ignores invalid declaration values', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'EUR' as unknown as 'USD' }),
      ]),
    ).toBe('USD');
  });
});

describe('gatewayPricingCatalog currency', () => {
  it('never emits mixed-currency quotes even when entries declare per-model', () => {
    const catalog = gatewayPricingCatalog([
      model('a', { currency: 'CNY' }),
      model('b', { currency: 'USD' }),
      model('c'),
    ]);
    expect(Object.values(catalog.xd).map((quote) => quote.currency)).toEqual([
      'USD',
      'USD',
      'USD',
    ]);
  });

  it('labels every quote with the uniform declared currency', () => {
    const catalog = gatewayPricingCatalog([
      model('a', { currency: 'CNY' }),
      model('b'),
    ]);
    expect(Object.values(catalog.xd).map((quote) => quote.currency)).toEqual([
      'CNY',
      'CNY',
    ]);
  });
});
