import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "ui-sans-serif", "system-ui", "sans-serif"],
        title: ["Noto Serif TC", "Songti TC", "PMingLiU", "serif"]
      },
      colors: {
        ink: {
          50: "#F7F5EF",
          100: "#EBE6DA",
          200: "#D8CFBD",
          300: "#C1B39B",
          400: "#9A8973",
          500: "#75644E",
          600: "#5A4D3D",
          700: "#342C23",
          800: "#2D271F",
          900: "#1A1713"
        },
        paper: {
          50: "#FFFEFC",
          100: "#FBF8F1",
          200: "#EEE5D4",
          300: "#DDCFB6",
          400: "#D3C4AE",
          500: "#BAA889"
        },
        mist: {
          100: "#F2EEE6",
          200: "#DFD4C2",
          300: "#CDBDA4",
          400: "#B5A283",
          500: "#9A876C",
          600: "#75644D",
          700: "#665B4D"
        },
        gold: {
          100: "#F7EED2",
          200: "#EFD9A6",
          300: "#E2BE77",
          400: "#D4A64D",
          500: "#BF8734",
          600: "#9A6927"
        },
        surface: {
          900: "#F8F5EE",
          800: "#EFE9DD",
          700: "#E3DAC9",
          600: "#D3C4AE"
        },
        accent: {
          400: "#D4A64D",
          500: "#BF8734"
        }
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(191,135,52,0.35), 0 12px 36px rgba(38,32,26,0.18)"
      }
    }
  },
  plugins: []
};

export default config;
