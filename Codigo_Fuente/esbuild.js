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
  // Servidor MCP `mcp_alfred`: proceso stdio aparte, sin `vscode`, con los mismos externos.
  const alfredMcp = await esbuild.context({
    entryPoints: ["src/mcp/alfredServer.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    mainFields: ["module", "main"],
    outfile: "dist/alfred-mcp.js",
    external: ["vscode", "node:sqlite", "koffi", "mpg123-decoder", "ws"],
    logLevel: "info",
  });
  if (watch) {
    await ctx.watch();
    await alfredMcp.watch();
    console.log("[esbuild] watching...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    await alfredMcp.rebuild();
    await alfredMcp.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
