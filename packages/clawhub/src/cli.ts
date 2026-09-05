#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import { getCliBuildLabel, getCliVersion } from "./cli/buildInfo.js";
import { resolveClawdbotDefaultWorkspace } from "./cli/clawdbotConfig.js";
import { cmdLoginFlow, cmdLogout, cmdToken, cmdWhoami } from "./cli/commands/auth.js";
import {
  cmdDeleteSkill,
  cmdHideSkill,
  cmdUndeleteSkill,
  cmdUnhideSkill,
} from "./cli/commands/delete.js";
import { cmdInspect, cmdVerifySkill } from "./cli/commands/inspect.js";
import { cmdMergeSkill, cmdRenameSkill, cmdSetSkillTag } from "./cli/commands/ownership.js";
import {
  cmdDeletePackage,
  cmdDeletePackageTrustedPublisher,
  cmdDownloadPackage,
  cmdExplorePackages,
  cmdGetPackageTrustedPublisher,
  cmdInspectPackage,
  cmdPackageModerationStatus,
  cmdPackageMigrationStatus,
  cmdPackageReadiness,
  cmdPackPackage,
  cmdPublishPackage,
  cmdRecoverPackage,
  cmdReportPackage,
  cmdSetPackageTrustedPublisher,
  cmdTransferPackage,
  cmdUndeletePackage,
  cmdValidatePackage,
  cmdVerifyPackage,
} from "./cli/commands/packages.js";
import { cmdPublish } from "./cli/commands/publish.js";
import { cmdCreatePublisher } from "./cli/commands/publishers.js";
import { cmdScan, cmdScanDownload } from "./cli/commands/scan.js";
import {
  cmdExplore,
  cmdInstall,
  cmdList,
  cmdPin,
  cmdSearch,
  cmdUninstall,
  cmdUnpin,
  cmdUpdate,
} from "./cli/commands/skills.js";
import { cmdStarSkill } from "./cli/commands/star.js";
import { cmdSync } from "./cli/commands/sync.js";
import {
  cmdTransferAccept,
  cmdTransferCancel,
  cmdTransferList,
  cmdTransferReject,
  cmdTransferRequest,
} from "./cli/commands/transfer.js";
import { cmdUnstarSkill } from "./cli/commands/unstar.js";
import { configureCommanderHelp, styleEnvBlock, styleError, styleTitle } from "./cli/helpStyle.js";
import { DEFAULT_REGISTRY, DEFAULT_SITE } from "./cli/registry.js";
import type { GlobalOpts } from "./cli/types.js";
import { fail, formatError } from "./cli/ui.js";

const CLI_HELP_HEADER = styleTitle(`🦞 ClawHub CLI ${getCliBuildLabel()}`);
const HELP_DESCRIPTION = "Display help for command";

const program = new Command()
  .name("clawhub")
  .description(styleEnvBlock("install, update, search, and publish skills plus OpenClaw packages."))
  .version(getCliVersion(), "-V, --cli-version", "Show CLI version")
  .helpOption("-h, --help", HELP_DESCRIPTION)
  .option("--workdir <dir>", "Working directory (default: cwd)")
  .option("--dir <dir>", "Skills directory (relative to workdir, default: skills)")
  .option("--site <url>", "Site base URL for registry discovery and device verification")
  .option("--registry <url>", "Registry API base URL")
  .option("--no-input", "Disable prompts")
  .showHelpAfterError()
  .showSuggestionAfterError()
  .addHelpCommand("help [command]", HELP_DESCRIPTION)
  .addHelpText(
    "after",
    styleEnvBlock(
      "\nEnv:\n  CLAWHUB_SITE\n  CLAWHUB_REGISTRY\n  CLAWHUB_WORKDIR\n  (CLAWDHUB_* supported)\n",
    ),
  );

configureCommanderHelp(program);
addCliHelpHeader(program);
program.configureOutput({
  outputError: (message, write) => write(styleError(message)),
});

function addCliHelpHeader(command: Command) {
  command.addHelpText("beforeAll", `${CLI_HELP_HEADER}\n`);
}

function registerCommand(parent: Command, path: readonly string[]) {
  const command = parent.command(path.at(-1) ?? "").helpOption("-h, --help", HELP_DESCRIPTION);
  configureCommanderHelp(command);
  return command;
}

function registerCommandGroup(parent: Command, path: readonly string[]) {
  const command = parent.command(path.at(-1) ?? "").helpOption("-h, --help", HELP_DESCRIPTION);
  configureCommanderHelp(command);
  return command;
}

function applyCommandHelpGroups(parent: Command, groups: Record<string, string>) {
  for (const command of parent.commands) {
    const group = groups[command.name()];
    if (group) command.helpGroup(group);
  }
}

function validateTopLevelCommand(args: string[]) {
  if (hasTerminalGlobalFlag(args)) return;
  const commandName = findFirstTopLevelOperand(args);
  if (!commandName) return;
  const knownCommands = new Set([
    "help",
    ...program.commands.flatMap((command) => [command.name(), ...command.aliases()]),
  ]);
  if (knownCommands.has(commandName)) return;
  program.error(`error: unknown command '${commandName}'`, { code: "commander.unknownCommand" });
}

function hasTerminalGlobalFlag(args: string[]) {
  return args.some(
    (arg) => arg === "--help" || arg === "-h" || arg === "--cli-version" || arg === "-V",
  );
}

function findFirstTopLevelOperand(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--") return args[index + 1];
    if (arg.startsWith("--")) {
      if (arg === "--workdir" || arg === "--dir" || arg === "--site" || arg === "--registry") {
        index += 1;
        continue;
      }
      if (
        arg.startsWith("--workdir=") ||
        arg.startsWith("--dir=") ||
        arg.startsWith("--site=") ||
        arg.startsWith("--registry=")
      ) {
        continue;
      }
      if (arg === "--help" || arg === "--cli-version") return undefined;
      if (arg === "--no-input") continue;
      return undefined;
    }
    if (arg.startsWith("-")) {
      if (arg === "-h" || arg === "-V") return undefined;
      return undefined;
    }
    return arg;
  }
  return undefined;
}

async function resolveGlobalOpts(): Promise<GlobalOpts> {
  const raw = program.opts<{ workdir?: string; dir?: string; site?: string; registry?: string }>();
  const workdir = await resolveWorkdir(raw.workdir);
  const dir = resolve(workdir, raw.dir ?? "skills");
  const site = raw.site ?? process.env.CLAWHUB_SITE ?? process.env.CLAWDHUB_SITE ?? DEFAULT_SITE;
  const registrySource = raw.registry
    ? "cli"
    : process.env.CLAWHUB_REGISTRY || process.env.CLAWDHUB_REGISTRY
      ? "env"
      : "default";
  const registry =
    raw.registry ??
    process.env.CLAWHUB_REGISTRY ??
    process.env.CLAWDHUB_REGISTRY ??
    DEFAULT_REGISTRY;
  return { workdir, dir, site, registry, registrySource };
}

function isInputAllowed() {
  const globalFlags = program.opts<{ input?: boolean }>();
  return globalFlags.input !== false;
}

async function resolveWorkdir(explicit?: string) {
  if (explicit?.trim()) return resolve(explicit.trim());
  const envWorkdir = process.env.CLAWHUB_WORKDIR?.trim() ?? process.env.CLAWDHUB_WORKDIR?.trim();
  if (envWorkdir) return resolve(envWorkdir);

  const cwd = resolve(process.cwd());
  const hasMarker = await hasClawhubMarker(cwd);
  if (hasMarker) return cwd;

  const clawdbotWorkspace = await resolveClawdbotDefaultWorkspace();
  return clawdbotWorkspace ? resolve(clawdbotWorkspace) : cwd;
}

async function hasClawhubMarker(workdir: string) {
  const lockfile = join(workdir, ".clawhub", "lock.json");
  if (await pathExists(lockfile)) return true;
  const markerDir = join(workdir, ".clawhub");
  if (await pathExists(markerDir)) return true;
  const legacyLockfile = join(workdir, ".clawdhub", "lock.json");
  if (await pathExists(legacyLockfile)) return true;
  const legacyMarkerDir = join(workdir, ".clawdhub");
  return pathExists(legacyMarkerDir);
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

registerCommand(program, ["login"])
  .description("Log in with device flow or store a token")
  .option("--token <token>", "API token")
  .option("--label <label>", "Token label", "CLI device login")
  .option("--no-browser", "Do not open browser (device flow prints a verification URL)")
  .option("--device", "Use device flow (default)")
  .action(async (options) => {
    const opts = await resolveGlobalOpts();
    await cmdLoginFlow(opts, options, isInputAllowed());
  });

registerCommand(program, ["logout"])
  .description("Remove stored token")
  .action(async () => {
    const opts = await resolveGlobalOpts();
    await cmdLogout(opts);
  });

registerCommand(program, ["whoami"])
  .description("Validate token")
  .action(async () => {
    const opts = await resolveGlobalOpts();
    await cmdWhoami(opts);
  });

registerCommand(program, ["token"])
  .description("Print stored API token")
  .action(async () => {
    await cmdToken();
  });

const auth = registerCommandGroup(program, ["auth"])
  .description("Authentication commands")
  .showHelpAfterError()
  .showSuggestionAfterError();

registerCommand(auth, ["auth", "login"])
  .description("Log in with device flow or store a token")
  .option("--token <token>", "API token")
  .option("--label <label>", "Token label", "CLI device login")
  .option("--no-browser", "Do not open browser (device flow prints a verification URL)")
  .option("--device", "Use device flow (default)")
  .action(async (options) => {
    const opts = await resolveGlobalOpts();
    await cmdLoginFlow(opts, options, isInputAllowed());
  });

registerCommand(auth, ["auth", "logout"])
  .description("Remove stored token")
  .action(async () => {
    const opts = await resolveGlobalOpts();
    await cmdLogout(opts);
  });

registerCommand(auth, ["auth", "whoami"])
  .description("Validate token")
  .action(async () => {
    const opts = await resolveGlobalOpts();
    await cmdWhoami(opts);
  });

registerCommand(program, ["search"])
  .description("Search skills")
  .argument("<query...>", "Query string")
  .option("--limit <n>", "Max results", (value) => Number.parseInt(value, 10))
  .option("--prefix", "Treat the query as a skill slug prefix")
  .option("--exact", "Treat the query as an exact skill slug")
  .option("--cursor <cursor>", "Continue a prefix listing from a cursor")
  .action(async (queryParts, options) => {
    const opts = await resolveGlobalOpts();
    const query = queryParts.join(" ").trim();
    await cmdSearch(opts, query, {
      limit: options.limit,
      prefix: Boolean(options.prefix),
      exact: Boolean(options.exact),
      cursor: options.cursor,
    });
  });

registerCommand(program, ["install"])
  .description("Install a skill into <dir>")
  .argument("<skill>", "Skill to install, e.g. @openclaw/demo or skills-sh:owner/repo/slug")
  .option("--version <version>", "Version to install")
  .option("--force", "Overwrite existing folder")
  .option("--force-install", "Install a pending GitHub-backed skill before ClawHub scan completes")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdInstall(opts, slug, options.version, options.force, options.forceInstall);
  });

registerCommand(program, ["update"])
  .description("Update installed skills")
  .argument("[skill]", "Skill to update, e.g. @openclaw/demo or skills-sh:owner/repo/slug")
  .option("--all", "Update all installed skills")
  .option("--version <version>", "Update to specific version (single slug only)")
  .option("--force", "Overwrite when local files do not match any version")
  .option("--force-install", "Install a pending GitHub-backed skill before ClawHub scan completes")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdUpdate(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["uninstall"])
  .description("Uninstall a skill")
  .argument("<skill>", "Installed skill to remove")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdUninstall(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["list"])
  .description("List installed skills (tracked and manually installed)")
  .action(async () => {
    const opts = await resolveGlobalOpts();
    await cmdList(opts);
  });

registerCommand(program, ["pin"])
  .description("Pin an installed skill so update commands skip it")
  .argument("<skill>", "Installed skill to pin")
  .option("--reason <text>", "Optional pin reason")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPin(opts, slug, options);
  });

registerCommand(program, ["unpin"])
  .description("Remove a skill pin so updates can change it again")
  .argument("<skill>", "Installed skill to unpin")
  .action(async (slug) => {
    const opts = await resolveGlobalOpts();
    await cmdUnpin(opts, slug);
  });

registerCommand(program, ["explore"])
  .description("Browse latest updated skills from the registry")
  .option(
    "--limit <n>",
    "Number of skills to show (max 200)",
    (value) => Number.parseInt(value, 10),
    25,
  )
  .option("--sort <order>", "Sort by newest, rating, downloads, or trending", "newest")
  .option("--json", "Output JSON")
  .action(async (options) => {
    const opts = await resolveGlobalOpts();
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit) ? options.limit : 25;
    await cmdExplore(opts, { limit, sort: options.sort, json: options.json });
  });

registerCommand(program, ["inspect"])
  .description("Fetch skill metadata and files without installing")
  .argument("<skill>", "Skill to inspect, e.g. @openclaw/demo")
  .option("--version <version>", "Version to inspect")
  .option("--tag <tag>", "Tag to inspect (default: latest)")
  .option("--versions", "List version history (first page)")
  .option("--limit <n>", "Max versions to list (1-200)", (value) => Number.parseInt(value, 10))
  .option("--files", "List files for the selected version")
  .option("--file <path>", "Fetch raw file bytes (<= 10MB)")
  .option("--json", "Output JSON")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdInspect(opts, slug, options);
  });

registerCommand(program, ["publish"])
  .description("Legacy alias: publish a skill from folder")
  .argument("<path>", "Skill folder path")
  .option("--slug <slug>", "Published skill URL name")
  .option("--name <name>", "Display name")
  .option("--owner <handle>", "Publish under an org/user publisher handle")
  .option("--source-owner <handle>", "Source owner handle when migrating an existing skill")
  .option("--migrate-owner", "Move an existing skill to the selected owner when republishing")
  .option("--version <version>", "Explicit version (defaults to 1.0.0 or next patch)")
  .option("--fork-of <slug[@version]>", "Mark as a fork of an existing skill")
  .option("--changelog <text>", "Changelog text")
  .option("--tags <tags>", "Comma-separated tags", "latest")
  .option("--categories <slugs>", "Comma-separated category slugs")
  .option("--topics <topics>", "Comma-separated topics")
  .option("--dry-run", "Preview without publishing")
  .option("--json", "Output JSON")
  .option("--source-repo <repo>", "GitHub source repository")
  .option("--source-commit <sha>", "GitHub source commit")
  .option("--source-ref <ref>", "GitHub source ref")
  .option("--source-path <path>", "Path to the skill within the source repository")
  .action(async (folder, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPublish(opts, folder, options);
  });

const scanCmd = registerCommand(program, ["scan"])
  .description("Run or download ClawHub scan reports")
  .argument("[path]", "Deprecated local skill folder path")
  .option("--slug <slug>", "Published skill slug to scan")
  .option("--version <version>", "Published skill version to scan")
  .option("--update", "Write published scan results back to the selected version")
  .option("-o, --output <path>", "Write the full report ZIP to a file")
  .option("--json", "Output scan report JSON")
  .action(async (folder, options) => {
    const opts = await resolveGlobalOpts();
    await cmdScan(opts, folder, options);
  });

registerCommand(scanCmd, ["scan", "download"])
  .description("Download stored scan results for a submitted skill or plugin version")
  .argument("<name>", "Skill slug or plugin package name")
  .option("--version <version>", "Submitted version to download scan results for")
  .option("--kind <kind>", "Artifact kind: skill or plugin", "skill")
  .option("-o, --output <path>", "Output ZIP file")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    const parentOptions = scanCmd.opts<{ version?: string; output?: string }>();
    await cmdScanDownload(opts, name, {
      ...options,
      version: options.version ?? parentOptions.version,
      output: options.output ?? parentOptions.output,
    });
  });

registerCommand(program, ["delete"])
  .description("Soft-delete a skill or withdraw one version")
  .argument("<skill>", "Skill ref")
  .option(
    "--version <version>",
    "Withdraw one non-latest version; the retained artifact can be restored, but the version number remains reserved",
  )
  .option("--reason <text>", "Whole-skill moderation note/reason")
  .option("--note <text>", "Alias for --reason")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdDeleteSkill(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["hide"])
  .description("Hide one of your skills")
  .argument("<skill>", "Skill to hide")
  .option("--reason <text>", "Moderation note/reason")
  .option("--note <text>", "Alias for --reason")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdHideSkill(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["undelete"])
  .description("Restore a hidden skill or an owner-withdrawn version")
  .argument("<skill>", "Skill to restore")
  .option(
    "--version <version>",
    "Restore the exact retained version without changing latest or tags",
  )
  .option("--reason <text>", "Moderation note/reason")
  .option("--note <text>", "Alias for --reason")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdUndeleteSkill(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["unhide"])
  .description("Unhide one of your skills")
  .argument("<skill>", "Skill to unhide")
  .option("--reason <text>", "Moderation note/reason")
  .option("--note <text>", "Alias for --reason")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdUnhideSkill(opts, slug, options, isInputAllowed());
  });

const skill = registerCommandGroup(program, ["skill"]).description("Manage published skills");
registerCommand(skill, ["skill", "publish"])
  .description("Publish a skill from folder")
  .argument("<path>", "Skill folder path")
  .option("--slug <slug>", "Published skill URL name")
  .option("--name <name>", "Display name")
  .option("--owner <handle>", "Publish under an org/user publisher handle")
  .option("--source-owner <handle>", "Source owner handle when migrating an existing skill")
  .option("--migrate-owner", "Move an existing skill to the selected owner when republishing")
  .option("--version <version>", "Explicit version (defaults to 1.0.0 or next patch)")
  .option("--fork-of <slug[@version]>", "Mark as a fork of an existing skill")
  .option("--changelog <text>", "Changelog text")
  .option("--tags <tags>", "Comma-separated tags", "latest")
  .option("--categories <slugs>", "Comma-separated category slugs")
  .option("--topics <topics>", "Comma-separated topics")
  .option("--dry-run", "Preview without publishing")
  .option("--json", "Output JSON")
  .option("--source-repo <repo>", "GitHub source repository")
  .option("--source-commit <sha>", "GitHub source commit")
  .option("--source-ref <ref>", "GitHub source ref")
  .option("--source-path <path>", "Path to the skill within the source repository")
  .action(async (folder, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPublish(opts, folder, options);
  });

registerCommand(skill, ["skill", "verify"])
  .description("Verify a published skill using ClawHub security evidence")
  .argument("<slug>", "Skill slug")
  .option("--version <version>", "Version to verify")
  .option("--tag <tag>", "Tag to verify")
  .option("--card", "Output generated skill-card.md Markdown")
  .addOption(new Option("--json", "Output JSON").hideHelp())
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdVerifySkill(opts, slug, options);
  });

registerCommand(skill, ["skill", "tag"])
  .description("Point a skill tag at an existing version")
  .argument("<skill>", "Skill ref")
  .argument("<version>", "Existing version")
  .option("--tag <tag>", "Tag to move", "latest")
  .option("--yes", "Skip confirmation")
  .action(async (skillRef, version, options) => {
    const opts = await resolveGlobalOpts();
    await cmdSetSkillTag(opts, skillRef, version, options, isInputAllowed());
  });

const publisherCmd = registerCommandGroup(program, ["publisher"])
  .description("Publisher organization commands")
  .showHelpAfterError()
  .showSuggestionAfterError();

registerCommand(publisherCmd, ["publisher", "create"])
  .description("Create an org publisher you own")
  .argument("<handle>", "Publisher handle, for example example.tools")
  .option("--display-name <name>", "Publisher display name")
  .option("--json", "Output JSON")
  .action(async (handle, options) => {
    const opts = await resolveGlobalOpts();
    await cmdCreatePublisher(opts, handle, options);
  });

const packageCmd = registerCommandGroup(program, ["package"]).description(
  "Browse and publish OpenClaw packages",
);

registerCommand(packageCmd, ["package", "explore"])
  .description("Browse published packages and plugins")
  .argument("[query...]", "Optional search query")
  .option("--family <family>", "skill|code-plugin|bundle-plugin|claw")
  .option("--official", "Only official packages")
  .option("--executes-code", "Only packages that execute code")
  .option("--target <target>", "Filter by host target, e.g. darwin-arm64")
  .option("--os <os>", "Filter by host OS, e.g. darwin, linux, win32")
  .option("--arch <arch>", "Filter by host architecture, e.g. arm64 or x64")
  .option("--libc <libc>", "Filter by libc, e.g. glibc or musl")
  .option("--requires-browser", "Only packages that require a browser")
  .option("--requires-desktop", "Only packages that require local desktop access")
  .option("--requires-native-deps", "Only packages with native dependency requirements")
  .option("--requires-external-service", "Only packages that require an external service")
  .option("--external-service <name>", "Filter by named external service")
  .option("--binary <name>", "Filter by required local binary")
  .option("--os-permission <name>", "Filter by required OS permission")
  .option("--artifact-kind <kind>", "legacy-zip|npm-pack")
  .option("--npm-mirror", "Only packages available through the npm mirror")
  .option(
    "--limit <n>",
    "Number of packages to show (max 100)",
    (value) => Number.parseInt(value, 10),
    25,
  )
  .option("--json", "Output JSON")
  .action(async (queryParts, options) => {
    const opts = await resolveGlobalOpts();
    const query = Array.isArray(queryParts) ? queryParts.join(" ").trim() : "";
    await cmdExplorePackages(opts, query, options);
  });

registerCommand(packageCmd, ["package", "inspect"])
  .description("Fetch package metadata and files without installing")
  .argument("<name>", "Package name")
  .option("--version <version>", "Version to inspect")
  .option("--tag <tag>", "Tag to inspect (default: latest)")
  .option("--versions", "List version history (first page)")
  .option("--limit <n>", "Max versions to list (1-100)", (value) => Number.parseInt(value, 10))
  .option("--files", "List files for the selected version")
  .option("--file <path>", "Fetch a text preview (<= 200KB)")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdInspectPackage(opts, name, options);
  });

registerCommand(packageCmd, ["package", "download"])
  .description("Download a package artifact and verify its published digests")
  .argument("<name>", "Package name")
  .option("--version <version>", "Version to download")
  .option("--tag <tag>", "Tag to download (default: latest)")
  .option("-o, --output <path>", "Output file or directory")
  .option("--force", "Overwrite existing output file")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdDownloadPackage(opts, name, options);
  });

registerCommand(packageCmd, ["package", "verify"])
  .description("Verify a local package artifact against ClawHub or expected digests")
  .argument("<file>", "Artifact file")
  .option("--package <name>", "Package name to resolve expected artifact metadata")
  .option("--version <version>", "Package version to resolve")
  .option("--tag <tag>", "Package tag to resolve")
  .option("--sha256 <hex>", "Expected ClawHub SHA-256")
  .option("--npm-integrity <sri>", "Expected npm sha512 integrity")
  .option("--npm-shasum <sha1>", "Expected npm shasum")
  .option("--json", "Output JSON")
  .action(async (file, options) => {
    const opts = await resolveGlobalOpts();
    await cmdVerifyPackage(opts, file, {
      ...options,
      packageName: options.package,
    });
  });

registerCommand(packageCmd, ["package", "validate"])
  .description("Validate a local plugin package with the bundled Plugin Inspector")
  .argument("<source>", "Package folder path")
  .option("--out <dir>", "Directory for Plugin Inspector reports", "reports")
  .option("--openclaw <path>", "Optional local OpenClaw checkout to inspect against")
  .option("--openclaw-version <version>", "OpenClaw target: latest, beta, or an exact version")
  .option("--runtime", "Enable runtime capture; imports plugin code")
  .option("--allow-execute", "Allow runtime capture in an isolated workspace")
  .option("--no-mock-sdk", "Disable mocked OpenClaw SDK during runtime capture")
  .option("--json", "Output JSON")
  .action(async (source, options) => {
    const opts = await resolveGlobalOpts();
    await cmdValidatePackage(opts, source, options);
  });

registerCommand(packageCmd, ["package", "delete"])
  .description("Soft-delete a package or withdraw one version")
  .argument("<name>", "Package name")
  .option(
    "--version <version>",
    "Withdraw one non-latest version; the retained artifact can be restored, but the version number remains reserved",
  )
  .option("--yes", "Skip confirmation")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdDeletePackage(opts, name, options, isInputAllowed());
  });

registerCommand(packageCmd, ["package", "undelete"])
  .description("Restore a soft-deleted package or an owner-withdrawn release")
  .argument("<name>", "Package name")
  .option(
    "--version <version>",
    "Restore the exact retained release without changing latest or dist-tags",
  )
  .option("--yes", "Skip confirmation")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdUndeletePackage(opts, name, options, isInputAllowed());
  });

registerCommand(packageCmd, ["package", "transfer"])
  .description("Transfer a plugin package to another publisher")
  .argument("<name>", "Package name")
  .requiredOption("--to <owner>", "Destination publisher handle")
  .option("--reason <text>", "Audit reason")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdTransferPackage(opts, name, options);
  });

registerCommand(packageCmd, ["package", "report"])
  .description("Report a package for moderator review")
  .argument("<name>", "Package name")
  .option("--version <version>", "Package version")
  .requiredOption("--reason <text>", "Report reason")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdReportPackage(opts, name, options);
  });

registerCommand(packageCmd, ["package", "moderation-status"])
  .description("Show package moderation status")
  .argument("<name>", "Package name")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPackageModerationStatus(opts, name, options);
  });

registerCommand(packageCmd, ["package", "readiness"])
  .description("Check package readiness for future OpenClaw consumption")
  .argument("<name>", "Package name")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPackageReadiness(opts, name, options);
  });

registerCommand(packageCmd, ["package", "migration-status"])
  .description("Show package migration status for future OpenClaw consumption")
  .argument("<name>", "Package name")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPackageMigrationStatus(opts, name, options);
  });

registerCommand(packageCmd, ["package", "pack"])
  .description("Create a ClawPack npm tarball from a plugin package folder")
  .argument("<source>", "Package folder path")
  .option("--pack-destination <dir>", "Directory for the generated .tgz (default: workdir)")
  .option("--json", "Output JSON")
  .action(async (source, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPackPackage(opts, source, options);
  });

registerCommand(packageCmd, ["package", "publish"])
  .description("Publish a code plugin or bundle plugin from a folder or GitHub source")
  .argument("<source>", "Package folder path, GitHub repo (owner/repo[@ref]), or URL")
  .option("--family <family>", "code-plugin|bundle-plugin|claw")
  .option("--name <name>", "Package name")
  .option("--display-name <name>", "Display name")
  .option("--owner <handle>", "Publish under this owner/publisher handle")
  .option("--version <version>", "Version")
  .option("--changelog <text>", "Changelog text")
  .option(
    "--manual-override-reason <reason>",
    "Required for manual publish when trusted publisher config exists",
  )
  .option("--tags <tags>", "Comma-separated tags", "latest")
  .option("--categories <slugs>", "Comma-separated category slugs")
  .option("--topics <topics>", "Comma-separated topics")
  .option("--bundle-format <format>", "Bundle format")
  .option("--host-targets <targets>", "Comma-separated bundle host targets")
  .option("--source-repo <repo>", "GitHub repo (owner/repo or URL)")
  .option("--source-commit <sha>", "Git commit SHA")
  .option("--source-ref <ref>", "Git ref/tag/branch")
  .option("--source-path <path>", "Repo subpath")
  .option("--dry-run", "Preview what would be published without uploading")
  .option("--wait", "Wait for security checks and definitive publication")
  .option(
    "--wait-timeout <seconds>",
    "Maximum seconds to wait for definitive publication",
    (value) => Number(value),
  )
  .option("--json", "Output JSON (for CI pipelines)")
  .action(async (source, options) => {
    const opts = await resolveGlobalOpts();
    await cmdPublishPackage(opts, source, options);
  });

registerCommand(packageCmd, ["package", "recover"])
  .description("Recover a failed staged OpenClaw release publication with fresh security checks")
  .argument("<attempt-id>", "Failed publish attempt ID")
  .requiredOption(
    "--manual-override-reason <reason>",
    "Audit reason for authorized publisher recovery",
  )
  .option("--wait", "Wait for security checks and definitive publication")
  .option("--wait-timeout <seconds>", "Maximum seconds to wait for publication", Number)
  .option("--json", "Output JSON")
  .action(async (attemptId, options) => {
    const opts = await resolveGlobalOpts();
    await cmdRecoverPackage(opts, attemptId, options);
  });

const trustedPublisherCmd = registerCommandGroup(packageCmd, [
  "package",
  "trusted-publisher",
]).description("Manage package trusted publisher config");

registerCommand(trustedPublisherCmd, ["package", "trusted-publisher", "get"])
  .description("Show trusted publisher config for a package")
  .argument("<name>", "Package name")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdGetPackageTrustedPublisher(opts, name, options);
  });

registerCommand(trustedPublisherCmd, ["package", "trusted-publisher", "set"])
  .description("Set trusted publisher config for a package")
  .argument("<name>", "Package name")
  .requiredOption("--repository <repo>", "GitHub repository, for example openclaw/openclaw")
  .requiredOption("--workflow-filename <file>", "GitHub Actions workflow filename")
  .option("--environment <name>", "GitHub Actions environment name")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdSetPackageTrustedPublisher(opts, name, options);
  });

registerCommand(trustedPublisherCmd, ["package", "trusted-publisher", "delete"])
  .description("Delete trusted publisher config for a package")
  .argument("<name>", "Package name")
  .option("--json", "Output JSON")
  .action(async (name, options) => {
    const opts = await resolveGlobalOpts();
    await cmdDeletePackageTrustedPublisher(opts, name, options);
  });

registerCommand(skill, ["skill", "rename"])
  .description("Rename a published skill and keep the old slug as a redirect")
  .argument("<skill>", "Current skill")
  .argument("<new-slug>", "New canonical slug")
  .option("--yes", "Skip confirmation")
  .action(async (slug, newSlug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdRenameSkill(opts, slug, newSlug, options, isInputAllowed());
  });

registerCommand(skill, ["skill", "merge"])
  .description("Merge one owned skill into another and redirect the old slug")
  .argument("<source>", "Source skill")
  .argument("<target>", "Target skill")
  .option("--yes", "Skip confirmation")
  .action(async (sourceSlug, targetSlug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdMergeSkill(opts, sourceSlug, targetSlug, options, isInputAllowed());
  });

const transfer = registerCommandGroup(program, ["transfer"]).description(
  "Transfer skill ownership",
);

registerCommand(transfer, ["transfer", "request"])
  .description("Request skill transfer to another user")
  .argument("<skill>", "Skill to transfer")
  .argument("<handle>", "Recipient handle (e.g., @username)")
  .option("--message <text>", "Optional message for recipient")
  .option("--yes", "Skip confirmation")
  .action(async (slug, handle, options) => {
    const opts = await resolveGlobalOpts();
    await cmdTransferRequest(opts, slug, handle, options, isInputAllowed());
  });

registerCommand(transfer, ["transfer", "list"])
  .description("List pending transfer requests")
  .option("--outgoing", "Show outgoing transfer requests")
  .action(async (options) => {
    const opts = await resolveGlobalOpts();
    await cmdTransferList(opts, options);
  });

registerCommand(transfer, ["transfer", "accept"])
  .description("Accept incoming transfer for a skill")
  .argument("<skill>", "Skill to accept")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdTransferAccept(opts, slug, options, isInputAllowed());
  });

registerCommand(transfer, ["transfer", "reject"])
  .description("Reject incoming transfer for a skill")
  .argument("<skill>", "Skill to reject")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdTransferReject(opts, slug, options, isInputAllowed());
  });

registerCommand(transfer, ["transfer", "cancel"])
  .description("Cancel outgoing transfer for a skill")
  .argument("<skill>", "Skill to cancel")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdTransferCancel(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["star"])
  .description("Add a skill to your highlights")
  .argument("<skill>", "Skill to highlight")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdStarSkill(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["unstar"])
  .description("Remove a skill from your highlights")
  .argument("<skill>", "Skill to remove from highlights")
  .option("--yes", "Skip confirmation")
  .action(async (slug, options) => {
    const opts = await resolveGlobalOpts();
    await cmdUnstarSkill(opts, slug, options, isInputAllowed());
  });

registerCommand(program, ["sync"])
  .description("Scan local skills and publish new or changed ones")
  .option("--root <dir...>", "Extra scan roots (one or more)")
  .option("--all", "Publish all new or changed skills without prompting")
  .option("--dry-run", "Show what would be published")
  .option("--json", "Output JSON")
  .option("--owner <handle>", "Publish under an org/user publisher handle")
  .option("--bump <type>", "Version bump for updates (patch|minor|major)", "patch")
  .option("--changelog <text>", "Changelog to use for updates")
  .option("--tags <tags>", "Comma-separated tags", "latest")
  .option("--concurrency <n>", "Concurrent registry/file checks", (value) =>
    Number.parseInt(value, 10),
  )
  .option("--source-repo <repo>", "GitHub repo URL or owner/name for source provenance")
  .option("--source-commit <sha>", "Git commit SHA for source provenance")
  .option("--source-ref <ref>", "Git ref for source provenance")
  .action(async (options) => {
    const opts = await resolveGlobalOpts();
    const bump =
      options.bump === "patch" || options.bump === "minor" || options.bump === "major"
        ? options.bump
        : fail("--bump must be patch, minor, or major");
    const concurrency = options.concurrency ?? 6;
    if (concurrency < 1 || concurrency > 32) fail("--concurrency must be between 1 and 32");
    await cmdSync(
      opts,
      {
        root: options.root,
        all: options.all,
        dryRun: options.dryRun,
        json: options.json,
        owner: options.owner,
        bump,
        changelog: options.changelog,
        tags: options.tags,
        concurrency,
        sourceRepo: options.sourceRepo,
        sourceCommit: options.sourceCommit,
        sourceRef: options.sourceRef,
      },
      isInputAllowed(),
    );
  });

applyCommandHelpGroups(program, {
  login: "Auth:",
  logout: "Auth:",
  whoami: "Auth:",
  auth: "Auth:",
  search: "Skills:",
  install: "Skills:",
  update: "Skills:",
  uninstall: "Skills:",
  list: "Skills:",
  pin: "Skills:",
  unpin: "Skills:",
  explore: "Skills:",
  inspect: "Skills:",
  star: "Skills:",
  unstar: "Skills:",
  publish: "Publishing:",
  sync: "Publishing:",
  skill: "Publishing:",
  publisher: "Publishing:",
  package: "Packages:",
  delete: "Moderation:",
  hide: "Moderation:",
  undelete: "Moderation:",
  unhide: "Moderation:",
  transfer: "Moderation:",
  help: "Help:",
});

applyCommandHelpGroups(packageCmd, {
  explore: "Discovery:",
  inspect: "Discovery:",
  download: "Artifacts:",
  verify: "Artifacts:",
  pack: "Publishing:",
  publish: "Publishing:",
  "trusted-publisher": "Publishing:",
  recover: "Publishing:",
  delete: "Moderation:",
  undelete: "Moderation:",
  transfer: "Moderation:",
  report: "Moderation:",
  "moderation-status": "Moderation:",
  readiness: "Operations:",
  "migration-status": "Operations:",
});

program.action(() => {
  program.outputHelp();
  process.exitCode = 0;
});

validateTopLevelCommand(process.argv.slice(2));

void program.parseAsync(process.argv).catch((error) => {
  fail(formatError(error));
});
