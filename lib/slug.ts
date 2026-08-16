// Short, unambiguous slugs for tracking links (no look-alike characters).
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function randomSlug(n = 6): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return s;
}
