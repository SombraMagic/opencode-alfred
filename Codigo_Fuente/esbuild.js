const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    mainFields: ["module", "main"],
    outfile: "dist/extension.js",
    external: ["vscode", "node:sqlite", "koffi", "mpg123-decoder", "ws"],
    logLevel: "info",
  });
  // Servidor MCP `voz`: proceso stdio aparte, sin `vscode`, con los mismos externos.
  const vozMcp = await esbuild.context({
    entryPoints: ["src/mcp/vozServer.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    mainFields: ["module", "main"],
    outfile: "dist/voz-mcp.js",
    external: ["vscode", "node:sqlite", "koffi", "mpg123-decoder", "ws"],
    logLevel: "info",
  });
  if (watch) {
    await ctx.watch();
    await vozMcp.watch();
    console.log("[esbuild] watching...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    await vozMcp.rebuild();
    await vozMcp.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
