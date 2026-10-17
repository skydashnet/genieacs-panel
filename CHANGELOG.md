# Changelog

TR69 Controle follows [Semantic Versioning](https://semver.org/). Release versions
are calculated from conventional commits since the previous release commit
(`chore(release): vX.Y.Z`); a `v*` Git tag counts too, when it names a newer version.

## [1.18.0] - 2026-09-26

### New

- Filter SSIDs by enabled/disabled on the device WiFi tab (`51e145f`)
- Contatos dos assinantes do SGP na caixa de entrada (`9eeb119`)
- Contatos de assinantes do SGP sem ONT no painel (`570a711`)
- Remember WiFi filter and add it to the customer portal (`87f9e14`)
- Filter device invoices by open / cancelled / other (`64030f1`)
- Sincroniza todos os clientes do SGP para os contatos do WhatsApp (`87d4f1d`)
- Usa /api/ura/clientes/ como listagem padrão de clientes (`5ff2bc3`)
- Open the WiFi tab on "Ativas" by default (`a3aca17`)
- Reorder the menu and give Plano its own icon (`92de914`)
- Escolher o centro do mapa clicando no mapa (`5e422ad`)
- Show the build commit next to the version; wrap invoice filter on mobile (`7980c92`)
- Show the session's provider (name and slug) in the menu header (`15e49f4`)
- Centro do mapa editável nas Configurações (`2403c9d`)
- Clearer WiFi password gap; console header says platform administrator (`d32cd46`)
- Endereço principal do provedor com ponto no mapa (`dee80bd`)
- Aba Geral própria para o endereço principal do provedor (`6164f82`)
- Cadastro completo do provedor na aba Geral (`f0ae6cf`)
- Preencher o cadastro do provedor pelo CNPJ (`04a80f7`)
- CEP, localizar no mapa, sede na Topologia e CNPJ no onboarding (`924f69c`)
- Remove an ONT from GenieACS from its device page (`d1f9977`)

### Fixed

- Know which networks are on, and stop counting unknown as disabled (`8b96264`)
- Torna a sincronização de contatos do SGP fácil de achar (`3143fc1`)
- Trocar tiles escuros do CARTO por OSM com filtro escuro (`2ce62cd`)
- Consulta de CNPJ com três fontes em cascata e motivo no log (`303e17c`)
- Longitude fora de ±180 ao arrastar para outra cópia do mundo (`5662fea`)
- Centro padrão em Brasília, não Jacarta (`6d01127`)
- Stop the old ONT from taking the account back after a swap (`0cebf6b`)
- Salvar da aba Geral grava só a aba, sem sincronizar IDs (`42469dc`)

### Maintenance

- O servidor que respondeu sem dizer o sabor não é "Respondeu ()" (`77d5af9`)
- O que o prazo zero custa, dito onde a decisão é tomada (`f0d036a`)
- O prazo da trilha deixa de ser uma constante no agendador (`2e647b6`)
- Apagar os mapeamentos de segurança WiFi, que nunca foram ligados (`46632e9`)
- Teto próprio para quem enfileira, e outro para quem enfileira em bloco (`13f9ca1`)
- O prazo da trilha ganha campo na tela (`e94e475`)
- Os números do painel que faltavam viram recorte da lista (`bc6f8f7`)
- Keep an unstable ONT pair dismissed while it keeps trading the login (`fc4fdce`)
- Dotenv 17→18, express-rate-limit 7→8 (`0538004`)
- O minuto gasto do envio passa a atravessar o processo (`c760bcb`)
- Reach the SGP contract for ONTs whose login the panel could not match (`c682609`)
- O provedor que sai leva os dados dele: exportação pelo console (`66513f1`)
- Há quanto tempo, e não desde quando (`17eb206`)
- Tag each ONT in GenieACS with its contract, customer ID, store and technician (`5b029b1`)
- O módulo SGP vem para o lado da conversa do WhatsApp (`9fa3514`)
- Show the ONT's WAN and LAN MAC on the device page (`24569d4`)
- Três leituras escritas duas vezes, e a segunda cópia errava (`8e95363`)
- A 2ª via e o número do assinante, a partir do módulo SGP da conversa (`410649f`)
- A fila ociosa do WhatsApp deixa de visitar provedor sem nada a enviar (`e20208a`)
- Liberação em confiança pela rota que o SGP atende: /api/ura/liberacaopromessa/ (`638df1d`)
- Código morto sai; e uma função "morta" era a que a tela devia usar (`3b556fe`)
- Read Nokia optics and WAN VLAN by name, and show what GenieACS holds (`b55e76f`)
- Fatura cancelada deixa de contar como "em aberto" (`6e4554c`)
- Drop a pasted Postman {{url}} from endpoint paths (`75e72b6`)
- SGP contacts: own deadline for the listing, background sync (`28a833e`)
- Botão "Abrir no SGP" no lugar de "Abrir roteador" no módulo SGP (`29d2881`)
- Cada número do WhatsApp tem a sua cor na caixa de entrada (`6924c9e`)
- Read the temperature from DeviceInfo.TemperatureStatus (`339f93f`)
- SGP contacts: read more listing shapes, keep partial runs, time each page (`850c415`)
- Save the contacts section's settings through PUT /config (`acd5b7e`)
- O topo da página de WhatsApp cabe numa linha (`27e10f9`)
- Read the PPPoE login off ZTE ONTs that never reported it (`234993d`)
- Contacts entry below the device inventory (`4544666`)
- O que o operador faz na ONT passa a deixar linha na trilha (`d13b984`)
- Read Nokia optics from X_ALU_OntOpticalParam (`5d6f892`)
- Reset de fábrica da ONT, confirmado pelo número de série (`65104b8`)
- Botões "Abrir no SGP" e "Chamar no WhatsApp" na tela do equipamento (`0c43a91`)
- Ping e traceroute pela ONT, no modelo de dados que ela fala (`f96037d`)
- Tela do equipamento: botões do topo em ordem alfabética (`89bad19`)
- Full SGP client record, editable in the panel (`7830723`)
- Reset de fábrica: exigir a senha do operador duas vezes (`4a7a82b`)
- Firmware da ONT pelo painel, com os arquivos do GenieACS (`253b0d9`)
- Export and import the base as a CSV spreadsheet (`604ca0e`)
- Boas-vindas: checklist "Primeiros passos" e conclusão guardada no provedor (`965880b`)
- Retry SGP link/contact upserts the database dropped for deadlock (`6252600`)
- Separar a configuração da plataforma da configuração de cada provedor (`3f6e87e`)
- Reiniciar vários equipamentos de uma vez (`f7fbe78`)
- Firmware em lote, com cada ONT conferida contra o arquivo (`ec4a478`)
- Assistente de boas-vindas: tela inicial, progresso, SGP, WhatsApp e resumo (`ec200ee`)
- Bot de autoatendimento: menu numerado, pedir atendente e liga/desliga (`99445ba`)
- Esconder "Painel e ACS" e "Parâmetros TR-069" do provedor na SaaS (`f04eead`)
- Login em duas etapas com app autenticador (`ae9d3cb`)
- O dono exige o login em duas etapas da equipe, e a equipe destrava quem perdeu tudo (`1ed75a1`)
- Send an open invoice to the client over WhatsApp (`2b7dc83`)
- Planilha do inventário: o recorte da lista de equipamentos em CSV (`fde9268`)
- Open the menu entry on the active subscribers (`8b9e76a`)
- Enviar o slug de confirmação ao apagar um provedor (`c3cd766`)
- Inventário: buscar pelo nome do assinante e pelo contrato SGP (`9ec1a01`)
- Alertas técnicos também por e-mail (`3d15c00`)
- Client record: one masked field per phone in the edit form (`44553e3`)
- Alertas técnicos também pelo Telegram, com o bot do próprio provedor (`dcf7b0b`)
- Configuração: aba "Sobre" com as informações do painel (`9207a0b`)
- Renomear o produto para "TR69 Controle" (`5029851`)
- Client record: open the client's WhatsApp conversation from the record (`ada0c00`)
- Separa provedores que dividem o mesmo GenieACS por tag de equipamentos (`2b41c6d`)
- Editar membro da equipe e mandar o link de senha pelo WhatsApp (`f7e8966`)
- Open the conversation on the number the client record shows (`d5414f5`)
- Marca sozinho as ONTs novas com a tag do provedor pelo prefixo PPPoE (`1576fe6`)
- Mais tipos de arquivo, colar print, arrastar e vários anexos de uma vez (`3a557f2`)
- Provedor sem tag num GenieACS compartilhado não vê mais a frota alheia (`fc3d942`)
- Contacts list: show the number the client record shows for ONT contracts (`204857f`)
- "Está funcionando?" vira um sino no canto superior (`d0fc752`)
- Link de senha e convite com endereço mesmo sem domínio-base (`0106a55`)
- Client record: open a WhatsApp conversation with any of the client's numbers (`4d1d4c6`)
- Corrige "Abrir o painel" do console num deploy de host único (`996e335`)
- WhatsApp no celular: lista ou conversa, botões em ícone, caixa de escrever enxuta (`6d05fe2`)
- Sessão de atendimento da plataforma com acesso total ao painel do provedor (`aaf0406`)
- Botões da conversa só em ícone também no notebook (`9870b95`)
- Sincronização de IDs de cliente: motivo real e frotas grandes (`ee53b8d`)
- Buscar endereço e adicionar ponto no lugar achado (`be67f72`)
- Portal do cliente: contato do provedor (`b4a076b`)
- Importar KML/KMZ (`5843707`)
- Find the previous release by its release commit, not by a tag (`a7185a5`)
- Exclude every release already cut, and run through a symlinked path (`793edcc`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/2771df9a8985...793edcc6cf0f)

## [1.17.0] - 2026-09-22

### New

- Let the bell ask the ONT for the optical object itself (`413dd6a`)
- Add Arabic, and make the layout direction-aware (`327b2a6`)

### Fixed

- Read the subscriber and the optical RX off the ONT itself (`f5ed5ee`)
- Block IPv4-mapped IPv6 in the SSRF guard (`a157a76`)
- Confine a request-supplied attachment path to the provider's outbox (`b6dda33`)
- Give every safeFetch a deadline (`9d0a617`)
- Cap the Evolution response body before it is buffered (`c3624df`)
- Authenticate an attachment upload before buffering its body (`875ac72`)
- Find the optical reading by its name, not by a guessed path (`c8297c8`)
- Count every provider, not the active ones, before sweeping the legacy area (`1b851af`)
- Refuse a database switch once a second provider exists (`0253f6b`)
- Require TLS for the Evolution server (`3f09a7b`)
- Honour NODE_ENV in the secret-box guard, and give a rotation a read window (`67cd4c7`)
- Keep the tenant insert guard across a chained builder (`60c2b89`)
- Put the name resolution under the request deadline (`d9a84be`)
- Translate the SGP blocked-host refusal into Hindi (`02ae65f`)
- Link by the login the ONT reports, not the one an account holds (`e347d7b`)

### Changed

- Delete the unreachable copy of the Evolution target check (`fb58445`)

### Maintenance

- Atualizar o plano de SaaS multi-tenant contra o que existe (`7f42926`)
- Onda 13: o plano de controle, e o contrato de quem tem a chave (`eea5421`)
- Resolve the provider from the host, and refuse a token replayed on another's (`bd1d13c`)
- Close the three SSRF holes before the ACS URL becomes customer data (`b31543b`)
- Onda 13: a tela do plano de controle, e a navegação que ela ainda não tem (`46f4258`)
- Onda 13: recusar catálogo duplicado dentro de um provedor (`262139e`)
- Onda 13: vincular alguém a um provedor, do plano de controle (`33a17ed`)
- Onda 13: quem tem a chave do plano de controle (`c9c960b`)
- Onda 13: o registro de provedores, e nascer igual a um do boot (`b0bbcbf`)
- Finish the session half of Phase 2, now that a host names a provider (`f78e174`)
- Show the membership row is already the revocation, instead of adding a counter (`2374450`)
- Arm a SQL sentinel under APP_ENV=test, so every test is a scoping test (`c07043c`)
- Onda 13: a sessão diz se a pessoa tem a chave (`518b0fc`)
- Onda 13: as costuras entre as quatro faixas (`e39b51f`)
- Pin the resolved IP for GenieACS, and let the login screen learn the name (`9a31863`)
- Onda 14: o contrato do provedor por subdomínio (`d3db129`)
- Give each provider its own GenieACS, with a credential and a ceiling (`546bfc2`)
- Onda 16: o portão da Fase 8 — 404 e não 403, varrido sobre as 24 rotas por id (`5e10de4`)
- Prove the switch guard let a lone provider through without opening a socket (`b136a5b`)
- Record the handful of actions that leave no trace in the data (`c1e1043`)
- Hand a provider its own data back, without handing over its secrets (`a530c85`)
- Onda 17 (backend): papéis reais, e a guarda dizendo o que a rota faz (`2b5ddf7`)
- Stop the outbound-limit tests from depending on the machine's resolver (`3e21b17`)
- Onda 17 (frontend): quatro papéis na tela, e a guarda perguntando o que a pessoa alcança (`9742d03`)
- Onda 18: o convite, e o buraco que a onda 17 deixou no papel de owner (`f4d6d65`)
- Onda 17 (teste): o alcance de cada papel, provado por HTTP (`9baa307`)
- Onda 19 (backend): a credencial com que o painel se apresenta à NBI (`46a82e1`)
- Onda 19 (frontend): a credencial da NBI na tela, e o campo de segredo sem ambiguidade (`6d2e789`)
- Onda 20: a trilha das ações sensíveis (`3b1a821`)
- Onda 21: levar o cadastro embora, e o "flake" da suíte finalmente diagnosticado (`aa738da`)
- Onda 22: apagar um provedor, com um registro que sobrevive a ele (`a92da4e`)
- The checklist has no open line left, and say what the order of delivery became (`e76ddac`)
- Pin the DNS case to a name, so an IP literal cannot mute it (`912188c`)
- Login por e-mail (backend), em três passos e sem dia de virada (`7d2d51f`)
- Decide "is this production?" in one place, and honour both variables (`afd3c21`)
- Make suspending a provider take effect without a restart (`5a93d35`)
- Record who was put into an ISP's team, and who took them out (`e887306`)
- Fecha o espaço de nomes nas três portas que faltavam (`c01c3fd`)
- Login por e-mail (painel), sem dia de virada na tela (`4918578`)
- Add Hindi to the panel, the portal and the API (`bb7c250`)
- Fase 5: planos, limites e o ciclo de vida da assinatura (`0d11989`)
- Close both SSRF holes, on one table and one pinned transport (`f284343`)
- Add the Hindi string for the blocked-host SGP error (`352597f`)
- Give Hindi the key that landed while it was being written (`4750a99`)
- Print which tests failed, and keep the stream that says so (`676aca6`)
- Frontend do login por e-mail, e o merge com a main que o CI já testava (`1dbf9e8`)
- Fase 6: the provider's own frontend — name, sign-up, onboarding, plan (`e09e577`)
- Segundo merge com a main, e a lacuna de i18n que era dela (`2a1f2a8`)
- Drop the duplicate Hindi blocked-host key (`e39a7a4`)
- Put the clock, the operator's choice and the generated password back in charge (`69d57b2`)
- Fase 4: o conector do GenieACS, e o fim das sete cópias (`f8e2596`)
- Fase 7: operate the hosted edition — logs and metrics per provider, front door, deploy (`cfadc49`)
- Fase 4: o painel deixa de ser atualizado para quem não está olhando (`43d4058`)
- Avalia a devices_summary e fecha o muro de escala (`958dae3`)
- Compile the backend's native dependency in its own image stage (`34ea59d`)
- Make the email switch one switch, and the operators screen speak every language (`12252a5`)
- Give the new switch cases their own file, and the old one its tests back (`38518c5`)
- Fase 8: count the doors, and answer for every one of them (`7e7908d`)
- Give the backend's postinstall the file it needs to decline (`1151b26`)
- Fase 5: o portão comercial, e onde ele NÃO pode ficar (`116e277`)
- Fase 5: os limites, e o convite por onde eles escapariam (`76982ca`)
- Fase 5: o extrato comercial, e a coluna que precede o gateway (`943ed3b`)
- A porta da assinatura sai de cima do 401 (`bf5d6a0`)
- Impersonation, with its own audience and a ticket to carry it across hosts (`2c174fb`)
- Send the invite by email, where a deployment has somewhere to send it (`556552b`)
- Credit a payment reference once, and seed only the provider being born (`e4c93ac`)
- Ask Postgres for the index by name, not by scanning every schema (`35459df`)
- Give the frontend a test runner, and the first tests worth having (`eab6a93`)
- The screens the invite and the impersonation were missing (`d1a0654`)
- Tell Postgres the parameter is text (`9cb7dad`)
- RLS no Postgres: implementado, e desligado por padrão (`f693f33`)
- Read the provider before filtering the menu by it, and never show a black page again (`0952fb4`)
- Let the webhook's own pass settle an SGP event before the test reads the link (`6a23298`)
- Redefinir a senha por e-mail, e provar o endereço antes de mandar (`d6bd503`)
- O webhook do Evolution deixa de ser suposto (`4192351`)
- A volta: o painel se chama pela porta da frente (`30761f4`)
- Gerenciar planos, acesso e a trilha pelo console — as telas que faltavam (`c3d63eb`)
- Console da plataforma em russo, chinês e japonês (`62565c7`)
- Console da plataforma em espanhol, francês, alemão e italiano (`faebc44`)
- Console da plataforma em coreano, árabe e híndi — os treze fechados (`29811d9`)
- A tela pedia um host e o código exigia um caminho (`e8cccf0`)
- O cadastro do console se administra pela tela, e o último não sai (`d470a90`)
- O campo mostra o que ficou gravado, não o que foi digitado (`dc73f94`)
- O fallback do SPA resolve sob root, e não por caminho absoluto (`621363a`)
- A trilha do provedor ganha tela, e os dados do provedor ganham botão (`b9c7ba6`)
- O painel do provedor abre em outra aba, e o console fica onde estava (`eab385b`)
- O período pago vence, como o teste já vencia (`0067d7f`)
- E a tela para de prometer o que o painel já não cumpre (`d8da7f9`)
- A personificação abre sempre em outra aba, e a sessão dela é só da aba (`117a930`)
- O provedor ganha cadastro fiscal, e ele sai junto quando o provedor sai (`c733bda`)
- O cadastro manda a prova do endereço, e a poda deixa de ser promessa (`51d27b3`)
- O cadastro de um provedor deixa de ser definitivo (`c08224e`)
- A campanha parava de garrar no dia em que alguém revisava o rascunho (`5866a8d`)
- O eco do próprio envio era lido como falha, e a mensagem saía de novo (`8922e4e`)
- Duas credenciais que saíam por onde não deviam (`d4a4749`)
- O teto de assinantes valia só na varredura, e o pagamento repetido não se via (`c4a7883`)
- Os documentos param de mentir, e a guarda de egresso para de depender do .env (`97b9de5`)
- Um provedor bloqueava os outros, e a tela mentia em três lugares (`25d0202`)
- O lote do webhook não tinha prazo, e o anexo sem linha ficava no disco (`1b8b284`)
- A personificação vale para qualquer provedor, e não só para o primeiro (`79d4dc5`)
- Um provedor novo passa a ter como receber a primeira conta (`da5cd2f`)
- O GET que aposentava conta de assinante sem trilha e sob personificação (`98ec89b`)
- O painel avisa antes de bloquear (`691d95b`)
- A ação nova da trilha não tinha frase, e o portão local não olhava o frontend (`6e1d8da`)
- O endereço da plataforma roteia o console, e recusa sessão de provedor (`6d757d5`)
- O assinante ganha os dois direitos que a LGPD lhe dá (`0df18dc`)
- A trilha e a exclusão passam a dizer quem, e a exclusão passa a levar o disco (`a16c864`)
- O prazo corria na fila, o teto era do processo, e havia uma porta sem muro (`272d860`)
- O backup deixa de ser um parágrafo do runbook (`c2f136a`)
- O pagamento de um provedor deixa de ser um botão (`890db55`)
- A sessão do console existe, e ela não pertence a provedor nenhum (`a730cf4`)
- O console ganha casca própria, e o painel de um provedor não a empresta (`5fe7471`)
- O eco da nossa própria mensagem virava uma segunda bolha na conversa (`ce25127`)
- O console deixa de ser servido no host de um provedor (`7e78cc6`)
- A retenção passa a valer para provedor suspenso, que guardava para sempre (`4b80c84`)
- A rotação da SECRET_BOX_KEY passa a ter a metade que faltava (`c6feb69`)
- O painel passa a pedir o dinheiro, e não só a recebê-lo (`39f8068`)
- O proxy que o SaaS exige deixa de ser exercício do leitor (`1db6a92`)
- A conta que opera a plataforma não é membro de provedor nenhum (`416d5a4`)
- Desde quando o provedor está suspenso, que ninguém conseguia responder (`288e127`)
- Os dois documentos voltam a dizer a verdade sobre o que existe (`4fa5cb3`)
- O valor pago deixa de ser enfeite do extrato (`8c3da7d`)
- O endereço de um provedor novo, em um comando (`2721dd7`)
- Dois testes da cadência paravam de correr contra o relógio (`09ae84b`)
- O relógio parado tem de parar no presente, não em 1970 (`fd35c76`)
- O script achava o arquivo de ambiente de um só dos dois deploys (`2ea605d`)
- O script deixa de exigir um nginx já preparado para o desafio (`55128ed`)
- O prazo do teste da fila tinha 40 ms para uma ida ao banco (`cdca88d`)
- No host único, o que é anônimo apontava para o primeiro provedor (`abdb3ea`)
- O login pergunta onde entrar, e a porta não veste o primeiro provedor (`e576d48`)
- O SQLite sai do modo em que um leitor tranca um escritor (`b0fb165`)
- O provedor bloqueado passa a ter onde pagar (`73d5e98`)
- A plataforma ganha o próprio provedor (`848403e`)
- A barra lateral diz qual chapéu se está usando (`8b4902e`)
- O console passa a mostrar a saúde do deploy (`b37fea5`)
- O console passa a criar a conta de um provedor administrado (`fa7b6aa`)
- O onboarding sugere o GenieACS do provedor (`a9edb5b`)
- O runbook da migração ganha o caminho de quem não tem curinga (`d195034`)
- O catálogo padrão de equipamentos é o da plataforma (`880eed1`)
- A sonda de configuração ganha credencial própria, senão ela mentiria (`d640274`)
- Testar a integração com o Evolution, com zero números conectados (`912c962`)
- O caminho do webhook nas linhas gravadas antes da garantia existir (`38abcf5`)
- O diagnóstico passa a dizer quando os dois lados não batem (`1599d6d`)
- O webhook que a tela dizia saudável e não entregava nada (`ff7a116`)
- A faixa do cliente no topo da tela do aparelho (`7cfc5c3`)
- Liberação em confiança e Abrir chamado também no topo (`03655f6`)
- Os números do painel levam à lista que eles contam (`f397f01`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.16.0...v1.17.0)

## [1.16.0] - 2026-09-10

### New

- Record device signal and uptime over time (`b9125dc`)
- Chart a device's readings on its page (`928d790`)
- Carry a subscriber's SGP link onto the ONT that replaced theirs (`f5ba01b`)
- Add an in-repo QR encoder with golden vectors from an independent oracle (`afb21d6`)
- Draw the Pix QR code and give Pix its own field (`68808c3`)
- Open a support ticket in the ERP from an ONT's page (`bb8b570`)

### Fixed

- Complete the Russian dictionary (`27500c9`)
- Truncate the inform to whole seconds before storing it (`6f85f9b`)
- Drop the Russian keys the last two merges each added (`39ce403`)

### Maintenance

- I18n: traduzir para russo as chaves da onda 7 (`5077277`)
- Onda 8: contrato, configuração e traduções compartilhadas (`af2aa4d`)
- Onda 8: sgp_links por provedor (`1a8944c`)
- Onda 8: retenção do histórico e o botão que a varredura nunca teve (`ff2af73`)
- Onda 8: subárvore de mídia por provedor, e a varredura por provedor (`dafb791`)
- Onda 8: remover as duas chaves de backend sem consumidor (`207e54c`)
- Onda 8: o botão de limpeza varre só o provedor que o apertou (`b2ffcf6`)
- Onda 8: cobrir o upgrade de sgp_links num banco que já tem linhas (`40551a2`)
- Onda 9: base compartilhada — recuo, índices e o contrato (`eb4d5ef`)
- Onda 9: a saúde tem de distinguir recuo de fila parada (`a77ecb2`)
- Onda 9: reenviar é devolver a linha à fila (`d0df4bc`)
- Toda mensagem recebida era arquivada no primeiro provedor (`a84d687`)
- Onda 9 (faixa A): a fila recua em vez de queimar as tentativas (`e27e36d`)
- Onda 9: a campanha também espera, e a costura do lote (`9b9d668`)
- Onda 10: as quatro migrações por provedor (`07e569b`)
- Onda 10: o mapa por provedor (`1ccbe2e`)
- Onda 10: provisionamento por provedor (`e0f7b9e`)
- Onda 10: o log de eventos do SGP por provedor, e a entrega que se identifica (`207f4c2`)
- Onda 10: as datas de instalação por provedor, e a varredura de Customer ID em laço (`5472e17`)
- Onda 10: o reaper de boot passa a rodar por provedor (`e607404`)
- Onda 10: o agendador inteiro passa a rodar por provedor (`ad3844f`)
- Onda 11: a migração do catálogo de equipamentos (`76a0c01`)
- `whereLike` quebra no MySQL contra coluna utf8mb4 (`ca3f0f2`)
- Onda 11: as credenciais de WiFi do assinante, por provedor (`ea2bb6d`)
- Onda 11: o catálogo de equipamentos por provedor (`f8a80fa`)
- Onda 11: validada nos três bancos antes de empurrar (`9caa1cd`)
- Onda 12: a ponte de vínculo, e o contrato do que o token carrega (`2b2c9b1`)
- Onda 12: a espinha de autenticação — o token nomeia o provedor (`eefcb15`)
- Onda 12: /api/users passa a ser a equipe de um provedor (`cb04538`)
- Onda 12: fechar a brecha do vínculo encerrado, e reconciliar com a faixa B (`b6a7ff0`)
- Onda 12: dizer que a guarda do último admin não é alcançável pela rota (`b02f965`)
- Onda 12: `users` e `tenant_users` são do deploy, e agora está escrito (`134a319`)
- Cover the upgrade path of the last three tenancy steps (`2fe76d1`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.15.0...v1.16.0)

## [1.15.0] - 2026-09-09

### New

- Add provisioning and SGP event storage (`7490fae`)
- Read the PPPoE password and normalize SGP events (`b4067b6`)
- Add the write primitives provisioning composes (`8a8d18a`)
- Apply the SGP contract profile to a CPE (`4ca67f2`)
- Ingest SGP events by webhook and by reconciliation (`fb0d246`)
- Add Italian (`c7107e4`)
- Add the activation and SGP event surfaces (`6f74052`)
- Lay the foundation for the Evolution API integration (`b76cace`)
- Run the backend on PostgreSQL, and prove it in CI (`d10daa1`)
- Add the Evolution HTTP client and the wave 1 message keys (`c7766dd`)
- The Evolution instance lifecycle (`314df6d`)
- Inbound handlers and the outbox worker (`efa7042`)
- Make customer accounts belong to a provider (`4dbe6b7`)
- The dunning renderer, the SGP phone, and the wave 2 surface (`2bc7817`)
- Conversation reads and the subscriber resolver (`67c2e3c`)
- Technical alerts, and the rules that keep them readable (`6cf7f82`)
- Technical alerts, and the message bodies they were missing (`7090e0d`)
- The billing cadence — templates, campaigns and the flush loop (`ab71cb7`)
- O bot de autoatendimento (`8a0dff5`)
- The settings tab, the number cards and the QR pairing (`36fa2e1`)
- The portal URL on the settings form, and a delete warning that says what to do (`73eee6e`)
- The inbox route, and the vocabulary its screen will need (`22a813e`)
- The mechanism that scopes a query to one provider (`bc24934`)
- Scope the three tables that delete without a where clause (`bf53a7b`)
- The operator's inbox screen (`0b2c487`)
- The two refusals the inbox could provoke but not name (`8a87dde`)
- Make subscriber accounts answer only to their own provider (`061616f`)
- The two screens where a campaign's text is decided (`f92c3b4`)
- The alerts screen, where four thresholds are four different units (`a4009d8`)
- Give the WhatsApp inbox and send queue a provider (`088e951`)
- The billing cadence and the campaigns list (`f02b1f5`)
- Campaigns and the alert cooldown belong to a provider (`1c3c5a8`)
- One page, six tabs — the operator's whole WhatsApp surface (`4bf39f4`)
- The shared ground for wave 5 — a message's origin, and the words for the rest (`b57f2cf`)
- Closing a thread, and finding one (`3dd452a`)
- Let an operator correct a subscriber's number (`97137a2`)
- Give the configuration pair a provider (`c542636`)
- The shared ground for wave 6 — attachments, and where each audience fetches them (`5c3f809`)
- The operator's file — upload, allowlist, and a composer that carries it (`392c43a`)
- A stored attachment becomes one somebody can open (`2930786`)
- A real page back through a thread (`d3e959e`)
- Add Korean and repair the Traditional Chinese drift (`69e0f5b`)
- The shared ground for wave 7 — a retention window and one honest health read (`c373702`)
- Add Russian, and undo the zh-TW duplication two merges caused (`9151ccd`)
- Give each provider its own caches, and release the two jobs that can go (`a0d9527`)
- The attachment sweep — the first thing here that deletes (`640a71e`)
- One read that answers "is this working?", and a strip that says it (`718bf28`)
- The sweep tells the strip, and the strip stops scanning (`21609c1`)

### Fixed

- Close the gaps found in the second codebase analysis (`756a29a`)
- Make MySQL usable and JWT_SECRET rotatable (`689efbe`)
- Derive the copied-table list from the schema, and refresh the plan (`9bc490c`)
- Three ways the alerts and the templates lied, and the codes that hid it (`4f77c28`)
- The alerts form was about to speak the campaign's sentence (`5a00cd0`)
- The reason a build refused, and a timestamp typed as a lie (`977ceda`)
- The bot's ceiling counts the bot, and nothing else (`d12dc3f`)
- The dedupe belt was also mistaking a campaign for an answer (`e2867fb`)
- The panel could not serve itself from a path containing a dot (`3f3376f`)
- One error map for everybody, and a file with nothing in it (`9c1062c`)
- The limiter next to its sibling, and a disk path the browser never needed (`8f235a6`)
- Twenty-one keys that were declared twice, and the check that would have caught them (`af09eb2`)
- Wire the retention window the config was only pretending to have (`06ec4c3`)
- MySQL keeps whole seconds, and three health tests were asserting milliseconds (`8efb5ca`)
- Complete the Russian dictionary (`37f0b90`)
- Point the comparison links at this repository (`e0d3ff1`)

### Maintenance

- Deepen the multi-tenant plan with verified code findings (`7b3e05f`)
- Drop the stale note about hardcoded portal messages (`bdd16e7`)
- Cover activation and SGP event handling (`5241ad2`)
- Document activation and event handling (`e9fc591`)
- Merge branch 'main' and translate the new strings into Italian (`305c27f`)
- Name the migration that creates the tables (`011c107`)
- Add German as a fifth interface and API language (`f16fdc1`)
- Ignore the harness agent worktrees (`f7575b2`)
- Add French as a sixth interface and API language (`e395bcb`)
- I18n: French for everything this branch added (`5ce9880`)
- Add Japanese as a seventh interface and API language (`fdc12b3`)
- I18n: the vocabulary for the screens of wave 4 (`f69408c`)
- Add Simplified Chinese as an eighth interface and API language (`030dff3`)
- Add Traditional Chinese as a ninth interface and API language (`32d137c`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.14.0...v1.15.0)

## [1.14.0] - 2026-09-08

### New

- Issue an independent password for each customer account (`ac6157c`)
- Integrate subscriber contracts and billing from SGP (`675f2dc`)
- Add multi-language support with pt-BR, en and es (`ab7b32b`)
- Translate network map and customer portal (`61d9831`)
- Translate the settings page (`5d4574f`)
- Translate the device detail page and document languages (`74744a3`)
- Translate the API responses (`2cf15ca`)
- Surface contract state across the device fleet (`00dd64b`)
- Reconcile the ONT fleet against SGP contracts (`a88e62d`)

### Maintenance

- Add the multi-tenant SaaS conversion plan (`7071b38`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.13.1...v1.14.0)

## [1.13.1] - 2026-07-26

### Fixed

- Bootstrap legacy CLI updates (`5e2c9d5`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.13.0...v1.13.1)

## [1.13.0] - 2026-07-26

### New

- Added explicit Customer ID synchronization when settings are saved, with immutable identity preservation and accurate generated, preserved, and pending counts.
- Added writable WAN parameter discovery across ZTE, Huawei, CMCC, and FiberHome conventions, including name, VLAN, PPPoE credentials, service list, connection mode, NAT, and interface bindings.

### Changed

- Migrated the frontend to React 19 and React Router 8.
- Raised the supported runtime to Node.js 22.22 and updated both install and CLI update flows to replace older runtimes automatically.

### Fixed

- Fixed disabled or read-only WAN fields when the ONT reports writable parameters.
- Fixed misleading WAN task responses when no values changed.
- Fixed Customer ID preservation counts when a stable SoftwareID and PPPoE identity moves to a new GenieACS device ID.

### Security

- Removed the affected React Router 7 dependency line and verified zero production dependency vulnerabilities.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.12.0...v1.13.0)

## [1.12.0] - 2026-07-25

### New

- Expand customer operations and device management (`6bf6a8e`)

### Maintenance

- Redesign project readme (`feea67e`)
- Add product screenshots and community badges (`97ef8d6`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.11.0...v1.12.0)

## [1.11.0] - 2026-07-24

### New

- Added customer self-service controls for changing the SSID and WiFi password reported by each ONT.
- Added encrypted recovery of the last password changed through the portal, with explicit eye controls for on-demand reveal.

### Fixed

- Normalized GenieACS boolean variants so enabled WiFi radios no longer appear disabled in the operator panel or customer portal.

### Security

- Bound every portal WiFi mutation and password reveal to the authenticated customer account, with dedicated rate limits and no client-supplied device target.
- Protected saved WiFi passwords with AES-256-GCM and kept decrypted values out of overview responses and process caches.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.2...v1.11.0)

## [1.10.2] - 2026-07-24

### Fixed

- Bind overview cache independently of request context (`d940608`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.1...v1.10.2)

## [1.10.1] - 2026-07-24

### Fixed

- Deduplicate global toast notifications (`f10067e`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.0...v1.10.1)

## [1.10.0] - 2026-07-24

### New

- Added an isolated customer portal on port 5891 with safe ONT and WiFi status.
- Added immutable, database-backed Customer IDs bound to SoftwareVersion and PPPoE identity.

### Fixed

- Loaded the map engine and topology concurrently, bundled Leaflet CSS locally, and centered existing assets at zoom 15.

### Security

- Hardened session revocation, route isolation, origin checks, rate limits, CSP, and deployment secrets.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.2...v1.10.0)

## [1.9.2] - 2026-07-24

### Improved

- Render cached charts without Recharts (`321ab4b`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.1...v1.9.2)

## [1.9.1] - 2026-07-24

### Fixed

- Keep desktop sidebar anchored while scrolling (`9eef4fd`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.0...v1.9.1)

## [1.9.0] - 2026-07-24

### New

- Add Git-derived version and changelog UI (`ffae6ab`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.8.5...v1.9.0)

## [1.8.5] - 2026-07-24

### New

- Rebuilt the panel as a lightweight Vite single-page application.
- Added production installer and self-updating `skygenpanel` management CLI.
- Added branded navigation, responsive operator UI, and selectable map layers.
- Added full physical topology management for HTB, OLT, ODC, ODP, ONT, and fiber cables.
- Added typed WiFi configuration tasks compatible with installer virtual parameters.
- Added fleet analytics and the GenieACS fault queue.

### Fixed

- Prevented blank screens caused by GenieACS metadata objects reaching React.
- Preserved the Leaflet map and viewport across topology refreshes.
- Removed stale Next.js artifacts during updates.
- Hardened production headers, dependency bootstrapping, and static asset delivery.

[Full history](https://github.com/skydashnet/genieacs-panel/commits/main)
