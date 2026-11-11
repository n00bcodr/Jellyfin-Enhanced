// strict mode (alwaysStrict, every file a module): static is a reserved word.
export function reserved(): number { const static = 1; return static; }
