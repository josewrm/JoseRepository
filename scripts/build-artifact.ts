// Builds the browser edition as one self-contained HTML page (dist/apply2interview.html).
// Same host code as the Node server; see src/browser/main.ts.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const page = `<title>Jarvis Empleo</title>
<meta name="host-auth" content="browser-local">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
${read("public/styles.css")}
</style>
${body.trim()}
<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"></script>
<script>
${inline(bundle)}
</script>
<script>
${inline(read("public/app.js"))}
</script>
`;

mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/apply2interview.html"), page);
console.log(`dist/apply2interview.html  ${(page.length / 1024).toFixed(0)} KB`);
