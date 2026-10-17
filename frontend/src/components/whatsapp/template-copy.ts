/** `wa_templates.name` is 80 characters wide — `NAME_LIMIT` in waTemplateService.js. */
export const TEMPLATE_NAME_LIMIT = 80

const fold = (value: string) => value.trim().toLocaleLowerCase()

/**
 * The name a duplicated template starts with: "Name (copy)", then
 * "Name (copy 2)", "Name (copy 3)"… until one is free.
 *
 * Names are unique on the server, so a duplicate that kept the original name
 * would be refused on save. The base is what gets cut when the result would
 * pass the column width — never the suffix, which is the part that tells the
 * two apart.
 */
export function copyName(name: string, existingNames: string[], suffix: string): string {
  const taken = new Set(existingNames.map(fold))
  const base = name.trim()
  for (let n = 1; ; n += 1) {
    const tag = ` (${suffix}${n > 1 ? ` ${n}` : ''})`
    const candidate = `${base.slice(0, Math.max(TEMPLATE_NAME_LIMIT - tag.length, 1)).trimEnd()}${tag}`
    if (!taken.has(fold(candidate))) return candidate
  }
}
