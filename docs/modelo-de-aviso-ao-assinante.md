# Modelo de aviso de privacidade ao assinante

> **Para o provedor adaptar e publicar em nome próprio.**
>
> O controlador do dado do assinante é **o provedor**, e não a plataforma. Este texto é um ponto
> de partida: a plataforma **não o publica por você** e não deve aparecer como autora dele —
> trocar o controlador do dado é justamente a confusão que a LGPD pune. Publique no seu site,
> no seu portal de atendimento ou onde o assinante o encontre antes de coletar o dado (art. 9º).
>
> **Não é parecer jurídico** e não foi revisado por advogado. Os trechos entre colchetes `[ ]` são
> seus; as marcas **(jurídico)** pedem decisão de quem entende de direito. Para preencher com
> precisão, use:
> `docs/lgpd-inventario-de-dados.md` (o que o painel guarda e por quanto tempo) e
> `docs/lista-de-compartilhamento.md` (para quem o dado vai).
>
> O painel **ainda não tem um campo** para o endereço deste aviso; hoje ele precisa ser divulgado
> por você, fora do painel.

---

## Aviso de privacidade — [nome do provedor]

*Última atualização: [data].*

### 1. Quem somos

[Razão social], CNPJ [ ], com sede em [endereço], é o responsável pelos seus dados pessoais
(controlador) quando você é nosso cliente. Para falar sobre eles: [e-mail / telefone / canal].
[Encarregado pelo tratamento de dados, se houver: nome e contato. **(jurídico)**]

### 2. Que dados tratamos

Conforme os serviços que usamos para atendê-lo:

- **Cadastro e contrato:** nome, documento (CPF/CNPJ), telefone, endereço, plano, situação do
  contrato, faturas.
- **Acesso:** o identificador da sua conta e, se você usa o portal do assinante, a senha dele
  (guardada de forma cifrada).
- **Seu equipamento:** identificador da ONT, sinal, temperatura e estado do aparelho,
  histórico de troca de equipamento. [Se você usa a senha de WiFi guardada para suporte,
  diga.]
- **Atendimento por WhatsApp:** seu telefone, as mensagens trocadas e os arquivos que você enviar,
  a avaliação do atendimento. [Se usa atendimento por robô ou IA, diga.]
- **Localização:** a posição da sua instalação na nossa rede de fibra, obtida do endereço
  cadastrado.
- **Indicações:** se você foi indicado por um cliente, seu nome e telefone.

### 3. Para quê, e com que fundamento **(jurídico)**

[Para cada finalidade, o fundamento do art. 7º da LGPD que o provedor adota. Exemplos de
finalidade: prestar o serviço contratado e cobrar; suporte técnico e diagnóstico da conexão;
atendimento; cumprir obrigações legais e regulatórias; avisos de manutenção e de cobrança.]

### 4. Com quem compartilhamos

Marque apenas o que **você** usa, e apague o resto. Cada linha corresponde à tabela B de
`docs/lista-de-compartilhamento.md`.

| Se você usa… | Escreva no aviso |
| --- | --- |
| O painel SkyGenPanel | "Usamos o SkyGenPanel, operado por [razão social da plataforma], para administrar a rede, o atendimento e o cadastro, o que inclui armazenar seus dados em infraestrutura dessa empresa." |
| WhatsApp | "O atendimento por WhatsApp passa pela rede do WhatsApp (Meta) e por um servidor de integração operado por [a plataforma / nós]." |
| SGP (ou outro ERP) | "Seus dados de contrato e cobrança ficam no nosso sistema de gestão, [nome do ERP]." |
| Atendimento por IA | "Parte do atendimento é feita por inteligência artificial fornecida por [nome do fornecedor]. O conteúdo da conversa é enviado a ele, **inclusive o CPF/CNPJ se você o digitar.** [Oriente o assinante a não digitar dados desnecessários.]" |
| TeiaH Valid, exportação | "Compartilhamos com a base TeiaH o **endereço** e o valor devido de contratos cancelados com faturas em aberto. Não enviamos nome, documento nem telefone." **(jurídico — é compartilhamento de dado de inadimplência.)** |
| TeiaH Valid, consulta | "Consultamos o seu CPF/CNPJ na TeiaH para obter dados cadastrais ao abrir um novo cliente." **(jurídico)** |
| Focus Chat | "Lemos a agenda de contatos do nosso sistema de atendimento Focus Chat." |
| Telegram | "Avisos operacionais da equipe são enviados por Telegram." [Só se os avisos puderem conter dado de cliente.] |
| Mapa da rede | "O endereço da sua instalação é enviado ao serviço OpenStreetMap (Nominatim) para obter coordenadas. **Isso acontece por padrão no painel e não pode ser desligado pelo provedor.**" |

[Se houver outros destinos fora do painel — contabilidade, cobrança, órgãos de proteção ao
crédito, autoridades —, liste aqui. A lista deste modelo cobre só o que o painel envia.]

### 5. Por quanto tempo guardamos

[Para cada tipo de dado, o prazo que **você** adota. Hoje o painel apaga sozinho, por idade,
apenas a trilha de auditoria (padrão de 1 ano), a telemetria dos aparelhos, as execuções de
ativação, os eventos do ERP e os eventos do robô de atendimento; as mensagens do WhatsApp e seus anexos só são apagados se você configurar um prazo;
e o cadastro, o contrato importado do ERP e as conversas **não têm prazo automático**. O
documento `docs/lgpd-inventario-de-dados.md`, seção 4, tem a tabela exata. Não escreva neste
aviso um prazo que o painel não aplica: ou configure o prazo no painel, ou diga que o dado é
guardado enquanto durar o contrato e pelo prazo legal.]

### 6. Seus direitos

Você pode, a qualquer momento, pedir: confirmação de que tratamos seus dados; acesso a eles;
correção; anonimização, bloqueio ou eliminação do que for desnecessário ou tratado em
desconformidade; portabilidade; informação sobre com quem compartilhamos; e revogação do
consentimento, quando for essa a base. Para isso, fale conosco em [canal da seção 1]. Responderemos
em [prazo]. Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).

*Como atender: o painel tem o **dossiê** do assinante (o que guardamos sobre ele) e a
**eliminação** (pelas mesmas regras de alcance). Elas não alcançam cópias em backup nem o que
já foi enviado a terceiros; ao responder, diga isso.*

### 7. Alterações

[Como você avisa o assinante quando este aviso mudar.]
