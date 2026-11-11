// strict -> strictBindCallApply: call() checks its arguments.
function twice(n: number): number { return n * 2; }
export const result = twice.call(undefined, 'two');
