'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { publicAPI, type PublicInfo } from '@/lib/api'
import {
  LEAD_FIELDS,
  POLICY_UPDATED_AT,
  RECIPIENTS,
  leadRetentionSentence
} from '@/lib/privacy'

/** Como a página chama cada grau de obrigatoriedade de `LeadField`. */
const REQUISITO = {
  always: 'obrigatório',
  contact: 'um dos dois é obrigatório',
  never: 'opcional'
} as const

/**
 * A política de privacidade do SITE: a de quem é controlador do dado — nós. Ela
 * fala do pedido de contato da vitrine, de quem opera o painel e do cadastro do
 * provedor contratante.
 *
 * Fala também, em uma seção só, do que NÃO é dela: o assinante de um provedor
 * tem como controlador o provedor, e o aviso dele é do provedor. Dizer isso
 * aqui é o que impede esta página de parecer falar por quem não é seu
 * controlador.
 *
 * O que muda de um deploy para outro vem do servidor (`/api/public/info`):
 * quem somos, o canal de contato e o prazo de guarda. O texto que o código
 * pode desmentir — os campos do formulário — vem de `lib/privacy.ts` e é
 * confrontado com `landing.tsx` por um teste.
 */
export default function PrivacyPage() {
  const [info, setInfo] = useState<PublicInfo | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let vivo = true
    document.title = 'Política de privacidade'
    void publicAPI.info()
      .then((res) => { if (vivo && res.success && res.data) setInfo(res.data) })
      .catch(() => {})
      .finally(() => { if (vivo) setLoaded(true) })
    return () => { vivo = false }
  }, [])

  const contato = info?.contactEmail || null
  const quem = info?.legalName || info?.tradeName || null

  return (
    <div className="min-h-screen bg-[#0a1411] text-slate-300 antialiased">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link to="/" className="text-sm font-semibold text-emerald-400 hover:text-emerald-300">← Voltar</Link>
          <span className="text-xs text-slate-500">Atualizada em {POLICY_UPDATED_AT}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-10 px-4 py-10 text-[0.95rem] leading-7 sm:px-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Política de privacidade</h1>
          <p className="mt-3 text-slate-400">
            Aqui você vê, em português claro, que dados nossos sistemas guardam sobre você, para quê, com quem os
            compartilhamos e como exercer os seus direitos pela Lei Geral de Proteção de Dados (LGPD, Lei nº 13.709/2018).
          </p>
          <p className="mt-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-400">
            <span lang="en">This policy is written in Portuguese, which is the language that governs it, and is
            about the Brazilian LGPD.</span>{' '}
            <span lang="es">Esta política está escrita en portugués, que es el idioma que rige, y trata de la LGPD brasileña.</span>
          </p>
        </div>

        <Section title="1. Quem é o responsável pelos seus dados">
          {quem ? (
            <>
              <p>
                O responsável (controlador) é <strong className="text-white">{quem}</strong>
                {info?.taxId ? <>, inscrita sob o CNPJ <strong className="text-white">{info.taxId}</strong></> : null}
                {info?.address ? <>, com sede em {info.address}</> : null}.
              </p>
              {contato ? (
                <p>
                  Para qualquer assunto sobre seus dados, escreva para{' '}
                  <a className="font-semibold text-emerald-400 hover:text-emerald-300" href={`mailto:${contato}`}>{contato}</a>.
                </p>
              ) : (
                <p className="text-amber-300/90">
                  O canal de contato ainda não foi cadastrado nesta instalação.
                </p>
              )}
            </>
          ) : (
            <p className="text-amber-300/90">
              {loaded
                ? 'Os dados do responsável ainda não foram cadastrados nesta instalação.'
                : 'Carregando…'}
            </p>
          )}
        </Section>

        <Section title="2. Quais dados coletamos, e para quê">
          <h3 className="font-semibold text-white">Quando você pede contato ou uma demonstração</h3>
          <p>O formulário da página inicial coleta:</p>
          <ul className="list-disc space-y-1 ps-6">
            {LEAD_FIELDS.map((field) => (
              <li key={field.key}>
                {field.label}{' '}
                <span className="text-slate-500">({REQUISITO[field.required]})</span>
              </li>
            ))}
          </ul>
          <p>
            Usamos esses dados para responder ao seu pedido e dar andamento ao contato comercial. A base legal é a
            realização de procedimentos preliminares relacionados a um contrato, a pedido seu (LGPD, art. 7º, V).
            Você precisa informar o nome e ao menos um jeito de falar com você (e-mail ou telefone); o resto é opcional.
          </p>
          <p>
            <strong className="text-white">Não gravamos o seu endereço IP junto ao pedido.</strong> O servidor mantém,
            à parte, um registro técnico de acesso — data, endereço IP, caminho acessado e resultado — para segurança
            e diagnóstico. Esse registro é da infraestrutura e segue a retenção dela; ele não é a base do contato comercial.
          </p>

          <h3 className="pt-2 font-semibold text-white">Quando você opera o painel</h3>
          <p>
            Guardamos nome de usuário, e-mail, telefone (opcional), o papel que você tem, a senha — <strong className="text-white">apenas
            como resumo criptográfico (hash), nunca em texto legível</strong> — e, se você ligar a verificação em duas etapas, o
            segredo dela e os códigos de recuperação. Registramos também as ações que você faz no painel (quem fez o quê,
            e quando), para segurança e para que o provedor consiga auditar o próprio ambiente. Base legal: execução do
            contrato (art. 7º, V) e legítimo interesse em segurança (art. 7º, IX).
          </p>

          <h3 className="pt-2 font-semibold text-white">Quando um provedor contrata o serviço</h3>
          <p>
            Guardamos razão social, CNPJ ou CPF, endereço, e-mail e telefone de cobrança, para emitir a assinatura e
            cumprir obrigações fiscais (art. 7º, II e V).
          </p>
        </Section>

        <Section title="3. Se você é cliente de um provedor de internet">
          <p>
            Os dados de quem é assinante de um provedor — a conexão, o equipamento, o atendimento — são
            controlados <strong className="text-white">pelo seu provedor</strong>, e não por nós. Neste caso, nós somos o
            operador: processamos esses dados em nome dele. Para saber o que ele guarda e exercer seus direitos sobre
            esses dados, fale com o seu provedor; o aviso de privacidade dele é dele.
          </p>
        </Section>

        <Section title="4. Com quem compartilhamos">
          <p>Os dados da plataforma — os desta política — chegam aos seguintes destinatários:</p>
          <ul className="space-y-3">
            {RECIPIENTS.map((r) => (
              <li key={r.who}>
                <strong className="text-white">{r.who}</strong> — recebe {r.what}, para {r.why}.
              </li>
            ))}
          </ul>
          <p>
            <strong className="text-white">Não usamos</strong> ferramentas de análise de audiência, rastreadores de
            publicidade nem verificação por captcha de terceiros. Na página pública, o navegador guarda apenas o seu
            idioma e o seu tema (claro ou escuro), localmente, para lembrar a sua escolha. Quem entra no painel tem
            também a sessão guardada no navegador, para continuar logado.
          </p>
        </Section>

        <Section title="5. Por quanto tempo guardamos">
          <ul className="list-disc space-y-2 ps-6">
            <li>
              <strong className="text-white">Pedido de contato.</strong>{' '}
              {loaded || info ? leadRetentionSentence(info?.leadRetentionDays) : 'Carregando…'}
            </li>
            <li>
              <strong className="text-white">Conta de operador.</strong> Enquanto a conta existir; os registros de ações
              acompanham o prazo de auditoria definido pelo provedor.
            </li>
            <li>
              <strong className="text-white">Cadastro do provedor.</strong> Enquanto durar o contrato e pelo prazo
              que a legislação fiscal exigir depois dele.
            </li>
          </ul>
        </Section>

        <Section title="6. Seus direitos">
          <p>
            Pela LGPD (art. 18), você pode pedir: confirmação de que tratamos dados seus; acesso a eles; correção;
            anonimização, bloqueio ou eliminação do que for desnecessário ou excessivo; portabilidade; informação sobre
            com quem compartilhamos.
            {contato ? (
              <> Escreva para <a className="font-semibold text-emerald-400 hover:text-emerald-300" href={`mailto:${contato}`}>{contato}</a> e
              responderemos no prazo que a lei estabelece.</>
            ) : null}
          </p>
          <p>
            Você também pode apresentar reclamação à Autoridade Nacional de Proteção de Dados (ANPD).
          </p>
        </Section>

        <Section title="7. Como protegemos">
          <ul className="list-disc space-y-1 ps-6">
            <li>Senhas guardadas apenas como hash.</li>
            <li>Credenciais de integração (ERP, WhatsApp e afins) guardadas cifradas.</li>
            <li>Os dados de cada provedor ficam separados dos de outro por regra do próprio sistema: uma consulta que não diz de qual provedor é falha em vez de devolver dados misturados.</li>
            <li>Ações sensíveis no painel ficam registradas.</li>
          </ul>
        </Section>

        <Section title="8. Mudanças nesta política">
          <p>
            Quando o texto mudar, a data no topo muda junto. A versão em vigor é sempre a desta página.
          </p>
        </Section>
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-bold text-white">{title}</h2>
      {children}
    </section>
  )
}
