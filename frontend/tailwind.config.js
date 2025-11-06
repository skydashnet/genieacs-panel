/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Luxury gradient colors
        luxury: {
          gold: '#D4AF37',
          silver: '#C0C0C0',
          platinum: '#E5E4E2',
          bronze: '#CD7F32',
          diamond: '#B9F2FF',
          ruby: '#E0115F',
          emerald: '#50C878',
          sapphire: '#0F52BA',
        }
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "gradient-shift": {
          "0%, 100%": {
            backgroundPosition: "0% 50%",
          },
          "50%": {
            backgroundPosition: "100% 50%",
          },
        },
        "float": {
          "0%, 100%": {
            transform: "translateY(0px)",
          },
          "50%": {
            transform: "translateY(-10px)",
          },
        },
        "pulse-glow": {
          "0%, 100%": {
            boxShadow: "0 0 20px rgba(212, 175, 55, 0.3)",
          },
          "50%": {
            boxShadow: "0 0 40px rgba(212, 175, 55, 0.6)",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "gradient-shift": "gradient-shift 3s ease infinite",
        "float": "float 3s ease-in-out infinite",
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'gradient-luxury': 'linear-gradient(135deg, #667eea 0%, #764ba2 25%, #f093fb 50%, #f5576c 75%, #fda085 100%)',
        'gradient-gold': 'linear-gradient(135deg, #D4AF37 0%, #F4E4C1 50%, #E6D690 100%)',
        'gradient-sapphire': 'linear-gradient(135deg, #0F52BA 0%, #4169E1 50%, #87CEEB 100%)',
        'gradient-emerald': 'linear-gradient(135deg, #50C878 0%, #3CB371 50%, #2E8B57 100%)',
        'gradient-ruby': 'linear-gradient(135deg, #E0115F 0%, #FF1493 50%, #FF69B4 100%)',
        'gradient-diamond': 'linear-gradient(135deg, #B9F2FF 0%, #E0FFFF 50%, #F0FFFF 100%)',
        'gradient-platinum': 'linear-gradient(135deg, #E5E4E2 0%, #F5F5F5 50%, #FFFFFF 100%)',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}