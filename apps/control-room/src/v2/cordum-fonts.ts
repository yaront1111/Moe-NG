/**
 * Self-hosted Cordum typefaces, imported for their side effect only.
 *
 * Each `@fontsource` weight ships its own `@font-face` rule plus a woff2 file;
 * Vite bundles both, and the daemon serves them from its OWN origin, so the faces
 * load under the static host's `default-src 'self'` CSP with no external request
 * and no CSP relaxation. This replaces the build-time Google Fonts `<link>`, which
 * that CSP blocked (the page then fell back to system fonts and logged a CSP
 * violation on every load). The weights below match the token stacks in
 * `styles/cordum-tokens.css`: display (Space Grotesk 400-700), body (IBM Plex Sans
 * 400-700), utility (IBM Plex Mono 400-600).
 */
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
