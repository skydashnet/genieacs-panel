# Com quem o dado pessoal é compartilhado

Esta é a lista de destinos externos que o código do SkyGenPanel alcança, e o que sai para cada
um. É a matéria-prima de três documentos: a política de privacidade do site (`/privacidade`), o
anexo de operador (`docs/anexo-de-operador.md`) e o modelo de aviso ao assinante
(`docs/modelo-de-aviso-ao-assinante.md`).

**Isto não é parecer jurídico.** Descreve o que o código faz. Ele foi lido, não executado contra
os serviços de terceiros: onde diz "sai X", X é o que o código monta para enviar, e não uma
garantia sobre o que o terceiro faz com isso depois.

## Como esta lista se mantém verdadeira

Uma lista de compartilhamento escrita à mão envelhece no primeiro `fetch` novo: alguém acrescenta
uma chamada a um serviço, a lista continua dizendo o que dizia, e o titular lê um documento
incompleto sem que nada avise. O guarda é `backend/test/sharing-list.test.js`: ele varre a fonte
do backend e do frontend atrás de endereços `https://…` e exige que **cada host** esteja nesta
página ou numa lista de exceções do teste, com o motivo escrito. Host novo sem decisão quebra a
suíte.

O que o teste **não** alcança, e por isso está dito aqui: endereços que o provedor digita numa
tela (o ERP dele, o servidor do GenieACS, o servidor Evolution, o provedor de IA quando ele
troca o padrão). Esses não estão no código; estão nas linhas 1, 2, 4, 5 e 8 da tabela B, descritos
pelo que fazem e não por um endereço.

## Quem escolhe o destino

- **Nós** — decisão da plataforma, igual para todos.
- **Fixo no código** — o endereço está escrito no código; nem nós nem o provedor o trocam por
  uma tela.
- **Provedor** — o administrador do provedor configura numa tela de Configuração.
- **Deploy** — quem tem o servidor, por variável de ambiente.

---

## A. Dado da plataforma — aqui o controlador somos nós

Quem é titular: o interessado que pediu contato na vitrine, o operador do painel e o cadastro
fiscal do provedor.

| Destino | Quem escolhe | O que sai | Quando |
| --- | --- | --- | --- |
| **Nossa equipe, por e-mail e por WhatsApp** | Nós (destinos no perfil da plataforma) | nome, empresa, e-mail, telefone, cidade e mensagem do pedido de contato | a cada pedido enviado pelo formulário da vitrine |
| **Asaas** (`api.asaas.com`; `api-sandbox.asaas.com` em teste) | Fixo no código | razão social, CPF/CNPJ, e-mail, telefone e endereço de cobrança **do provedor** | ao cadastrar o provedor como cliente do gateway |
| **BrasilAPI**, **CNPJ.ws** (`publica.cnpj.ws`) e **ReceitaWS** (`receitaws.com.br`) | Fixo no código | o CNPJ digitado | no cadastro, para preencher a empresa; alcançável também pela rota pública `GET /api/public/cnpj`, sem login |
| **BrasilAPI** (`brasilapi.com.br`) e **ViaCEP** (`viacep.com.br`) | Fixo no código | o CEP digitado | para preencher o endereço |
| **Provedor de SMTP** | Deploy | e-mail do operador e o texto da mensagem (convite, recuperação de senha, verificação, avisos de cobrança) | a cada e-mail transacional enviado |
| **Provedor de infraestrutura em nuvem** | Nós | tudo o que o serviço armazena | continuamente — é onde o serviço roda. **O nome do fornecedor não está no código; preencha ao publicar.** |
| **OpenStreetMap** (`tile.openstreetmap.org`) ou **Google** (`mt1.google.com`) | O operador escolhe o mapa-base na tela | o endereço IP do navegador do operador e as coordenadas da área que ele está vendo | quando o operador abre um mapa; é o navegador que pede as imagens, não o servidor |
| **Meta** (`connect.facebook.net`, `graph.facebook.com`, `www.facebook.com`, `web.facebook.com`, `staticxx.facebook.com`) | Fixo no código | no navegador do operador: o script da Meta e a identidade do operador no Embedded Signup; no servidor (`graph.facebook.com`): o identificador da conta WhatsApp Business (WABA), o endereço de retorno do webhook do painel e o token de verificação; o token de acesso vai em cabeçalho | só quando o provedor conecta o WhatsApp oficial (API da Meta) |

---

## B. Dado do assinante — o controlador é o provedor; nós somos operador

Estes destinos recebem dado de **assinante**, que é do provedor. Quem decide ligá-los é o
provedor (ou, nos dois primeiros, a edição do produto), e o provedor é quem precisa nomeá-los no
próprio aviso. O modelo está em `docs/modelo-de-aviso-ao-assinante.md`.

| # | Destino | Quem escolhe | O que sai do painel | O que volta | Condição |
| --- | --- | --- | --- | --- | --- |
| 1 | **Servidor GenieACS** | Edição: na **SaaS a plataforma o hospeda** (nós somos operador do ACS de cada provedor); o console pode marcar que o provedor usa o **próprio** servidor. Na instalação própria, é sempre do provedor | comandos TR-069 e consultas aos aparelhos | telemetria, identificadores e estado da ONT | sempre que o painel opera aparelhos |
| 2 | **Servidor Evolution** (a ponte para o WhatsApp) | Na **SaaS é um servidor único da plataforma** para todos os números; na instalação própria, do provedor | o telefone do assinante e o conteúdo das mensagens, anexos inclusos | as mensagens recebidas | enquanto o WhatsApp do provedor estiver ligado |
| 3 | **WhatsApp / Meta** | Provedor | as mesmas mensagens, pela rede do WhatsApp | — | conversa com o assinante (a rede do WhatsApp é um terceiro por natureza do canal) |
| 4 | **SGP** (ERP do provedor) | Provedor (URL e token dele) | consultas sobre o assinante (a chave da consulta depende da função) | nome, documento, telefone, endereço, plano, situação, faturas | integração ligada |
| 5 | **Provedor de IA** — escolhido pelo provedor: compatível com OpenAI (padrão `api.z.ai`, modelo `glm-4.5-flash`) ou Claude (`api.anthropic.com`, Anthropic) | Provedor (endereço, chave e modelo dele; o padrão do código é a Z.ai) | o conteúdo da conversa, **os códigos de pagamento da fatura consultada (PIX, linha digitável e link)**, **inclusive o CPF/CNPJ quando o assinante o digita** — o robô é instruído a pedi-lo para identificar o titular | a resposta | atendimento por IA ligado e com chave |
| 6 | **TeiaH Valid** (`api.valid.teiah.ai`) — exportação | Provedor | **endereço** (rua, número, bairro, cidade, UF, CEP), **valor devido** e meses de início e cancelamento de contratos cancelados com faturas em aberto. O código afirma que **nunca** envia nome, documento nem telefone | — | exportação ligada |
| 7 | **TeiaH Valid** — consulta de documento | Provedor | o **CPF/CNPJ** consultado | nome, nome da mãe quando houver, e-mails, telefones e endereços da pessoa | uso da consulta no cadastro de cliente |
| 8 | **Focus Chat** (`api.focuschat.com.br`) | Provedor | nada do assinante: o painel só **lê** a agenda de contatos | os contatos | integração ligada |
| 9 | **Telegram** (`api.telegram.org`) | Host fixo; bot e grupo escolhidos pelo provedor | o texto do alerta. O código do cliente afirma que o alerta nomeia equipamento e não sabe de assinante; **não audito cada alerta** | — | canal ligado |
| 10 | **Nominatim / OpenStreetMap** (`nominatim.openstreetmap.org`) | Fixo no código — **o provedor não pode desligar** | o **endereço do assinante** (número, rua, cidade, UF e CEP) para obter coordenadas; e o texto digitado na busca de lugares da Topologia | as coordenadas | ao localizar o assinante no mapa |

---

## O que esta lista ainda não resolve

- **Não nomeia o fornecedor de nuvem**, porque o código não o conhece.
- **Não há campo, hoje, para o provedor publicar a própria política.** A política do site fala do
  que somos controladores; o aviso ao assinante é do provedor, e o painel não tem onde guardar
  o endereço dele. É decisão de produto, não feita.
- A linha 10 é a única em que o provedor não tem como impedir o envio do endereço do assinante.
- A linha 9 e o conteúdo do `payload` de `platform_alerts` não foram auditados campo a campo.
