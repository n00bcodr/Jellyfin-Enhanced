// Real v12 state responses always contain these five collections/preferences members.
// Tests vary their contents explicitly; malformed-envelope tests bypass this fixture.
export const spoilerState = (overrides = {}) => ({Series:{}, Movies:{}, Collections:{}, PendingTmdb:{}, Prefs:{}, ...overrides});
