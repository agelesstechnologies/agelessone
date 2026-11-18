/**
 * The next item code for a category prefix: the highest number already used after "PREFIX-", plus one, written with at
 * least 4 digits (EC-0001, EC-0002 … EC-10000). Codes typed by hand (imports) count too, so a made code never collides
 * with them. Other prefixes are ignored, even when one starts like another (EC vs ECX).
 */
export function nextItemCode(prefix: string, existingCodes: Iterable<string>): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const code of existingCodes) {
    const m = pattern.exec(code);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(4, '0')}`;
}
