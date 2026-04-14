// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // URL final del sitio (GitHub Pages usuario)
  site: 'https://LorenzoAdr.github.io',
  // Repositorio = subruta donde se sirven los assets (barra final obligatoria)
  base: '/RealTimeMonitor/',
  output: 'static',
  // Tailwind v4: plugin de Vite (no @astrojs/tailwind / integrations: [tailwind()])
  vite: {
    plugins: [tailwindcss()],
  },
});
