import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ci, pluginRoot, reports } from "@openclaw/plugin-inspector";
import ignore from "ignore";
import mime from "mime";
import semver from "semver";
import { parseClawPack } from "../../clawpack.js";
import {
  apiRequest,
  apiRequestForm,
  fetchBinary,
  fetchText,
  getHttpErrorStatus,
  isRetryableHttpError,
  registryUrl,
  uploadBinary,
} from "../../http.js";
import {
  ApiCliUploadUrlResponseSchema,
  ApiRoutes,
  LegacyApiRoutes,
  ApiV1DeleteResponseSchema,
  ApiUploadFileResponseSchema,
  ApiV1PackageArtifactResponseSchema,
  ApiV1PackageListResponseSchema,
  ApiV1PackageModerationStatusResponseSchema,
  ApiV1PackagePublishAttemptResponseSchema,
  type ApiV1PackagePublishAttemptResponse,
  ApiV1PackagePublishRecoveryResponseSchema,
  ApiV1PackagePublishResponseSchema,
  type ApiV1PackagePublishResponse,
  ApiV1PackageReadinessResponseSchema,
  ApiV1PackageReportResponseSchema,
  ApiV1PackageResponseSchema,
  ApiV1PackageSearchResponseSchema,
  ApiV1PackageTransferResponseSchema,
  ApiV1PackageTrustedPublisherResponseSchema,
  ApiV1PackageVersionListResponseSchema,
  ApiV1PackageVersionResponseSchema,
  ApiV1PublishTokenMintResponseSchema,
  estimatePackageMultipartUploadBytes,
  getPackageMultipartSizeError,
  MAX_PACKAGE_CLAWPACK_BYTES,
  MAX_PACKAGE_MULTIPART_BYTES,
  normalizeOpenClawExternalPluginCompatibility,
  type PackageArtifactSummary,
  type PackageCompatibility,
  type PackageFamily,
  type PackageTrustedPublisher,
  type PackageVerificationSummary,
  decodeUtf8Text,
  validateOpenClawExternalCodePluginPackageContents,
  validateOpenClawExternalCodePluginPackageJson,
} from "../../schema/index.js";
import { buildGitHubFolderContentHash, hashSkillFiles } from "../../skills.js";
import { getOptionalAuthToken, requireAuthToken } from "../authToken.js";
import { getRegistry } from "../registry.js";
import { titleCase } from "../slug.js";
import type { GlobalOpts } from "../types.js";
import {
  createCrabLoader,
  fail,
  formatError,
  isInteractive,
  promptConfirm,
  styleText,
} from "../ui.js";
import {
  createGitHubRetryBudget,
  fetchGitHubSource,
  normalizeGitHubRepo,
  resolveLocalGitInfo,
  resolveSourceInput,
} from "./github.js";

const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIR = ".clawdhub";
const DOT_IGNORE = ".clawhubignore";
const LEGACY_DOT_IGNORE = ".clawdhubignore";
const PACKAGE_PUBLISH_RETRY_COUNT = 5;
const PACKAGE_PUBLISH_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PACKAGE_PUBLISH_WAIT_TIMEOUT_SECONDS = 30 * 60;
// ClawHub unpacks and stores a ClawPack inside one HTTP action before it
// answers the publish request, so large packages need far more than the
// default upload timeout; 5 minutes matches the front-end function budget.
const PACKAGE_PUBLISH_REQUEST_TIMEOUT_MS = 5 * 60_000;
const AUTHOR_REMEDIATION_DOCS_BASE = "https://docs.openclaw.ai/clawhub/plugin-validation-fixes";
const LEGACY_AUTHOR_REMEDIATION_SUMMARIES = {
  "channel-env-vars":
    "Move legacy channel environment variable metadata into the current setup/config metadata.",
  "legacy-before-agent-start":
    "Replace the legacy before_agent_start hook with the current prompt/model hooks.",
  "legacy-root-sdk-import":
    "Prefer focused public plugin SDK subpath imports instead of the legacy root barrel.",
  "manifest-name-missing": "Add a display name to the plugin manifest.",
  "manifest-unknown-contracts":
    "Remove unsupported manifest contract keys or move them to a documented OpenClaw contract field.",
  "manifest-unknown-fields":
    "Move unsupported top-level manifest fields into supported package metadata or remove them.",
  "package-entrypoint-missing":
    "Publish the entrypoint declared in OpenClaw package metadata or update the metadata to point at an existing file.",
  "package-install-metadata-incomplete":
    "Complete the OpenClaw install metadata so ClawHub can identify the install target.",
  "package-json-missing": "Add a package.json to the plugin package.",
  "package-manifest-version-drift":
    "Align the plugin version declared in package.json and openclaw.plugin.json.",
  "package-min-host-version-drift":
    "Set the package minimum host version to the OpenClaw version range the plugin was built and tested against.",
  "package-npm-pack-entrypoint-missing":
    "Include the declared OpenClaw entrypoints in the npm-packed artifact.",
  "package-npm-pack-metadata-missing":
    "Include OpenClaw metadata files in the npm-packed artifact.",
  "package-npm-pack-unavailable": "Make the package packable before publishing it through ClawHub.",
  "package-openclaw-entry-missing":
    "Declare the plugin runtime entrypoint in package.json OpenClaw metadata.",
  "package-openclaw-metadata-missing": "Add the package.json openclaw metadata block.",
  "package-openclaw-unsupported-metadata": "Remove unsupported OpenClaw package metadata fields.",
  "package-plugin-api-compat-missing":
    "Declare the OpenClaw plugin API range this package supports.",
  "provider-auth-env-vars":
    "Move legacy provider authentication environment variables into current provider setup metadata.",
  "reserved-sdk-import": "Stop importing reserved bundled-plugin SDK compatibility paths.",
  "security-manifest-schema-unavailable":
    "Remove or update the unsupported security manifest schema reference.",
  "sdk-load-session-store":
    "Replace deprecated loadSessionStore whole-store access with row-scoped session helpers.",
  "sdk-session-file-helper":
    "Replace deprecated session file-path helpers with session entry and transcript identity APIs.",
  "sdk-session-store-write":
    "Replace deprecated whole-store session writes with row-scoped session helpers.",
  "sdk-session-transcript-file-target":
    "Replace legacy transcript file targets with public transcript identity or target helpers.",
  "sdk-session-transcript-low-level":
    "Replace low-level transcript writes with the structured transcript runtime helpers.",
  "unrecognized-security-manifest":
    "Remove unsupported security manifest files until OpenClaw documents a versioned security manifest schema.",
} as const;

type PackageInspectOptions = {
  version?: string;
  tag?: string;
  versions?: boolean;
  limit?: number;
  files?: boolean;
  file?: string;
  json?: boolean;
};

type PackageExploreOptions = {
  family?: PackageFamily;
  official?: boolean;
  limit?: number;
  json?: boolean;
};

type PublishablePackageFamily = "code-plugin" | "bundle-plugin" | "claw";

type PackagePublishOptions = {
  family?: PublishablePackageFamily;
  name?: string;
  displayName?: string;
  owner?: string;
  version?: string;
  changelog?: string;
  manualOverrideReason?: string;
  tags?: string;
  categories?: string;
  topics?: string;
  bundleFormat?: string;
  hostTargets?: string;
  sourceRepo?: string;
  sourceCommit?: string;
  sourceRef?: string;
  sourcePath?: string;
  dryRun?: boolean;
  wait?: boolean;
  waitTimeout?: number;
  json?: boolean;
};

type PackagePublishRuntime = {
  now?: () => number;
  revalidateTrustedTooling?: () => Promise<void> | void;
  sleep?: (milliseconds: number) => Promise<void>;
};

type PackagePackOptions = {
  packDestination?: string;
  json?: boolean;
};

type PackageValidateOptions = {
  out?: string;
  openclaw?: string;
  openclawVersion?: string;
  runtime?: boolean;
  allowExecute?: boolean;
  mockSdk?: boolean;
  json?: boolean;
};

type PackageDownloadOptions = {
  version?: string;
  tag?: string;
  output?: string;
  force?: boolean;
  json?: boolean;
};

type PackageVerifyOptions = {
  packageName?: string;
  version?: string;
  tag?: string;
  sha256?: string;
  npmIntegrity?: string;
  npmShasum?: string;
  json?: boolean;
};

type PackageReportOptions = {
  version?: string;
  reason?: string;
  json?: boolean;
};

type PackageModerationStatusOptions = {
  json?: boolean;
};

type PackageReadinessOptions = {
  json?: boolean;
};

type PackageMigrationStatusOptions = PackageReadinessOptions;

type PackageTrustedPublisherGetOptions = {
  json?: boolean;
};

type PackageTrustedPublisherSetOptions = {
  repository?: string;
  workflowFilename?: string;
  environment?: string;
  json?: boolean;
};

type PackageTrustedPublisherDeleteOptions = {
  json?: boolean;
};

type PackageDeleteOptions = {
  yes?: boolean;
  json?: boolean;
  version?: string;
};

type PackageUndeleteOptions = PackageDeleteOptions;

type PackageTransferOptions = {
  to: string;
  reason?: string;
  json?: boolean;
};

type PackageFile = {
  relPath: string;
  bytes: Uint8Array;
  contentType?: string;
};

type InferredPublishSource = {
  repo?: string;
  commit?: string;
  ref?: string;
  path?: string;
  url?: string;
};

type PackagePublishSource = ReturnType<typeof buildSource>;

type PackagePublishPayload = {
  name: string;
  displayName: string;
  ownerHandle?: string;
  family: PublishablePackageFamily;
  version: string;
  changelog: string;
  expectedArtifactSha256?: string;
  manualOverrideReason?: string;
  tags: string[];
  categories?: string[];
  topics?: string[];
  source?: NonNullable<PackagePublishSource>;
  bundle?: {
    format?: string;
    hostTargets: string[];
  };
};

type PackagePublishPlan = {
  folder: string;
  cleanup?: () => Promise<void>;
  filesOnDisk: PackageFile[];
  clawpackOnDisk?: PackageFile;
  packageJson?: unknown;
  payload: PackagePublishPayload;
  compatibility?: PackageCompatibility;
  sourceLabel: string;
  output: {
    source: string;
    name: string;
    displayName: string;
    family: PublishablePackageFamily;
    version: string;
    commit?: string;
    files: number;
    totalBytes: number;
    artifactSha256?: string;
  };
};

function assertClawPublishArtifactDigest(
  plan: PackagePublishPlan,
  result: { artifactSha256?: string },
) {
  if (plan.payload.family !== "claw") return;
  if (result.artifactSha256 !== plan.payload.expectedArtifactSha256) {
    fail(
      `ClawHub artifact SHA-256 mismatch: expected ${plan.payload.expectedArtifactSha256}, got ${result.artifactSha256 ?? "missing"}`,
    );
  }
}

async function validateClawPublishProfilePolicy(
  plan: PackagePublishPlan,
  registry: string,
  token: string,
) {
  if (plan.payload.family !== "claw") return;
  const { validateClawPackageContents } = await import("../../schema/clawPackage.js");
  const validationInput = {
    packageName: plan.payload.name,
    version: plan.payload.version,
    packageJson: plan.packageJson,
    files: plan.filesOnDisk.map((file) => ({
      path: file.relPath,
      text: decodeUtf8Text(file.bytes) ?? undefined,
    })),
  };
  const currentValidation = validateClawPackageContents({
    ...validationInput,
    openClawProfilePolicy: "current",
  });
  if (currentValidation.ok) return;

  const packageDetail = await apiRequestPackageDetail(registry, plan.payload.name, token);
  if (
    packageDetail?.package?.family === "claw" &&
    packageDetail.package.clawProfilePolicyVersion === undefined
  ) {
    return;
  }
  fail(currentValidation.issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "));
}

type PackedClawPack = {
  path: string;
  file: PackageFile;
  parsed: ReturnType<typeof parseClawPack>;
  identity: ArtifactIdentity;
};

type PrintableFile = {
  path: string;
  size: number | null;
  sha256: string | null;
  contentType: string | null;
};

type PackageResponse = Awaited<ReturnType<typeof apiRequestPackageDetail>>;
type PackageVersionResponse = Awaited<ReturnType<typeof apiRequestPackageVersion>>;
type PackageArtifactResponse = Awaited<ReturnType<typeof apiRequestPackageArtifact>>;
type ArtifactIdentity = {
  sha256: string;
  npmIntegrity: string;
  npmShasum: string;
  byteLength: number;
};

export async function cmdExplorePackages(
  opts: GlobalOpts,
  query: string,
  options: PackageExploreOptions = {},
) {
  const trimmedQuery = query.trim();
  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader(trimmedQuery ? "Searching packages" : "Listing packages");
  try {
    const limit = clampLimit(options.limit ?? 25, 100);
    if (trimmedQuery) {
      const url = registryUrl(`${ApiRoutes.packages}/search`, registry);
      url.searchParams.set("q", trimmedQuery);
      url.searchParams.set("limit", String(limit));
      if (options.family) url.searchParams.set("family", options.family);
      if (options.official) url.searchParams.set("isOfficial", "true");
      const result = await apiRequest(
        registry,
        { method: "GET", url: url.toString(), token },
        ApiV1PackageSearchResponseSchema,
      );
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.results.length === 0) {
        console.log("No packages found.");
        return;
      }
      for (const entry of result.results) {
        console.log(formatPackageLine(entry.package));
      }
      return;
    }

    const route =
      options.family === "code-plugin"
        ? ApiRoutes.codePlugins
        : options.family === "bundle-plugin"
          ? ApiRoutes.bundlePlugins
          : ApiRoutes.packages;
    const url = registryUrl(route, registry);
    url.searchParams.set("limit", String(limit));
    if (options.family === "skill" || options.family === "claw") {
      url.searchParams.set("family", options.family);
    }
    if (options.official) url.searchParams.set("isOfficial", "true");
    const result = await apiRequest(
      registry,
      { method: "GET", url: url.toString(), token },
      ApiV1PackageListResponseSchema,
    );
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.items.length === 0) {
      console.log("No packages found.");
      return;
    }
    for (const item of result.items) {
      console.log(formatPackageLine(item));
    }
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdInspectPackage(
  opts: GlobalOpts,
  packageName: string,
  options: PackageInspectOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  if (options.version && options.tag) fail("Use either --version or --tag");

  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader("Fetching package");
  try {
    const detail = await apiRequestPackageDetail(registry, trimmed, token);
    if (!detail.package) {
      spinner.fail("Package not found");
      return;
    }

    const tags = normalizeTags(detail.package.tags);
    const latestVersion = detail.package.latestVersion ?? tags.latest ?? null;
    const taggedVersion = options.tag ? (tags[options.tag] ?? null) : null;
    if (options.tag && !taggedVersion) {
      spinner.fail(`Unknown tag "${options.tag}"`);
      return;
    }
    const requestedVersion = options.version ?? taggedVersion ?? null;

    let versionResult: PackageVersionResponse | null = null;
    if (options.files || options.file || options.version || options.tag) {
      const targetVersion = requestedVersion ?? latestVersion;
      if (!targetVersion) fail("Could not resolve latest version");
      spinner.text = `Fetching ${trimmed}@${targetVersion}`;
      versionResult = await apiRequestPackageVersion(registry, trimmed, targetVersion, token);
    }

    let versionsList: Awaited<ReturnType<typeof apiRequestPackageVersions>> | null = null;
    if (options.versions) {
      const limit = clampLimit(options.limit ?? 25, 100);
      spinner.text = `Fetching versions (${limit})`;
      versionsList = await apiRequestPackageVersions(registry, trimmed, limit, token);
    }

    let fileContent: string | null = null;
    if (options.file) {
      const url = registryUrl(
        `${ApiRoutes.packages}/${encodeURIComponent(trimmed)}/file`,
        registry,
      );
      url.searchParams.set("path", options.file);
      url.searchParams.set("preview", "1");
      if (options.version) {
        url.searchParams.set("version", options.version);
      } else if (options.tag) {
        url.searchParams.set("tag", options.tag);
      } else if (latestVersion) {
        url.searchParams.set("version", latestVersion);
      }
      spinner.text = `Fetching ${options.file}`;
      fileContent = await fetchText(registry, { url: url.toString(), token });
    }

    spinner.stop();

    const output = {
      package: detail.package,
      owner: detail.owner,
      version: versionResult?.version ?? null,
      versions: versionsList?.items ?? null,
      file: options.file ? { path: options.file, content: fileContent } : null,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    const shouldPrintMeta = !options.file || options.files || options.versions || options.version;
    if (shouldPrintMeta) {
      printPackageSummary(detail);
    }

    if (shouldPrintMeta && versionResult?.version) {
      printVersionSummary(versionResult.version);
      printCompatibility(
        versionResult.version.compatibility ?? detail.package.compatibility ?? null,
      );
      printVerification(versionResult.version.verification ?? detail.package.verification ?? null);
      printArtifact(versionResult.version.artifact ?? detail.package.artifact ?? null);
    } else if (shouldPrintMeta) {
      printCompatibility(detail.package.compatibility ?? null);
      printVerification(detail.package.verification ?? null);
      printArtifact(detail.package.artifact ?? null);
    }

    if (versionsList?.items) {
      if (versionsList.items.length === 0) {
        console.log("No versions found.");
      } else {
        console.log("Versions:");
        for (const item of versionsList.items) {
          console.log(`- ${item.version}  ${formatTimestamp(item.createdAt)}`);
        }
      }
    }

    if (versionResult?.version && options.files) {
      const files = normalizeFiles(versionResult.version.files);
      if (files.length === 0) {
        console.log("No files found.");
      } else {
        console.log("Files:");
        for (const file of files) {
          console.log(formatFileLine(file));
        }
      }
    }

    if (options.file && fileContent !== null) {
      if (shouldPrintMeta) console.log(`\n${options.file}:\n`);
      process.stdout.write(fileContent);
      if (!fileContent.endsWith("\n")) process.stdout.write("\n");
    }
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdGetPackageTrustedPublisher(
  opts: GlobalOpts,
  packageName: string,
  options: PackageTrustedPublisherGetOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader("Fetching trusted publisher");
  try {
    const result = await apiRequestPackageTrustedPublisher(registry, trimmed, token);
    spinner.stop();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (!result.trustedPublisher) {
      console.log("No trusted publisher configured.");
      return;
    }
    printTrustedPublisher(result.trustedPublisher);
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdSetPackageTrustedPublisher(
  opts: GlobalOpts,
  packageName: string,
  options: PackageTrustedPublisherSetOptions,
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  const repository = options.repository?.trim();
  const workflowFilename = options.workflowFilename?.trim();
  const environment = options.environment?.trim() || undefined;
  if (!repository) fail("--repository required");
  if (!workflowFilename) fail("--workflow-filename required");

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader("Saving trusted publisher");
  try {
    const result = await apiRequest(
      registry,
      {
        method: "POST",
        path: `${ApiRoutes.packages}/${encodeURIComponent(trimmed)}/trusted-publisher`,
        token,
        body: {
          repository,
          workflowFilename,
          ...(environment ? { environment } : {}),
        },
      },
      ApiV1PackageTrustedPublisherResponseSchema,
    );
    spinner.stop();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    console.log(`Trusted publisher saved for ${trimmed}.`);
    if (result.trustedPublisher) {
      printTrustedPublisher(result.trustedPublisher);
    }
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdDeletePackageTrustedPublisher(
  opts: GlobalOpts,
  packageName: string,
  options: PackageTrustedPublisherDeleteOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader("Deleting trusted publisher");
  try {
    const result = await apiRequest(
      registry,
      {
        method: "DELETE",
        path: `${ApiRoutes.packages}/${encodeURIComponent(trimmed)}/trusted-publisher`,
        token,
      },
      ApiV1DeleteResponseSchema,
    );
    spinner.stop();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    console.log(`Trusted publisher deleted for ${trimmed}.`);
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdPackPackage(
  opts: GlobalOpts,
  sourceArg: string,
  options: PackagePackOptions = {},
) {
  if (!sourceArg?.trim()) fail("Path required");
  const resolvedSource = await resolveSourceInput(sourceArg, {
    workdir: opts.workdir,
    localWorkdirs: [process.cwd(), opts.workdir],
  });
  if (resolvedSource.kind !== "local") fail("Path must be a package folder");
  const sourcePath = resolvedSource.path;
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat?.isDirectory()) fail("Path must be a package folder");

  const packageJson = await readJsonFile(join(sourcePath, "package.json"));
  if (!packageJson) fail("package.json required");
  const pluginManifest = await readJsonFile(join(sourcePath, "openclaw.plugin.json"));
  if (!pluginManifest) fail("openclaw.plugin.json required");

  const packageName = packageJsonString(packageJson, "name");
  const packageVersion = packageJsonString(packageJson, "version");
  if (!packageName) fail("package.json name required");
  if (!packageVersion) fail("package.json version required");
  if (!semver.valid(packageVersion)) fail("package.json version must be valid semver");

  const validation = validateOpenClawExternalCodePluginPackageJson(packageJson);
  if (validation.issues.length > 0) {
    fail(validation.issues.map((issue) => issue.message).join(" "));
  }

  const packDestination = resolve(opts.workdir, options.packDestination ?? ".");
  await mkdir(packDestination, { recursive: true });

  const spinner = options.json
    ? null
    : createCrabLoader(`Packing ${packageName}@${packageVersion}`);
  try {
    const packed = await createClawPackFromFolder({
      sourcePath,
      packDestination,
      cwd: opts.workdir,
    });
    const contentValidation = validateOpenClawExternalCodePluginPackageContents(
      packed.parsed.packageJson,
      packed.parsed.entries.map((entry) => entry.path),
    );
    if (contentValidation.issues.length > 0) {
      fail(contentValidation.issues.map((issue) => issue.message).join(" "));
    }
    const output = {
      path: packed.path,
      name: packed.parsed.packageName,
      version: packed.parsed.packageVersion,
      size: packed.file.bytes.byteLength,
      files: packed.parsed.entries.length,
      sha256: packed.identity.sha256,
      npmIntegrity: packed.identity.npmIntegrity,
      npmShasum: packed.identity.npmShasum,
    };

    spinner?.succeed(
      `Packed ${packed.parsed.packageName}@${packed.parsed.packageVersion} -> ${packed.path}`,
    );
    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      console.log(`Path: ${packed.path}`);
      console.log(`Size: ${packed.file.bytes.byteLength} bytes`);
      console.log(`SHA-256: ${packed.identity.sha256}`);
      console.log(`npm integrity: ${packed.identity.npmIntegrity}`);
    }
  } catch (error) {
    spinner?.fail(formatError(error));
    throw error;
  }
}

export async function cmdValidatePackage(
  opts: GlobalOpts,
  sourceArg: string,
  options: PackageValidateOptions = {},
) {
  if (!sourceArg?.trim()) fail("Path required");
  const resolvedSource = await resolveSourceInput(sourceArg, {
    workdir: opts.workdir,
    localWorkdirs: [process.cwd(), opts.workdir],
  });
  if (resolvedSource.kind !== "local") fail("Path must be a package folder");
  const sourcePath = resolvedSource.path;
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat?.isDirectory()) fail("Path must be a package folder");
  if (options.openclaw?.trim() && options.openclawVersion?.trim()) {
    fail("Choose either --openclaw or --openclaw-version");
  }

  const outDir = options.out?.trim() || "reports";
  const openclawPath = options.openclaw?.trim() ? resolve(opts.workdir, options.openclaw) : false;
  const openclawVersion = options.openclawVersion?.trim() || (openclawPath ? undefined : "latest");
  const generatedConfig = await createPluginInspectorConfigIfNeeded(sourcePath);
  let report: Awaited<ReturnType<typeof pluginRoot.runCheck>>["report"];
  let paths: Awaited<ReturnType<typeof pluginRoot.runCheck>>["paths"];
  try {
    const runCheckOptions = {
      allowExecution: options.allowExecute === true,
      authorFacing: true,
      capture: options.runtime === true,
      configPath: generatedConfig?.path,
      mockSdk: options.mockSdk !== false,
      openclawPath,
      ...(openclawVersion ? { openclawVersion } : {}),
      outDir,
      pluginRoot: sourcePath,
    } as Parameters<typeof pluginRoot.runCheck>[0] & { authorFacing: true };
    const result = await pluginRoot.runCheck(runCheckOptions);
    paths = result.paths;
    report = filterAuthorFacingInspectorReport(result.report);
    await mkdir(dirname(paths.jsonPath), { recursive: true });
    await writeFile(paths.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } finally {
    if (generatedConfig) {
      await rm(generatedConfig.dir, { recursive: true, force: true });
    }
  }

  await ci.writeOutputs(report, {
    cwd: dirname(paths.jsonPath),
    outDir: ".",
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports.sanitizeArtifact(report), null, 2)}\n`);
  } else {
    console.log(renderPackageValidateTextSummary(report, paths));
  }

  if (reportStatus(report) !== "pass") {
    const breakageCount = reportBreakageCount(report);
    throw new Error(
      `Plugin Inspector found ${breakageCount} hard error${breakageCount === 1 ? "" : "s"}`,
    );
  }
}

async function createPluginInspectorConfigIfNeeded(sourcePath: string) {
  if (
    (await fileExists(join(sourcePath, "plugin-inspector.config.json"))) ||
    (await fileExists(join(sourcePath, ".plugin-inspector.json")))
  ) {
    return null;
  }

  const packageJson = await readJsonFile(join(sourcePath, "package.json"));
  const pluginManifest = await readJsonFile(join(sourcePath, "openclaw.plugin.json"));
  if (!packageJson && !pluginManifest) {
    return null;
  }
  if (hasPackagePluginInspectorConfig(packageJson)) {
    return null;
  }

  const rawName =
    packageJsonString(packageJson, "name") ??
    packageJsonString(pluginManifest, "id") ??
    basename(sourcePath);
  const configDir = await mkdtemp(join(tmpdir(), "clawhub-plugin-inspector-config-"));
  const configPath = join(configDir, "plugin-inspector.config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        plugin: {
          id: pluginInspectorFixtureId(rawName),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { dir: configDir, path: configPath };
}

async function fileExists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

function hasPackagePluginInspectorConfig(packageJson: Record<string, unknown> | null) {
  if (!packageJson) return false;
  return (
    isPlainRecord(packageJson.pluginInspector) || isPlainRecord(packageJson["plugin-inspector"])
  );
}

function pluginInspectorFixtureId(rawName: string) {
  return (
    rawName
      .split("/")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "published-plugin"
  );
}

async function createClawPackFromFolder(options: {
  sourcePath: string;
  packDestination: string;
  cwd: string;
}): Promise<PackedClawPack> {
  const result = spawnSync(
    "npm",
    [
      "pack",
      options.sourcePath,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      options.packDestination,
    ],
    {
      cwd: options.cwd,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || "npm pack failed").trim());
  }

  let npmOutput: unknown;
  try {
    npmOutput = JSON.parse(result.stdout) as unknown;
  } catch {
    fail("npm pack did not return JSON output");
  }
  const npmEntry = Array.isArray(npmOutput)
    ? npmOutput[0]
    : isPlainRecord(npmOutput)
      ? Object.values(npmOutput)[0]
      : undefined;
  const filename = isPlainRecord(npmEntry) ? npmEntry["filename"] : undefined;
  if (typeof filename !== "string" || !filename) {
    fail("npm pack did not return a tarball filename");
  }

  const packPath = resolve(options.packDestination, filename);
  const bytes = new Uint8Array(await readFile(packPath));
  const parsed = parseClawPack(bytes);
  return {
    path: packPath,
    file: {
      relPath: basename(packPath),
      bytes,
      contentType: "application/octet-stream",
    },
    parsed,
    identity: computeArtifactIdentity(bytes),
  };
}

export async function cmdPublishPackage(
  opts: GlobalOpts,
  sourceArg: string,
  options: PackagePublishOptions = {},
  runtime: PackagePublishRuntime = {},
) {
  if (!sourceArg?.trim()) fail("Path required");
  const waitTimeoutSeconds = options.wait
    ? resolvePackagePublishWaitTimeout(options)
    : DEFAULT_PACKAGE_PUBLISH_WAIT_TIMEOUT_SECONDS;

  let plan: PackagePublishPlan | undefined;
  try {
    plan = await preparePackagePublishPlan(opts, sourceArg, options);

    if (options.dryRun) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(plan.output, null, 2)}\n`);
      } else {
        printPackageDryRun({
          source: plan.sourceLabel,
          family: plan.payload.family,
          name: plan.payload.name,
          displayName: plan.payload.displayName,
          version: plan.payload.version,
          commit: plan.payload.source?.commit,
          compatibility: plan.compatibility,
          tags: plan.payload.tags,
          files: plan.filesOnDisk,
        });
      }
      return;
    }

    if (plan.payload.family === "code-plugin") {
      const validation = validateOpenClawExternalCodePluginPackageContents(
        plan.packageJson,
        plan.filesOnDisk.map((file) => file.relPath),
      );
      if (validation.issues.length > 0) {
        fail(validation.issues.map((issue) => issue.message).join(" "));
      }
    }

    const registry = await getRegistry(opts, { cache: true });
    const spinner = options.json
      ? null
      : createCrabLoader(`Preparing ${plan.payload.name}@${plan.payload.version}`);
    try {
      const revalidateTrustedTooling =
        runtime.revalidateTrustedTooling ?? revalidateTrustedToolingIdentityAtMutationBoundary;
      const trustedToolingBoundary =
        runtime.revalidateTrustedTooling !== undefined ||
        Boolean(process.env.TRUSTED_TOOLING_IDENTITY_JSON?.trim());
      const inventoryDigest = buildGitHubFolderContentHash(hashSkillFiles(plan.filesOnDisk).files);
      let resolvedPublishToken = await resolvePackagePublishToken({
        registry,
        packageName: plan.payload.name,
        version: plan.payload.version,
        scope: "upload",
        inventoryDigest,
        manualOverrideReason: plan.payload.manualOverrideReason,
        spinner,
      });
      let publishToken = resolvedPublishToken.token;
      await validateClawPublishProfilePolicy(plan, registry, publishToken);
      const form = new FormData();
      const payloadJson = JSON.stringify(plan.payload);
      form.set("payload", payloadJson);

      if (plan.clawpackOnDisk) {
        if (isPackageMultipartTooLarge(payloadJson, "clawpack", [plan.clawpackOnDisk])) {
          const staged = await uploadClawPackToStorage(
            registry,
            publishToken,
            plan.clawpackOnDisk,
            spinner,
            revalidateTrustedTooling,
            trustedToolingBoundary,
          );
          form.set("clawpack", staged.storageId);
          form.set("clawpackUploadTicket", staged.uploadTicket);
        } else {
          if (spinner) spinner.text = `Uploading ${plan.clawpackOnDisk.relPath}`;
          const blob = new Blob([Buffer.from(plan.clawpackOnDisk.bytes)], {
            type: "application/octet-stream",
          });
          form.append("clawpack", blob, plan.clawpackOnDisk.relPath);
        }
      } else {
        let index = 0;
        for (const file of plan.filesOnDisk) {
          index += 1;
          if (spinner) {
            spinner.text = `Uploading ${file.relPath} (${index}/${plan.filesOnDisk.length})`;
          }
          const blob = new Blob([Buffer.from(file.bytes)], {
            type: file.contentType ?? "application/octet-stream",
          });
          form.append("files", blob, file.relPath);
        }
      }

      if (spinner) spinner.text = `Publishing ${plan.payload.name}@${plan.payload.version}`;
      await revalidateTrustedTooling();
      if (resolvedPublishToken.kind === "github-actions") {
        resolvedPublishToken = await resolvePackagePublishToken({
          registry,
          packageName: plan.payload.name,
          version: plan.payload.version,
          scope: "publish",
          inventoryDigest,
          manualOverrideReason: plan.payload.manualOverrideReason,
          spinner,
        });
        publishToken = resolvedPublishToken.token;
      }
      const result = await apiRequestForm(
        registry,
        {
          method: "POST",
          path: ApiRoutes.packages,
          token: publishToken,
          form,
          retryCount: trustedToolingBoundary ? 0 : PACKAGE_PUBLISH_RETRY_COUNT,
          timeoutMs: PACKAGE_PUBLISH_REQUEST_TIMEOUT_MS,
        },
        ApiV1PackagePublishResponseSchema,
      );
      assertClawPublishArtifactDigest(plan, result);

      let finalResult: ApiV1PackagePublishResponse | ApiV1PackagePublishAttemptResponse = result;
      if (options.wait && result.publicationStatus !== "published") {
        const packageName = plan.payload.name;
        const version = plan.payload.version;
        const manualOverrideReason = plan.payload.manualOverrideReason;
        if (!result.attemptId) {
          fail(
            `ClawHub did not confirm publication of ${packageName}@${version} or return a publish attempt ID.`,
          );
        }
        finalResult = await waitForPackagePublication({
          registry,
          attemptId: result.attemptId,
          packageName,
          version,
          publishToken,
          waitTimeoutSeconds,
          spinner,
          runtime,
          refreshPublishToken: async () => {
            publishToken = (
              await resolvePackagePublishToken({
                registry,
                packageName,
                version,
                scope: "publish",
                inventoryDigest,
                manualOverrideReason,
                spinner,
              })
            ).token;
            return publishToken;
          },
        });
        assertClawPublishArtifactDigest(plan, finalResult);
      }

      const publicationStatus = finalResult.publicationStatus;
      const outputStatus =
        publicationStatus === "pending"
          ? "pending-publication"
          : publicationStatus === "published"
            ? "published"
            : "submitted";
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ...plan.output,
              status: outputStatus,
              releaseId: finalResult.releaseId,
              artifactSha256: finalResult.artifactSha256,
              publicationStatus,
              attemptId: finalResult.attemptId,
              inspectorFindings: result.inspectorFindings,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        if (publicationStatus === "pending") {
          spinner?.succeed(
            `Update submitted for ${plan.payload.name}@${plan.payload.version}; pending security scans before it becomes public.`,
          );
        } else if (publicationStatus === "published") {
          spinner?.succeed(
            `OK. Published ${plan.payload.name}@${plan.payload.version} (${finalResult.releaseId})`,
          );
        } else {
          spinner?.succeed(
            `Update submitted for ${plan.payload.name}@${plan.payload.version}; publication status was not reported.`,
          );
        }
        printPackageInspectorFindings(result);
      }
    } catch (error) {
      spinner?.fail(formatError(error));
      throw error;
    }
  } finally {
    await plan?.cleanup?.();
  }
}

export async function cmdRecoverPackage(
  opts: GlobalOpts,
  attemptIdArg: string,
  options: Pick<PackagePublishOptions, "manualOverrideReason" | "wait" | "waitTimeout" | "json">,
  runtime: PackagePublishRuntime = {},
) {
  const attemptId = attemptIdArg.trim();
  if (!attemptId) fail("Publish attempt ID required");
  const manualOverrideReason = options.manualOverrideReason?.trim();
  if (!manualOverrideReason || manualOverrideReason.length > 500) {
    fail("--manual-override-reason must contain 1 through 500 characters");
  }
  const waitTimeoutSeconds = resolvePackagePublishWaitTimeout(options);
  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = options.json ? null : createCrabLoader("Recovering staged publication");
  try {
    const result = await apiRequest(
      registry,
      {
        method: "POST",
        path: `${ApiRoutes.publishAttempts}/${encodeURIComponent(attemptId)}/recover`,
        token,
        body: { manualOverrideReason },
        retryCount: 0,
      },
      ApiV1PackagePublishRecoveryResponseSchema,
    );
    if (["blocked", "failed", "expired"].includes(result.publicationStatus)) {
      fail(
        `Recovery ${result.publicationStatus} for ${result.name}@${result.version}. Attempt ${result.attemptId}.`,
      );
    }
    const finalResult =
      options.wait && result.publicationStatus !== "published"
        ? await waitForPackagePublication({
            registry,
            attemptId: result.attemptId,
            packageName: result.name,
            version: result.version,
            publishToken: token,
            waitTimeoutSeconds,
            spinner,
            runtime,
          })
        : result;
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...result, ...finalResult }, null, 2)}\n`);
    } else if (finalResult.publicationStatus === "published") {
      spinner?.succeed(`Published ${result.name}@${result.version} (${result.releaseId})`);
    } else {
      spinner?.succeed(
        `Recovery submitted for ${result.name}@${result.version}; pending security checks. Attempt ${result.attemptId}.`,
      );
    }
  } catch (error) {
    spinner?.fail(formatError(error));
    throw error;
  }
}

function revalidateTrustedToolingIdentityAtMutationBoundary() {
  if (!process.env.TRUSTED_TOOLING_IDENTITY_JSON?.trim()) return;

  const verifierPath = fileURLToPath(
    new URL("../../../../../.github/scripts/verify-trusted-tooling-identity.cjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [verifierPath], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return;

  const detail = (result.stderr || result.stdout || "verification process failed").trim();
  fail(`Trusted tooling authorization changed before package mutation: ${detail}`);
}

function resolvePackagePublishWaitTimeout(options: PackagePublishOptions) {
  const waitTimeoutSeconds = options.waitTimeout ?? DEFAULT_PACKAGE_PUBLISH_WAIT_TIMEOUT_SECONDS;
  if (!Number.isInteger(waitTimeoutSeconds) || waitTimeoutSeconds <= 0) {
    fail("--wait-timeout must be a positive integer number of seconds");
  }
  return waitTimeoutSeconds;
}

async function waitForPackagePublication(params: {
  registry: string;
  attemptId: string;
  packageName: string;
  version: string;
  publishToken: string;
  waitTimeoutSeconds: number;
  spinner: ReturnType<typeof createCrabLoader> | null;
  runtime: PackagePublishRuntime;
  refreshPublishToken?: () => Promise<string>;
}) {
  const now = params.runtime.now ?? Date.now;
  const sleep =
    params.runtime.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const deadline = now() + params.waitTimeoutSeconds * 1_000;
  let publishToken = params.publishToken;
  let refreshedAfterUnauthorized = false;

  while (now() < deadline) {
    if (params.spinner) {
      params.spinner.text = `Waiting for security checks on ${params.packageName}@${params.version}`;
    }

    let status: ApiV1PackagePublishAttemptResponse;
    try {
      status = await fetchPackagePublishAttempt(params.registry, params.attemptId, publishToken);
    } catch (error) {
      if (
        getHttpErrorStatus(error) === 401 &&
        params.refreshPublishToken &&
        hasGitHubActionsOidcEnv() &&
        !refreshedAfterUnauthorized
      ) {
        publishToken = await params.refreshPublishToken();
        refreshedAfterUnauthorized = true;
        continue;
      }
      if (!isRetryableHttpError(error)) throw error;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      if (params.spinner) {
        params.spinner.text = `Retrying publication status for ${params.packageName}@${params.version}`;
      }
      await sleep(Math.min(PACKAGE_PUBLISH_POLL_INTERVAL_MS, remainingMs));
      continue;
    }
    refreshedAfterUnauthorized = false;

    if (status.publicationStatus === "published") return status;
    if (
      status.publicationStatus === "blocked" ||
      status.publicationStatus === "failed" ||
      status.publicationStatus === "expired"
    ) {
      const detail = status.error?.trim() ? `: ${status.error.trim()}` : "";
      fail(
        `ClawHub publication ${status.publicationStatus} for ${params.packageName}@${params.version}${detail}`,
      );
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(PACKAGE_PUBLISH_POLL_INTERVAL_MS, remainingMs));
  }

  return fail(
    `Timed out after ${params.waitTimeoutSeconds}s waiting for ClawHub to publish ${params.packageName}@${params.version}. Attempt ${params.attemptId} is still pending.`,
  );
}

async function fetchPackagePublishAttempt(
  registry: string,
  attemptId: string,
  publishToken: string,
) {
  return await apiRequest(
    registry,
    {
      method: "GET",
      path: `${ApiRoutes.publishAttempts}/${encodeURIComponent(attemptId)}`,
      token: publishToken,
      retryCount: 0,
    },
    ApiV1PackagePublishAttemptResponseSchema,
  );
}

function printPackageInspectorFindings(result: ApiV1PackagePublishResponse) {
  const findings = result.inspectorFindings ?? [];
  if (findings.length === 0) return;
  const errorCount = findings.filter((finding) => finding.findingKind === "error").length;
  const warningCount = findings.length - errorCount;
  const parts = [
    warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : null,
    errorCount > 0 ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => Boolean(part));
  console.log(`Plugin Inspector findings: ${parts.join(", ")}`);
  for (const finding of findings.slice(0, 10)) {
    const label = finding.issueClass ? `${finding.code} (${finding.issueClass})` : finding.code;
    console.log(`- ${finding.findingKind.toUpperCase()} ${label}: ${finding.message}`);
    if (finding.authorRemediation?.summary) {
      console.log(`  Fix: ${finding.authorRemediation.summary}`);
      if (finding.authorRemediation.docsUrl) {
        console.log(`  Docs: ${finding.authorRemediation.docsUrl}`);
      }
    }
  }
  if (findings.length > 10) {
    console.log(`- ...and ${findings.length - 10} more findings`);
  }
}

function renderPackageValidateTextSummary(report: unknown, paths: Record<string, unknown>) {
  const status = reportStatus(report)?.toUpperCase() ?? "UNKNOWN";
  const breakageCount = reportBreakageCount(report);
  const findings = collectInspectorFindings(report);
  const warningCount = findings.filter((finding) => !isInspectorBreakage(finding)).length;
  const lines = [
    `Plugin Inspector: ${status}`,
    `Breakages: ${breakageCount}`,
    `Warnings: ${warningCount}`,
    `Findings: ${findings.length === 0 ? "none" : findings.length}`,
  ];

  if (findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of findings) {
      lines.push(formatValidateFinding(finding));
      const remediation = readAuthorRemediation(finding);
      if (remediation?.summary) {
        lines.push(`  Fix: ${remediation.summary}`);
      }
      if (remediation?.docsUrl) {
        lines.push(`  Docs: ${remediation.docsUrl}`);
      }
      const evidenceLines = formatFindingEvidence(finding);
      if (evidenceLines.length > 0) {
        lines.push("  Evidence:", ...evidenceLines.map((line) => `  - ${line}`));
      }
    }
  }

  const reportPaths = formatReportPaths(paths);
  if (reportPaths) {
    lines.push("", `Reports written: ${reportPaths}`);
  }

  return lines.join("\n");
}

function collectInspectorFindings(report: unknown): Record<string, unknown>[] {
  if (!isPlainRecord(report)) return [];
  const keys = ["issues", "breakages", "warnings", "suggestions"] as const;
  const findings: Record<string, unknown>[] = [];
  for (const key of keys) {
    const value = report[key];
    if (!Array.isArray(value)) continue;
    for (const finding of value) {
      if (isPlainRecord(finding)) findings.push(finding);
    }
  }
  return findings;
}

function formatValidateFinding(finding: Record<string, unknown>) {
  const level = isInspectorBreakage(finding) ? "ERROR" : "WARNING";
  const code =
    typeof finding.code === "string" && finding.code.trim() ? finding.code.trim() : "unknown";
  const issueClass =
    typeof finding.issueClass === "string" && finding.issueClass.trim()
      ? ` (${finding.issueClass.trim()})`
      : "";
  const severity =
    typeof finding.severity === "string" && finding.severity.trim()
      ? ` ${finding.severity.trim()}`
      : "";
  const message =
    typeof finding.message === "string" && finding.message.trim()
      ? finding.message.trim()
      : typeof finding.title === "string" && finding.title.trim()
        ? finding.title.trim()
        : "see generated report";
  return `- ${level} ${code}${issueClass}${severity}: ${message}`;
}

function readAuthorRemediation(finding: Record<string, unknown>) {
  if (!isPlainRecord(finding.authorRemediation)) return null;
  const summary =
    typeof finding.authorRemediation.summary === "string"
      ? finding.authorRemediation.summary.trim()
      : "";
  const docsUrl =
    typeof finding.authorRemediation.docsUrl === "string"
      ? finding.authorRemediation.docsUrl.trim()
      : "";
  return {
    summary: summary || null,
    docsUrl: docsUrl || null,
  };
}

function formatFindingEvidence(finding: Record<string, unknown>) {
  const evidence = finding.evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence.map(formatEvidenceValue).filter((line): line is string => Boolean(line));
}

function formatEvidenceValue(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isPlainRecord(value)) {
    return Object.entries(value)
      .map(([key, entry]) => {
        if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
          return `${key}: ${entry}`;
        }
        return null;
      })
      .filter((entry): entry is string => Boolean(entry))
      .join(", ");
  }
  return null;
}

function formatReportPaths(paths: Record<string, unknown>) {
  const labels: Array<[string, unknown]> = [
    ["json", paths.jsonPath],
    ["markdown", paths.markdownPath],
    ["issues", paths.issuesPath],
  ];
  const rendered = labels
    .filter(([, filePath]) => typeof filePath === "string" && filePath.trim().length > 0)
    .map(([label, filePath]) => `${label}=${String(filePath)}`);
  return rendered.length > 0 ? rendered.join(", ") : null;
}

export async function cmdDownloadPackage(
  opts: GlobalOpts,
  packageName: string,
  options: PackageDownloadOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  if (options.version && options.tag) fail("Use either --version or --tag");

  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = options.json ? null : createCrabLoader("Resolving package artifact");
  try {
    const targetVersion = await resolvePackageVersion(registry, trimmed, {
      token,
      version: options.version,
      tag: options.tag,
    });
    spinnerText(spinner, `Resolving ${trimmed}@${targetVersion}`);
    const artifactResult = await apiRequestPackageArtifact(registry, trimmed, targetVersion, token);
    spinnerText(spinner, `Downloading ${trimmed}@${targetVersion}`);
    const bytes = await fetchBinary(registry, {
      url: artifactResult.artifact.downloadUrl,
      token,
    });
    const identity = computeArtifactIdentity(bytes);
    validateDownloadedArtifact(trimmed, artifactResult, bytes, identity);

    const filename = defaultArtifactFilename(trimmed, targetVersion, artifactResult.artifact);
    const outputPath = await resolveArtifactOutputPath(opts, options.output, filename);
    await assertOutputWritable(outputPath, Boolean(options.force));
    await writeFile(outputPath, bytes);
    spinner?.stop();

    const output = {
      package: artifactResult.package.name,
      version: targetVersion,
      artifact: artifactResult.artifact,
      path: outputPath,
      bytes: bytes.byteLength,
      sha256: identity.sha256,
      npmIntegrity: artifactResult.artifact.kind === "npm-pack" ? identity.npmIntegrity : undefined,
      npmShasum: artifactResult.artifact.kind === "npm-pack" ? identity.npmShasum : undefined,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    console.log(`Downloaded ${artifactResult.package.name}@${targetVersion} -> ${outputPath}`);
    console.log(`Artifact: ${artifactResult.artifact.kind}`);
    console.log(`SHA-256: ${identity.sha256}`);
    if (artifactResult.artifact.kind === "npm-pack") {
      console.log(`npm integrity: ${identity.npmIntegrity}`);
      console.log(`npm shasum: ${identity.npmShasum}`);
    }
  } catch (error) {
    spinner?.fail(formatError(error));
    throw error;
  }
}

export async function cmdVerifyPackage(
  opts: GlobalOpts,
  filePath: string,
  options: PackageVerifyOptions = {},
) {
  const targetFile = resolve(opts.workdir, filePath);
  if (options.version && options.tag) fail("Use either --version or --tag");
  if ((options.version || options.tag) && !options.packageName?.trim()) {
    fail("--package is required with --version or --tag");
  }

  const spinner = options.json ? null : createCrabLoader("Reading artifact");
  try {
    const bytes = new Uint8Array(await readFile(targetFile));
    const identity = computeArtifactIdentity(bytes);
    let artifactResult: PackageArtifactResponse | null = null;

    if (options.packageName?.trim()) {
      const packageName = normalizePackageNameOrFail(options.packageName);
      const token = await getOptionalAuthToken();
      const registry = await getRegistry(opts, { cache: true });
      spinnerText(spinner, `Resolving ${packageName}`);
      const targetVersion = await resolvePackageVersion(registry, packageName, {
        token,
        version: options.version,
        tag: options.tag,
      });
      artifactResult = await apiRequestPackageArtifact(registry, packageName, targetVersion, token);
      validateDownloadedArtifact(packageName, artifactResult, bytes, identity);
    }

    const expectedSha256 =
      options.sha256?.trim() ||
      (artifactResult?.artifact.kind === "npm-pack" ? artifactResult.artifact.sha256 : undefined);
    const expectedNpmIntegrity =
      options.npmIntegrity?.trim() || artifactResult?.artifact.npmIntegrity;
    const expectedNpmShasum = options.npmShasum?.trim() || artifactResult?.artifact.npmShasum;
    assertDigestMatch("SHA-256", expectedSha256, identity.sha256);
    assertDigestMatch("npm integrity", expectedNpmIntegrity, identity.npmIntegrity);
    assertDigestMatch("npm shasum", expectedNpmShasum, identity.npmShasum);

    spinner?.stop();
    const output = {
      path: targetFile,
      bytes: bytes.byteLength,
      sha256: identity.sha256,
      npmIntegrity: identity.npmIntegrity,
      npmShasum: identity.npmShasum,
      expected: {
        sha256: expectedSha256,
        npmIntegrity: expectedNpmIntegrity,
        npmShasum: expectedNpmShasum,
        package: artifactResult?.package.name,
        version: artifactResult?.version,
        artifactKind: artifactResult?.artifact.kind,
      },
      verified: Boolean(expectedSha256 || expectedNpmIntegrity || expectedNpmShasum),
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    console.log(`Path: ${targetFile}`);
    console.log(`SHA-256: ${identity.sha256}`);
    console.log(`npm integrity: ${identity.npmIntegrity}`);
    console.log(`npm shasum: ${identity.npmShasum}`);
    if (output.verified) {
      console.log("OK. Artifact verification passed.");
    } else {
      console.log("Computed artifact digests. Pass --package or expected digests to verify.");
    }
  } catch (error) {
    spinner?.fail(formatError(error));
    throw error;
  }
}

export async function cmdDeletePackage(
  opts: GlobalOpts,
  nameArg: string,
  options: PackageDeleteOptions = {},
  inputAllowed = true,
) {
  const name = nameArg.trim();
  if (!name) fail("Package name required");
  const version = normalizeDeleteVersion(options.version);

  if (!options.yes) {
    if (!isInteractive() || inputAllowed === false) fail("Pass --yes (no input)");
    const ok = await promptConfirm(
      version
        ? `Delete ${name} version ${version}? (withdraws public access; the exact retained artifact can be restored, but the version number remains reserved; publish a replacement first if deleting the current latest version)`
        : `Delete ${name}? (soft delete package and all releases)`,
    );
    if (!ok) return undefined;
  }

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const target = version ? `${name} version ${version}` : name;
  const spinner = createCrabLoader(`Deleting ${target}`);
  try {
    const result = await apiRequest(
      registry,
      {
        method: "DELETE",
        path: `${ApiRoutes.packages}/${encodeURIComponent(name)}${
          version ? `/versions/${encodeURIComponent(version)}` : ""
        }`,
        token,
        ...(version ? { body: { version }, retryCount: 0 } : {}),
      },
      ApiV1DeleteResponseSchema,
    );
    spinner.succeed(`OK. Deleted ${target}`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

function normalizeDeleteVersion(value: string | undefined) {
  if (value === undefined) return undefined;
  const version = value.trim();
  if (!version) fail("--version cannot be empty");
  return version;
}

export async function cmdUndeletePackage(
  opts: GlobalOpts,
  nameArg: string,
  options: PackageUndeleteOptions = {},
  inputAllowed = true,
) {
  const name = nameArg.trim();
  if (!name) fail("Package name required");
  const version = normalizeDeleteVersion(options.version);

  if (!options.yes) {
    if (!isInteractive() || inputAllowed === false) fail("Pass --yes (no input)");
    const ok = await promptConfirm(
      version
        ? `Restore ${name} version ${version}? (restores the exact retained artifact; does not make it latest or restore tags or dist-tags)`
        : `Restore ${name}? (restore package and releases)`,
    );
    if (!ok) return undefined;
  }

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const target = version ? `${name} version ${version}` : name;
  const spinner = createCrabLoader(`Restoring ${target}`);
  try {
    const result = await apiRequest(
      registry,
      {
        method: "POST",
        path: version
          ? `${ApiRoutes.packages}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/restore`
          : `${ApiRoutes.packages}/${encodeURIComponent(name)}/undelete`,
        token,
        ...(version ? { retryCount: 0 } : {}),
      },
      ApiV1DeleteResponseSchema,
    );
    spinner.succeed(`OK. Restored ${target}`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdTransferPackage(
  opts: GlobalOpts,
  nameArg: string,
  options: PackageTransferOptions,
) {
  const name = normalizePackageNameOrFail(nameArg);
  const toOwner = options.to?.trim().replace(/^@+/, "").toLowerCase();
  if (!toOwner) fail("--to required");
  const reason = options.reason?.trim();

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader(`Transferring ${name} to @${toOwner}`);
  try {
    const result = await apiRequest(
      registry,
      {
        method: "POST",
        path: `${ApiRoutes.packages}/${encodeURIComponent(name)}/transfer`,
        token,
        body: {
          toOwner,
          ...(reason ? { reason } : {}),
        },
      },
      ApiV1PackageTransferResponseSchema,
    );
    spinner.succeed(`OK. Transferred ${name} to @${toOwner}`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdReportPackage(
  opts: GlobalOpts,
  packageName: string,
  options: PackageReportOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  const reason = options.reason?.trim();
  const version = options.version?.trim();
  if (!reason) fail("--reason required");

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = options.json ? null : createCrabLoader(`Reporting ${trimmed}`);
  try {
    const result = await apiRequest(
      registry,
      {
        method: "POST",
        path: `${ApiRoutes.packages}/${encodeURIComponent(trimmed)}/report`,
        token,
        body: {
          reason,
          ...(version ? { version } : {}),
        },
      },
      ApiV1PackageReportResponseSchema,
    );
    spinner?.stop();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (result.alreadyReported) {
      console.log(`Already reported ${trimmed}.`);
      return;
    }
    const versionSuffix = version ? `@${version}` : "";
    console.log(`OK. Reported ${trimmed}${versionSuffix} for moderator review.`);
  } catch (error) {
    spinner?.fail(formatError(error));
    throw error;
  }
}

export async function cmdPackageModerationStatus(
  opts: GlobalOpts,
  packageName: string,
  options: PackageModerationStatusOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const result = await apiRequest(
    registry,
    {
      method: "GET",
      path: `${ApiRoutes.packages}/${encodeURIComponent(trimmed)}/moderation`,
      token,
    },
    ApiV1PackageModerationStatusResponseSchema,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log(`${result.package.name} moderation`);
  console.log(`  package scan: ${result.package.scanStatus ?? "unknown"}`);
  console.log(`  open reports: ${result.package.reportCount}`);
  if (!result.latestRelease) {
    console.log("  latest release: none");
    return;
  }
  const state = result.latestRelease.moderationState ?? "none";
  console.log(`  latest: ${result.latestRelease.version}`);
  console.log(`  release scan: ${result.latestRelease.scanStatus}`);
  console.log(`  manual state: ${state}`);
  console.log(`  blocked: ${result.latestRelease.blockedFromDownload ? "yes" : "no"}`);
  if (result.latestRelease.reasons.length > 0) {
    console.log(`  reasons: ${result.latestRelease.reasons.join(", ")}`);
  }
  if (result.latestRelease.moderationReason) {
    console.log(`  note: ${result.latestRelease.moderationReason}`);
  }
}

export async function cmdPackageReadiness(
  opts: GlobalOpts,
  packageName: string,
  options: PackageReadinessOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const result = await apiRequest(
    registry,
    {
      method: "GET",
      path: `${ApiRoutes.packages}/${encodeURIComponent(trimmed)}/readiness`,
      token,
    },
    ApiV1PackageReadinessResponseSchema,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log(`${result.package.name} readiness: ${result.ready ? "ready" : "blocked"}`);
  for (const check of result.checks) {
    console.log(`${check.status.toUpperCase()} ${check.id}: ${check.message}`);
  }
  if (result.blockers.length > 0) {
    console.log(`Blockers: ${result.blockers.join(", ")}`);
  }
}

export async function cmdPackageMigrationStatus(
  opts: GlobalOpts,
  packageName: string,
  options: PackageMigrationStatusOptions = {},
) {
  const trimmed = normalizePackageNameOrFail(packageName);
  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const result = await apiRequest(
    registry,
    {
      method: "GET",
      path: `${ApiRoutes.packages}/${encodeURIComponent(trimmed)}/readiness`,
      token,
    },
    ApiV1PackageReadinessResponseSchema,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const version = result.package.latestVersion ?? "no release";
  console.log(`${result.package.name} migration: ${result.ready ? "ready" : "blocked"}`);
  console.log(`Version: ${version}`);
  console.log(`Official: ${result.package.isOfficial ? "yes" : "no"}`);
  for (const check of result.checks) {
    console.log(`${check.status.toUpperCase()} ${check.id}: ${check.message}`);
  }
  if (result.blockers.length > 0) {
    console.log(`Blockers: ${result.blockers.join(", ")}`);
  }
}

async function apiRequestPackageDetail(registry: string, name: string, token?: string) {
  return await apiRequest(
    registry,
    { method: "GET", path: `${ApiRoutes.packages}/${encodeURIComponent(name)}`, token },
    ApiV1PackageResponseSchema,
  );
}

async function apiRequestPackageArtifact(
  registry: string,
  name: string,
  version: string,
  token?: string,
) {
  return await apiRequest(
    registry,
    {
      method: "GET",
      path: `${ApiRoutes.packages}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/artifact`,
      token,
    },
    ApiV1PackageArtifactResponseSchema,
  );
}

async function apiRequestPackageTrustedPublisher(registry: string, name: string, token?: string) {
  return await apiRequest(
    registry,
    {
      method: "GET",
      path: `${ApiRoutes.packages}/${encodeURIComponent(name)}/trusted-publisher`,
      token,
    },
    ApiV1PackageTrustedPublisherResponseSchema,
  );
}

async function apiRequestPackageVersion(
  registry: string,
  name: string,
  version: string,
  token?: string,
) {
  return await apiRequest(
    registry,
    {
      method: "GET",
      path: `${ApiRoutes.packages}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
      token,
    },
    ApiV1PackageVersionResponseSchema,
  );
}

async function apiRequestPackageVersions(
  registry: string,
  name: string,
  limit: number,
  token?: string,
) {
  const url = registryUrl(`${ApiRoutes.packages}/${encodeURIComponent(name)}/versions`, registry);
  url.searchParams.set("limit", String(limit));
  return await apiRequest(
    registry,
    { method: "GET", url: url.toString(), token },
    ApiV1PackageVersionListResponseSchema,
  );
}

async function resolvePackageVersion(
  registry: string,
  name: string,
  args: { token?: string; version?: string; tag?: string },
) {
  if (args.version?.trim()) return args.version.trim();
  const detail = await apiRequestPackageDetail(registry, name, args.token);
  if (!detail.package) fail("Package not found");
  const tags = normalizeTags(detail.package.tags);
  if (args.tag?.trim()) {
    const tagged = tags[args.tag.trim()];
    if (!tagged) fail(`Unknown tag "${args.tag.trim()}"`);
    return tagged;
  }
  const latest = detail.package.latestVersion ?? tags.latest;
  if (!latest) fail("Could not resolve latest version");
  return latest;
}

function normalizePackageNameOrFail(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) fail("Package name required");
  return trimmed;
}

function reportStatus(report: unknown): string | null {
  return isPlainRecord(report) && typeof report.status === "string" ? report.status : null;
}

function reportBreakageCount(report: unknown): number {
  if (!isPlainRecord(report) || !isPlainRecord(report.summary)) return 0;
  const value = report.summary.breakageCount;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function filterAuthorFacingInspectorReport<T>(report: T): T {
  if (!isPlainRecord(report)) return report;
  const findingKeys = ["issues", "breakages", "warnings", "suggestions"] as const;
  if (!findingKeys.some((key) => Array.isArray(report[key]))) return report;

  const next: Record<string, unknown> = { ...report };
  const rawIssues = Array.isArray(report.issues) ? report.issues : null;
  if (rawIssues) {
    next.issues = rawIssues
      .map(normalizeAuthorFacingInspectorFinding)
      .filter((finding): finding is Record<string, unknown> => Boolean(finding));
    delete next.breakages;
    delete next.warnings;
    delete next.suggestions;
  } else {
    for (const key of findingKeys) {
      if (Array.isArray(report[key])) {
        next[key] = report[key]
          .map(normalizeAuthorFacingInspectorFinding)
          .filter((finding): finding is Record<string, unknown> => Boolean(finding));
      }
    }
  }

  const authorFindings = findingKeys.flatMap((key) => {
    const value = next[key];
    return Array.isArray(value) ? value : [];
  });
  const breakageCount = authorFindings.filter(isInspectorBreakage).length;
  const warningCount = authorFindings.length - breakageCount;
  next.status = breakageCount > 0 ? "fail" : "pass";
  next.summary = {
    breakageCount,
    warningCount,
    deprecationWarningCount: authorFindings.filter(
      (finding) => isPlainRecord(finding) && finding.issueClass === "deprecation-warning",
    ).length,
    issueCount: authorFindings.length,
  };
  return next as T;
}

function hasAuthorRemediation(value: unknown) {
  return (
    isPlainRecord(value) &&
    isPlainRecord(value.authorRemediation) &&
    typeof value.authorRemediation.summary === "string" &&
    value.authorRemediation.summary.trim().length > 0
  );
}

function normalizeAuthorFacingInspectorFinding(value: unknown) {
  if (!isPlainRecord(value)) return null;
  if (hasAuthorRemediation(value)) return value;
  const code = typeof value.code === "string" ? value.code : "";
  const summary =
    LEGACY_AUTHOR_REMEDIATION_SUMMARIES[code as keyof typeof LEGACY_AUTHOR_REMEDIATION_SUMMARIES];
  if (!summary) return null;
  return {
    ...value,
    authorRemediation: {
      summary,
      docsUrl: `${AUTHOR_REMEDIATION_DOCS_BASE}#${code}`,
    },
  };
}

function isInspectorBreakage(value: unknown) {
  if (!isPlainRecord(value)) return false;
  return value.level === "breakage" || value.level === "error" || value.severity === "P0";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function spinnerText(spinner: ReturnType<typeof createCrabLoader> | null, text: string) {
  if (spinner) spinner.text = text;
}

function clampLimit(value: number, max: number) {
  if (!Number.isFinite(value)) return Math.min(25, max);
  return Math.max(1, Math.min(Math.round(value), max));
}

function formatPackageLine(item: {
  name: string;
  displayName: string;
  family: PackageFamily;
  latestVersion?: string | null;
  channel: "official" | "community" | "private";
  isOfficial: boolean;
  verificationTier?: string | null;
  summary?: string | null;
}) {
  const flags = [
    familyLabel(item.family),
    item.isOfficial ? "official" : item.channel,
    item.verificationTier ?? null,
  ].filter(Boolean);
  const version = item.latestVersion ? ` v${item.latestVersion}` : "";
  const summary = item.summary ? `  ${styleText(truncate(item.summary, 96), "muted")}` : "";
  return `${styleText(`${item.name}${version}`, "brand")}  ${item.displayName}  ${styleText(
    `[${flags.join(", ")}]`,
    "muted",
  )}${summary}`;
}

function computeArtifactIdentity(bytes: Uint8Array): ArtifactIdentity {
  return {
    sha256: digestHex(bytes, "sha256"),
    npmIntegrity: `sha512-${digestBase64(bytes, "sha512")}`,
    npmShasum: digestHex(bytes, "sha1"),
    byteLength: bytes.byteLength,
  };
}

function digestHex(bytes: Uint8Array, algorithm: "sha1" | "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

function digestBase64(bytes: Uint8Array, algorithm: "sha512") {
  return createHash(algorithm).update(bytes).digest("base64");
}

function validateDownloadedArtifact(
  requestedPackageName: string,
  artifactResult: PackageArtifactResponse,
  bytes: Uint8Array,
  identity: ArtifactIdentity,
) {
  const artifact = artifactResult.artifact;
  if (artifact.kind === "npm-pack") {
    assertDigestMatch("SHA-256", artifact.sha256, identity.sha256);
    if (typeof artifact.size === "number" && artifact.size !== identity.byteLength) {
      fail(`artifact size mismatch: expected ${artifact.size}, got ${identity.byteLength}`);
    }
    assertDigestMatch("npm integrity", artifact.npmIntegrity, identity.npmIntegrity);
    assertDigestMatch("npm shasum", artifact.npmShasum, identity.npmShasum);
    const parsed = parseClawPack(bytes);
    if (parsed.packageName !== artifactResult.package.name) {
      fail(
        `ClawPack package name mismatch: expected ${artifactResult.package.name}, got ${parsed.packageName}`,
      );
    }
    if (parsed.packageVersion !== artifactResult.version) {
      fail(
        `ClawPack package version mismatch: expected ${artifactResult.version}, got ${parsed.packageVersion}`,
      );
    }
    if (requestedPackageName !== artifactResult.package.name) {
      fail(
        `Resolved package mismatch: expected ${requestedPackageName}, got ${artifactResult.package.name}`,
      );
    }
  }
  if (requestedPackageName !== artifactResult.package.name) {
    fail(
      `Resolved package mismatch: expected ${requestedPackageName}, got ${artifactResult.package.name}`,
    );
  }
}

function assertDigestMatch(label: string, expected: string | null | undefined, actual: string) {
  if (!expected) return;
  if (expected !== actual) {
    fail(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function defaultArtifactFilename(
  name: string,
  version: string,
  artifact: PackageArtifactResponse["artifact"],
) {
  if (artifact.kind === "npm-pack" && artifact.npmTarballName) return artifact.npmTarballName;
  const safeName = name
    .replace(/^@/, "")
    .replaceAll("/", "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${safeName}-${version}.${artifact.kind === "npm-pack" ? "tgz" : "zip"}`;
}

async function resolveArtifactOutputPath(
  opts: GlobalOpts,
  output: string | undefined,
  filename: string,
) {
  if (!output?.trim()) return resolve(opts.workdir, filename);
  const resolved = resolve(opts.workdir, output.trim());
  const outputStat = await stat(resolved).catch(() => null);
  if (outputStat?.isDirectory()) return join(resolved, filename);
  return resolved;
}

async function assertOutputWritable(path: string, force: boolean) {
  const existing = await stat(path).catch(() => null);
  if (existing && !force) fail(`Refusing to overwrite ${path}. Use --force.`);
  await mkdir(dirname(path), { recursive: true });
}

function printPackageSummary(detail: PackageResponse) {
  if (!detail.package) return;
  const pkg = detail.package;
  console.log(`${pkg.name}  ${pkg.displayName}`);
  console.log(`Family: ${familyLabel(pkg.family)}`);
  console.log(`Channel: ${pkg.channel}${pkg.isOfficial ? " (official)" : ""}`);
  if (pkg.summary) console.log(`Summary: ${pkg.summary}`);
  if (pkg.runtimeId) console.log(`Runtime ID: ${pkg.runtimeId}`);
  if (detail.owner?.handle || detail.owner?.displayName) {
    console.log(`Owner: ${detail.owner.handle ?? detail.owner.displayName}`);
  }
  console.log(`Created: ${formatTimestamp(pkg.createdAt)}`);
  console.log(`Updated: ${formatTimestamp(pkg.updatedAt)}`);
  if (pkg.latestVersion) console.log(`Latest: ${pkg.latestVersion}`);
  printArtifact(pkg.artifact ?? null);
  const tags = Object.entries(normalizeTags(pkg.tags));
  if (tags.length > 0) {
    console.log(`Tags: ${tags.map(([tag, version]) => `${tag}=${version}`).join(", ")}`);
  }
}

function printVersionSummary(version: NonNullable<PackageVersionResponse["version"]>) {
  console.log(`Selected: ${version.version}`);
  console.log(`Selected At: ${formatTimestamp(version.createdAt)}`);
  if (version.changelog.trim()) console.log(`Changelog: ${truncate(version.changelog, 120)}`);
}

function printTrustedPublisher(trustedPublisher: PackageTrustedPublisher) {
  console.log(`Provider: ${trustedPublisher.provider}`);
  console.log(`Repository: ${trustedPublisher.repository}`);
  console.log(`Workflow: ${trustedPublisher.workflowFilename}`);
  if (trustedPublisher.environment) {
    console.log(`Environment: ${trustedPublisher.environment}`);
  }
}

function printCompatibility(compatibility: PackageCompatibility | null | undefined) {
  if (!compatibility) return;
  const entries = formatCompatibilityEntries(compatibility);
  if (entries.length > 0) console.log(`Compatibility: ${entries.join(", ")}`);
}

function formatCompatibilityEntries(compatibility: PackageCompatibility) {
  return [
    compatibility.pluginApiRange ? `pluginApi=${compatibility.pluginApiRange}` : null,
    compatibility.builtWithOpenClawVersion
      ? `builtWith=${compatibility.builtWithOpenClawVersion}`
      : null,
    compatibility.pluginSdkVersion ? `sdk=${compatibility.pluginSdkVersion}` : null,
    compatibility.minGatewayVersion ? `minGateway=${compatibility.minGatewayVersion}` : null,
  ].filter(Boolean);
}

function printVerification(verification: PackageVerificationSummary | null | undefined) {
  if (!verification) return;
  console.log(`Verification: ${verification.tier} / ${verification.scope}`);
  if (verification.summary) console.log(`Verification Summary: ${verification.summary}`);
  if (verification.sourceRepo) console.log(`Source Repo: ${verification.sourceRepo}`);
  if (verification.sourceCommit) console.log(`Source Commit: ${verification.sourceCommit}`);
  if (verification.sourceTag) console.log(`Source Ref: ${verification.sourceTag}`);
  if (verification.scanStatus) console.log(`Scan: ${verification.scanStatus}`);
}

function printArtifact(artifact: PackageArtifactSummary | null | undefined) {
  if (!artifact || typeof artifact !== "object") return;
  const summary = artifact as {
    kind?: string;
    sha256?: string;
    size?: number;
    format?: string;
    npmIntegrity?: string;
    npmShasum?: string;
    npmTarballName?: string;
  };
  if (!summary.kind) return;
  console.log(`Artifact: ${summary.kind}${summary.format ? ` (${summary.format})` : ""}`);
  if (summary.sha256) console.log(`Artifact SHA-256: ${summary.sha256}`);
  if (typeof summary.size === "number") {
    console.log(`Artifact Size: ${formatByteCount(summary.size)}`);
  }
  if (summary.npmIntegrity) console.log(`npm integrity: ${summary.npmIntegrity}`);
  if (summary.npmShasum) console.log(`npm shasum: ${summary.npmShasum}`);
  if (summary.npmTarballName) console.log(`npm tarball: ${summary.npmTarballName}`);
}

function normalizeTags(tags: unknown): Record<string, string> {
  if (!tags || typeof tags !== "object") return {};
  const resolved: Record<string, string> = {};
  for (const [tag, version] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof version === "string") resolved[tag] = version;
  }
  return resolved;
}

function normalizeFiles(files: unknown): PrintableFile[] {
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => {
      if (!file || typeof file !== "object") return null;
      const entry = file as {
        path?: unknown;
        size?: unknown;
        sha256?: unknown;
        contentType?: unknown;
      };
      if (typeof entry.path !== "string") return null;
      return {
        path: entry.path,
        size: typeof entry.size === "number" ? entry.size : null,
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : null,
        contentType: typeof entry.contentType === "string" ? entry.contentType : null,
      };
    })
    .filter((entry): entry is PrintableFile => Boolean(entry));
}

function formatFileLine(file: PrintableFile) {
  const size = typeof file.size === "number" ? `${file.size}B` : "?";
  const hash = file.sha256 ?? "?";
  return `- ${file.path}  ${size}  ${hash}`;
}

function familyLabel(family: PackageFamily) {
  switch (family) {
    case "code-plugin":
      return "Code Plugin";
    case "bundle-plugin":
      return "Bundle Plugin";
    case "claw":
      return "Claw";
    default:
      return "Skill";
  }
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatTimestamp(value: number) {
  return new Date(value).toISOString();
}

async function readJsonFile(path: string) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stripMarkdownFrontmatter(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 4).replace(/^\n+/, "");
}

function extractReadmeH1(content: string) {
  const body = stripMarkdownFrontmatter(content);
  for (const line of body.split("\n")) {
    const match = /^#(?!#)\s+(.+?)\s*$/.exec(line.trim());
    const title = match?.[1]?.replace(/\s+#+$/, "").trim();
    if (title) return title;
  }
  return undefined;
}

function readReadmeH1FromPackageFiles(files: PackageFile[]) {
  const readme = files.find((file) => {
    const path = file.relPath.toLowerCase();
    return path === "readme.md" || path === "readme.mdx";
  });
  if (!readme) return undefined;
  try {
    return extractReadmeH1(new TextDecoder().decode(readme.bytes));
  } catch {
    return undefined;
  }
}

function packageJsonString(value: Record<string, unknown> | null, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function assertPackageMultipartSize(
  payloadJson: string,
  fileFieldName: "files" | "clawpack",
  files: PackageFile[],
) {
  if (isPackageMultipartTooLarge(payloadJson, fileFieldName, files)) {
    fail(getPackageMultipartSizeError());
  }
}

function getClawPackSizeError(path: string) {
  return `ClawPack "${path}" exceeds 120MB limit`;
}

function isPackageMultipartTooLarge(
  payloadJson: string,
  fileFieldName: "files" | "clawpack",
  files: PackageFile[],
) {
  return (
    estimatePackageMultipartUploadBytes({
      payloadJson,
      fileFieldName,
      files: files.map((file) => ({
        name: file.relPath,
        size: file.bytes.byteLength,
        type: file.contentType,
      })),
    }) > MAX_PACKAGE_MULTIPART_BYTES
  );
}

async function uploadClawPackToStorage(
  registry: string,
  publishToken: string,
  file: PackageFile,
  spinner: ReturnType<typeof createCrabLoader> | null,
  revalidateTrustedTooling: () => Promise<void> | void,
  trustedToolingBoundary: boolean,
) {
  if (spinner) spinner.text = `Uploading ${file.relPath}`;
  await revalidateTrustedTooling();
  const { uploadUrl, uploadTicket } = await apiRequest(
    registry,
    {
      method: "POST",
      path: LegacyApiRoutes.cliUploadUrl,
      token: publishToken,
      ...(trustedToolingBoundary ? { retryCount: 0 } : {}),
    },
    ApiCliUploadUrlResponseSchema,
  );
  await revalidateTrustedTooling();
  const result = await uploadBinary(
    {
      url: uploadUrl,
      bytes: file.bytes,
      contentType: file.contentType ?? "application/octet-stream",
      retryCount: trustedToolingBoundary ? 0 : PACKAGE_PUBLISH_RETRY_COUNT,
    },
    ApiUploadFileResponseSchema,
  );
  return { storageId: result.storageId, uploadTicket };
}

const REAL_BUNDLE_MANIFESTS = [
  { path: ".codex-plugin/plugin.json", format: "codex" },
  { path: ".claude-plugin/plugin.json", format: "claude" },
  { path: ".cursor-plugin/plugin.json", format: "cursor" },
] as const;

function hasRealBundleManifest(fileSet: Set<string>) {
  return REAL_BUNDLE_MANIFESTS.some((marker) => fileSet.has(marker.path));
}

function hasLooseBundleMarker(fileSet: Set<string>) {
  return Array.from(fileSet).some(
    (path) =>
      path.startsWith("skills/") ||
      path.startsWith("commands/") ||
      path.startsWith("agents/") ||
      path === "hooks/hooks.json" ||
      path === ".mcp.json" ||
      path === ".lsp.json" ||
      path === "settings.json",
  );
}

function detectPackageFamily(
  fileSet: Set<string>,
  packageJson: unknown,
  explicit?: PublishablePackageFamily,
): PublishablePackageFamily {
  if (explicit) return explicit;
  const packageRecord =
    packageJson && typeof packageJson === "object" && !Array.isArray(packageJson)
      ? (packageJson as Record<string, unknown>)
      : undefined;
  const openclaw =
    packageRecord?.openclaw &&
    typeof packageRecord.openclaw === "object" &&
    !Array.isArray(packageRecord.openclaw)
      ? (packageRecord.openclaw as Record<string, unknown>)
      : undefined;
  if (typeof openclaw?.claw === "string") {
    return "claw";
  }
  if (hasRealBundleManifest(fileSet)) return "bundle-plugin";
  if (fileSet.has("openclaw.plugin.json")) return "code-plugin";
  if (hasLooseBundleMarker(fileSet)) return "bundle-plugin";
  return fail("Could not detect package family. Use --family.");
}

async function readBundleManifestInfo(
  filesOnDisk: PackageFile[],
  folder: string,
  parsedClawpack: ReturnType<typeof parseClawPack> | undefined,
) {
  for (const marker of REAL_BUNDLE_MANIFESTS) {
    const manifest =
      readJsonEntry(filesOnDisk, marker.path) ??
      (parsedClawpack ? null : await readJsonFile(join(folder, marker.path)));
    if (manifest) return { manifest, format: marker.format };
  }
  return { manifest: null, format: undefined };
}

function parseTags(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCsv(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function applyGitHubSourcePath(
  source: Awaited<ReturnType<typeof resolveSourceInput>>,
  sourcePath: string | undefined,
) {
  const explicitPath = sourcePath?.trim();
  if (!explicitPath || source.kind !== "github") return source;
  return { ...source, path: explicitPath };
}

async function preparePackagePublishPlan(
  opts: GlobalOpts,
  sourceArg: string,
  options: PackagePublishOptions,
): Promise<PackagePublishPlan> {
  const githubRetryBudget = createGitHubRetryBudget();
  const resolvedSource = await resolveSourceInput(sourceArg, {
    workdir: opts.workdir,
    localWorkdirs: [process.cwd(), opts.workdir],
    retryBudget: githubRetryBudget,
  });
  const sourceForFetch = applyGitHubSourcePath(resolvedSource, options.sourcePath);
  let folder = sourceForFetch.kind === "local" ? sourceForFetch.path : "";
  let cleanup: (() => Promise<void>) | undefined;
  let inferredSource: InferredPublishSource | undefined;
  let clawpackOnDisk: PackageFile | undefined;
  let parsedClawpack: ReturnType<typeof parseClawPack> | undefined;
  const addCleanup = (next: () => Promise<void>) => {
    const previous = cleanup;
    cleanup = async () => {
      await next();
      await previous?.();
    };
  };

  if (sourceForFetch.kind === "github") {
    const fetchSpinner = options.json
      ? null
      : createCrabLoader(`Fetching ${sourceForFetch.owner}/${sourceForFetch.repo}`);
    try {
      const fetched = await fetchGitHubSource(sourceForFetch, githubRetryBudget);
      folder = fetched.dir;
      cleanup = fetched.cleanup;
      inferredSource = fetched.source;
      fetchSpinner?.stop();
    } catch (error) {
      fetchSpinner?.fail(formatError(error));
      throw error;
    }
  } else {
    const folderStat = await stat(folder).catch(() => null);
    if (!folderStat) fail("Path must be a folder or package tarball .tgz");
    if (folderStat.isFile()) {
      if (!folder.endsWith(".tgz")) fail("Package publish files must end in .tgz");
      const bytes = new Uint8Array(await readFile(folder));
      if (bytes.byteLength > MAX_PACKAGE_CLAWPACK_BYTES) {
        fail(getClawPackSizeError(basename(folder)));
      }
      parsedClawpack = parseClawPack(bytes);
      clawpackOnDisk = {
        relPath: basename(folder),
        bytes,
        contentType: "application/octet-stream",
      };
    } else if (!folderStat.isDirectory()) {
      fail("Path must be a folder or package tarball .tgz");
    }

    const localGitInfo = folderStat.isDirectory() ? resolveLocalGitInfo(folder) : null;
    if (localGitInfo) {
      inferredSource = {
        repo: localGitInfo.repo,
        commit: localGitInfo.commit,
        ref: localGitInfo.ref,
        path: localGitInfo.path,
        ...(localGitInfo.repo ? { url: `https://github.com/${localGitInfo.repo}` } : {}),
      };
    }
  }

  let filesOnDisk = parsedClawpack
    ? parsedClawpack.entries.map((entry) => ({
        relPath: entry.path,
        bytes: entry.bytes,
        contentType: mime.getType(entry.path) ?? "application/octet-stream",
      }))
    : await listPackageFiles(folder);
  if (filesOnDisk.length === 0) fail("No files found");

  const fileSet = new Set(filesOnDisk.map((file) => file.relPath.toLowerCase()));
  const packageJson =
    parsedClawpack?.packageJson ?? (await readJsonFile(join(folder, "package.json")));
  const pluginManifest =
    readJsonEntry(filesOnDisk, "openclaw.plugin.json") ??
    (parsedClawpack ? null : await readJsonFile(join(folder, "openclaw.plugin.json")));
  const bundleManifestInfo = await readBundleManifestInfo(filesOnDisk, folder, parsedClawpack);
  const bundleManifest = bundleManifestInfo.manifest;
  const family = detectPackageFamily(fileSet, packageJson, options.family);
  const name =
    options.name?.trim() ||
    parsedClawpack?.packageName ||
    packageJsonString(packageJson, "name") ||
    packageJsonString(pluginManifest, "id") ||
    packageJsonString(bundleManifest, "id") ||
    basename(folder).trim().toLowerCase();
  const displayName =
    options.displayName?.trim() ||
    packageJsonString(pluginManifest, "name") ||
    packageJsonString(packageJson, "displayName") ||
    packageJsonString(bundleManifest, "name") ||
    readReadmeH1FromPackageFiles(filesOnDisk) ||
    titleCase(basename(folder));
  const ownerHandle = options.owner?.trim().replace(/^@+/, "");
  const version =
    options.version?.trim() ||
    parsedClawpack?.packageVersion ||
    packageJsonString(packageJson, "version");
  const changelog = options.changelog ?? "";
  const tags = parseTags(options.tags ?? "latest");
  const source = buildSource(options, inferredSource);

  if (!name) fail("--name required");
  if (!displayName) fail("--display-name required");
  if (!version) fail("--version required");
  if (family !== "claw" && !fileSet.has("openclaw.plugin.json")) {
    fail("openclaw.plugin.json required");
  }
  if ((family === "code-plugin" || family === "claw") && !semver.valid(version)) {
    fail(`--version must be valid semver for ${family === "claw" ? "Claws" : "code plugins"}`);
  }
  if (family === "code-plugin") {
    if (!fileSet.has("package.json")) fail("package.json required");
    if (!source) fail("--source-repo and --source-commit required for code plugins");
    const validation = validateOpenClawExternalCodePluginPackageJson(packageJson);
    if (validation.issues.length > 0) {
      fail(validation.issues.map((issue) => issue.message).join(" "));
    }
  }

  if (family === "claw") {
    const { validateClawPackageContents } = await import("../../schema/clawPackage.js");
    const validation = validateClawPackageContents({
      packageName: name,
      version,
      packageJson,
      openClawProfilePolicy: "publication-compatible",
      files: filesOnDisk.map((file) => ({
        path: file.relPath,
        text: decodeUtf8Text(file.bytes) ?? undefined,
      })),
    });
    if (!validation.ok) {
      fail(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "));
    }
    if (!clawpackOnDisk) {
      fail("Claw publication requires an already-built package tarball (.tgz)");
    }
  }

  if (family === "code-plugin" && !clawpackOnDisk) {
    const packDestination = await mkdtemp(join(tmpdir(), "clawhub-clawpack-"));
    let packed: PackedClawPack;
    try {
      packed = await createClawPackFromFolder({
        sourcePath: folder,
        packDestination,
        cwd: opts.workdir,
      });
      if (packed.parsed.packageName !== name) {
        fail(`ClawPack package name mismatch: expected ${name}, got ${packed.parsed.packageName}`);
      }
      if (packed.parsed.packageVersion !== version) {
        fail(
          `ClawPack package version mismatch: expected ${version}, got ${packed.parsed.packageVersion}`,
        );
      }
    } catch (error) {
      await rm(packDestination, { recursive: true, force: true });
      throw error;
    }
    addCleanup(async () => {
      await rm(packDestination, { recursive: true, force: true });
    });
    clawpackOnDisk = packed.file;
    filesOnDisk = packed.parsed.entries.map((entry) => ({
      relPath: entry.path,
      bytes: entry.bytes,
      contentType: mime.getType(entry.path) ?? "application/octet-stream",
    }));
  }
  const totalBytes = clawpackOnDisk
    ? clawpackOnDisk.bytes.byteLength
    : filesOnDisk.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const categories = parseCsv(options.categories);
  const topics = parseCsv(options.topics);
  const payload: PackagePublishPayload = {
    name,
    displayName,
    ...(ownerHandle ? { ownerHandle } : {}),
    family,
    version,
    changelog,
    ...(family === "claw" && clawpackOnDisk
      ? { expectedArtifactSha256: digestHex(clawpackOnDisk.bytes, "sha256") }
      : {}),
    ...(options.manualOverrideReason?.trim()
      ? { manualOverrideReason: options.manualOverrideReason.trim() }
      : {}),
    tags,
    ...(options.categories !== undefined ? { categories } : {}),
    ...(options.topics !== undefined ? { topics } : {}),
    ...(source ? { source } : {}),
    ...(family === "bundle-plugin"
      ? {
          bundle: {
            format: options.bundleFormat?.trim() || bundleManifestInfo.format,
            hostTargets: parseCsv(options.hostTargets),
          },
        }
      : {}),
  };
  try {
    if (clawpackOnDisk) {
      if (clawpackOnDisk.bytes.byteLength > MAX_PACKAGE_CLAWPACK_BYTES) {
        fail(getClawPackSizeError(clawpackOnDisk.relPath));
      }
    } else {
      assertPackageMultipartSize(JSON.stringify(payload), "files", filesOnDisk);
    }
  } catch (error) {
    await cleanup?.();
    throw error;
  }
  const sourceLabel = describePublishSource(sourceForFetch, source, folder);

  return {
    folder,
    cleanup,
    filesOnDisk,
    clawpackOnDisk,
    packageJson,
    payload,
    compatibility:
      family === "code-plugin"
        ? normalizeOpenClawExternalPluginCompatibility(packageJson)
        : undefined,
    sourceLabel,
    output: {
      source: sourceLabel,
      name,
      displayName,
      family,
      version,
      ...(source?.commit ? { commit: source.commit } : {}),
      files: filesOnDisk.length,
      totalBytes,
      ...(family === "claw" && clawpackOnDisk
        ? { artifactSha256: digestHex(clawpackOnDisk.bytes, "sha256") }
        : {}),
    },
  };
}

function readJsonEntry(files: PackageFile[], path: string) {
  const file = files.find((entry) => entry.relPath.toLowerCase() === path.toLowerCase());
  if (!file) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(file.bytes)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasGitHubActionsOidcEnv(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

async function requestGitHubActionsOidcToken(
  audience: string,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim();
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim();
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub Actions OIDC is not available in this environment.");
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${requestToken}`,
    },
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub OIDC token request failed (${response.status}): ${responseText || response.statusText}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("GitHub OIDC token request returned invalid JSON.");
  }

  const token = (parsed as { value?: unknown }).value;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("GitHub OIDC token response did not include a token value.");
  }
  return token;
}

async function mintPackagePublishToken(
  registry: string,
  packageName: string,
  version: string,
  githubOidcToken: string,
  scope: "upload" | "publish",
  inventoryDigest: string,
) {
  const response = await apiRequest(
    registry,
    {
      method: "POST",
      path: ApiRoutes.publishTokenMint,
      body: {
        packageName,
        version,
        githubOidcToken,
        scope,
        inventoryDigest,
        ...(process.env.TRUSTED_TOOLING_IDENTITY_JSON?.trim()
          ? { trustedToolingIdentityJson: process.env.TRUSTED_TOOLING_IDENTITY_JSON.trim() }
          : {}),
      },
    },
    ApiV1PublishTokenMintResponseSchema,
  );
  return response.token;
}

async function resolvePackagePublishToken(params: {
  registry: string;
  packageName: string;
  version: string;
  scope: "upload" | "publish";
  inventoryDigest: string;
  manualOverrideReason?: string;
  spinner: ReturnType<typeof createCrabLoader> | null;
}) {
  if (params.manualOverrideReason?.trim()) {
    return { kind: "user" as const, token: await requireAuthToken() };
  }

  if (!hasGitHubActionsOidcEnv()) {
    return { kind: "user" as const, token: await requireAuthToken() };
  }

  if (params.spinner) {
    params.spinner.text = "Requesting GitHub Actions OIDC token";
  }
  try {
    const githubOidcToken = await requestGitHubActionsOidcToken("clawhub");
    if (params.spinner) {
      params.spinner.text = "Minting short-lived ClawHub publish token";
    }
    return {
      kind: "github-actions" as const,
      token: await mintPackagePublishToken(
        params.registry,
        params.packageName,
        params.version,
        githubOidcToken,
        params.scope,
        params.inventoryDigest,
      ),
    };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (status !== undefined && status !== 400 && status !== 403 && status !== 404) {
      throw error;
    }
    if (params.spinner) {
      params.spinner.text = "Trusted publishing unavailable, falling back to ClawHub token";
    }
    return { kind: "user" as const, token: await requireAuthToken() };
  }
}

function buildSource(options: PackagePublishOptions, inferred?: InferredPublishSource) {
  const rawRepo = options.sourceRepo?.trim() || inferred?.repo?.trim();
  const rawCommit = options.sourceCommit?.trim() || inferred?.commit?.trim();
  const rawRef = options.sourceRef?.trim() || inferred?.ref?.trim();
  const explicitPath = options.sourcePath?.trim();
  const rawPath = explicitPath !== undefined ? explicitPath : inferred?.path?.trim();
  if (!rawRepo && !rawCommit && !rawRef && !rawPath) return undefined;
  if (!rawRepo || !rawCommit) fail("--source-repo and --source-commit must be set together");
  const repo = normalizeGitHubRepo(rawRepo);
  if (!repo) fail("--source-repo must be a GitHub repo or URL");
  const explicitRepo = options.sourceRepo?.trim();
  const url = explicitRepo
    ? explicitRepo.startsWith("http")
      ? explicitRepo
      : `https://github.com/${repo}`
    : inferred?.url || `https://github.com/${repo}`;
  return {
    kind: "github" as const,
    url,
    repo,
    ref: rawRef || rawCommit,
    commit: rawCommit,
    path: rawPath || ".",
    importedAt: Date.now(),
  };
}

function describePublishSource(
  sourceInput: Awaited<ReturnType<typeof resolveSourceInput>>,
  source: ReturnType<typeof buildSource>,
  folder: string,
) {
  if (source) {
    return `github:${source.repo}@${source.ref}${source.path !== "." ? `:${source.path}` : ""}`;
  }
  if (sourceInput.kind === "github") {
    const repo = `${sourceInput.owner}/${sourceInput.repo}`;
    return `github:${repo}@${sourceInput.ref ?? "HEAD"}${
      sourceInput.path !== "." ? `:${sourceInput.path}` : ""
    }`;
  }
  return `local:${folder}`;
}

function printPackageDryRun(params: {
  source: string;
  family: PackageFamily;
  name: string;
  displayName: string;
  version: string;
  commit?: string;
  compatibility?: PackageCompatibility;
  tags: string[];
  files: PackageFile[];
}) {
  console.log("Dry run - nothing will be published.");
  console.log("");
  console.log(`Source:    ${params.source}`);
  console.log(`Family:    ${params.family}`);
  console.log(`Name:      ${params.name}`);
  console.log(`Display:   ${params.displayName}`);
  console.log(`Version:   ${params.version}`);
  if (params.commit) console.log(`Commit:    ${params.commit}`);
  if (params.compatibility) {
    console.log(`Compat:    ${formatCompatibilityEntries(params.compatibility).join(", ")}`);
  }
  console.log(
    `Files:     ${params.files.length} files (${formatByteCount(
      params.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    )})`,
  );
  console.log(`Tags:      ${params.tags.join(", ")}`);
  console.log("");
  console.log("Files:");
  for (const file of params.files) {
    console.log(`  ${file.relPath.padEnd(28)} ${formatByteCount(file.bytes.byteLength)}`);
  }
}

function formatByteCount(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function listPackageFiles(root: string) {
  const files: PackageFile[] = [];
  const absRoot = resolve(root);
  const ig = ignore();
  ig.add([".git/", "node_modules/", `${DOT_DIR}/`, `${LEGACY_DOT_DIR}/`]);
  await addIgnoreFile(ig, join(absRoot, DOT_IGNORE));
  await addIgnoreFile(ig, join(absRoot, LEGACY_DOT_IGNORE));
  await walk(absRoot, async (absPath) => {
    const relPath = normalizePath(relative(absRoot, absPath));
    if (!relPath || ig.ignores(relPath)) return;
    const bytes = new Uint8Array(await readFile(absPath));
    files.push({
      relPath,
      bytes,
      contentType: mime.getType(relPath) ?? "application/octet-stream",
    });
  });
  return files;
}

function normalizePath(path: string) {
  return path
    .split(sep)
    .join("/")
    .replace(/^\.\/+/, "");
}

async function walk(dir: string, onFile: (path: string) => Promise<void>) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile);
      continue;
    }
    if (!entry.isFile()) continue;
    await onFile(full);
  }
}

async function addIgnoreFile(ig: ReturnType<typeof ignore>, path: string) {
  try {
    const raw = await readFile(path, "utf8");
    ig.add(raw.split(/\r?\n/));
  } catch {
    // optional
  }
}
