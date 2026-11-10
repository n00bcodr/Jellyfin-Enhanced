/** Jellyfin item responses are extensible; validate the fields this facade consumes.
 * Feature consumers remain responsible for validating their own extra projections. */
export function decodeItem(value: unknown): Record<string, unknown> | null {
 if (value === null) return null;
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Jellyfin item response');
 if ('Id' in value && value.Id !== null && typeof value.Id !== 'string') throw new Error('Invalid Jellyfin item Id');
 return Object.fromEntries(Object.entries(value));
}
