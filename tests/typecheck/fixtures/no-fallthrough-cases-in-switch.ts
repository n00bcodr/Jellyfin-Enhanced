// noFallthroughCasesInSwitch: a case with statements must not fall through.
export function pick(n: number): number {
  let r = 0;
  switch (n) {
    case 1:
      r = 1;
    case 2:
      r = 2;
      break;
  }
  return r;
}
