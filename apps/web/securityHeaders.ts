/**
 * The security headers on every response of the app's origin (PLAN.md §20.26). In production a
 * CloudFront Function adds them to the viewer response (`infra/alchemy.run.ts`); `vite preview`
 * sends them too (`vite.config.ts`), so the browser tests run the production bundle under the same
 * policy and fail on any violation. `pnpm dev` doesn't: React's dev runtime needs inline scripts.
 */

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  // The inbox message frame (`MessageSheet`) is a `srcdoc` document, and those inherit this
  // policy: its own `<style>` and the sanitized mail's `style` attributes are inline styles.
  // Scripts stay `'self'` only, and the frame adds its own stricter policy on top.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // The OAuth consent page must not be framed (clickjacking, PLAN.md §20.24).
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders = {
  "content-security-policy": contentSecurityPolicy,
  // Two years, the preload list's minimum; users' subdomains on the shared domain serve no web.
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // `frame-ancestors` for browsers that predate it.
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
} as const;
