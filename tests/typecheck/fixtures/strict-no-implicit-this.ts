// strict -> noImplicitThis: this in a plain function has an implicit any type.
export const make = { outer() { return function inner() { return this; }; } };
