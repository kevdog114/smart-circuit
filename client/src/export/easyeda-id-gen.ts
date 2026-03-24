// ============================================================
// EasyEDA ID Generator
// EasyEDA requires IDs in the format `gge<number>` (e.g., gge1, gge42).
// ============================================================

export interface IdGenerator {
  (): string;
  reset(): void;
}

/**
 * Creates a monotonic ID generator that produces `gge1`, `gge2`, etc.
 */
export function createIdGenerator(): IdGenerator {
  let counter = 0;

  const generator = (() => `gge${++counter}`) as IdGenerator;

  generator.reset = () => {
    counter = 0;
  };

  return generator;
}
