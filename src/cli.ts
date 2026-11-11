#!/usr/bin/env node
/**
 * The `servable` executable: `serve` and `routes` (see serve-cli.ts for the
 * contract and README "Command line" for the documentation).
 */
import { readFileSync } from "node:fs";
import { CliError, EXIT, createReporter, errorFields, routesCommand, serveCommand } from "./serve-cli.js";

const USAGE = `Usage: servable <command> [options]

Commands:
  serve <module>    Serve the compiled app a module default-exports
  routes <module>   Print the routes it answers, without serving it

Run "servable <command> --help" for a command's options.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "serve") return serveCommand(rest);
  if (command === "routes") return routesCommand(rest);
  if (command === "--version" || command === "-v") {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return EXIT.OK;
  }
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command === undefined ? EXIT.USAGE : EXIT.OK;
  }
  const json = argv.includes("--json");
  if (!json) process.stderr.write(USAGE);
  const fields = errorFields(new CliError("E_USAGE", `unknown command: ${command}`), true);
  await new Promise<void>((done) => createReporter(json).final("error", fields, done));
  return EXIT.USAGE;
}

process.exitCode = await main(process.argv.slice(2));
// Exit explicitly: the app may hold timers or sockets open that would
// otherwise keep a stopped server's process alive.
process.exit();
