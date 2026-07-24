type BrandMarkProps = {
  className?: string
  title?: string
}

export function BrandMark({ className = 'h-9 w-9', title }: BrandMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="brand-surface" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563EB" />
          <stop offset="1" stopColor="#0F172A" />
        </linearGradient>
        <linearGradient id="brand-node" x1="21" y1="17" x2="43" y2="45" gradientUnits="userSpaceOnUse">
          <stop stopColor="#67E8F9" />
          <stop offset="1" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#brand-surface)" />
      <path d="M20 20L32 30L44 20M32 30V45" fill="none" stroke="white" strokeOpacity=".78" strokeWidth="3" strokeLinecap="round" />
      <circle cx="20" cy="20" r="5" fill="url(#brand-node)" stroke="white" strokeWidth="2" />
      <circle cx="44" cy="20" r="5" fill="url(#brand-node)" stroke="white" strokeWidth="2" />
      <circle cx="32" cy="45" r="5" fill="url(#brand-node)" stroke="white" strokeWidth="2" />
      <circle cx="32" cy="30" r="7" fill="#0F172A" stroke="white" strokeWidth="2.5" />
      <circle cx="32" cy="30" r="2.5" fill="#67E8F9" />
    </svg>
  )
}
