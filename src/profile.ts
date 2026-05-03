import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ConductorFact = {
  preferred: string;
  evidence: string[];
};

export type ConductorStackProfile = {
  root: string;
  packageManager?: ConductorFact;
  typecheck?: ConductorFact;
  lint?: ConductorFact;
  format?: ConductorFact;
  frontend?: {
    framework: string;
    router?: string;
    evidence: string[];
  };
};

export type ConductorDoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
};

export function detectStackProfile(root: string): ConductorStackProfile {
  const packageJson = readPackageJson(root);
  const scripts = packageJson?.scripts ?? {};
  const profile: ConductorStackProfile = { root };

  const packageManagerEvidence: string[] = [];
  if (existsSync(join(root, "bun.lock"))) packageManagerEvidence.push("bun.lock");
  if (
    typeof packageJson?.packageManager === "string" &&
    packageJson.packageManager.startsWith("bun@")
  ) {
    packageManagerEvidence.push("package.json#packageManager");
  }
  if (packageManagerEvidence.length > 0) {
    profile.packageManager = { preferred: "bun", evidence: packageManagerEvidence };
  }

  const typecheck = typeof scripts.typecheck === "string" ? scripts.typecheck : undefined;
  if (typecheck) {
    profile.typecheck = { preferred: typecheck, evidence: ["package.json#scripts.typecheck"] };
  } else if (existsSync(join(root, "tsconfig.json"))) {
    profile.typecheck = { preferred: "bunx tsgo --noEmit", evidence: ["tsconfig.json"] };
  }

  const lint =
    typeof scripts.lint === "string"
      ? scripts.lint
      : typeof scripts["lint:check"] === "string"
        ? scripts["lint:check"]
        : undefined;
  if (lint) profile.lint = { preferred: lint, evidence: ["package.json#scripts.lint"] };

  const format =
    typeof scripts.format === "string"
      ? scripts.format
      : typeof scripts["format:check"] === "string"
        ? scripts["format:check"]
        : undefined;
  if (format) profile.format = { preferred: format, evidence: ["package.json#scripts.format"] };

  if (hasAny(root, ["next.config.ts", "next.config.mjs", "next.config.js"])) {
    profile.frontend = { framework: "nextjs", router: "app", evidence: ["next.config.*"] };
  }

  return profile;
}

export function doctorStackProfile(profile: ConductorStackProfile): ConductorDoctorCheck[] {
  const checks: ConductorDoctorCheck[] = [];
  checks.push({
    name: "package manager",
    status: profile.packageManager?.preferred === "bun" ? "pass" : "warn",
    message: profile.packageManager
      ? `${profile.packageManager.preferred} (${profile.packageManager.evidence.join(", ")})`
      : "not detected",
  });
  checks.push({
    name: "typecheck command",
    status: profile.typecheck ? "pass" : "warn",
    message: profile.typecheck?.preferred ?? "not detected",
  });
  checks.push({
    name: "lint command",
    status: profile.lint ? "pass" : "skip",
    message: profile.lint?.preferred ?? "not configured",
  });
  checks.push({
    name: "format command",
    status: profile.format ? "pass" : "skip",
    message: profile.format?.preferred ?? "not configured",
  });
  checks.push({
    name: "frontend framework",
    status: profile.frontend ? "pass" : "skip",
    message: profile.frontend
      ? `${profile.frontend.framework} ${profile.frontend.router ?? ""}`.trim()
      : "not detected",
  });
  return checks;
}

export function exportPolicy(profile: ConductorStackProfile): Record<string, unknown> {
  return {
    schema_version: 1,
    source: "conductor",
    root: profile.root,
    package_manager: profile.packageManager,
    commands: {
      typecheck: profile.typecheck?.preferred,
      lint: profile.lint?.preferred,
      format: profile.format?.preferred,
    },
    frontend: profile.frontend,
  };
}

function hasAny(root: string, names: string[]): boolean {
  return names.some((name) => existsSync(join(root, name)));
}

function readPackageJson(
  root: string,
): { packageManager?: unknown; scripts?: Record<string, unknown> } | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as { packageManager?: unknown; scripts?: Record<string, unknown> };
  } catch {
    return undefined;
  }
}
