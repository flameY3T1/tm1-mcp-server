/**
 * TM1 name identity. The server treats `Total Year`, `totalyear` and
 * `TOTAL YEAR` as one object: names are compared without case and without
 * spaces. A client-side lookup against server names has to key on this, not on
 * `toLowerCase()` alone.
 */
export const tm1NameKey = (name: string): string =>
  name.toLowerCase().replace(/ /g, "");

export const tm1NameEquals = (a: string, b: string): boolean =>
  tm1NameKey(a) === tm1NameKey(b);
