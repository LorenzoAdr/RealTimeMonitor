// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // URL canónica de GitHub Pages (el host suele normalizar el usuario a minúsculas)
  site: 'https://lorenzoadr.github.io',
  // Repositorio = subruta donde se sirven los assets (barra final obligatoria)
  base: '/RealTimeMonitor/',
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
