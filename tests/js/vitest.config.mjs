/**
 * Sin tool_plugins en el repo, los tests que importan desde ../../tool_plugins/js/ fallan al cargar.
 * Vitest solo añade exclusiones extra cuando falta ese árbol (el resto de patrones son los por defecto).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const hasToolPlugins = fs.existsSync(path.join(repoRoot, "tool_plugins", "scripts", "build_all.sh"));

/** Patrones alineados con los exclude por defecto de Vitest (sustituyen al default si se fijan). */
const defaultExclude = [
    "**/node_modules/**",
    "**/dist/**",
    "**/cypress/**",
    "**/.{idea,git,cache,output,temp}/**",
    "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
];

// Objeto plano: evita `import "vitest/config"` (algunos entornos resuelven mal el paquete).
export default {
    test: hasToolPlugins
        ? {}
        : {
              exclude: [
                  ...defaultExclude,
                  "**/replay_alias.test.mjs",
                  "**/arinc_import_validation.test.mjs",
              ],
          },
};
