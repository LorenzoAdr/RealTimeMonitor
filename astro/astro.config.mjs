// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
// `defineConfig` no acepta función: solo devuelve el objeto tal cual.
// Para desarrollo local con rutas tipo /docs/en/ sin prefijo del repo, usa: npm run dev
// (ASTRO_LOCAL_BASE=1 → base "/"). Build y preview usan /RealTimeMonitor/ (GitHub Pages).
const base = process.env.ASTRO_LOCAL_BASE === '1' ? '/' : '/RealTimeMonitor/';

export default defineConfig({
  site: 'https://lorenzoadr.github.io',
  base,
  output: 'static',
  // Evita depender de un .css externo en /_astro/ (cachés, bloqueos, rutas raras)
  build: {
    inlineStylesheets: 'always',
  },
  // Tailwind v4: plugin de Vite (no @astrojs/tailwind / integrations: [tailwind()])
  vite: {
    plugins: [tailwindcss()],
  },
});
