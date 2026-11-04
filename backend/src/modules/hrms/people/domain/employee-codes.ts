/**
 * The next employee code for a department prefix: the highest number already used after that prefix, plus one,
 * written with at least 3 digits (ATS001, ATS002 … ATS1000). Codes typed by hand (imports) count too, so a generated
 * code never collides with them. Other prefixes are ignored, even when one starts like another (ATH vs ATHR).
 */
export function nextEmployeeCode(prefix: string, existingCodes: string[]): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const highest = existingCodes.reduce((max, code) => {
    const m = pattern.exec(code);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}
