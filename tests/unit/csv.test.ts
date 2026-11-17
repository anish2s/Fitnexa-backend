import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/lib/csv.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside quotes', () => {
    expect(parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
    ]);
  });
  it('accepts CRLF, strips the Excel BOM, drops blank lines, keeps empty cells', () => {
    expect(parseCsv('﻿name,phone\r\n\r\nAsha,,\r\n,,\r\n')).toEqual([
      ['name', 'phone'],
      ['Asha', '', ''],
    ]);
  });
  it('last line without a newline still counts', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']]);
  });
});
