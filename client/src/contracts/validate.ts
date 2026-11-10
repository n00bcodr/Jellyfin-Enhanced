/** Schema vocabulary emitted by the DTO generator; deliberately fails on unknown schemas. */
export type Schema = boolean | {
  readonly $ref?: string;
  readonly type?: string;
  readonly anyOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: Schema;
  readonly items?: Schema;
};

/** Validate JSON without coercion, stripping fields or supplying defaults. */
export function validateSchema(value: unknown, schema: Schema, definitions: Readonly<Record<string, Schema>>): boolean {
  const ancestors = new Set<object>();
  function json(value: unknown, depth: number): boolean {
    if (depth > 100) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = Array.isArray(value)
      ? value.every(child => json(child, depth + 1))
      : Object.prototype.toString.call(value) === '[object Object]' && Object.values(value).every(child => json(child, depth + 1));
    ancestors.delete(value);
    return valid;
  }
  function matches(value: unknown, rule: Schema, depth: number): boolean {
    if (depth > 100) return false;
    if (typeof rule === 'boolean') return rule;
    if (rule.$ref !== undefined) {
      const prefix = '#/$defs/';
      const target = rule.$ref.startsWith(prefix) ? definitions[rule.$ref.slice(prefix.length)] : undefined;
      return target !== undefined && matches(value, target, depth + 1);
    }
    if (rule.anyOf !== undefined) return rule.anyOf.some(option => matches(value, option, depth + 1));
    switch (rule.type) {
      case 'null': return value === null;
      case 'string': return typeof value === 'string';
      case 'boolean': return typeof value === 'boolean';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'array': return Array.isArray(value) && rule.items !== undefined && value.every(item => matches(item, rule.items!, depth + 1));
      case 'object': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        if (rule.required?.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return false;
        return Object.entries(value).every(([key, child]) => {
          const property = rule.properties && Object.prototype.hasOwnProperty.call(rule.properties, key) ? rule.properties[key] : undefined;
          return matches(child, property ?? rule.additionalProperties ?? true, depth + 1);
        });
      }
      default: return false;
    }
  }
  return json(value, 0) && matches(value, schema, 0);
}
