import { readFileSync } from 'node:fs';
export const schema = JSON.parse(readFileSync(new URL('../../../contracts/bootstrap.schema.json', import.meta.url), 'utf8'));
export const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const USER_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const USER_C = 'cccccccccccccccccccccccccccccccc';

// Test-only representative transport construction. Production validation never fills defaults.
function sample(rule, overrides) {
  if (overrides === null) return null;
  if (rule.$ref) return sample(schema.$defs[rule.$ref.split('/').at(-1)], overrides);
  if (rule.anyOf) {
    if (overrides === undefined && rule.anyOf.some(r => r.type === 'null')) return null;
    return sample(rule.anyOf.find(r => r.type !== 'null'), overrides);
  }
  if (rule.type === 'object') {
    if (rule.properties) return { ...Object.fromEntries(Object.entries(rule.properties).map(([key, child]) => [key, sample(child, overrides?.[key])])), ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([key]) => !(key in rule.properties))) };
    return Object.fromEntries(Object.entries(overrides ?? {}).map(([key, child]) => [key, sample(rule.additionalProperties, child)]));
  }
  if (rule.type === 'array') return (overrides ?? []).map(value => sample(rule.items, value));
  if (overrides !== undefined) return overrides;
  return { string: '', integer: 0, number: 0, boolean: false, null: null }[rule.type] ?? null;
}
export const contractValue = (name, overrides) => sample(schema.$defs[name], overrides);
export const bootstrapFixture = (overrides = {}) => contractValue('BootstrapResponse', {
  Version: '1.2.3', UserId: USER_A, ...overrides
});
