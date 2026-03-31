import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Noto Sans TC", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      colors: {
        surface: {
          900: "#090C11",
          800: "#111827",
          700: "#1B2433",
          600: "#243245"
        },
        accent: {
          400: "#28C6FF",
          500: "#13A8E0"
        }
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(40,198,255,0.35), 0 12px 36px rgba(7,12,20,0.52)"
      }
    }
  },
  plugins: []
};

export default config;
