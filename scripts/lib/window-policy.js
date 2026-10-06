'use strict';

/**
 * lib/window-policy.js — navigation policy for the Electron window.
 *
 * Extracted from `main.js` so the security-relevant behaviour is unit-testable
 * without launching Electron. The window displays a local web app; any
 * navigation that is not that app must be refused and, when it is an ordinary
 * web link, handed to the system browser instead.
 */

/** Normalizes a URL to its bare origin, or null when it is not a valid URL. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return null;
  }
}

/**
 * True only for the app's own frontend origin.
 *
 * An origin comparison is required rather than a prefix check. The string
 * `http://127.0.0.1:8502@evil.example/` begins with the frontend URL but
 * actually navigates to `evil.example`, so a prefix check would load an
 * attacker-controlled page inside the app window — where it would render
 * alongside the user's own notebook.
 */
function isFrontendUrl(url, frontendUrl) {
  const expected = originOf(frontendUrl);
  if (!expected) return false;
  return originOf(url) === expected;
}

/**
 * True for a link that belongs in the system browser.
 *
 * Matching is case-insensitive because a URL scheme is case-insensitive:
 * `HTTPS://example.com` is a real web link and must not slip past the check.
 * Non-web schemes such as `javascript:` and `file:` are deliberately excluded.
 */
function isExternalHttpUrl(url) {
  return /^https?:\/\//i.test(String(url));
}

module.exports = { isFrontendUrl, isExternalHttpUrl, originOf };
