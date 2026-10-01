// Builds the browser edition as one self-contained HTML page (dist/apply2interview.html).
// Same host code as the Node server; see src/browser/main.ts.
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const result = await build({
  entryPoints: [resolve(root, "src/browser/main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  loader: { ".html": "text", ".md": "text" },
  alias: { "node:crypto": resolve(root, "src/browser/crypto-shim.ts") },
  logLevel: "warning",
});
const bundle = result.outputFiles[0].text;

const index = read("public/index.html");
const bodyOpen = /<body[^>]*>/.exec(index)!;
const body = index
  .slice(bodyOpen.index + bodyOpen[0].length, index.indexOf("</body>"))
  .replace(/<script[^>]*src="\/app\.js"[^>]*><\/script>/, "")
  .replace(/<script[^>]*vis-network[^>]*><\/script>/, "");
// Keep </script> sequences inside inline code from closing the tag early.
const inline = (code: string) => code.replace(/<\/script/gi, "<\\/script");

// Private build: A2I_PRIVATE=1 seeds the page with data/private-seed.json (gitignored:
// the candidate's own CV and facts). It is never committed and only goes into a private page.
const privateBuild = process.env.A2I_PRIVATE === "1";
const seedPath = resolve(root, "data/private-seed.json");
if (privateBuild && !existsSync(seedPath)) throw new Error("A2I_PRIVATE=1 needs data/private-seed.json");
const seed = privateBuild ? `<script>window.A2I_SEED = ${inline(readFileSync(seedPath, "utf8").trim())};</script>\n` : "";

const page = `<title>Jarvis Empleo</title>
<meta name="host-auth" content="browser-local">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700;800&family=Rajdhani:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
${read("public/styles.css")}
</style>
${body.trim()}
<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"></script>
${seed}<script>
${inline(bundle)}
</script>
<script>
${inline(read("public/app.js"))}
</script>
`;

mkdirSync(resolve(root, "dist"), { recursive: true });
const out = privateBuild ? "dist/jarvis-private.html" : "dist/apply2interview.html";
writeFileSync(resolve(root, out), page);
console.log(`${out}  ${(page.length / 1024).toFixed(0)} KB${privateBuild ? "  (private seed: do not share)" : ""}`);
