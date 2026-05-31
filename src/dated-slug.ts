const DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}-/;

export function slugifyBase(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (slug.length === 0) {
    throw new Error("Slug base must contain at least one alphanumeric character.");
  }
  return slug;
}

export function datePrefixSlug(base: string, timestamp = new Date().toISOString()): string {
  const slug = slugifyBase(base);
  if (DATE_PREFIX_PATTERN.test(slug)) return slug;
  return `${timestamp.slice(0, 10)}-${slug}`;
}
