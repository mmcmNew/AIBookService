import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        sepia: {
          50: '#fbf8f2',
          100: '#f6f0e2',
          200: '#eddcc5',
          300: '#e1c3a0',
          800: '#433422',
          900: '#2b2114',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['Merriweather', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(24px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        'slide-up': {
          from: { transform: 'translateY(12px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out both',
        'pop-in': 'pop-in 180ms ease-out both',
        'slide-in-right': 'slide-in-right 180ms ease-out both',
        'slide-up': 'slide-up 180ms ease-out both',
      },
    },
  },
  plugins: [
    // Вариант sepia: (применяется, когда на <html> стоит класс .sepia)
    plugin(({ addVariant }) => {
      addVariant('sepia', '.sepia &');
    }),
  ],
}
