import { DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALES, negotiateLocale, resolveLocale } from './config.js';
import ar from './locales/ar.js';
import de from './locales/de.js';
import hi from './locales/hi.js';
import en from './locales/en.js';
import fr from './locales/fr.js';
import es from './locales/es.js';
import it from './locales/it.js';
import ja from './locales/ja.js';
import ko from './locales/ko.js';
import ptBR from './locales/pt-BR.js';
import ru from './locales/ru.js';
import zhCN from './locales/zh-CN.js';
import zhTW from './locales/zh-TW.js';

export { DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALES, negotiateLocale, resolveLocale };

export const dictionaries = {
  'pt-BR': ptBR,
  en,
  es,
  it,
  de,
  fr,
  ja,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ko,
  ru,
  ar,
  hi
};

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(PLACEHOLDER_PATTERN, (match, name) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Translates `key` into `locale`, falling back to English and finally to the
 * key itself so a missing string is visible instead of an empty message.
 */
export function translate(locale, key, vars) {
  const template = dictionaries[locale]?.[key] ?? dictionaries[FALLBACK_LOCALE][key] ?? key;
  return interpolate(template, vars);
}

/**
 * An error whose message is a translation key, so the layer that has the
 * request locale can render it in the caller's language.
 */
export class TranslatableError extends Error {
  constructor(key, vars = null, options = {}) {
    super(key);
    this.name = 'TranslatableError';
    this.translationKey = key;
    this.translationVars = vars;
    if (options.status) this.status = options.status;
    if (options.code) this.code = options.code;
  }
}

/** Message for an error: translated when it carries a key, raw text otherwise. */
export function translateError(t, error) {
  if (!error) return '';
  if (error.translationKey) return t(error.translationKey, error.translationVars);
  return error.message || '';
}

/** Returns a translator bound to one locale. */
export function translatorFor(locale) {
  const active = resolveLocale(locale) || DEFAULT_LOCALE;
  return (key, vars) => translate(active, key, vars);
}
