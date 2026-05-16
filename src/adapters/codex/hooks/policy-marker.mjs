// Generated from src/policy-marker.ts. Do not edit by hand.
const PATH_CONTINUATION_PATTERN = /[A-Za-z0-9._~%:@+-]/;

/**
 * @param {string | undefined} content
 * @param {string} marker
 * @returns {boolean}
 */
export function hasSomaPolicyPrivateMarker(content, marker) {
  if (!content) return false;

  let index = content.indexOf(marker);
  while (index !== -1) {
    const next = content[index + marker.length];
    if (index + marker.length >= content.length || next === "/" || !PATH_CONTINUATION_PATTERN.test(next)) return true;
    index = content.indexOf(marker, index + marker.length);
  }

  return false;
}
