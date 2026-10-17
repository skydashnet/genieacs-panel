/**
 * Espelho de `backend/src/config/permissions.js`. Divergir dele é bug.
 *
 * A matriz de verdade é a do backend: é ela que decide o 403. Esta cópia existe
 * porque a tela precisa saber a resposta ANTES de perguntar — para não oferecer
 * um botão cujo pedido sempre falharia — e o backend não expõe a matriz por
 * nenhuma rota. Enquanto não expuser, o preço é este arquivo.
 *
 * Por isso ele é um só, e é a cópia inteira e não um recorte: um recorte com as
 * capacidades que a tela usa hoje convida a próxima capacidade a nascer só de
 * um lado, e a divergência aparece como botão morto, não como erro. Copiada
 * inteira, a conferência é uma leitura lado a lado.
 *
 * A tela erra fechando: uma capacidade que a matriz não conhece responde
 * `false`, como no backend. Esconder um botão que a pessoa poderia usar é
 * defeito visível e reclamado no mesmo dia; mostrar um que ela não pode usar é
 * o dedo apontando para o que ela não alcança.
 */

import type { TranslationKey } from '@/lib/i18n/dictionary'

/** Os quatro papéis, do mais para o menos poderoso. */
export const OPERATOR_ROLES = ['owner', 'admin', 'tech', 'viewer'] as const

export type OperatorRole = (typeof OPERATOR_ROLES)[number]

/** O papel de quem entra sem que ninguém tenha dito qual é. */
export const DEFAULT_ROLE: OperatorRole = 'viewer'

/** Toda capacidade que uma rota pode exigir. */
export const PERMISSIONS = [
  'devices.list',
  'devices.inspect',
  'devices.write',
  'devices.maintain',
  // A lista de equipamentos inteira num arquivo (série, PPPoE, ID do cliente).
  // Separada de `devices.list` como `contacts.export` é de `contacts.read`: ver
  // página por página não é o mesmo que levar a base toda de uma vez.
  'devices.export',
  'customers.secrets',
  'map.read',
  'map.write',
  'catalogue.read',
  'catalogue.write',
  'sgp.read',
  'sgp.act',
  'sgp.config',
  'teiah.read',
  'teiah.act',
  'teiah.config',
  'provisioning.read',
  'provisioning.run',
  'provisioning.write',
  'whatsapp.read',
  'whatsapp.send',
  'whatsapp.config',
  'campaigns.read',
  'campaigns.manage',
  'contacts.read',
  'contacts.edit',
  'contacts.settle',
  'contacts.export',
  'contacts.import',
  'settings.read',
  'settings.write',
  'operators.read',
  'operators.manage',
  'audit.read',
  'tenant.export',
  'customers.dossier',
  'customers.erase',
  'database.manage'
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Quem lê. */
const VIEWER: Permission[] = [
  'devices.list',
  'map.read',
  'catalogue.read'
]

/** O plantão: mexe em equipamento e fala com assinante; não mexe em configuração nem em gente. */
const TECH: Permission[] = [
  ...VIEWER,
  'devices.inspect',
  'devices.write',
  'customers.secrets',
  'map.write',
  'sgp.read',
  'sgp.act',
  'teiah.read',
  'provisioning.read',
  'provisioning.run',
  'whatsapp.read',
  'whatsapp.send',
  'campaigns.read',
  'contacts.read',
  'contacts.edit',
  'contacts.settle'
]

/** Administra a operação do provedor. */
const ADMIN: Permission[] = [
  ...TECH,
  'devices.maintain',
  'devices.export',
  'catalogue.write',
  'sgp.config',
  'teiah.act',
  'teiah.config',
  'provisioning.write',
  'whatsapp.config',
  'campaigns.manage',
  'contacts.export',
  'contacts.import',
  'settings.read',
  'settings.write',
  'operators.read',
  'operators.manage',
  'audit.read',
  'tenant.export',
  'customers.dossier',
  'customers.erase',
  'database.manage'
]

/**
 * `owner` e `admin` alcançam exatamente as mesmas rotas. A diferença entre eles
 * não é uma capacidade, é quem pode mexer no papel de quem — só um `owner`
 * promove ou rebaixa outro `owner` — e essa regra vive no controlador de
 * operadores do backend, não aqui.
 */
const MATRIX: Record<OperatorRole, ReadonlySet<Permission>> = {
  owner: new Set(ADMIN),
  admin: new Set(ADMIN),
  tech: new Set(TECH),
  viewer: new Set(VIEWER)
}

/**
 * O papel tal como vale para a autorização. Qualquer coisa desconhecida — uma
 * conta antiga que ainda carrega `'user'`, um papel que o backend passe a
 * emitir antes de esta cópia acompanhar — cai em `viewer`, que é a direção
 * segura e a mesma leitura que o backend faz.
 */
export function normalizeRole(role: string | undefined | null): OperatorRole {
  const name = String(role ?? '').trim().toLowerCase()
  return (OPERATOR_ROLES as readonly string[]).includes(name)
    ? (name as OperatorRole)
    : DEFAULT_ROLE
}

/**
 * O rótulo e a linha que descreve cada papel, por chave de tradução.
 *
 * Moram aqui, e não na tela, por serem `Record<OperatorRole, …>`: um papel novo
 * no espelho acima não compila enquanto não ganhar as duas frases. Um seletor
 * que oferece um papel sem dizer o que ele alcança é a tela pedindo que a
 * pessoa adivinhe o que está entregando.
 *
 * O texto das descrições sai da matriz acima. Quando uma capacidade mudar de
 * papel, a frase muda junto — descrição desatualizada aqui é a mesma classe de
 * bug que uma capacidade a mais ou a menos.
 */
export const ROLE_LABEL_KEYS: Record<OperatorRole, TranslationKey> = {
  owner: 'settings.operators.roleOwner',
  admin: 'settings.operators.roleAdmin',
  tech: 'settings.operators.roleTech',
  viewer: 'settings.operators.roleViewer'
}

export const ROLE_SUMMARY_KEYS: Record<OperatorRole, TranslationKey> = {
  owner: 'settings.operators.roleOwnerSummary',
  admin: 'settings.operators.roleAdminSummary',
  tech: 'settings.operators.roleTechSummary',
  viewer: 'settings.operators.roleViewerSummary'
}

/** Se um papel tem uma capacidade. Sem papel nenhum, não tem. */
export function roleHas(role: string | undefined | null, permission: Permission): boolean {
  if (role === undefined || role === null) return false
  return MATRIX[normalizeRole(role)].has(permission)
}
