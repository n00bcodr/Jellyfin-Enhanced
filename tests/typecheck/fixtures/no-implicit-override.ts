// noImplicitOverride: an overriding member needs override.
class Base { run(): void {} }
export class Derived extends Base {
  run(): void {}
}
