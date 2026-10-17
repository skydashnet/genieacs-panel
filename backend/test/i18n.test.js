import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, startTestServers, stopTestServers } from './helpers/harness.js';
import { dictionaries, LOCALES, translate } from '../src/i18n/index.js';
import { negotiateLocale, parseAcceptLanguage, resolveLocale } from '../src/i18n/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every dictionary file in a directory, so a new locale is covered by existing. */
function localeFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(extension))
    .map((name) => path.join(directory, name));
}

let panelUrl;
let portalUrl;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('dictionaries', () => {
  it('translates every English key in every other locale', () => {
    const expected = Object.keys(dictionaries.en).sort();
    for (const locale of LOCALES) {
      assert.deepEqual(
        Object.keys(dictionaries[locale]).sort(),
        expected,
        `${locale} does not cover the same keys as en`
      );
    }
  });

  it('declares every key exactly once, in both halves of the app', () => {
    // A duplicated key is invisible to every other check here: the object
    // literal keeps the LAST one, so the file parses, the key set matches and
    // the parity test above passes — while the string an operator reads is not
    // the string anyone last edited. It happened for real, to Traditional
    // Chinese, when two branches added the same twenty keys and the merge kept
    // both copies.
    //
    // Read from the SOURCE, not from the imported object, because by the time
    // it is an object the duplicate is already gone.
    const files = [
      ...localeFiles(path.join(HERE, '..', 'src', 'i18n', 'locales'), '.js'),
      ...localeFiles(path.join(HERE, '..', '..', 'frontend', 'src', 'lib', 'i18n', 'locales'), '.ts')
    ];
    assert.ok(files.length >= 2, 'the locale directories should not be empty');

    for (const file of files) {
      // Every `'key':` anywhere on a line, not just at the start of one. Two of
      // the duplicates that provoked this test were appended to the END of an
      // existing line, which is precisely how they stayed invisible to a reader
      // scanning down the left margin.
      const keys = [...fs.readFileSync(file, 'utf8').matchAll(/'([a-zA-Z0-9_.-]+)':\s*'/g)].map((m) => m[1]);
      const twice = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
      assert.deepEqual(twice, [], `${path.basename(file)} declares ${twice.join(', ')} more than once`);
    }
  });

  it('keeps the placeholders of every English string', () => {
    const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(',');
    for (const [key, template] of Object.entries(dictionaries.en)) {
      for (const locale of LOCALES) {
        assert.equal(
          placeholders(dictionaries[locale][key]),
          placeholders(template),
          `${locale}.${key} does not use the same placeholders as en.${key}`
        );
      }
    }
  });

  it('interpolates variables and falls back to English for a missing key', () => {
    assert.equal(
      translate('pt-BR', 'settings.connectionStatus', { status: 503 }),
      'O servidor GenieACS respondeu com status 503'
    );
    assert.equal(translate('es', 'common.routeNotFound'), 'Ruta no encontrada');
    assert.equal(translate('de', 'common.routeNotFound'), 'Route nicht gefunden');
    assert.equal(translate('fr', 'common.routeNotFound'), 'Route introuvable');
    assert.equal(translate('ja', 'common.routeNotFound'), 'ルートが見つかりません');
    assert.equal(translate('zh-CN', 'common.routeNotFound'), '找不到该路由');
    assert.equal(translate('zh-TW', 'common.routeNotFound'), '找不到該路由');
    assert.equal(translate('ko', 'common.routeNotFound'), '경로를 찾을 수 없습니다');
    assert.equal(translate('ru', 'common.routeNotFound'), 'Маршрут не найден');
    assert.equal(translate('ar', 'common.routeNotFound'), 'المسار غير موجود');
    assert.equal(translate('hi', 'common.routeNotFound'), 'मार्ग नहीं मिला');
    assert.equal(translate('pt-BR', 'nonexistent.key'), 'nonexistent.key');
  });
});

describe('locale negotiation', () => {
  it('resolves regional tags to a supported locale', () => {
    assert.equal(resolveLocale('pt'), 'pt-BR');
    assert.equal(resolveLocale('PT-pt'), 'pt-BR');
    assert.equal(resolveLocale('es-419'), 'es');
    assert.equal(resolveLocale('en-GB'), 'en');
    assert.equal(resolveLocale('it-CH'), 'it');
    assert.equal(resolveLocale('de-AT'), 'de');
    assert.equal(resolveLocale('fr-CA'), 'fr');
    assert.equal(resolveLocale('ja-JP'), 'ja');
    assert.equal(resolveLocale('zh'), 'zh-CN');
    assert.equal(resolveLocale('zh-Hans'), 'zh-CN');
    assert.equal(resolveLocale('zh-SG'), 'zh-CN');
    assert.equal(resolveLocale('zh-TW'), 'zh-TW');
    assert.equal(resolveLocale('zh-HK'), 'zh-TW');
    assert.equal(resolveLocale('zh-Hant'), 'zh-TW');
    assert.equal(resolveLocale('ko-KR'), 'ko');
    assert.equal(resolveLocale('ru-RU'), 'ru');
    assert.equal(resolveLocale('ar-EG'), 'ar');
    assert.equal(resolveLocale('hi-IN'), 'hi');
    assert.equal(resolveLocale('nl'), null);
  });

  it('orders Accept-Language entries by quality', () => {
    assert.deepEqual(
      parseAcceptLanguage('nl;q=0.4, es;q=0.9, en;q=0.6'),
      ['es', 'en', 'nl']
    );
    assert.deepEqual(parseAcceptLanguage(''), []);
  });

  it('picks the first supported language and defaults to pt-BR', () => {
    assert.equal(negotiateLocale('nl-NL, es;q=0.8'), 'es');
    assert.equal(negotiateLocale('de-DE'), 'de');
    assert.equal(negotiateLocale('fr-FR'), 'fr');
    assert.equal(negotiateLocale('ja-JP'), 'ja');
    assert.equal(negotiateLocale('zh-CN'), 'zh-CN');
    assert.equal(negotiateLocale('zh-TW'), 'zh-TW');
    assert.equal(negotiateLocale('ko-KR'), 'ko');
    assert.equal(negotiateLocale('ru-RU'), 'ru');
    assert.equal(negotiateLocale('ar-SA'), 'ar');
    assert.equal(negotiateLocale('hi-IN'), 'hi');
    assert.equal(negotiateLocale('nl-NL'), 'pt-BR');
    assert.equal(negotiateLocale(undefined), 'pt-BR');
    assert.equal(negotiateLocale('*'), 'pt-BR');
  });
});

describe('translated responses', () => {
  it('answers in Portuguese by default', async () => {
    const { status, body, response } = await call(`${panelUrl}/api/does-not-exist`);
    assert.equal(status, 404);
    assert.equal(body.message, 'Rota não encontrada');
    assert.equal(response.headers.get('content-language'), 'pt-BR');
  });

  it('honours the Accept-Language header', async () => {
    for (const [header, message] of [
      ['en', 'Route not found'],
      ['es', 'Ruta no encontrada'],
      ['it', 'Rotta non trovata'],
      ['de', 'Route nicht gefunden'],
      ['fr', 'Route introuvable'],
      ['ja', 'ルートが見つかりません'],
      ['zh-CN', '找不到该路由'],
      ['zh-TW', '找不到該路由'],
      ['ko', '경로를 찾을 수 없습니다'],
      ['ru', 'Маршрут не найден'],
      ['ar', 'المسار غير موجود'],
      ['hi', 'मार्ग नहीं मिला'],
      ['nl;q=0.9, en;q=0.5', 'Route not found']
    ]) {
      const { body } = await call(`${panelUrl}/api/does-not-exist`, {
        headers: { 'Accept-Language': header }
      });
      assert.equal(body.message, message);
    }
  });

  it('translates authentication failures', async () => {
    const { status, body } = await call(`${panelUrl}/api/devices`, {
      headers: { 'Accept-Language': 'es' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'Se requiere el token de autenticación');
  });

  it('translates portal session failures', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/overview`, {
      headers: { 'Accept-Language': 'en' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'A customer session is required');
  });

  it('varies on Accept-Language so proxies keep the languages apart', async () => {
    const { response } = await call(`${panelUrl}/api/does-not-exist`);
    assert.match(response.headers.get('vary') || '', /Accept-Language/i);
  });
});
