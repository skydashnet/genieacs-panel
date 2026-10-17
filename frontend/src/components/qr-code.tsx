import { useMemo } from 'react'
import { encodeQrCode, toSvgPath } from '@/lib/qr/encode'

/**
 * The white margin the standard requires around a symbol. Readers use it to
 * find the finder patterns; without it a phone held close to the screen often
 * fails to lock on at all.
 */
const QUIET_ZONE = 4

interface QrCodeProps {
  value: string
  /** Rendered edge length in CSS pixels, quiet zone included. */
  size?: number
  ariaLabel: string
  className?: string
}

/**
 * A QR symbol drawn as inline SVG.
 *
 * Deliberately not theme-aware. Every other surface in the panel follows the
 * viewer's dark mode; this one must not, because a light-on-dark QR is inverted
 * as far as a camera is concerned and a good share of banking apps refuse to
 * read it. Dark modules on white, always, with the white extending through the
 * quiet zone.
 */
export function QrCode({ value, size = 200, ariaLabel, className }: QrCodeProps) {
  const symbol = useMemo(() => {
    const matrix = encodeQrCode(value)
    if (!matrix) return null
    return { extent: matrix.size + QUIET_ZONE * 2, path: toSvgPath(matrix, QUIET_ZONE) }
  }, [value])

  // A payload too long to encode is not an error worth a message of its own:
  // the copyable text is right beside this, and it still pays the invoice.
  if (!symbol) return null

  return (
    <svg
      viewBox={`0 0 ${symbol.extent} ${symbol.extent}`}
      width={size}
      height={size}
      role="img"
      aria-label={ariaLabel}
      className={className}
      // `shapeRendering` keeps the module edges hard at any scale; anti-aliased
      // edges blur the boundary between a dark and a light module.
      shapeRendering="crispEdges"
    >
      <rect width={symbol.extent} height={symbol.extent} fill="#ffffff" />
      <path d={symbol.path} fill="#000000" />
    </svg>
  )
}

export default QrCode
