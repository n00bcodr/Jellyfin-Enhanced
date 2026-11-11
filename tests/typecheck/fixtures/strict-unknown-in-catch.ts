// strict -> useUnknownInCatchVariables: a catch variable is unknown.
export function message(): string {
  try { return ''; } catch (error) { return error.message; }
}
