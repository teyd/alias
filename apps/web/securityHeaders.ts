/**
 * The security headers on every response of the app's origin (PLAN.md §20.26). In production a
 * CloudFront Function adds them to the viewer response (`infra/alchemy.run.ts`); `vite preview`
 * sends them too (`vite.config.ts`), so the browser tests run the production bundle under the same
 * policy and fail on any violation. `pnpm dev` doesn't: React's dev runtime needs inline scripts.
 */

/** Where Cloudflare serves the Turnstile widget's script and its challenge frame (§20.27). */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * The headers, with `turnstileOrigin` allowed to run the sign-up widget: Cloudflare's in
 * production, the Turnstile emulator's in the browser tests (the API names the script's URL).
 */
export const securityHeaders = (turnstileOrigin: string = TURNSTILE_ORIGIN) => ({
  "content-security-policy": [
    "default-src 'self'",
    // Turnstile's script is loaded from Cloudflare, and its widget is a frame from there too
    // (Cloudflare's CSP guidance for Turnstile: `script-src` and `frame-src`).
    `script-src 'self' ${turnstileOrigin}`,
    `frame-src ${turnstileOrigin}`,
    // The inbox message frame (`MessageSheet`) is a `srcdoc` document, and those inherit this
    // policy: its own `<style>` and the sanitized mail's `style` attributes are inline styles.
    // Scripts stay limited to the app and Turnstile, and the frame adds its own stricter policy.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // The OAuth consent page must not be framed (clickjacking, PLAN.md §20.24).
    "frame-ancestors 'none'",
  ].join("; "),
  // Two years, the preload list's minimum; users' subdomains on the shared domain serve no web.
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // `frame-ancestors` for browsers that predate it.
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
});
