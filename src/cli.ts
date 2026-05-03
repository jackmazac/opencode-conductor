#!/usr/bin/env bun
import { resolve } from "node:path";
import { detectStackProfile, doctorStackProfile, exportPolicy } from "./profile.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const root = resolve(
    args.find((arg) => !arg.startsWith("--") && arg !== command) ?? process.cwd(),
  );
  const json = args.includes("--json");

  if (command === "help" || command === "--help") {
    process.stdout.write(helpText());
    return;
  }

  const profile = detectStackProfile(root);

  if (command === "detect" || command === "status") {
    process.stdout.write(json ? `${JSON.stringify(profile, null, 2)}\n` : formatProfile(profile));
    return;
  }

  if (command === "doctor") {
    const checks = doctorStackProfile(profile);
    process.stdout.write(json ? `${JSON.stringify({ checks }, null, 2)}\n` : formatChecks(checks));
    process.exit(checks.some((check) => check.status === "fail") ? 1 : 0);
  }

  if (command === "policy" && args[1] === "export") {
    process.stdout.write(`${JSON.stringify(exportPolicy(profile), null, 2)}\n`);
    return;
  }

  throw new Error(`unknown conductor command: ${args.join(" ")}`);
}

function formatProfile(profile: ReturnType<typeof detectStackProfile>): string {
  const lines = [`root: ${profile.root}`];
  if (profile.packageManager) lines.push(`package manager: ${profile.packageManager.preferred}`);
  if (profile.typecheck) lines.push(`typecheck: ${profile.typecheck.preferred}`);
  if (profile.lint) lines.push(`lint: ${profile.lint.preferred}`);
  if (profile.format) lines.push(`format: ${profile.format.preferred}`);
  if (profile.frontend)
    lines.push(`frontend: ${profile.frontend.framework} ${profile.frontend.router ?? ""}`.trim());
  return `${lines.join("\n")}\n`;
}

function formatChecks(checks: ReturnType<typeof doctorStackProfile>): string {
  return `${checks.map((check) => `[${check.status.padEnd(4)}] ${check.name}: ${check.message}`).join("\n")}\n`;
}

function helpText(): string {
  return "Usage: conductor <detect|doctor|status|policy export> [path] [--json]\n";
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
