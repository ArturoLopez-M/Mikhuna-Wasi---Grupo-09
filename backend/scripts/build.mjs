// Empaqueta cada Lambda de src/lambdas/<nombre>/index.ts en
// dist/<nombre>/index.js (un .zip por Lambda en Terraform).
import { readdirSync } from "node:fs";
import { build } from "esbuild";

const names = readdirSync("src/lambdas", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

await build({
  entryPoints: names.map((n) => `src/lambdas/${n}/index.ts`),
  outbase: "src/lambdas",
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // Dependencia opcional de pg que no se usa.
  external: ["pg-native"],
  logLevel: "warning",
});

console.log(`Lambdas empaquetadas en dist/: ${names.join(", ")}`);
