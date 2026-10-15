/**
 * Toda rota do painel endereçada por um id de linha, numa lista só.
 *
 * Mora aqui e não dentro da suíte porque dois testes a leem: a varredura em
 * `tenant-id-sweep.test.js`, que faz cada chamada de verdade, e a cobertura em
 * `route-coverage.test.js`, que confere que nenhuma rota endereçada por id
 * ficou de fora dela. Ler a lista de dentro do arquivo de teste faria o
 * segundo subir os servidores do primeiro só para contar casos.
 *
 * Cada caso diz:
 *
 * - `chave`   qual linha semeada usar (o seed devolve um objeto com estas chaves);
 * - `tabela`  onde conferir, depois, que a linha do vizinho ficou intacta;
 * - `coluna`  por qual coluna a rota endereça a linha (`id`, salvo quando a
 *             chave natural é que vai na URL, como o `node_id` do mapa);
 * - `esperado` o status que a rota tem que dar ao id do vizinho — 404 quase
 *             sempre, e o que não for 404 tem o motivo escrito ao lado;
 * - `controleSoNaoAchou` para as rotas que alcançam a rede quando o id resolve:
 *             o controle exige que a instância tenha sido encontrada, não que a
 *             chamada tenha dado certo.
 */
export const casos = [
  {
    // O dossiê LGPD de um assinante. A rota mais perigosa da lista: devolve
    // tudo o que existe sobre uma pessoa, e apontá-la para o id do vizinho
    // entregaria o dossiê de um assinante de outro ISP.
    chave: 'customerAccount',
    label: 'GET /api/customers/:accountId/export',
    method: 'GET',
    path: (id) => `/api/customers/${id}/export`,
    tabela: 'customer_accounts'
  },
  {
    // E a exclusão do mesmo assinante. O id do vizinho tem que dar 404 antes de
    // qualquer validação de corpo: um 409 dizendo "aposente a conta primeiro"
    // já teria confirmado que a linha existe.
    //
    // No controle, o id do próprio beta dá 409 e não 404 — a conta semeada está
    // ativa, e a rota exige aposentar antes. É o controle que se quer: um 409
    // só se chega DEPOIS de a conta ter sido encontrada, e a varredura não
    // destrói a linha que usa.
    chave: 'customerAccount',
    label: 'DELETE /api/customers/:accountId',
    method: 'DELETE',
    path: (id) => `/api/customers/${id}`,
    tabela: 'customer_accounts'
  },
  {
    chave: 'user',
    label: 'PATCH /api/users/:id',
    method: 'PATCH',
    path: (id) => `/api/users/${id}`,
    body: { role: 'viewer' },
    tabela: 'users'
  },
  {
    // Desligar o 2FA de alguém da equipe. O id do vizinho tem que dar 404 antes
    // de qualquer outra regra: um 409 "trabalha em outro provedor" ou "não tem
    // 2FA" já teria dito que a pessoa existe. No controle, a pessoa semeada não
    // tem 2FA e a resposta é 409 — que só se alcança depois de achá-la aqui.
    // Antes do DELETE: o controle dele encerra o vínculo da pessoa semeada.
    chave: 'user',
    label: 'POST /api/users/:id/mfa-reset',
    method: 'POST',
    path: (id) => `/api/users/${id}/mfa-reset`,
    tabela: 'users'
  },
  {
    chave: 'user',
    label: 'DELETE /api/users/:id',
    method: 'DELETE',
    path: (id) => `/api/users/${id}`,
    tabela: 'users'
  },
  {
    chave: 'tag',
    label: 'PATCH /api/whatsapp/tags/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/tags/${id}`,
    body: { name: 'Renomeada' },
    tabela: 'wa_tags'
  },
  {
    chave: 'tag',
    label: 'DELETE /api/whatsapp/tags/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/tags/${id}`,
    tabela: 'wa_tags'
  },
  {
    chave: 'conversation',
    label: 'GET /api/whatsapp/conversations/:id',
    method: 'GET',
    path: (id) => `/api/whatsapp/conversations/${id}`,
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'PUT /api/whatsapp/conversations/:id/tags',
    method: 'PUT',
    path: (id) => `/api/whatsapp/conversations/${id}/tags`,
    body: { tagIds: [] },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    // A indicação de um cliente: o estado mudado por quem atende. O id do
    // vizinho dá 404 antes de qualquer validação do corpo.
    chave: 'referral',
    label: 'PATCH /api/whatsapp/referrals/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/referrals/${id}`,
    body: { status: 'contacted' },
    tabela: 'customer_referrals'
  },
  {
    chave: 'template',
    label: 'PUT /api/whatsapp/templates/:id',
    method: 'PUT',
    path: (id) => `/api/whatsapp/templates/${id}`,
    body: { name: 'segunda-via', body: 'Outro texto', category: 'cobranca' },
    tabela: 'wa_templates'
  },
  {
    // A edição de uma campanha de aviso. O id do vizinho tem que dar 404 antes
    // de qualquer validação do corpo. No controle, o id do próprio beta dá 409
    // (a campanha semeada é de cobrança, e só a de aviso se edita): o 409 só
    // se chega DEPOIS de a campanha ter sido encontrada.
    chave: 'broadcast',
    label: 'PUT /api/whatsapp/broadcasts/:id',
    method: 'PUT',
    path: (id) => `/api/whatsapp/broadcasts/${id}`,
    body: { title: 'Aviso', filters: { contracts: ['1'] }, body: 'Oi' },
    tabela: 'wa_broadcasts'
  },
  {
    chave: 'template',
    label: 'DELETE /api/whatsapp/templates/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/templates/${id}`,
    tabela: 'wa_templates'
  },
  {
    // Antes do DELETE: o controle revoga a linha semeada, e uma linha
    // revogada responde 404 também ao dono.
    chave: 'optOut',
    label: 'PATCH /api/whatsapp/opt-outs/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/opt-outs/${id}`,
    body: { categories: ['marketing'] },
    tabela: 'wa_opt_outs'
  },
  {
    chave: 'optOut',
    label: 'DELETE /api/whatsapp/opt-outs/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/opt-outs/${id}`,
    tabela: 'wa_opt_outs'
  },
  {
    // Os incidentes de queda: a lista dos clientes atingidos de um provedor, e
    // o botão que manda WhatsApp para eles. O `resolve` vem por último porque
    // o controle fecha o incidente semeado.
    chave: 'outage',
    label: 'GET /api/whatsapp/outages/:id',
    method: 'GET',
    path: (id) => `/api/whatsapp/outages/${id}`,
    tabela: 'outage_incidents'
  },
  {
    chave: 'outage',
    label: 'PATCH /api/whatsapp/outages/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/outages/${id}`,
    body: { eta: 'amanhã' },
    tabela: 'outage_incidents'
  },
  {
    chave: 'outage',
    label: 'POST /api/whatsapp/outages/:id/notify',
    method: 'POST',
    path: (id) => `/api/whatsapp/outages/${id}/notify`,
    body: {},
    tabela: 'outage_incidents'
  },
  {
    chave: 'outage',
    label: 'POST /api/whatsapp/outages/:id/resolve',
    method: 'POST',
    path: (id) => `/api/whatsapp/outages/${id}/resolve`,
    tabela: 'outage_incidents'
  },
  {
    chave: 'maintenance',
    label: 'GET /api/whatsapp/maintenances/:id',
    method: 'GET',
    path: (id) => `/api/whatsapp/maintenances/${id}`,
    tabela: 'maintenance_windows'
  },
  {
    chave: 'maintenance',
    label: 'PATCH /api/whatsapp/maintenances/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/maintenances/${id}`,
    body: { message: 'outro texto' },
    tabela: 'maintenance_windows'
  },
  {
    chave: 'maintenance',
    label: 'POST /api/whatsapp/maintenances/:id/notify',
    method: 'POST',
    path: (id) => `/api/whatsapp/maintenances/${id}/notify`,
    body: {},
    tabela: 'maintenance_windows'
  },
  {
    chave: 'maintenance',
    label: 'POST /api/whatsapp/maintenances/:id/cancel',
    method: 'POST',
    path: (id) => `/api/whatsapp/maintenances/${id}/cancel`,
    body: {},
    tabela: 'maintenance_windows'
  },
  {
    chave: 'maintenance',
    label: 'POST /api/whatsapp/maintenances/:id/conclude',
    method: 'POST',
    path: (id) => `/api/whatsapp/maintenances/${id}/conclude`,
    body: {},
    tabela: 'maintenance_windows'
  },
  {
    chave: 'broadcast',
    label: 'POST /api/whatsapp/broadcasts/:id/status',
    method: 'POST',
    path: (id) => `/api/whatsapp/broadcasts/${id}/status`,
    body: { status: 'canceled' },
    tabela: 'wa_broadcasts'
  },
  {
    chave: 'broadcast',
    label: 'GET /api/whatsapp/broadcasts/:id/recipients',
    method: 'GET',
    path: (id) => `/api/whatsapp/broadcasts/${id}/recipients`,
    tabela: 'wa_broadcasts'
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/qr',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/qr`,
    tabela: 'whatsapp_accounts',
    // O beta chegaria à rede se o id resolvesse, e a porta 9 está fechada: o
    // controle abaixo aceita o erro de transporte, e o que ele exige é que a
    // resposta não seja `account_not_found`.
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/status',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/status`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/restart',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/restart`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/disconnect',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/disconnect`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/webhook',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/webhook`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/webhook',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/webhook`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/templates/sync',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/templates/sync`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    // Criar modelo na Meta. A conta é carregada antes de validar o corpo, então
    // o id do vizinho dá 404 mesmo com corpo válido; no controle, o número
    // semeado (por QR) dá 409 `meta_templates_cloud_only` — achado, recusado.
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/templates',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/templates`,
    body: { name: 'aviso_vizinho', category: 'UTILITY', language: 'pt_BR', bodyText: 'Olá' },
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/meta-token',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/meta-token`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    // Registrar o webhook da Meta. No controle, o número semeado (por QR) dá
    // 409 `not_cloud` — achado, recusado; nenhuma chamada sai para a Meta.
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/meta-webhook',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/meta-webhook`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/webhook/probe',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/webhook/probe`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'PATCH /api/whatsapp/accounts/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/accounts/${id}`,
    body: { label: 'Renomeado pelo vizinho' },
    tabela: 'whatsapp_accounts'
  },
  {
    chave: 'event',
    label: 'GET /api/sgp/events/:id',
    method: 'GET',
    path: (id) => `/api/sgp/events/${id}`,
    tabela: 'sgp_events'
  },
  {
    chave: 'event',
    label: 'POST /api/sgp/events/:id/retry',
    method: 'POST',
    path: (id) => `/api/sgp/events/${id}/retry`,
    tabela: 'sgp_events'
  },
  {
    chave: 'profile',
    label: 'PUT /api/provisioning/profiles/:id',
    method: 'PUT',
    path: (id) => `/api/provisioning/profiles/${id}`,
    body: { name: 'perfil-padrao', priority: 20, enabled: true },
    tabela: 'provisioning_profiles'
  },
  {
    chave: 'profile',
    label: 'DELETE /api/provisioning/profiles/:id',
    method: 'DELETE',
    path: (id) => `/api/provisioning/profiles/${id}`,
    tabela: 'provisioning_profiles'
  },
  {
    chave: 'swap',
    label: 'POST /api/devices/swaps/:id/acknowledge',
    method: 'POST',
    path: (id) => `/api/devices/swaps/${id}/acknowledge`,
    tabela: 'device_swaps'
  },
  {
    chave: 'vendor',
    label: 'GET /api/vendor-management/:id',
    method: 'GET',
    path: (id) => `/api/vendor-management/${id}`,
    tabela: 'vendors'
  },
  {
    chave: 'vendor',
    label: 'PUT /api/vendor-management/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/${id}`,
    body: {
      name: 'Fabricante Comum',
      manufacturer_patterns: ['ACME'],
      product_patterns: ['AC-1000'],
      parameter_prefix: 'InternetGatewayDevice'
    },
    tabela: 'vendors'
  },
  {
    chave: 'wifiConfig',
    label: 'GET /api/vendor-management/wifi-security-configs/:id',
    method: 'GET',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    tabela: 'wifi_security_config'
  },
  {
    chave: 'wifiConfig',
    label: 'PUT /api/vendor-management/wifi-security-configs/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    body: {
      product_class: 'AC-1000',
      security_types: ['WPA2'],
      password_param_path: 'WLANConfiguration.1.KeyPassphrase'
    },
    tabela: 'wifi_security_config'
  },
  {
    // Restaurar o padrão escreve na linha — com o id do vizinho seria
    // sobrescrever o perfil de outro ISP. No controle, sem caixa de plataforma,
    // a linha é achada e a resposta é "não há padrão" (`no_default`), que é o
    // que prova que o 404 do vizinho veio de não achar a linha.
    chave: 'vendor',
    label: 'POST /api/vendor-management/:id/reset',
    method: 'POST',
    path: (id) => `/api/vendor-management/${id}/reset`,
    tabela: 'vendors',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'not_found'
  },
  {
    chave: 'wifiConfig',
    label: 'POST /api/vendor-management/wifi-security-configs/:id/reset',
    method: 'POST',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}/reset`,
    tabela: 'wifi_security_config',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'not_found'
  },
  {
    chave: 'wifiConfig',
    label: 'DELETE /api/vendor-management/wifi-security-configs/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    tabela: 'wifi_security_config'
  },
  {
    chave: 'vendor',
    label: 'DELETE /api/vendor-management/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/${id}`,
    tabela: 'vendors'
  },

  // --- O mapa da planta. A URL leva a chave natural (`node_id`, `edge_id`) e
  // não o id da linha, e é justamente por isso que os dois provedores podem
  // nomear o mesmo poste: a unique é composta desde a onda que escopou a
  // tabela. O cabo vem antes do poste porque apagar o poste leva o cabo junto,
  // pela estrangeira composta com ON DELETE CASCADE.
  {
    chave: 'edge',
    label: 'GET /api/mapping-data/edges/:edgeId',
    method: 'GET',
    path: (id) => `/api/mapping-data/edges/${id}`,
    tabela: 'mapping_edges',
    coluna: 'edge_id'
  },
  {
    chave: 'edge',
    label: 'PUT /api/mapping-data/edges/:edgeId',
    method: 'PUT',
    path: (id) => `/api/mapping-data/edges/${id}`,
    body: (ids) => ({
      source: ids.nodeA, target: ids.nodeB, fiber_type: 'drop', distance: 42, notes: 'trocado pelo vizinho'
    }),
    tabela: 'mapping_edges',
    coluna: 'edge_id'
  },
  {
    chave: 'edge',
    label: 'DELETE /api/mapping-data/edges/:edgeId',
    method: 'DELETE',
    path: (id) => `/api/mapping-data/edges/${id}`,
    tabela: 'mapping_edges',
    coluna: 'edge_id'
  },
  {
    chave: 'nodeA',
    label: 'GET /api/mapping-data/nodes/:nodeId',
    method: 'GET',
    path: (id) => `/api/mapping-data/nodes/${id}`,
    tabela: 'mapping_nodes',
    coluna: 'node_id'
  },
  {
    chave: 'nodeA',
    label: 'PUT /api/mapping-data/nodes/:nodeId',
    method: 'PUT',
    path: (id) => `/api/mapping-data/nodes/${id}`,
    body: { type: 'odp', name: 'Renomeado pelo vizinho', latitude: -15.79, longitude: -47.88 },
    tabela: 'mapping_nodes',
    coluna: 'node_id'
  },
  {
    chave: 'nodeA',
    label: 'DELETE /api/mapping-data/nodes/:nodeId',
    method: 'DELETE',
    path: (id) => `/api/mapping-data/nodes/${id}`,
    tabela: 'mapping_nodes',
    coluna: 'node_id'
  },
  // --- O convite. Revogar o do vizinho seria fechar a porta de entrada da
  // equipe dele; o link continua valendo até o dono revogar.
  {
    chave: 'invite',
    label: 'DELETE /api/invites/:id',
    method: 'DELETE',
    path: (id) => `/api/invites/${id}`,
    tabela: 'tenant_invites'
  },
  // --- A caixa de entrada. A conversa carrega contrato e device id do
  // assinante, então lê-la de fora é ler o cadastro do vizinho.
  {
    chave: 'conversation',
    label: 'GET /api/whatsapp/conversations/:id/messages',
    method: 'GET',
    path: (id) => `/api/whatsapp/conversations/${id}/messages`,
    tabela: 'wa_conversations'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/assign',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/assign`,
    body: { userId: null },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/status',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/status`,
    body: { status: 'closed' },
    tabela: 'wa_conversations'
  },
  // O módulo SGP ao lado da conversa. A conversa é lida escopada ANTES de
  // qualquer consulta ao ERP, então o id do vizinho é 404 e o ERP nem é
  // chamado. Com o id próprio a resposta depende do SGP estar configurado aqui
  // (não está), e o controle só exige que a conversa tenha sido achada.
  {
    chave: 'conversation',
    label: 'GET /api/whatsapp/conversations/:id/subscriber',
    method: 'GET',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber`,
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/suggest-reply',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/suggest-reply`,
    body: {},
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber/bind',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber/bind`,
    body: { contract: '1' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber/unlock',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber/unlock`,
    body: { contract: '1' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber/dunning-resume',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber/dunning-resume`,
    body: { contract: '1' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber/second-copy',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber/second-copy`,
    body: { contract: '1', template: 'Olá {{nome}}' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber/invoice',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber/invoice`,
    body: { contract: '1', invoiceId: '1' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber/phone',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber/phone`,
    body: { contract: '1' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber/ticket',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber/ticket`,
    body: { contract: '1', content: 'Escrito no contrato do vizinho' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  // Endereçada pelo contrato do SGP, não por id daqui. Com o do vizinho não há
  // assinante (404 `subscriber_not_found`) e nenhuma conversa pode nascer; com
  // o próprio, a conversa abre.
  {
    chave: 'sgpContract',
    label: 'POST /api/whatsapp/contacts/:contract/conversation',
    method: 'POST',
    path: (contract) => `/api/whatsapp/contacts/${encodeURIComponent(contract)}/conversation`,
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  // A ficha completa do cliente, pela mesma chave da lista de contatos. O
  // contrato do vizinho não acha linha (404 `not_found`); o próprio abre a
  // ficha a partir do `sgp_links`, mesmo sem sincronização de contatos.
  {
    chave: 'sgpContract',
    label: 'GET /api/contacts/:key',
    method: 'GET',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}`,
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  // Os títulos pedem ao SGP, que aqui não está configurado: no controle a rota
  // passa da busca da ficha e para no SGP, que é o que separa as duas.
  {
    chave: 'sgpContract',
    label: 'GET /api/contacts/:key/invoices',
    method: 'GET',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}/invoices`,
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  // O boleto pelo WhatsApp pede os títulos ao SGP, como a rota acima: no
  // controle passa da busca da ficha e para no SGP.
  {
    chave: 'sgpContract',
    label: 'GET /api/contacts/:key/invoices/:invoiceId/whatsapp',
    method: 'GET',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}/invoices/T-1/whatsapp`,
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  {
    chave: 'sgpContract',
    label: 'POST /api/contacts/:key/invoices/:invoiceId/whatsapp',
    method: 'POST',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}/invoices/T-1/whatsapp`,
    body: { text: 'boleto da varredura' },
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  // "Receber": a ficha é procurada antes de tudo, então a chave do vizinho dá
  // 404; no controle a rota passa da ficha e para na baixa não configurada.
  {
    chave: 'sgpContract',
    label: 'POST /api/contacts/:key/invoices/:invoiceId/settle',
    method: 'POST',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}/invoices/T-1/settle`,
    body: { amount: 10, method: 'PIX' },
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  {
    chave: 'sgpContract',
    label: 'GET /api/contacts/:key/service-status',
    method: 'GET',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}/service-status`,
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  {
    chave: 'sgpContract',
    label: 'PATCH /api/contacts/:key',
    method: 'PATCH',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}`,
    body: { notes: 'anotação da varredura' },
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  {
    chave: 'sgpContract',
    label: 'POST /api/contacts/:key/sync',
    method: 'POST',
    path: (contract) => `/api/contacts/${encodeURIComponent(contract)}/sync`,
    tabela: 'sgp_links',
    coluna: 'contract'
  },
  // O contrato do corpo não existe em nenhum dos dois, de propósito: com o id do
  // vizinho a conversa não pode ser achada (404 `conversation_not_found`), e
  // com o próprio a rota passa dela e recusa o contrato — o controle exige só
  // que a CONVERSA tenha sido encontrada.
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/subscriber',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/subscriber`,
    body: { contract: 'CONTRATO-QUE-NAO-EXISTE' },
    tabela: 'wa_conversations',
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  // 409 e não 404, e está certo: a rota não distingue "não existe" de "não dá
  // para reenfileirar", e a leitura por baixo é escopada — o vizinho recebe a
  // mesma recusa que receberia para uma mensagem já entregue. O que se exige
  // aqui é o de sempre: a linha do outro provedor não pode ter sido tocada.
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/messages',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/messages`,
    body: { body: 'Escrito na conversa do vizinho' },
    tabela: 'wa_conversations',
    // Com o id próprio a rota vai à Evolution, que aqui é uma porta fechada:
    // o controle exige que a CONVERSA tenha sido encontrada, não que o envio
    // tenha dado certo.
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  // Reagir e apagar: a mensagem do vizinho não pode ser achada (404), e a
  // leitura por baixo é escopada. Com o id do próprio beta a rota passa dela:
  // a reação chega ao cliente Evolution e a política recusa o servidor sem
  // https (400, sem rede), e a exclusão marca só a linha do beta.
  {
    chave: 'failedMessage',
    label: 'POST /api/whatsapp/messages/:id/reaction',
    method: 'POST',
    path: (id) => `/api/whatsapp/messages/${id}/reaction`,
    // Vazio (tirar a reação): sem emoji no corpo, que o auxiliar de chamada
    // mede em caracteres e não em bytes.
    body: { emoji: '' },
    tabela: 'wa_messages'
  },
  {
    chave: 'failedMessage',
    label: 'POST /api/whatsapp/messages/:id/delete',
    method: 'POST',
    path: (id) => `/api/whatsapp/messages/${id}/delete`,
    tabela: 'wa_messages'
  },
  {
    chave: 'failedMessage',
    label: 'POST /api/whatsapp/messages/:id/requeue',
    method: 'POST',
    path: (id) => `/api/whatsapp/messages/${id}/requeue`,
    tabela: 'wa_messages',
    esperado: 409
  },
  // A conta do WhatsApp por último: apagá-la leva as conversas junto, e os
  // casos acima precisam delas de pé.
  {
    chave: 'account',
    label: 'DELETE /api/whatsapp/accounts/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/accounts/${id}`,
    tabela: 'whatsapp_accounts'
  }
];
