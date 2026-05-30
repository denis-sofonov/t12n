/**
 * Generate the social/OG card → public/og.png (1200×630).
 *
 *   node scripts/make-og.mjs
 *
 * Regenerate when the branding changes. Uses sharp to rasterise the SVG so the
 * result renders on Twitter / Facebook / Slack (which don't support SVG OG).
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og.png')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#ffffff"/>

  <!-- mark: ink braces + orange swipe -->
  <g transform="translate(80,72) scale(2.1)">
    <path d="M7 19 L25 13" fill="none" stroke="#ff5a1f" stroke-width="7" stroke-linecap="round"/>
    <g fill="none" stroke="#0e0e10" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13.5 5.5 C11 5.5 11 8 11 10.5 C11 12.8 9.5 15 7.5 16 C9.5 17 11 19.2 11 21.5 C11 24 11 26.5 13.5 26.5"/>
      <path d="M18.5 5.5 C21 5.5 21 8 21 10.5 C21 12.8 22.5 15 24.5 16 C22.5 17 21 19.2 21 21.5 C21 24 21 26.5 18.5 26.5"/>
    </g>
  </g>
  <text x="156" y="116" font-family="Menlo, monospace" font-size="40" font-weight="600" fill="#0e0e10" letter-spacing="-2">t12n</text>

  <!-- headline — first line in a solid orange marker block -->
  <rect x="76" y="244" width="628" height="72" rx="8" fill="#ff5a1f"/>
  <text x="92" y="299" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="74" font-weight="700" fill="#ffffff" letter-spacing="-3">Runtime checks,</text>
  <text x="80" y="392" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="74" font-weight="700" fill="#0e0e10" letter-spacing="-3">straight from your types.</text>

  <!-- subline -->
  <text x="82" y="472" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="30" fill="#5a5a5e">TypeScript types, validated at the boundary — no schemas to write.</text>

  <!-- stats -->
  <text x="82" y="552" font-family="Menlo, monospace" font-size="26" fill="#ff5a1f" letter-spacing="0.5">~8× faster than Zod   ·   ~3 KB   ·   zero runtime deps</text>
</svg>`

await sharp(Buffer.from(svg)).png().toFile(out)
console.log('wrote', out)
