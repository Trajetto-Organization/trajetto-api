/**
 * The wall time of the driver's login refusals by CPF (SEC-4).
 *
 * A CPF may name logins in several companies, and the password is compared
 * with each, one bcrypt apiece: an unknown CPF cost one comparison, a CPF
 * with logins in three carriers three. With the same 401, the clock still
 * told an anonymous caller in how many carriers a CPF signs in — personal
 * data, against the promise that a CPF alone says nothing.
 *
 * Doing the missing comparisons would cost CPU on every anonymous guess (up
 * to ten bcrypts, through a gate of two) and turn the login into a lever for
 * a denial of service. So a refusal SLEEPS instead: as long as the
 * comparisons it skipped would have taken at this request's own pace, so
 * every refusal lasts `target` comparisons. Only refusals wait: a success is
 * reached only with the password.
 *
 * The clock is an object, not two functions, so a test can drive it.
 */
const refusalClock = {
  now: (): number => performance.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * Pure: how long a refusal that compared `done` passwords in `elapsedMs`
 * waits so that it lasts as long as `target` comparisons. Nothing without a
 * measured comparison, nothing once the target was reached.
 */
function refusalPaddingMs(
  elapsedMs: number,
  done: number,
  target: number,
): number {
  if (done <= 0 || done >= target || elapsedMs <= 0) return 0;

  return (elapsedMs / done) * (target - done);
}

export { refusalClock, refusalPaddingMs };
