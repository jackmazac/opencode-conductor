#!/usr/bin/env bun
import { resolve } from "node:path";
import { makeHealthReport, type HealthCheck } from "@mazac-fox/opencode-fleet-contracts";
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

  if (command === "detect") {
    process.stdout.write(json ? `${JSON.stringify(profile, null, 2)}\n` : formatProfile(profile));
    return;
  }

  if (command === "status") {
    process.stdout.write(
      json ? `${JSON.stringify(statusReport(profile), null, 2)}\n` : formatProfile(profile),
    );
    return;
  }

  if (command === "doctor") {
    const checks = doctorStackProfile(profile);
    process.stdout.write(
      json ? `${JSON.stringify(doctorReport(checks), null, 2)}\n` : formatChecks(checks),
    );
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

function statusReport(profile: ReturnType<typeof detectStackProfile>) {
  const checks: HealthCheck[] = [
    healthCheck("profile", "ok", `detected stack profile for ${profile.root}`),
    profile.packageManager
      ? healthCheck("package manager", "ok", profile.packageManager.preferred)
      : healthCheck("package manager", "warn", "not detected"),
    profile.typecheck
      ? healthCheck("typecheck command", "ok", profile.typecheck.preferred)
      : healthCheck("typecheck command", "warn", "not detected"),
    profile.lint
      ? healthCheck("lint command", "ok", profile.lint.preferred)
      : healthCheck("lint command", "skip", "not configured"),
  ];
  const now = new Date().toISOString();
  return makeHealthReport({
    source: "conductor.cli.status",
    checks,
    started_at: now,
    finished_at: now,
  });
}

function doctorReport(checks: ReturnType<typeof doctorStackProfile>) {
  const now = new Date().toISOString();
  return makeHealthReport({
    source: "conductor.cli.doctor",
    checks: checks.map((check) =>
      healthCheck(check.name, healthStatus(check.status), check.message),
    ),
    started_at: now,
    finished_at: now,
  });
}

function healthCheck(name: string, status: HealthCheck["status"], message: string): HealthCheck {
  return { name, status, message };
}

function healthStatus(status: "pass" | "warn" | "fail" | "skip"): HealthCheck["status"] {
  if (status === "pass") return "ok";
  return status;
}

function helpText(): string {
  return "Usage: conductor <detect|doctor|status|policy export> [path] [--json]\n";
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
