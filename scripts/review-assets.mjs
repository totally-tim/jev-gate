import { mkdirSync, writeFileSync } from 'node:fs';

// Public, generic score glyphs: no review results or repository content belong here.
// Keep v1 immutable once published; change the directory for a new visual design.
const root = new URL('../assets/review/v1/', import.meta.url);
for (const [tone, bg, track, accent, ink] of [
  ['amber', '#fff8c5', '#eadfb5', '#bf8700', '#633c01'],
  ['blue', '#ddf4ff', '#bddbed', '#218bff', '#0550ae'],
]) {
  mkdirSync(new URL(`${tone}/`, root), { recursive: true });
  for (let n = 0; n <= 100; n++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44" role="img" aria-label="${n}% model estimate"><circle cx="22" cy="22" r="22" fill="${bg}"/><circle cx="22" cy="22" r="18" fill="none" stroke="${track}" stroke-width="3"/><circle cx="22" cy="22" r="18" fill="none" stroke="${accent}" stroke-width="3" pathLength="100" stroke-dasharray="${n} ${100 - n}" transform="rotate(-90 22 22)"/><text x="22" y="27" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="14" font-weight="600" fill="${ink}">${n}<tspan font-size="8">%</tspan></text></svg>\n`;
    writeFileSync(new URL(`${tone}/${n}.svg`, root), svg);
  }
}
writeFileSync(new URL('match.svg', root), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#fff8c5"/><g fill="none" stroke="#9a6700" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="10" r="3"/><path d="m10.5 12 6.5 6.5m-3-3 2-2m0 4 2-2"/></g></svg>\n');
writeFileSync(new URL('mark.svg', root), '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="#6e56cf"/><path d="M8 8h4v12H8m8-12h4v12h-4M12 14h4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>\n');
