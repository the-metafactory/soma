const SOMA_POLICY_PATH_CONTINUATION_PATTERN = /[A-Za-z0-9._~%:@+-]/;

export function hasSomaPolicyPrivateMarker(content: string | undefined, marker: string): boolean {
  if (!content) return false;

  let index = content.indexOf(marker);
  while (index !== -1) {
    const next = content[index + marker.length];
    if (index + marker.length >= content.length || next === "/" || !SOMA_POLICY_PATH_CONTINUATION_PATTERN.test(next)) {
      return true;
    }
    index = content.indexOf(marker, index + marker.length);
  }

  return false;
}
