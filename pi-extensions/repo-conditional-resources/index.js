import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(extensionDir, "defaults.json");
const defaultUserConfigPath = join(homedir(), ".pi", "agent", "repo-conditional-resources.json");

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizePath(path) {
  if (typeof path !== "string") {
    return path;
  }
  const trimmed = path.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (trimmed.startsWith("~")) {
    return join(homedir(), trimmed.slice(1));
  }
  return trimmed;
}

function loadJson(path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath || !existsSync(normalizedPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(normalizedPath, "utf8"));
  } catch (error) {
    console.warn(`[repo-conditional-resources] Could not parse ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function mergeProfile(baseProfile, overrideProfile, baseDir) {
  return {
    ...(baseProfile ?? {}),
    ...(overrideProfile ?? {}),
    match: {
      ...(baseProfile?.match ?? {}),
      ...(overrideProfile?.match ?? {}),
    },
    resources: {
      ...(baseProfile?.resources ?? {}),
      ...(overrideProfile?.resources ?? {}),
    },
    __baseDir: baseDir,
  };
}

function loadProfilesFromConfig(path) {
  const normalizedPath = normalizePath(path);
  const config = loadJson(normalizedPath);
  if (!config || typeof config !== "object") {
    return { debug: undefined, replaceDefaults: false, profiles: [] };
  }

  const baseDir = dirname(normalizedPath);
  const profiles = Array.isArray(config.profiles)
    ? config.profiles
        .filter((profile) => profile && typeof profile === "object" && typeof profile.name === "string")
        .map((profile) => ({ ...profile, __baseDir: baseDir }))
    : [];

  return {
    debug: typeof config.debug === "boolean" ? config.debug : undefined,
    replaceDefaults: config.replaceDefaults === true,
    profiles,
  };
}

function loadConfig() {
  const defaults = loadProfilesFromConfig(defaultConfigPath);
  const overridePath = normalizePath(process.env.PI_REPO_CONDITIONAL_RESOURCES_CONFIG || defaultUserConfigPath);
  const override = loadProfilesFromConfig(overridePath);

  const profiles = new Map();
  const seedProfiles = override.replaceDefaults ? [] : defaults.profiles;

  for (const profile of seedProfiles) {
    profiles.set(profile.name, profile);
  }

  for (const profile of override.profiles) {
    const existing = profiles.get(profile.name);
    profiles.set(profile.name, mergeProfile(existing, profile, profile.__baseDir));
  }

  return {
    debug: override.debug ?? defaults.debug ?? false,
    profiles: Array.from(profiles.values()).filter((profile) => profile.enabled !== false),
    overridePath,
  };
}

function runGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function extractOwnerRepo(remoteUrl) {
  const match = remoteUrl.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

function detectRepo(cwd) {
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    return null;
  }

  const remotesRaw = runGit(root, ["remote", "-v"]) ?? "";
  const remoteUrls = unique(
    remotesRaw
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean),
  );

  return {
    root,
    remoteUrls,
    ownerRepos: unique(remoteUrls.map(extractOwnerRepo)),
  };
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  const pattern = `^${escapeRegExp(glob).replace(/\*/g, ".*")}$`;
  return new RegExp(pattern, "i");
}

function regexMatches(patterns, value) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  });
}

function globMatches(patterns, value) {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function anyMatch(patterns, values, matcher) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  return values.some((value) => matcher(patterns, value));
}

function matchesProfile(profile, repoInfo) {
  const match = profile.match ?? {};
  const includeMatchers = [
    Array.isArray(match.repoPatterns) && match.repoPatterns.length > 0,
    Array.isArray(match.remotePatterns) && match.remotePatterns.length > 0,
    Array.isArray(match.pathPatterns) && match.pathPatterns.length > 0,
  ].some(Boolean);

  if (!includeMatchers) {
    return false;
  }

  const included =
    anyMatch(match.repoPatterns, repoInfo.ownerRepos, globMatches) ||
    anyMatch(match.remotePatterns, repoInfo.remoteUrls, regexMatches) ||
    anyMatch(match.pathPatterns, [repoInfo.root], regexMatches);

  if (!included) {
    return false;
  }

  const excluded =
    anyMatch(match.excludeRepoPatterns, repoInfo.ownerRepos, globMatches) ||
    anyMatch(match.excludeRemotePatterns, repoInfo.remoteUrls, regexMatches) ||
    anyMatch(match.excludePathPatterns, [repoInfo.root], regexMatches);

  return !excluded;
}

function resolvePaths(baseDir, paths) {
  if (!Array.isArray(paths)) {
    return [];
  }
  return unique(
    paths.map((path) => {
      const normalizedPath = normalizePath(path);
      return isAbsolute(normalizedPath) ? normalizedPath : resolve(baseDir, normalizedPath);
    }),
  ).filter((path) => existsSync(path));
}

function describeRepo(repoInfo) {
  const repoLabel = repoInfo.ownerRepos[0] ?? repoInfo.remoteUrls[0] ?? repoInfo.root;
  return `${repoLabel} @ ${repoInfo.root}`;
}

export default function registerRepoConditionalResources(pi) {
  pi.on("resources_discover", async (event, ctx) => {
    const repoInfo = detectRepo(event.cwd);
    if (!repoInfo) {
      return undefined;
    }

    const config = loadConfig();
    const matchedProfiles = config.profiles.filter((profile) => matchesProfile(profile, repoInfo));

    if (matchedProfiles.length === 0) {
      return undefined;
    }

    const skillPaths = unique(matchedProfiles.flatMap((profile) => resolvePaths(profile.__baseDir, profile.resources?.skills)));
    const promptPaths = unique(matchedProfiles.flatMap((profile) => resolvePaths(profile.__baseDir, profile.resources?.prompts)));
    const themePaths = unique(matchedProfiles.flatMap((profile) => resolvePaths(profile.__baseDir, profile.resources?.themes)));

    if (config.debug && ctx.hasUI) {
      ctx.ui.notify(
        `Matched ${matchedProfiles.map((profile) => profile.name).join(", ")} for ${describeRepo(repoInfo)}`,
        "info",
      );
    }

    return {
      skillPaths,
      promptPaths,
      themePaths,
    };
  });
}
