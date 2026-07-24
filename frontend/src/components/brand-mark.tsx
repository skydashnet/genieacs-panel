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
      <rect width="64" height="64" rx="13" fill="#173F35" />
      <path d="M20 19L32 30L44 19M32 30V45" fill="none" stroke="#F4F3ED" strokeOpacity=".78" strokeWidth="3" strokeLinecap="round" />
      <circle cx="20" cy="19" r="5" fill="#D97706" stroke="#F4F3ED" strokeWidth="2" />
      <circle cx="44" cy="19" r="5" fill="#D97706" stroke="#F4F3ED" strokeWidth="2" />
      <circle cx="32" cy="45" r="5" fill="#D97706" stroke="#F4F3ED" strokeWidth="2" />
      <circle cx="32" cy="30" r="7" fill="#F4F3ED" stroke="#173F35" strokeWidth="2" />
      <circle cx="32" cy="30" r="2.75" fill="#173F35" />
    </svg>
  )
}
