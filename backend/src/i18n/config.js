export const LOCALES = ['pt-BR', 'en', 'es', 'it', 'de', 'fr', 'ja', 'zh-CN', 'zh-TW', 'ko', 'ru', 'ar', 'hi'];

export const DEFAULT_LOCALE = 'pt-BR';

/** English is the dictionary the other locales are checked against. */
export const FALLBACK_LOCALE = 'en';

/** Tags written in Traditional script: the explicit subtag, plus its regions. */
const TRADITIONAL_CHINESE = /(^|-)(hant|tw|hk|mo)(-|$)/;

/**
 * Resolves an arbitrary BCP-47 tag to a supported locale.
 * `pt`, `pt-PT` and `pt-BR` all resolve to `pt-BR`; `es-419` resolves to `es`;
 * `zh-TW`, `zh-HK`, `zh-MO` and `zh-Hant` resolve to `zh-TW`, every other `zh`
 * tag to `zh-CN`.
 */
export function resolveLocale(tag) {
  if (!tag) return null;
  const normalized = String(tag).trim().toLowerCase();
  if (!normalized) return null;
  const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized);
  if (exact) return exact;
  const [base] = normalized.split('-');
  if (base === 'pt') return 'pt-BR';
  if (base === 'en') return 'en';
  if (base === 'es') return 'es';
  if (base === 'it') return 'it';
  if (base === 'de') return 'de';
  if (base === 'fr') return 'fr';
  if (base === 'ja') return 'ja';
  if (base === 'ko') return 'ko';
  if (base === 'ru') return 'ru';
  if (base === 'ar') return 'ar';
  if (base === 'hi') return 'hi';
  // Traditional-script markers pick zh-TW; every other zh tag gets Simplified.
  if (base === 'zh') return TRADITIONAL_CHINESE.test(normalized) ? 'zh-TW' : 'zh-CN';
  return null;
}

/** Parses an `Accept-Language` header into tags ordered by descending quality. */
export function parseAcceptLanguage(header) {
  return String(header || '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qualityParam = params
        .map((param) => param.trim())
        .find((param) => param.startsWith('q='));
      const quality = qualityParam ? Number.parseFloat(qualityParam.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag && entry.quality > 0)
    .sort((left, right) => right.quality - left.quality)
    .map((entry) => entry.tag);
}

/** Picks the best supported locale for an `Accept-Language` header. */
export function negotiateLocale(header) {
  for (const tag of parseAcceptLanguage(header)) {
    if (tag === '*') break;
    const resolved = resolveLocale(tag);
    if (resolved) return resolved;
  }
  return DEFAULT_LOCALE;
}
