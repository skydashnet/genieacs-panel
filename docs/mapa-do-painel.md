# Mapa do painel

Toda tela, o endereço dela, a permissão que ela exige e de quem ela é. Levantado das rotas
(`frontend/src/app.tsx`), do menu (`frontend/src/components/sidebar.tsx`) e das permissões
(`backend/src/config/permissions.js`).

Serve para três coisas: treinar quem vai operar, receber provedor novo sem passear a esmo, e
responder "onde fica X" sem abrir o código.

**Os três mundos deste produto**, porque a mesma URL pode ser coisas diferentes:

| Mundo | Quem entra | Como se chega |
| --- | --- | --- |
| **Painel do provedor** | operadores de um ISP | o endereço do painel, com sessão de provedor |
| **Console da plataforma** | quem está em `platform_admins` | `/platform` — no ápice do domínio-base, ou dentro do painel onde não há domínio-base |
| **Portal do assinante** | o cliente final do ISP | porta/host do portal, sessão própria |

---

## 1. Público — sem sessão

| Endereço | Tela | Observação |
| --- | --- | --- |
| `/` | **Vitrine** | só existe no ápice da plataforma; em host único a raiz leva ao console |
| `/signup` | Cadastro de provedor | aceita `?plano=` vindo da vitrine |
| `/login` | Entrada | a do console e a do provedor são rotas distintas no mesmo caminho |
| `/privacidade` | Política de privacidade | texto em `frontend/src/pages/privacy.tsx`, dados em `frontend/src/lib/privacy.ts`; nas duas árvores públicas |
| `/setup` | Primeira instalação | só enquanto não há nenhum usuário |
| `/invite` | Aceitar convite de equipe | por token |
| `/forgot-password`, `/reset-password` | Recuperação de senha | exige e-mail verificado |
| `/verify-email` | Confirmação de e-mail | por token |
| `/impersonate` | Resgate do bilhete de personificação | abre a sessão do provedor a partir do console |

As quatro primeiras são as únicas que fazem sentido para um buscador; as outras são
transacionais e dependem de token.

**E o que um buscador alcança de verdade é decidido por host.** `GET /robots.txt` e
`GET /sitemap.xml` (`backend/src/services/seoFiles.js`) respondem conforme o endereço seja o
ápice da plataforma ou não: no ápice, `Disallow: /` com exceção de `/`, `/signup`, `/login` e `/privacidade`,
mais o `Sitemap:`; em qualquer outro host — painel de provedor, deploy de endereço único,
portal do assinante — `Disallow: /` e nada de mapa. Num deploy sem ápice, portanto, o efeito é
só um: **manter o painel fora dos buscadores**.

---

## 2. Painel do provedor — os nove itens de menu

Na ordem em que aparecem. A coluna *permissão* é a que a tela exige para **abrir** — a mesma
que guarda a rota no backend.

| # | Item | Endereço | Permissão | O que é |
| --- | --- | --- | --- | --- |
| 1 | **Operação** | `/dashboard` | `devices.list` | saúde da rede |
| 2 | **WhatsApp** | `/whatsapp` | `whatsapp.read` | conversas, campanhas e alertas |
| 3 | **Inventário de equipamentos** | `/devices` | `devices.list` | ONT e CPE |
| 4 | **Contatos** | `/contacts` | `whatsapp.read` | assinantes do SGP |
| 5 | **Topologia da rede** | `/network-map` | `map.read` | pontos físicos |
| 6 | **Trilha** | `/audit` | `audit.read` | quem fez o quê |
| 7 | **Plano** | `/plan` | `settings.read` | assinatura e uso — **só na edição hospedada** |
| 8 | **Provedores** | `/platform` | chave de plataforma | **só para administrador de plataforma** |
| 9 | **Configuração** | `/settings` | `settings.read` | ACS e fabricantes |

Telas fora do menu, alcançadas de dentro de outra:

| Endereço | Chega-se por | Permissão |
| --- | --- | --- |
| `/devices/detail?id=…` | clique num aparelho | `devices.list` |
| `/contacts/:key` | clique num contato | `whatsapp.read` |
| `/onboarding` | automático, no primeiro acesso sem ACS configurado | `settings.write` |
| `/sitemap` | o pé da barra lateral | nenhuma — todo papel abre |

`/sitemap` é este documento virado tela: os mesmos grupos, com link para cada item e para as
quinze seções da Configuração (`/settings?tab=…`). Lista só o que a sessão aberta alcança, então
um `viewer` vê três telas ali.

### 2.1 A tela do aparelho — cinco abas

`Visão geral` · `WAN` · `WiFi` · `Clientes` · `Avançado`

A faixa do topo (cliente, contrato, plano, situação) e os botões de *Liberação em confiança* e
*Abrir chamado* ficam **fora** do seletor de abas, então acompanham as cinco. O bloco
*Integração SGP*, com faturas e desvincular, mora dentro de **Visão geral**.

### 2.2 Configuração — quinze abas

| Aba | É de |
| --- | --- |
| Geral | o provedor |
| Painel e ACS | o provedor (o GenieACS dele, com credencial própria) |
| Parâmetros TR-069 | o provedor |
| Portal do cliente | o provedor |
| Integração SGP | o provedor (o ERP dele) |
| TeiaH Valid | o provedor |
| Integrações | o provedor |
| Ativação automática | o provedor |
| Chatbot | o provedor |
| WhatsApp | o provedor (a conexão Evolution dele) |
| Acesso da conta | a pessoa (senha, e-mail) e a equipe |
| Perfis de fabricante | o provedor — herdado do catálogo padrão da plataforma |
| Mapeamentos WiFi | o provedor — idem |
| Banco de dados | **o deploy** — escondido na edição hospedada |
| Sobre | versão e notas |

---

## 3. Console da plataforma — onze abas

Tudo atrás de dois guardas: sessão válida **e** estar em `platform_admins`. Quem não está
recebe **404**, não 403 — de propósito, para que um token de provedor não consiga distinguir
um deploy hospedado de um self-hosted sem console nenhum.

| Aba | O que decide |
| --- | --- |
| **Provedores** | criar, suspender, corrigir cadastro, personificar; a caixa da plataforma fica fora da lista |
| **Planos** | o catálogo que a vitrine mostra e que os provedores assinam |
| **Assinaturas** | o estado de cada provedor |
| **Receita** | o que entrou |
| **Cupons** | desconto |
| **Leads** | quem pediu contato na vitrine |
| **Acesso à plataforma** | quem tem a chave do console |
| **Trilha da plataforma** | ações sobre provedores |
| **Configurações** | do deploy |
| **Saúde do deploy** | edição, dialeto do banco, endereços, o que está configurado — nunca o valor |
| **Catálogo padrão** | de onde o provedor novo herda o catálogo de equipamentos |

Dentro da linha de um provedor, cinco painéis: equipe, plano, cadastro, gateway de pagamento
e GenieACS.

---

## 4. Portal do assinante

Aplicação à parte, com porta e sessão próprias (`portalApp`). O cliente final entra com o ID
de cliente e a senha do portal, e alcança o que é dele: dados da conexão, troca de senha do
WiFi e faturas quando o SGP está ligado.

Não compartilha sessão com o painel, e a origem é verificada (`portalOriginGuard`).

---

## 5. Quem enxerga o quê, por papel

Os quatro papéis e o que cada um abre, do mais restrito ao mais amplo:

| Papel | Alcança |
| --- | --- |
| **viewer** | três capacidades — lista de aparelhos, mapa e catálogo. Dos nove itens de menu, abre **três**: Operação, Inventário e Topologia |
| **tech** | o acima, mais inspecionar e escrever no aparelho, provisionamento, SGP, segredos do cliente — e `whatsapp.read`, que lhe abre WhatsApp e Contatos |
| **admin** | o acima, mais configuração, equipe, exportação, trilha, dossiê e exclusão de titular |
| **owner** | **as mesmas permissões de `admin`** |
| *administrador de plataforma* | não é papel, é uma chave à parte: soma-se ao papel que a pessoa tem no provedor dela |

**`owner` e `admin` não diferem em permissão** — `MATRIX` dá o mesmo conjunto aos dois
(`permissions.js:194-195`). O que `owner` tem a mais é poder sobre o próprio papel: só um
`owner` cria ou convida outro `owner`, e só ele rebaixa ou remove um. É regra de quem manda em
quem, não de qual tela abre — e o painel recusa remover o último `owner` de um provedor.

A permissão exigida por cada tela está na seção 2. A fonte é `backend/src/config/permissions.js`,
e `backend/test/role-reach.test.js` fixa o alcance de cada papel.

> A primeira versão desta tabela dizia que um `viewer` abre **dois** dos nove itens. Era erro de
> contagem minha: `devices.list` abre **duas** telas — Operação e Inventário —, não uma. Quem
> mede isso agora é `frontend/test/screens.test.ts`, que afirma exatamente quais três itens o
> papel alcança, em vez de confiar na conta de quem escreveu.
