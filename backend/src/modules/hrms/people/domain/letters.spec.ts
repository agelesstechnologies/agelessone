import { describe, expect, it } from 'vitest';
import { DEFAULT_JOINING, fillLetter, longDate, unknownFields } from './letters';

const values = {
  name: 'Asha', fullName: 'Asha Rao', employeeCode: 'ATS004', designation: 'Engineer', department: 'Software Development',
  company: 'Ageless Technologies', joiningDate: '1 December 2026', engagementType: 'permanent', manager: null, today: '9 November 2026',
};

describe('letter templates', () => {
  it('fills every field; a field with no value becomes a dash; spaces inside the braces are fine', () => {
    expect(fillLetter('Dear {{ fullName }}, ID {{employeeCode}}, manager {{manager}}.', values)).toBe('Dear Asha Rao, ID ATS004, manager -.');
  });

  it('finds misspelt fields (each once) and leaves them in the text', () => {
    expect(unknownFields('{{nmae}} {{name}} {{nmae}} {{salary}}')).toEqual(['nmae', 'salary']);
    expect(fillLetter('{{nmae}}', values)).toBe('{{nmae}}');
  });

  it('the built-in joining letter uses only known fields', () => {
    expect(unknownFields(DEFAULT_JOINING.body)).toEqual([]);
    expect(fillLetter(DEFAULT_JOINING.body, values)).toContain('Asha Rao');
  });

  it('long dates', () => {
    expect(longDate('2026-11-09')).toBe('9 November 2026');
    expect(longDate('2027-01-31')).toBe('31 January 2027');
  });
});
