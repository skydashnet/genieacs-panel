/** Um dos nomes de `Icon`. */
type IconName = string

/**
 * O texto da página pública.
 *
 * Fora dos dicionários do painel de propósito: é texto de venda, que muda com
 * a campanha e é escrito por quem vende, e não vocabulário de tela que precise
 * existir em treze idiomas para o tipo compilar. Português é o mercado; o
 * inglês é o que qualquer outro idioma recebe.
 */
export interface LandingCopy {
  nav: { features: string; how: string; plans: string; faq: string; signIn: string; signUp: string }
  hero: { kicker: string; titleA: string; titleHighlight: string; subtitle: string; ctaPlans: string; ctaDemo: string; chips: string[] }
  /** A ilustração do painel no hero: rótulos da janela de exemplo. */
  mockup: {
    title: string; online: string; alerts: string; signal: string; devices: string; wifiChanged: string
    customer: string; waFrom: string; waText: string; ok: string; weak: string
  }
  /** A faixa logo abaixo do hero: números e fabricantes compatíveis. */
  stats: { value: string; label: string }[]
  vendors: { title: string; items: string[] }
  features: { title: string; subtitle: string; items: { icon: IconName; title: string; text: string }[] }
  how: { title: string; subtitle: string; steps: { title: string; text: string }[] }
  plans: {
    title: string; subtitle: string; monthly: string; yearly: string; perMonth: string; perYear: string
    perDays: string; featured: string; trial: string; noTrial: string; choose: string; talk: string
    /** `{label}` sem limite, com a concordância do idioma. */
    unlimited: string; devices: string; operators: string; subscribers: string; empty: string; free: string
    yearlySave: string
  }
  faq: { title: string; items: { q: string; a: string }[] }
  /**
   * Depoimentos. A seção só aparece com a lista preenchida — e só com
   * depoimentos REAIS, de clientes que autorizaram o nome.
   */
  testimonials: { title: string; items: { quote: string; name: string; role: string }[] }
  cta: { title: string; text: string; button: string }
  demo: {
    title: string; text: string; name: string; company: string; email: string; phone: string; city: string
    devices: string; message: string; submit: string; sending: string; done: string; error: string; close: string
    plan: string; anyPlan: string
    /** O aviso na coleta (LGPD art. 9º): o que se faz com o dado, ao lado do botão de enviar. */
    privacyNotice: string; privacyLink: string
  }
  footer: {
    rights: string; console: string; tagline: string; product: string; contact: string; company: string; privacy: string
    taxId: string; whatsapp: string; email: string
  }
}

const ptBR: LandingCopy = {
  nav: { features: 'Recursos', how: 'Como funciona', plans: 'Planos', faq: 'Dúvidas', signIn: 'Entrar', signUp: 'Contratar' },
  hero: {
    kicker: 'Gestão TR-069 para provedores',
    titleA: 'Gerencie os roteadores dos seus assinantes',
    titleHighlight: 'sem rolar caminhão',
    subtitle: 'Plataforma completa de gestão TR-069 para provedores: ACS, painel de operações, portal do assinante e integração com SGP e WhatsApp — pronta em 24 horas, sem obra na sua rede.',
    ctaPlans: 'Ver planos',
    ctaDemo: 'Pedir demonstração',
    chips: ['Multi-vendor: Nokia, ZTE, Huawei e mais', 'Integração nativa com SGP', 'Notificações por WhatsApp']
  },
  mockup: {
    title: 'Painel do provedor',
    online: 'Online',
    alerts: 'Alertas',
    signal: 'Sinal óptico médio',
    devices: 'Equipamentos',
    wifiChanged: 'Senha do Wi-Fi alterada pelo portal',
    customer: 'Cliente',
    waFrom: 'WhatsApp',
    waText: 'Detectamos instabilidade na sua região. Já estamos trabalhando nisso.',
    ok: 'OK',
    weak: 'Fraco'
  },
  stats: [
    { value: '24h', label: 'para o provedor começar a operar' },
    { value: '0', label: 'obras na rede para ativar' },
    { value: 'TR-069', label: 'padrão aberto, multi-fabricante' },
    { value: '24/7', label: 'monitoramento do ACS' }
  ],
  vendors: {
    title: 'Compatível com os principais fabricantes',
    items: ['Nokia', 'ZTE', 'Huawei', 'Fiberhome', 'Intelbras', 'TP-Link', 'Parks']
  },
  features: {
    title: 'Tudo que sua operação precisa, num só painel',
    subtitle: 'Do diagnóstico do sinal óptico ao autoatendimento do assinante — menos visitas técnicas, menos ligações no suporte.',
    items: [
      { icon: 'server', title: 'ACS TR-069 gerenciado', text: 'GenieACS hospedado e monitorado por nós. Você aponta as ONTs e começa a operar.' },
      { icon: 'settings', title: 'Painel do operador', text: 'Sinal óptico, Wi-Fi, WAN, reboot, reset e troca de equipamento a um clique, com histórico e trilha de auditoria.' },
      { icon: 'phone', title: 'Portal do assinante', text: 'O cliente troca a senha do Wi-Fi, vê a fatura e desbloqueia a conexão sozinho.' },
      { icon: 'invoice', title: 'Integração com SGP', text: 'Contratos, planos e bloqueios sincronizados. Provisionamento automático por plano.' },
      { icon: 'chat', title: 'WhatsApp integrado', text: 'Alertas de queda, cobrança e atendimento pelo mesmo número, com bot e caixa de conversas.' },
      { icon: 'map', title: 'Mapa da rede', text: 'Veja CTOs, clientes e quedas no mapa e descubra em segundos o que foi afetado.' }
    ]
  },
  how: {
    title: 'Como funciona',
    subtitle: 'Do cadastro ao primeiro equipamento gerenciado em um dia.',
    steps: [
      { title: 'Escolha o plano', text: 'Cadastre seu provedor em 2 minutos e ganhe o período de teste.' },
      { title: 'Aponte as ONTs', text: 'Configure a URL do ACS no seu provisionamento ou na OLT. Sem obra na rede.' },
      { title: 'Conecte o SGP e o WhatsApp', text: 'Integre seu ERP e seu número para automatizar o suporte.' },
      { title: 'Opere de qualquer lugar', text: 'Resolva pelo painel o que antes pedia visita técnica.' }
    ]
  },
  plans: {
    title: 'Planos',
    subtitle: 'Comece com o período de teste grátis. Sem fidelidade — cancele quando quiser.',
    monthly: 'Mensal',
    yearly: 'Anual',
    perMonth: '/mês',
    perYear: '/ano',
    perDays: '/{days} dias',
    featured: 'Mais popular',
    trial: '{days} dias grátis',
    noTrial: 'Sem período de teste',
    choose: 'Contratar',
    talk: 'Falar com vendas',
    unlimited: '{label} ilimitados',
    devices: 'equipamentos',
    operators: 'operadores',
    subscribers: 'assinantes',
    empty: 'Os planos estão sendo atualizados. Peça uma demonstração e montamos uma proposta para você.',
    free: 'Grátis',
    yearlySave: 'Economize {percent}%'
  },
  faq: {
    title: 'Dúvidas frequentes',
    items: [
      { q: 'Preciso instalar alguma coisa no meu servidor?', a: 'Não. O ACS e o painel rodam na nossa infraestrutura. Você só aponta as ONTs para o endereço do ACS.' },
      { q: 'Quais marcas de ONT e roteador são compatíveis?', a: 'Qualquer equipamento com TR-069: Nokia, ZTE, Huawei, Fiberhome, Intelbras, TP-Link, Parks e outros. Mantemos um catálogo de parâmetros por fabricante.' },
      { q: 'Como funciona o período de teste?', a: 'Você usa a plataforma completa durante o teste. Ao final, a cobrança é gerada por PIX ou boleto e o painel continua funcionando após o pagamento.' },
      { q: 'Funciona com o meu SGP?', a: 'Temos integração nativa com o SGP: contratos, planos, bloqueio e desbloqueio. Para outros ERPs, fale com a gente.' },
      { q: 'Posso trocar de plano depois?', a: 'Sim, a qualquer momento, pelo próprio painel. A mudança vale a partir do próximo ciclo.' }
    ]
  },
  testimonials: { title: 'Quem já usa', items: [] },
  cta: {
    title: 'Pronto para reduzir as visitas técnicas?',
    text: 'Crie sua conta agora ou fale com a gente para uma demonstração guiada.',
    button: 'Começar teste grátis'
  },
  demo: {
    title: 'Pedir demonstração',
    text: 'Deixe seu contato e mostramos a plataforma funcionando com equipamentos iguais aos seus.',
    name: 'Seu nome',
    company: 'Provedor',
    email: 'E-mail',
    phone: 'WhatsApp',
    city: 'Cidade',
    devices: 'Quantos assinantes?',
    message: 'Mensagem (opcional)',
    submit: 'Enviar',
    sending: 'Enviando…',
    done: 'Recebemos seu pedido! Em breve entraremos em contato.',
    error: 'Não foi possível enviar agora. Tente de novo ou chame no WhatsApp.',
    close: 'Fechar',
    plan: 'Plano de interesse',
    anyPlan: 'Ainda não sei',
    privacyNotice: 'Usamos estes dados para responder ao seu pedido e dar andamento ao contato comercial.',
    privacyLink: 'Política de privacidade'
  },
  footer: {
    rights: 'Todos os direitos reservados.',
    privacy: 'Política de privacidade',
    console: 'Console da plataforma',
    tagline: 'Gestão TR-069 para provedores de internet: ACS, painel, portal do assinante e WhatsApp.',
    product: 'Produto',
    contact: 'Contato',
    company: 'Empresa',
    taxId: 'CNPJ',
    whatsapp: 'WhatsApp',
    email: 'E-mail'
  }
}

const en: LandingCopy = {
  nav: { features: 'Features', how: 'How it works', plans: 'Plans', faq: 'FAQ', signIn: 'Sign in', signUp: 'Get started' },
  hero: {
    kicker: 'TR-069 management for ISPs',
    titleA: 'Manage your subscribers’ routers',
    titleHighlight: 'without rolling a truck',
    subtitle: 'A complete TR-069 management platform for ISPs: ACS, operations panel, subscriber portal and ERP and WhatsApp integration — ready in 24 hours, no changes to your network.',
    ctaPlans: 'See plans',
    ctaDemo: 'Request a demo',
    chips: ['Multi-vendor: Nokia, ZTE, Huawei and more', 'Native SGP integration', 'WhatsApp notifications']
  },
  mockup: {
    title: 'Provider panel',
    online: 'Online',
    alerts: 'Alerts',
    signal: 'Average optical signal',
    devices: 'Devices',
    wifiChanged: 'Wi-Fi password changed from the portal',
    customer: 'Customer',
    waFrom: 'WhatsApp',
    waText: 'We detected instability in your area. We are already working on it.',
    ok: 'OK',
    weak: 'Weak'
  },
  stats: [
    { value: '24h', label: 'for the ISP to start operating' },
    { value: '0', label: 'network changes to activate' },
    { value: 'TR-069', label: 'open standard, multi-vendor' },
    { value: '24/7', label: 'ACS monitoring' }
  ],
  vendors: {
    title: 'Works with the main vendors',
    items: ['Nokia', 'ZTE', 'Huawei', 'Fiberhome', 'Intelbras', 'TP-Link', 'Parks']
  },
  features: {
    title: 'Everything your operation needs, in one panel',
    subtitle: 'From optical signal diagnostics to subscriber self-service — fewer truck rolls, fewer support calls.',
    items: [
      { icon: 'server', title: 'Managed TR-069 ACS', text: 'GenieACS hosted and monitored by us. Point your ONTs and start operating.' },
      { icon: 'settings', title: 'Operator panel', text: 'Optical signal, Wi-Fi, WAN, reboot, reset and device swaps in one click, with history and an audit trail.' },
      { icon: 'phone', title: 'Subscriber portal', text: 'Customers change their Wi-Fi password, see their invoice and unlock their connection on their own.' },
      { icon: 'invoice', title: 'SGP integration', text: 'Contracts, plans and suspensions in sync. Automatic provisioning per plan.' },
      { icon: 'chat', title: 'Built-in WhatsApp', text: 'Outage alerts, billing and support on the same number, with a bot and a shared inbox.' },
      { icon: 'map', title: 'Network map', text: 'See boxes, customers and outages on the map and find out in seconds what was affected.' }
    ]
  },
  how: {
    title: 'How it works',
    subtitle: 'From signup to your first managed device in a day.',
    steps: [
      { title: 'Pick a plan', text: 'Sign your ISP up in 2 minutes and get the free trial.' },
      { title: 'Point your ONTs', text: 'Set the ACS URL in your provisioning or on the OLT. No network changes.' },
      { title: 'Connect SGP and WhatsApp', text: 'Integrate your ERP and your number to automate support.' },
      { title: 'Operate from anywhere', text: 'Fix from the panel what used to need a technician visit.' }
    ]
  },
  plans: {
    title: 'Plans',
    subtitle: 'Start with the free trial. No lock-in — cancel anytime.',
    monthly: 'Monthly',
    yearly: 'Yearly',
    perMonth: '/mo',
    perYear: '/yr',
    perDays: '/{days} days',
    featured: 'Most popular',
    trial: '{days}-day free trial',
    noTrial: 'No trial period',
    choose: 'Get started',
    talk: 'Talk to sales',
    unlimited: 'Unlimited {label}',
    devices: 'devices',
    operators: 'operators',
    subscribers: 'subscribers',
    empty: 'Plans are being updated. Request a demo and we will put together a proposal for you.',
    free: 'Free',
    yearlySave: 'Save {percent}%'
  },
  faq: {
    title: 'Frequently asked questions',
    items: [
      { q: 'Do I need to install anything on my server?', a: 'No. The ACS and the panel run on our infrastructure. You only point your ONTs at the ACS address.' },
      { q: 'Which ONT and router brands are supported?', a: 'Any TR-069 device: Nokia, ZTE, Huawei, Fiberhome, Intelbras, TP-Link, Parks and others. We keep a per-vendor parameter catalogue.' },
      { q: 'How does the trial work?', a: 'You use the full platform during the trial. When it ends an invoice is issued (PIX or boleto) and the panel keeps working once it is paid.' },
      { q: 'Does it work with my ERP?', a: 'We have native SGP integration: contracts, plans, suspension and unlocking. For other ERPs, get in touch.' },
      { q: 'Can I change plans later?', a: 'Yes, at any time, from the panel itself. The change applies from the next cycle.' }
    ]
  },
  testimonials: { title: 'Who uses it', items: [] },
  cta: {
    title: 'Ready to cut down on truck rolls?',
    text: 'Create your account now or talk to us for a guided demo.',
    button: 'Start free trial'
  },
  demo: {
    title: 'Request a demo',
    text: 'Leave your contact and we will show you the platform running with devices like yours.',
    name: 'Your name',
    company: 'Company',
    email: 'Email',
    phone: 'WhatsApp',
    city: 'City',
    devices: 'How many subscribers?',
    message: 'Message (optional)',
    submit: 'Send',
    sending: 'Sending…',
    done: 'We got your request! We will be in touch soon.',
    error: 'Could not send right now. Try again or reach us on WhatsApp.',
    close: 'Close',
    plan: 'Plan of interest',
    anyPlan: 'Not sure yet',
    privacyNotice: 'We use these details to answer your request and follow up on it.',
    privacyLink: 'Privacy policy'
  },
  footer: {
    rights: 'All rights reserved.',
    privacy: 'Privacy policy',
    console: 'Platform console',
    tagline: 'TR-069 management for internet providers: ACS, panel, subscriber portal and WhatsApp.',
    product: 'Product',
    contact: 'Contact',
    company: 'Company',
    taxId: 'Tax ID',
    whatsapp: 'WhatsApp',
    email: 'Email'
  }
}

export function landingCopy(locale: string): LandingCopy {
  return locale.toLowerCase().startsWith('pt') ? ptBR : en
}

/** `{name}` → valor. */
export function fill(template: string, vars: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''))
}
