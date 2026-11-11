/**
 * A Content-Security-Policy header read the way a browser applies it: each
 * directive (lower-cased, as browsers match them) and the sources it allows.
 * The one reader of the tests that check a page against the policy helmet
 * sends next to it.
 *
 * `script-src 'self' https://x` → { "script-src": ["'self'", "https://x"] }
 */
export function directives(header: string): Record<string, string[]> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);

        return [name.toLowerCase(), values];
      }),
  );
}
