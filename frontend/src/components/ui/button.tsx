import React from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'luxury' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'lg'
  children: React.ReactNode
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'default', size = 'default', children, ...props }, ref) => {
    const baseClasses = 'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'
    
    const variantClasses = {
      default: 'bg-primary text-primary-foreground hover:bg-primary/90',
      luxury: 'relative overflow-hidden rounded-lg bg-gradient-to-r from-luxury-gold via-luxury-ruby to-luxury-sapphire px-6 py-3 text-white font-semibold shadow-lg transition-all duration-300 hover:shadow-xl hover:scale-105 active:scale-95',
      outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
      ghost: 'hover:bg-accent hover:text-accent-foreground'
    }
    
    const sizeClasses = {
      default: 'h-10 px-4 py-2',
      sm: 'h-9 rounded-md px-3',
      lg: 'h-11 rounded-md px-8'
    }
    
    const classes = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`
    
    return (
      <button className={classes} ref={ref} {...props}>
        {variant === 'luxury' && (
          <>
            <div className="absolute inset-0 bg-gradient-to-r from-luxury-sapphire via-luxury-ruby to-luxury-gold opacity-0 transition-opacity duration-300"></div>
            <span className="relative z-10">{children}</span>
          </>
        )}
        {variant !== 'luxury' && children}
      </button>
    )
  }
)

Button.displayName = 'Button'

export { Button }