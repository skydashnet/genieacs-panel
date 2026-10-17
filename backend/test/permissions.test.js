import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROLES,
  PERMISSIONS,
  DEFAULT_ROLE,
  normalizeRole,
  permissionsOf,
  roleHas,
  unknownPermissions,
  orphanPermissions
} from '../src/config/permissions.js';

const ROUTES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes'
);

describe('a matriz de papéis', () => {
  it('não deixa capacidade órfã', () => {
    // Capacidade que nenhum papel tem é rota que ninguém alcança — inclusive o
    // dono do provedor. Falha de teste é o lugar certo de descobrir isso.
    assert.deepEqual(orphanPermissions(), []);
  });

  it('cresce de viewer para tech para admin, sem tirar nada pelo caminho', () => {
    const viewer = permissionsOf('viewer');
    const tech = permissionsOf('tech');
    const admin = permissionsOf('admin');

    for (const permissao of viewer) {
      assert.ok(tech.has(permissao), `tech perdeu ${permissao}`);
    }
    for (const permissao of tech) {
      assert.ok(admin.has(permissao), `admin perdeu ${permissao}`);
    }
    // E cresce de verdade: uma hierarquia em que os três níveis são iguais
    // passaria em tudo acima sem ser hierarquia nenhuma.
    assert.ok(tech.size > viewer.size);
    assert.ok(admin.size > tech.size);
  });

  it('dá a owner exatamente o que dá a admin', () => {
    // A diferença entre os dois não é rota, é quem mexe no papel de quem — e
    // isso vive em `usersController`. Se um dia divergirem aqui, é porque
    // alguém escreveu a regra no lugar errado.
    assert.deepEqual([...permissionsOf('owner')].sort(), [...permissionsOf('admin')].sort());
  });

  it('dá ao viewer só o que hoje não pede papel nenhum', () => {
    assert.deepEqual([...permissionsOf('viewer')].sort(),
      ['catalogue.read', 'devices.list', 'map.read']);
  });
});

describe('a leitura de um papel', () => {
  it('trata papel desconhecido como o de menos poder', () => {
    // `'user'` é o default antigo da coluna e ainda está em linhas de verdade.
    for (const entrada of ['user', '', null, undefined, 'ADMINISTRADOR', 'root']) {
      assert.equal(normalizeRole(entrada), DEFAULT_ROLE, String(entrada));
    }
  });

  it('aceita os quatro papéis, em qualquer caixa', () => {
    for (const papel of ROLES) {
      assert.equal(normalizeRole(papel.toUpperCase()), papel);
    }
  });

  it('erra fechando diante de uma capacidade que não existe', () => {
    // A direção importa. "Não conheço, deixa passar" abre a rota para o viewer
    // e não aparece em lugar nenhum; "não conheço, recuso" vira 403 para todo
    // mundo, inclusive para o dono, que é falha barulhenta e corrigida no dia.
    for (const papel of ROLES) {
      assert.equal(roleHas(papel, 'inventada.qualquer'), false, papel);
    }
  });
});

describe('a cópia da matriz que o frontend carrega', () => {
  /**
   * `frontend/src/lib/permissions.ts` repete esta matriz, e a repetição é
   * deliberada: a tela precisa saber a resposta ANTES de perguntar, para não
   * oferecer um botão cujo pedido sempre falharia, e o backend não expõe a
   * matriz por rota nenhuma.
   *
   * O preço de uma cópia é a divergência, e ela é silenciosa das duas
   * direções: uma capacidade a mais no frontend é botão que responde 403; uma a
   * menos é botão que some para quem podia usá-lo. Nenhuma das duas quebra
   * nada, então nenhuma aparece. Este teste é o que as torna vermelhas — lê os
   * dois arquivos como texto, porque um `.ts` não é importável daqui, e compara
   * o que cada um declara.
   */
  const FRONT = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..',
    'frontend', 'src', 'lib', 'permissions.ts'
  );

  /**
   * Os itens de um array literal nomeado, na ordem em que aparecem.
   *
   * A anotação de tipo entre o nome e o `=` é opcional no padrão porque o
   * espelho escreve as duas formas — `export const PERMISSIONS = [` e
   * `const VIEWER: Permission[] = [`. Casar só uma delas faria as asserções
   * abaixo lerem lista vazia, que é a falha silenciosa que este bloco inteiro
   * existe para não ter.
   */
  function listaDe(fonte, nome) {
    const padrao = new RegExp(`${nome}\\s*(?::[^=]+)?=\\s*\\[`);
    const achado = padrao.exec(fonte);
    assert.ok(achado, `${nome} não encontrado no espelho do frontend`);
    // A partir do FIM do casamento e não do começo: `const VIEWER: Permission[]`
    // tem um `]` na própria anotação de tipo, e procurar o fechamento a partir
    // do início pararia nele — devolvendo lista vazia, verde, sempre.
    const inicio = achado.index + achado[0].length;
    const fim = fonte.indexOf(']', inicio);
    return [...fonte.slice(inicio, fim).matchAll(/'([^']+)'/g)].map(([, item]) => item);
  }

  const fonte = fs.readFileSync(FRONT, 'utf8');

  it('declara as mesmas capacidades, na mesma ordem', () => {
    assert.deepEqual(listaDe(fonte, 'export const PERMISSIONS'), [...PERMISSIONS]);
  });

  it('declara os mesmos papéis', () => {
    assert.deepEqual(listaDe(fonte, 'export const OPERATOR_ROLES'), [...ROLES]);
  });

  it('dá a cada papel exatamente o mesmo conjunto', () => {
    // Os três blocos do espelho são cumulativos como os daqui: TECH abre com
    // `...VIEWER` e ADMIN com `...TECH`, então cada lista literal traz só o que
    // aquele nível acrescenta — que é o que se compara.
    const acrescenta = {
      viewer: listaDe(fonte, 'const VIEWER'),
      tech: listaDe(fonte, 'const TECH'),
      admin: listaDe(fonte, 'const ADMIN')
    };
    const esperado = {
      viewer: [...permissionsOf('viewer')],
      tech: [...permissionsOf('tech')].filter((p) => !permissionsOf('viewer').has(p)),
      admin: [...permissionsOf('admin')].filter((p) => !permissionsOf('tech').has(p))
    };
    for (const nivel of ['viewer', 'tech', 'admin']) {
      assert.deepEqual(acrescenta[nivel].sort(), esperado[nivel].sort(), nivel);
    }
  });

  it('e a leitura não passa por não achar nada', () => {
    // Sem isto, uma mudança de forma no espelho — outro nome de constante, um
    // `as const` no meio — faria as três asserções acima lerem listas vazias e
    // ficarem verdes para sempre.
    assert.ok(listaDe(fonte, 'export const PERMISSIONS').length >= 20);
    assert.ok(listaDe(fonte, 'const ADMIN').length >= 5);
  });
});

describe('as capacidades que as rotas citam', () => {
  const arquivos = fs.readdirSync(ROUTES_DIR).filter((nome) => nome.endsWith('.js'));

  const citadas = new Map();
  for (const nome of arquivos) {
    const fonte = fs.readFileSync(path.join(ROUTES_DIR, nome), 'utf8');
    for (const [, permissao] of fonte.matchAll(/requirePermission\(\s*'([^']+)'\s*\)/g)) {
      if (!citadas.has(permissao)) citadas.set(permissao, new Set());
      citadas.get(permissao).add(nome);
    }
  }

  /**
   * A varredura estática, e a razão de ela existir.
   *
   * `requirePermission` erra fechando: um nome errado recusa todo mundo. Isso é
   * a direção segura e é também uma falha que só aparece quando alguém clica no
   * botão — e clica em produção, porque não há teste de rota para as 91. Aqui o
   * erro de digitação é vermelho antes do merge, que é onde ele custa nada.
   */
  it('nomeia só capacidades que existem', () => {
    const desconhecidas = unknownPermissions([...citadas.keys()]);
    assert.deepEqual(desconhecidas, [],
      desconhecidas.map((nome) => `${nome} (${[...citadas.get(nome)].join(', ')})`).join('; '));
  });

  it('cita ao menos uma capacidade — a varredura não pode passar por não achar nada', () => {
    // Sem isto o teste acima ficaria verde para sempre no dia em que a regex
    // deixasse de casar, que é exatamente o dia em que ele deveria falhar.
    assert.ok(citadas.size >= 10, `só ${citadas.size} capacidades citadas nas rotas`);
  });

  /**
   * `requireRole` foi removida quando a última rota deixou de usá-la. Este teste
   * é o que impede a volta: uma guarda por papel acrescentada de novo em meio a
   * 91 guardas por capacidade não chama atenção em revisão nenhuma, e reintroduz
   * o mundo de dois papéis numa rota só — que é onde essas coisas voltam.
   */
  it('não guarda rota por papel em lugar nenhum', () => {
    const comPapel = arquivos.filter(
      (nome) => /requireRole\s*\(/.test(fs.readFileSync(path.join(ROUTES_DIR, nome), 'utf8'))
    );
    assert.deepEqual(comPapel, []);
  });

  it('usa toda capacidade que a matriz declara, ou nomeia a exceção', () => {
    /**
     * Capacidade declarada e nunca exigida por rota nenhuma é peso morto: ou a
     * rota esqueceu de pedi-la, ou o nome sobrou de um recorte anterior.
     * Nenhuma das duas deve passar em silêncio.
     */
    const semRota = PERMISSIONS.filter((permissao) => !citadas.has(permissao));
    assert.deepEqual(semRota, [], `capacidades que nenhuma rota exige: ${semRota.join(', ')}`);
  });
});
