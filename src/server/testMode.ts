/**
 * The one test switch (07 B10): test hooks, /api/test/* and every VESPER_* variable exist only when the build constant
 * `__VESPER_TEST__` is true AND the process runs with VESPER_TEST=1. The release build compiles this to `false`, so
 * everything guarded by it is dead code there.
 */
export function isTestMode(): boolean {
  return __VESPER_TEST__ && process.env.VESPER_TEST === '1'
}

/** A VESPER_* switch, or undefined outside test mode. */
export function testEnv(name: `VESPER_${string}`): string | undefined {
  if (!(__VESPER_TEST__ && process.env.VESPER_TEST === '1')) return undefined
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}
