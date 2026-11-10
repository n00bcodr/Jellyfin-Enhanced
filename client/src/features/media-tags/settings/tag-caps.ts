/** The most tags a group's "Show up to" stepper offers before "All". */
export const MAX_CAP = 10;

/** A group's cap rule: `capAll` groups may show every tag ("All" = 0), `capFixed` groups always show one. */
export interface CapPolicy { capFixed?: boolean; capAll?: boolean }

/**
 * The next cap a stepper press gives: 1..10, with "All" (0) above 10 for
 * groups that allow it; null when the press does nothing.
 */
export function stepCap(cap: number, dir: number, meta: CapPolicy): number | null {
    if (meta.capFixed) return null;
    if (dir < 0) {
        if (cap === 0) return MAX_CAP;
        return cap > 1 ? cap - 1 : null;
    }
    if (cap === 0) return null;
    if (cap < MAX_CAP) return cap + 1;
    return meta.capAll ? 0 : null;
}

/** A stored cap clamped to what a group may hold (0 = all). */
export const clampCap = (cap: number): number => Math.max(0, Math.min(MAX_CAP, cap));
