// strict -> strictBuiltinIteratorReturn: a finished array iterator's value is undefined.
export function first(): number {
  const step = [1].values().next();
  if (step.done) { const n: number = step.value; return n; }
  return 0;
}
