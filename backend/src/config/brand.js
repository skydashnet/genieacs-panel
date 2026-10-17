/**
 * O nome do produto, como aparece para as pessoas: e-mails, cobrança, o
 * aplicativo autenticador, o nome de fábrica de um provedor.
 *
 * Só o nome visível. Os identificadores em minúsculas (`skygenpanel`: o
 * emissor dos tokens, as chaves do navegador, o serviço do systemd) ficam como
 * estão — trocá-los derrubaria toda sessão aberta e toda instalação existente.
 */
export const PRODUCT_NAME = 'TR69 Controle';

/** Nomes que o produto já teve. Um provedor ainda com um deles nunca escolheu nome. */
export const LEGACY_PRODUCT_NAMES = Object.freeze(['SkyGenPanel', 'GenieACS Panel']);
