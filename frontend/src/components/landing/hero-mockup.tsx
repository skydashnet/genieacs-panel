'use client'

import { Icon } from '@/components/ui/icon'
import type { LandingCopy } from '@/components/landing/content'

/**
 * A ilustração do painel no hero: uma janela de exemplo, desenhada em HTML.
 *
 * Não é print de tela de cliente nenhum — os números e nomes são de mentira e
 * genéricos de propósito. Decorativa: `aria-hidden`, porque o texto ao lado já
 * diz o que o produto faz.
 */
const ONTS = [
  { id: 'ZTEG•4F2A', model: 'ZTE F670L', dbm: '-18.4', ok: true },
  { id: 'ALCL•9B31', model: 'Nokia G-140W', dbm: '-21.7', ok: true },
  { id: 'HWTC•77C0', model: 'Huawei EG8145', dbm: '-27.9', ok: false },
  { id: 'FHTT•1D08', model: 'Fiberhome AN5506', dbm: '-19.2', ok: true }
]

export function HeroMockup({ copy }: { copy: LandingCopy }) {
  const m = copy.mockup
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-xl select-none">
      <div className="absolute -inset-6 rounded-4xl bg-emerald-400/10 blur-3xl" />

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0f1c18]/95 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="size-2.5 rounded-full bg-red-400/70" />
          <span className="size-2.5 rounded-full bg-amber-400/70" />
          <span className="size-2.5 rounded-full bg-emerald-400/70" />
          <span className="ml-3 text-xs font-semibold text-slate-400">{m.title}</span>
        </div>

        <div className="grid grid-cols-3 gap-2 px-3 py-4 sm:gap-3 sm:px-4">
          <div className="min-w-0 rounded-xl border border-white/10 bg-white/3 p-2 sm:p-3">
            <div className="truncate text-[0.6rem] uppercase text-slate-500 sm:text-[0.65rem] sm:tracking-wide">{m.devices}</div>
            <div className="mt-1 text-xl font-extrabold text-white">1.284</div>
          </div>
          <div className="min-w-0 rounded-xl border border-white/10 bg-white/3 p-2 sm:p-3">
            <div className="truncate text-[0.6rem] uppercase text-slate-500 sm:text-[0.65rem] sm:tracking-wide">{m.online}</div>
            <div className="mt-1 text-xl font-extrabold text-emerald-400">98,6%</div>
          </div>
          <div className="min-w-0 rounded-xl border border-white/10 bg-white/3 p-2 sm:p-3">
            <div className="truncate text-[0.6rem] uppercase text-slate-500 sm:text-[0.65rem] sm:tracking-wide">{m.alerts}</div>
            <div className="mt-1 text-xl font-extrabold text-amber-300">3</div>
          </div>
        </div>

        <div className="mx-4 mb-4 rounded-xl border border-white/10 bg-white/3 p-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>{m.signal}</span>
            <span className="font-semibold text-white">-19,6 dBm</span>
          </div>
          <svg viewBox="0 0 300 60" className="mt-2 h-14 w-full" preserveAspectRatio="none">
            <defs>
              <linearGradient id="mockup-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(52 211 153)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="rgb(52 211 153)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0 38 L25 34 L50 36 L75 28 L100 30 L125 24 L150 27 L175 20 L200 23 L225 18 L250 21 L275 15 L300 17 L300 60 L0 60 Z" fill="url(#mockup-area)" />
            <path d="M0 38 L25 34 L50 36 L75 28 L100 30 L125 24 L150 27 L175 20 L200 23 L225 18 L250 21 L275 15 L300 17" fill="none" stroke="rgb(52 211 153)" strokeWidth="2" />
          </svg>
        </div>

        <ul className="mx-4 mb-4 divide-y divide-white/5 rounded-xl border border-white/10">
          {ONTS.map((ont) => (
            <li key={ont.id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className={`size-2 shrink-0 rounded-full ${ont.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="font-mono text-slate-300">{ont.id}</span>
              <span className="hidden text-slate-500 sm:inline">{ont.model}</span>
              <span className={`ml-auto font-semibold ${ont.ok ? 'text-slate-300' : 'text-amber-300'}`}>{ont.dbm} dBm</span>
              <span className={`rounded px-1.5 py-0.5 text-[0.6rem] font-bold ${ont.ok ? 'bg-emerald-400/15 text-emerald-300' : 'bg-amber-400/15 text-amber-300'}`}>
                {ont.ok ? m.ok : m.weak}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="absolute -bottom-6 -left-4 hidden max-w-60 rounded-2xl border border-white/10 bg-[#12251f] p-3 shadow-xl sm:block">
        <div className="flex items-center gap-2 text-[0.7rem] font-semibold text-emerald-300">
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-[#25d366] text-white">
            <Icon name="chat" size={12} />
          </span>
          {m.waFrom}
        </div>
        <p className="mt-1.5 text-xs leading-5 text-slate-300">{m.waText}</p>
      </div>

      <div className="absolute -right-3 -top-4 hidden items-center gap-2 rounded-full border border-white/10 bg-[#12251f] px-3 py-1.5 text-[0.7rem] text-slate-300 shadow-xl sm:flex">
        <Icon name="wifi" size={14} className="text-emerald-400" />
        {m.wifiChanged}
      </div>
    </div>
  )
}

export default HeroMockup
