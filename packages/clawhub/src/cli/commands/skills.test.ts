/* @vitest-environment node */

import * as fsPromises from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthTokenModuleMocks,
  createHttpModuleMocks,
  createRegistryModuleMocks,
  createUiModuleMocks,
  makeGlobalOpts,
} from "../../../test/cliCommandTestKit.js";
import { ApiRoutes, LegacyApiRoutes } from "../../schema/index.js";
import * as skillStore from "../../skills.js";

const fsMocks = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdtemp: fsMocks.mkdtemp,
    mkdir: fsMocks.mkdir,
    rename: fsMocks.rename,
    rm: fsMocks.rm,
    stat: fsMocks.stat,
  };
});

const mocked = <T>(value: T) => value as T & Record<string, unknown>;
Object.assign(vi as object, { mocked });

const authTokenMocks = createAuthTokenModuleMocks();
const registryMocks = createRegistryModuleMocks();
const httpMocks = createHttpModuleMocks();
const uiMocks = createUiModuleMocks();
const mockApiRequest = httpMocks.apiRequest;
const mockDownloadZip = httpMocks.downloadZip;
const mockFetchBinary = httpMocks.fetchBinary;
const mockGetOptionalAuthToken = authTokenMocks.getOptionalAuthToken;
const mockSpinner = uiMocks.spinner;
const mockIsInteractive = vi.fn(() => false);
const mockPromptConfirm = vi.fn(async () => false);
vi.mock("../../http.js", () => httpMocks.moduleFactory());
vi.mock("../registry.js", () => registryMocks.moduleFactory());
vi.mock("../authToken.js", () => authTokenMocks.moduleFactory());
vi.mock("../ui.js", () => ({
  createCrabLoader: vi.fn(() => mockSpinner),
  fail: (message: string) => uiMocks.fail(message),
  formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  isInteractive: mockIsInteractive,
  promptConfirm: mockPromptConfirm,
  styleText: (value: string) => value,
}));

const extractZipToDirMock = vi.spyOn(skillStore, "extractZipToDir");
const extractGitHubZipPathToDirMock = vi.spyOn(skillStore, "extractGitHubZipPathToDir");
const hashSkillFilesMock = vi.spyOn(skillStore, "hashSkillFiles");
const listManualSkillsMock = vi.spyOn(skillStore, "listManualSkills");
const listTextFilesMock = vi.spyOn(skillStore, "listSkillFiles");
const readLockfileMock = vi.spyOn(skillStore, "readLockfile");
const readSkillOriginMock = vi.spyOn(skillStore, "readSkillOrigin");
const writeLockfileMock = vi.spyOn(skillStore, "writeLockfile");
const writeSkillOriginMock = vi.spyOn(skillStore, "writeSkillOrigin");

const mkdtempMock = fsMocks.mkdtemp;
const mkdirMock = fsMocks.mkdir;
const renameMock = fsMocks.rename;
const rmMock = fsMocks.rm;
const statMock = fsMocks.stat;
const {
  clampLimit,
  cmdExplore,
  cmdInstall,
  cmdList,
  cmdListSkillReports,
  cmdPin,
  cmdReportSkill,
  cmdSearch,
  cmdTriageSkillReport,
  cmdUninstall,
  cmdUnpin,
  cmdUpdate,
  formatExploreLine,
} = await import("./skills.js");
const {
  extractGitHubZipPathToDir,
  extractZipToDir,
  hashSkillFiles,
  listSkillFiles,
  readLockfile,
  readSkillOrigin,
  writeLockfile,
  writeSkillOrigin,
} = skillStore;
const { rename, rm, stat } = fsPromises;

const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});

function makeOpts() {
  return makeGlobalOpts();
}

function githubArtifactIdentity(repo: string, path: string, commit: string, contentHash: string) {
  return JSON.stringify({ installKind: "github", repo, path, commit, contentHash });
}

function archiveArtifactIdentity(canonicalRef: string, version: string) {
  return JSON.stringify({ installKind: "archive", canonicalRef, version });
}

beforeEach(() => {
  mkdtempMock.mockImplementation(async (prefix: string) => `${prefix}123`);
  mkdirMock.mockResolvedValue(undefined);
  renameMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
  statMock.mockRejectedValue(new Error("missing"));
  extractZipToDirMock.mockResolvedValue(undefined);
  extractGitHubZipPathToDirMock.mockResolvedValue(undefined);
  hashSkillFilesMock.mockReturnValue({ fingerprint: "hash", files: [] });
  listManualSkillsMock.mockResolvedValue([]);
  listTextFilesMock.mockResolvedValue([]);
  readLockfileMock.mockResolvedValue({ version: 1, skills: {} });
  readSkillOriginMock.mockResolvedValue(null);
  writeLockfileMock.mockResolvedValue(undefined);
  writeSkillOriginMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  extractZipToDirMock.mockRestore();
  extractGitHubZipPathToDirMock.mockRestore();
  hashSkillFilesMock.mockRestore();
  listManualSkillsMock.mockRestore();
  listTextFilesMock.mockRestore();
  readLockfileMock.mockRestore();
  readSkillOriginMock.mockRestore();
  writeLockfileMock.mockRestore();
  writeSkillOriginMock.mockRestore();
});

describe("explore helpers", () => {
  it("clamps explore limits and handles non-finite values", () => {
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(99)).toBe(99);
    expect(clampLimit(200)).toBe(200);
    expect(clampLimit(250)).toBe(200);
    expect(clampLimit(Number.NaN)).toBe(25);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(25);
    expect(clampLimit(Number.NaN, 10)).toBe(10);
  });

  it("formats explore lines with relative time and truncation", () => {
    const now = 4 * 60 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const summary = "a".repeat(60);
    const line = formatExploreLine({
      ownerHandle: "openclaw",
      slug: "weather",
      summary,
      updatedAt: now - 2 * 60 * 60 * 1000,
      latestVersion: null,
    });
    expect(line).toBe(`openclaw/weather  v?  2h ago  ${"a".repeat(49)}…`);
    nowSpy.mockRestore();
  });

  it("formats legacy registry results without an owner handle", () => {
    const now = 4 * 60 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    expect(
      formatExploreLine({
        slug: "weather",
        updatedAt: now - 2 * 60 * 60 * 1000,
        latestVersion: { version: "1.0.0" },
      }),
    ).toBe("weather  v1.0.0  2h ago");
    nowSpy.mockRestore();
  });
});

describe("cmdExplore", () => {
  it("passes optional auth token to apiRequest", async () => {
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockResolvedValue({ items: [] });

    await cmdExplore(makeOpts(), { limit: 25 });

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    expect(requestArgs?.token).toBe("tkn");
  });

  it("clamps limit and handles empty results", async () => {
    mockApiRequest.mockResolvedValue({ items: [] });

    await cmdExplore(makeOpts(), { limit: 0 });

    const [, args] = mockApiRequest.mock.calls[0] ?? [];
    const url = new URL(String(args?.url));
    expect(url.searchParams.get("limit")).toBe("1");
    expect(mockLog).toHaveBeenCalledWith("No skills found.");
  });

  it("prints formatted results", async () => {
    const now = 10 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const item = {
      ownerHandle: "openclaw",
      slug: "gog",
      summary: "Google Workspace CLI for Gmail, Calendar, Drive and more.",
      updatedAt: now - 90 * 1000,
      latestVersion: { version: "1.2.3" },
    };
    mockApiRequest.mockResolvedValue({ items: [item] });

    await cmdExplore(makeOpts(), { limit: 250 });

    const [, args] = mockApiRequest.mock.calls[0] ?? [];
    const url = new URL(String(args?.url));
    expect(url.searchParams.get("limit")).toBe("200");
    expect(mockLog).toHaveBeenCalledWith(formatExploreLine(item));
    nowSpy.mockRestore();
  });

  it("supports sort and json output", async () => {
    const payload = { items: [], nextCursor: null };
    mockApiRequest.mockResolvedValue(payload);

    await cmdExplore(makeOpts(), { limit: 10, sort: "installs", json: true });

    const [, args] = mockApiRequest.mock.calls[0] ?? [];
    const url = new URL(String(args?.url));
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("sort")).toBe("installs");
    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(payload, null, 2));
  });

  it("supports installs and trending sorts", async () => {
    mockApiRequest.mockResolvedValue({ items: [], nextCursor: null });

    await cmdExplore(makeOpts(), { limit: 5, sort: "newest" });
    await cmdExplore(makeOpts(), { limit: 5, sort: "installs" });
    await cmdExplore(makeOpts(), { limit: 5, sort: "trending" });

    const first = new URL(String(mockApiRequest.mock.calls[0]?.[1]?.url));
    const second = new URL(String(mockApiRequest.mock.calls[1]?.[1]?.url));
    const third = new URL(String(mockApiRequest.mock.calls[2]?.[1]?.url));
    expect(first.searchParams.get("sort")).toBe("createdAt");
    expect(second.searchParams.get("sort")).toBe("installs");
    expect(third.searchParams.get("sort")).toBe("trending");
  });

  it("normalizes legacy install aliases to installs", async () => {
    mockApiRequest.mockResolvedValue({ items: [], nextCursor: null });

    await cmdExplore(makeOpts(), { sort: "installsCurrent" });
    await cmdExplore(makeOpts(), { sort: "installs-current" });
    await cmdExplore(makeOpts(), { sort: "current" });
    await cmdExplore(makeOpts(), { sort: "installsAllTime" });
    await cmdExplore(makeOpts(), { sort: "installs-all-time" });

    for (const call of mockApiRequest.mock.calls) {
      const url = new URL(String(call[1]?.url));
      expect(url.searchParams.get("sort")).toBe("installs");
    }
  });

  it("supports downloads sort", async () => {
    mockApiRequest.mockResolvedValue({ items: [], nextCursor: null });

    await cmdExplore(makeOpts(), { sort: "downloads" });
    await cmdExplore(makeOpts(), { sort: "download" });

    for (const call of mockApiRequest.mock.calls) {
      const url = new URL(String(call[1]?.url));
      expect(url.searchParams.get("sort")).toBe("downloads");
    }
  });

  it("keeps install alias on the installs sort", async () => {
    mockApiRequest.mockResolvedValue({ items: [], nextCursor: null });

    await cmdExplore(makeOpts(), { sort: "installs" });
    await cmdExplore(makeOpts(), { sort: "install" });

    for (const call of mockApiRequest.mock.calls) {
      const url = new URL(String(call[1]?.url));
      expect(url.searchParams.get("sort")).toBe("installs");
    }
  });

  it("lists accepted install aliases in invalid sort guidance", async () => {
    await expect(cmdExplore(makeOpts(), { sort: "bad-sort" })).rejects.toThrow(
      'Invalid sort "bad-sort". Use newest, updated, rating, downloads, installs, or trending.',
    );
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});

describe("cmdSearch", () => {
  it("passes optional auth token to apiRequest", async () => {
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockResolvedValue({ results: [] });

    await cmdSearch(makeOpts(), "demo");

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    expect(requestArgs?.token).toBe("tkn");
  });

  it("defaults limit to 25 when not specified", async () => {
    mockGetOptionalAuthToken.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue({ results: [] });

    await cmdSearch(makeOpts(), "stock price");

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    const url = new URL(String(requestArgs?.url));
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("uses explicit limit when provided", async () => {
    mockGetOptionalAuthToken.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue({ results: [] });

    await cmdSearch(makeOpts(), "stock price", 5);

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    const url = new URL(String(requestArgs?.url));
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("routes prefix search through the paginated skills list", async () => {
    mockGetOptionalAuthToken.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue({ items: [], nextCursor: "cursor-2" });

    await cmdSearch(makeOpts(), "aigroup-", { prefix: true, limit: 10, cursor: "cursor-1" });

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    const url = new URL(String(requestArgs?.url));
    expect(url.pathname).toBe(ApiRoutes.skills);
    expect(url.searchParams.get("prefix")).toBe("aigroup-");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
    expect(url.searchParams.has("mode")).toBe(false);
    expect(mockLog).toHaveBeenCalledWith("Next cursor: cursor-2");
  });

  it("sets exact search mode", async () => {
    mockGetOptionalAuthToken.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue({ results: [] });

    await cmdSearch(makeOpts(), "aigroup-alpha", { exact: true });

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    const url = new URL(String(requestArgs?.url));
    expect(url.searchParams.get("q")).toBe("aigroup-alpha");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("mode")).toBe("exact");
  });

  it("rejects conflicting search modes", async () => {
    await expect(cmdSearch(makeOpts(), "aigroup-", { prefix: true, exact: true })).rejects.toThrow(
      "Choose either --prefix or --exact, not both",
    );
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("rejects a cursor without prefix mode", async () => {
    await expect(cmdSearch(makeOpts(), "demo", { cursor: "cursor-1" })).rejects.toThrow(
      "--cursor requires --prefix",
    );
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("prints skill owners in search results", async () => {
    mockGetOptionalAuthToken.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue({
      results: [
        {
          slug: "demo",
          displayName: "Demo Skill",
          version: "1.2.3",
          ownerHandle: "openclaw",
          downloads: 1234,
          score: 0.9876,
        },
        {
          slug: "legacy",
          displayName: "Legacy Skill",
          version: null,
          owner: { displayName: "Legacy Owner" },
          downloads: 1,
          score: 0.5,
        },
      ],
    });

    await cmdSearch(makeOpts(), "demo");

    expect(mockLog).toHaveBeenCalledWith(
      "demo v1.2.3  @openclaw     Demo Skill    1,234 downloads",
    );
    expect(mockLog).toHaveBeenCalledWith("legacy       Legacy Owner  Legacy Skill  1 download");
  });

  it("preserves canonical mixed API order and prints installable external references", async () => {
    mockGetOptionalAuthToken.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue({
      results: [
        {
          id: "skills-sh:acme/skills/calendar",
          source: "skills-sh",
          slug: "calendar",
          displayName: "External Calendar",
          score: 6_110,
          ownerHandle: "acme",
          install: {
            kind: "skills-sh",
            reference: "skills-sh/acme/skills/calendar",
            sourceUrl: "https://skills.sh/acme/skills/calendar",
          },
          sourceIdentity: {
            id: "acme/skills/calendar",
            owner: "acme",
            repo: "skills",
            host: null,
            lifetimeInstalls: 99_000,
          },
        },
        {
          id: "clawhub:skills:calendar",
          source: "clawhub",
          slug: "calendar-native",
          displayName: "Native Calendar",
          score: 5_095,
          ownerHandle: "openclaw",
          metrics: { rolling60DayInstalls: 12, bookmarks: 3, updatedAt: 1 },
        },
      ],
    });

    await cmdSearch(makeOpts(), "calendar");

    const lines = mockLog.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("skills-sh/acme/skills/calendar");
    expect(lines[0]).toContain("99,000 skills.sh lifetime installs");
    expect(lines[1]).toContain("calendar-native");
    expect(lines[1]).toContain("12 installs / 60d");
  });
});

describe("skill moderation commands", () => {
  it("submits skill reports", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      reported: true,
      alreadyReported: false,
      reportId: "skillReports:1",
      skillId: "skills:1",
      reportCount: 1,
    });

    await cmdReportSkill(makeOpts(), "demo", { version: "1.0.0", reason: "suspicious files" });

    expect(mockApiRequest).toHaveBeenCalledWith(
      "https://clawhub.ai",
      {
        method: "POST",
        path: "/api/v1/skills/demo/report",
        token: "tkn",
        body: { reason: "suspicious files", version: "1.0.0" },
      },
      expect.anything(),
    );
    expect(mockLog).toHaveBeenCalledWith("OK. Reported demo (skillReports:1).");
  });

  it("lists skill reports", async () => {
    mockApiRequest.mockResolvedValueOnce({
      items: [
        {
          reportId: "skillReports:1",
          skillId: "skills:1",
          skillVersionId: "skillVersions:1",
          slug: "demo",
          displayName: "Demo",
          version: "1.0.0",
          reason: "suspicious",
          status: "open",
          createdAt: 1,
          reporter: { userId: "users:reporter", handle: "reporter", displayName: "Reporter" },
          triagedAt: null,
          triagedBy: null,
          triageNote: null,
        },
      ],
      nextCursor: null,
      done: true,
    });

    await cmdListSkillReports(makeOpts(), { status: "open", limit: 10 });

    const request = mockApiRequest.mock.calls[0]?.[1] as { url?: string } | undefined;
    const url = new URL(String(request?.url));
    expect(url.pathname).toBe("/api/v1/skills/-/reports");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(mockLog).toHaveBeenCalledWith("skillReports:1 open demo");
  });

  it("triages skill reports", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      reportId: "skillReports:1",
      skillId: "skills:1",
      status: "confirmed",
      reportCount: 0,
      actionTaken: "hide",
    });

    await cmdTriageSkillReport(makeOpts(), "skillReports:1", {
      status: "confirmed",
      note: "handled",
      action: "hide",
      yes: true,
    });

    expect(mockApiRequest).toHaveBeenCalledWith(
      "https://clawhub.ai",
      {
        method: "POST",
        path: "/api/v1/skills/-/reports/skillReports%3A1/triage",
        token: "tkn",
        body: { status: "confirmed", note: "handled", finalAction: "hide" },
      },
      expect.anything(),
    );
    expect(mockLog).toHaveBeenCalledWith(
      "OK. Skill report skillReports:1 set to confirmed; action hide.",
    );
    expect(mockLog).toHaveBeenCalledWith("  - Hide the skill from public availability.");
  });
});

describe("cmdUpdate", () => {
  it("updates and canonicalizes a legacy slash-form skills.sh lock entry", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    const legacySourceRef = "skills-sh/patrick-erichsen/skills/html";
    const previousCommit = "a".repeat(40);
    const nextCommit = "b".repeat(40);
    const installedFiles = [{ path: "SKILL.md", sha256: "c".repeat(64), size: 1 }];
    const contentHash = skillStore.buildGitHubFolderContentHash(installedFiles);
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest
      .mockResolvedValueOnce({
        ok: true,
        slug: sourceRef,
        installKind: "github",
        github: {
          repo: "patrick-erichsen/skills",
          path: "skills/html",
          commit: nextCommit,
          contentHash,
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
        },
        provenance: {
          source: "skills.sh",
          reference: sourceRef,
        },
        trust: {
          clawhubScan: "unscanned",
          label: "Not scanned by ClawHub",
        },
        canonicalRef: null,
      })
      .mockResolvedValueOnce({ ok: true });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        html: {
          version: previousCommit,
          installedAt: 123,
          sourceRef: legacySourceRef,
        },
      },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef: legacySourceRef,
      installedVersion: previousCommit,
      installedAt: 123,
      fingerprint: "hash",
    });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    hashSkillFilesMock.mockReturnValue({ fingerprint: "hash", files: installedFiles });

    await cmdUpdate(makeOpts(), sourceRef, {}, false);

    expect(mockApiRequest).toHaveBeenCalledWith(
      "https://clawhub.ai",
      {
        method: "GET",
        path: `${ApiRoutes.skillsSh}/patrick-erichsen/skills/html/install`,
        token: "tkn",
      },
      expect.anything(),
    );
    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/patrick-erichsen/skills/zip/${nextCommit}`,
    });
    expect(writeSkillOrigin).toHaveBeenCalledWith("/work/skills/html", {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef,
      sourceKind: "skills-sh",
      sourceRepository: "patrick-erichsen/skills",
      sourcePath: "skills/html",
      sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
      clawhubScan: "unscanned",
      trustLabel: "Not scanned by ClawHub",
      artifactIdentity: githubArtifactIdentity(
        "patrick-erichsen/skills",
        "skills/html",
        nextCommit,
        contentHash,
      ),
      installedVersion: nextCommit,
      installedAt: 123,
      fingerprint: "hash",
    });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        [sourceRef]: {
          version: nextCommit,
          installedAt: 123,
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
        },
      },
    });
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "https://clawhub.ai",
      expect.objectContaining({
        path: LegacyApiRoutes.cliTelemetryInstall,
        body: expect.objectContaining({
          event: "install",
          slug: "html",
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
          version: nextCommit,
        }),
      }),
      expect.anything(),
    );
  });

  it("updates an external install through a scanned Repo Sync alias", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    const previousCommit = "a".repeat(40);
    const nextCommit = "b".repeat(40);
    const installedFiles = [{ path: "SKILL.md", sha256: "c".repeat(64), size: 1 }];
    const contentHash = skillStore.buildGitHubFolderContentHash(installedFiles);
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest
      .mockResolvedValueOnce({
        ok: true,
        slug: "html",
        installKind: "github",
        github: {
          repo: "patrick-erichsen/skills",
          path: "skills/html",
          commit: nextCommit,
          contentHash,
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
        },
        provenance: {
          source: "skills.sh",
          reference: sourceRef,
          repository: "patrick-erichsen/skills",
          path: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
        },
        trust: {
          clawhubScan: "scanned",
          label: "Scanned by ClawHub",
        },
        canonicalRef: "@openclaw/html",
      })
      .mockResolvedValueOnce({ ok: true });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        [sourceRef]: {
          version: previousCommit,
          installedAt: 123,
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${previousCommit}/skills/html`,
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
        },
      },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef,
      sourceKind: "skills-sh",
      sourceRepository: "patrick-erichsen/skills",
      sourcePath: "skills/html",
      sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${previousCommit}/skills/html`,
      clawhubScan: "unscanned",
      trustLabel: "Not scanned by ClawHub",
      installedVersion: previousCommit,
      installedAt: 123,
      fingerprint: "hash",
    });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    hashSkillFilesMock.mockReturnValue({ fingerprint: "hash", files: installedFiles });

    await cmdUpdate(makeOpts(), sourceRef, {}, false);

    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/patrick-erichsen/skills/zip/${nextCommit}`,
    });
    expect(writeSkillOrigin).toHaveBeenCalledWith("/work/skills/html", {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef,
      sourceKind: "skills-sh",
      sourceRepository: "patrick-erichsen/skills",
      sourcePath: "skills/html",
      sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
      canonicalRef: "@openclaw/html",
      clawhubScan: "scanned",
      trustLabel: "Scanned by ClawHub",
      artifactIdentity: githubArtifactIdentity(
        "patrick-erichsen/skills",
        "skills/html",
        nextCommit,
        contentHash,
      ),
      installedVersion: nextCommit,
      installedAt: 123,
      fingerprint: "hash",
    });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        [sourceRef]: {
          version: nextCommit,
          installedAt: 123,
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
          canonicalRef: "@openclaw/html",
          clawhubScan: "scanned",
          trustLabel: "Scanned by ClawHub",
        },
      },
    });
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "https://clawhub.ai",
      expect.objectContaining({
        path: LegacyApiRoutes.cliTelemetryInstall,
        body: {
          event: "install",
          slug: "html",
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${nextCommit}/skills/html`,
          canonicalRef: "@openclaw/html",
          clawhubScan: "scanned",
          trustLabel: "Scanned by ClawHub",
          version: nextCommit,
        },
      }),
      expect.anything(),
    );
  });

  it("reinstalls before promoting same-version bytes to a scanned alias", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    const commit = "a".repeat(40);
    const installedFiles = [{ path: "SKILL.md", sha256: "c".repeat(64), size: 1 }];
    const contentHash = skillStore.buildGitHubFolderContentHash(installedFiles);
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      slug: "html",
      installKind: "github",
      github: {
        repo: "openclaw/skills",
        path: "skills/html",
        commit,
        contentHash,
        sourceUrl: `https://github.com/openclaw/skills/tree/${commit}/skills/html`,
      },
      provenance: {
        source: "skills.sh",
        reference: sourceRef,
        repository: "openclaw/skills",
        path: "skills/html",
        sourceUrl: `https://github.com/openclaw/skills/tree/${commit}/skills/html`,
      },
      trust: {
        clawhubScan: "scanned",
        label: "Scanned by ClawHub",
      },
      canonicalRef: "@openclaw/html",
    });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        [sourceRef]: {
          version: commit,
          installedAt: 123,
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
        },
      },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef,
      sourceKind: "skills-sh",
      sourceRepository: "patrick-erichsen/skills",
      sourcePath: "skills/html",
      clawhubScan: "unscanned",
      trustLabel: "Not scanned by ClawHub",
      artifactIdentity: githubArtifactIdentity(
        "patrick-erichsen/skills",
        "skills/html",
        commit,
        contentHash,
      ),
      installedVersion: commit,
      installedAt: 123,
      fingerprint: "hash",
    });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    hashSkillFilesMock.mockReturnValue({ fingerprint: "hash", files: installedFiles });

    await cmdUpdate(makeOpts(), sourceRef, {}, false);

    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/openclaw/skills/zip/${commit}`,
    });
    expect(extractGitHubZipPathToDir).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      expect.stringContaining("/.html.tmp-"),
      "skills/html",
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith(
      "/work/skills/html",
      expect.objectContaining({
        sourceRepository: "openclaw/skills",
        canonicalRef: "@openclaw/html",
        clawhubScan: "scanned",
        trustLabel: "Scanned by ClawHub",
      }),
    );
  });

  it("fails when directly updating a pinned skill", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        demo: { version: "0.1.0", installedAt: 123, pinned: true, pinReason: "hold" },
      },
    });

    await expect(cmdUpdate(makeOpts(), "demo", { force: true }, false)).rejects.toThrow(
      /is pinned/i,
    );

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockDownloadZip).not.toHaveBeenCalled();
  });

  it("skips pinned skills during update --all and reports them in the summary", async () => {
    mockApiRequest.mockResolvedValue({
      latestVersion: { version: "2.0.0" },
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        demo: { version: "0.1.0", installedAt: 123, pinned: true, pinReason: "hold" },
        other: { version: "1.0.0", installedAt: 456 },
      },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(readSkillOrigin).mockResolvedValue(null);
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdUpdate(makeOpts(), undefined, { all: true }, false);

    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    const [, args] = mockApiRequest.mock.calls[0] ?? [];
    expect(args?.path).toBe(`${ApiRoutes.skills}/${encodeURIComponent("other")}`);
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        demo: { version: "0.1.0", installedAt: 123, pinned: true, pinReason: "hold" },
        other: { version: "2.0.0", installedAt: expect.any(Number) },
      },
    });
    expect(mockLog).toHaveBeenCalledWith("Skipped 1 pinned skill: demo");
  });

  it("continues update --all when a source-backed resolver response blocks one skill", async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: false,
        slug: "stale-github",
        reason: "github_verification_pending",
        message: "stale-github changed upstream; waiting for ClawHub scan.",
        status: 423,
      })
      .mockResolvedValueOnce({
        latestVersion: { version: "2.0.0" },
        moderation: null,
      });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        "stale-github": { version: "a".repeat(40), installedAt: 123 },
        demo: { version: "1.0.0", installedAt: 456 },
      },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([]);

    await cmdUpdate(makeOpts(), undefined, { all: true }, false);

    expect(mockSpinner.fail).toHaveBeenCalledWith(
      "stale-github: stale-github changed upstream; waiting for ClawHub scan.",
    );
    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({ slug: "demo", version: "2.0.0" }),
    );
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        "stale-github": { version: "a".repeat(40), installedAt: 123 },
        demo: { version: "2.0.0", installedAt: expect.any(Number) },
      },
    });
    const [, resolverArgs] = mockApiRequest.mock.calls[1] ?? [];
    expect(resolverArgs).toEqual(
      expect.objectContaining({
        path: `${ApiRoutes.skills}/${encodeURIComponent("stale-github")}/install`,
        acceptedStatuses: [403, 409, 410, 423],
      }),
    );
  });

  it("passes force-install to source-backed update resolution", async () => {
    const commit = "d".repeat(40);
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "aiq-deploy",
        installKind: "github",
        github: {
          repo: "NVIDIA/skills",
          path: "skills/aiq-deploy",
          commit,
          contentHash: "hash-aiq-deploy",
          sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
        },
      });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { "aiq-deploy": { version: "a".repeat(40), installedAt: 123 } },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "aiq-deploy",
      installedVersion: "a".repeat(40),
      installedAt: 123,
      fingerprint: "hash",
    });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);

    await cmdUpdate(makeOpts(), "aiq-deploy", { forceInstall: true }, false);

    const [, resolverArgs] = mockApiRequest.mock.calls[1] ?? [];
    expect(resolverArgs).toEqual(
      expect.objectContaining({
        path: `${ApiRoutes.skills}/${encodeURIComponent("aiq-deploy")}/install?forceInstall=1`,
      }),
    );
  });

  it("uses path-based skill lookup when no local fingerprint is available", async () => {
    mockApiRequest.mockResolvedValue({ latestVersion: { version: "1.0.0" } });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "0.1.0", installedAt: 123 } },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(readSkillOrigin).mockResolvedValue(null);
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdUpdate(makeOpts(), "demo", {}, false);

    const [, args] = mockApiRequest.mock.calls[0] ?? [];
    expect(args?.path).toBe(`${ApiRoutes.skills}/${encodeURIComponent("demo")}`);
    expect(args?.url).toBeUndefined();
  });

  it("uses stored owner handle when updating an owner-qualified install", async () => {
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "2.0.0" },
      owner: { handle: "openclaw" },
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123, ownerHandle: "openclaw" } },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(readSkillOrigin).mockResolvedValue(null);
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdUpdate(makeOpts(), undefined, { all: true }, false);

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    expect(requestArgs?.url).toContain("/api/v1/skills/demo?");
    expect(new URL(String(requestArgs?.url)).searchParams.get("ownerHandle")).toBe("openclaw");
    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({ slug: "demo", version: "2.0.0", ownerHandle: "openclaw" }),
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith(
      "/work/skills/demo",
      expect.objectContaining({ slug: "demo", ownerHandle: "openclaw" }),
    );
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        demo: { version: "2.0.0", installedAt: expect.any(Number), ownerHandle: "openclaw" },
      },
    });
  });

  it("updates owner-qualified lock entries in their owner-scoped directory", async () => {
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "2.0.0" },
      owner: { handle: "alice" },
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        "@alice/demo": { version: "1.0.0", installedAt: 123, ownerHandle: "alice" },
      },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(readSkillOrigin).mockResolvedValue(null);
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([]);
    vi.mocked(stat).mockRejectedValue(new Error("missing"));

    await cmdUpdate(makeOpts(), undefined, { all: true }, false);

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    expect(new URL(String(requestArgs?.url)).searchParams.get("ownerHandle")).toBe("alice");
    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({ slug: "demo", ownerHandle: "alice", version: "2.0.0" }),
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith(
      "/work/skills/@alice/demo",
      expect.objectContaining({ slug: "demo", ownerHandle: "alice" }),
    );
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        "@alice/demo": {
          version: "2.0.0",
          installedAt: expect.any(Number),
          ownerHandle: "alice",
        },
      },
    });
  });

  it("preserves the owner handle across sequential GitHub-backed updates", async () => {
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    const lock = {
      version: 1,
      skills: { demo: { version: "0".repeat(40), installedAt: 123, ownerHandle: "openclaw" } },
    } as const;
    let origin: Awaited<ReturnType<typeof readSkillOrigin>> = {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "demo",
      ownerHandle: "openclaw",
      installedVersion: "0".repeat(40),
      installedAt: 123,
    };

    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: null,
        owner: { handle: "openclaw" },
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "demo",
        installKind: "github",
        github: {
          repo: "owner/repo",
          path: "skills/demo",
          commit: firstCommit,
          contentHash: "first",
          sourceUrl: `https://github.com/owner/repo/tree/${firstCommit}/skills/demo`,
        },
      })
      .mockResolvedValueOnce({
        latestVersion: null,
        owner: { handle: "openclaw" },
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "demo",
        installKind: "github",
        github: {
          repo: "owner/repo",
          path: "skills/demo",
          commit: secondCommit,
          contentHash: "second",
          sourceUrl: `https://github.com/owner/repo/tree/${secondCommit}/skills/demo`,
        },
      });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockImplementation(async () => lock);
    vi.mocked(readSkillOrigin).mockImplementation(async () => origin);
    vi.mocked(writeSkillOrigin).mockImplementation(async (_target, nextOrigin) => {
      origin = nextOrigin;
    });
    vi.mocked(extractGitHubZipPathToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([]);
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);

    await cmdUpdate(makeOpts(), "demo", {}, false);
    await cmdUpdate(makeOpts(), "demo", {}, false);

    const metadataRequests = mockApiRequest.mock.calls.filter(([, args]) => {
      const request = args as { url?: string };
      return request.url?.includes("/api/v1/skills/demo?");
    });
    expect(metadataRequests).toHaveLength(2);
    for (const [, args] of metadataRequests) {
      expect(new URL((args as { url: string }).url).searchParams.get("ownerHandle")).toBe(
        "openclaw",
      );
    }
    expect(writeSkillOrigin).toHaveBeenLastCalledWith(
      "/work/skills/demo",
      expect.objectContaining({ ownerHandle: "openclaw" }),
    );
    expect(writeLockfile).toHaveBeenLastCalledWith("/work", {
      version: 1,
      skills: {
        demo: {
          version: secondCommit,
          installedAt: 123,
          ownerHandle: "openclaw",
        },
      },
    });
  });

  it("does not overwrite GitHub-backed local files when the origin fingerprint is missing", async () => {
    const commit = "b".repeat(40);
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "aiq-deploy",
        installKind: "github",
        github: {
          repo: "NVIDIA/skills",
          path: "skills/aiq-deploy",
          commit,
          contentHash: "hash-aiq-deploy",
          sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
        },
      });
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { "aiq-deploy": { version: "a".repeat(40), installedAt: 123 } },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "aiq-deploy",
      installedVersion: "a".repeat(40),
      installedAt: 123,
    });
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "local-fingerprint", files: [] });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);

    await cmdUpdate(makeOpts(), "aiq-deploy", {}, false);

    expect(mockLog).toHaveBeenCalledWith(
      "aiq-deploy: local changes (no match). Use --force to overwrite.",
    );
    expect(rm).not.toHaveBeenCalled();
    expect(mockFetchBinary).not.toHaveBeenCalled();
    expect(extractGitHubZipPathToDir).not.toHaveBeenCalled();
  });

  it("reinstalls GitHub-backed skills when only the lockfile remains", async () => {
    const commit = "c".repeat(40);
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "aiq-deploy",
        installKind: "github",
        github: {
          repo: "NVIDIA/skills",
          path: "skills/aiq-deploy",
          commit,
          contentHash: "hash-aiq-deploy",
          sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
        },
      });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { "aiq-deploy": { version: commit, installedAt: 123 } },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue(null);
    vi.mocked(listSkillFiles).mockResolvedValueOnce([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "clean-fingerprint", files: [] });
    vi.mocked(stat).mockRejectedValue(new Error("missing"));

    await cmdUpdate(makeOpts(), "aiq-deploy", {}, false);

    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/NVIDIA/skills/zip/${commit}`,
    });
    expect(extractGitHubZipPathToDir).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "/work/skills/aiq-deploy",
      "skills/aiq-deploy",
    );
    expect(mockSpinner.succeed).toHaveBeenCalledWith(
      `aiq-deploy: updated -> ${commit.slice(0, 12)}`,
    );
  });

  it("overwrites confirmed GitHub-backed local changes even when already at latest commit", async () => {
    const commit = "b".repeat(40);
    mockIsInteractive.mockReturnValue(true);
    mockPromptConfirm.mockResolvedValue(true);
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "aiq-deploy",
        installKind: "github",
        github: {
          repo: "NVIDIA/skills",
          path: "skills/aiq-deploy",
          commit,
          contentHash: "hash-aiq-deploy",
          sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
        },
      });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { "aiq-deploy": { version: commit, installedAt: 123 } },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "aiq-deploy",
      installedVersion: commit,
      installedAt: 123,
      fingerprint: "clean-fingerprint",
    });
    vi.mocked(listSkillFiles)
      .mockResolvedValueOnce([{ relPath: "SKILL.md", bytes: new Uint8Array([9]) }])
      .mockResolvedValueOnce([{ relPath: "SKILL.md", bytes: new Uint8Array([1]) }]);
    vi.mocked(hashSkillFiles)
      .mockReturnValueOnce({ fingerprint: "dirty-fingerprint", files: [] })
      .mockReturnValueOnce({ fingerprint: "clean-fingerprint", files: [] });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);

    await cmdUpdate(makeOpts(), "aiq-deploy", {}, true);

    expect(mockPromptConfirm).toHaveBeenCalledWith(
      `aiq-deploy: local changes (no match). Overwrite with ${commit.slice(0, 12)}?`,
    );
    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/NVIDIA/skills/zip/${commit}`,
    });
    expect(extractGitHubZipPathToDir).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "/work/skills/.aiq-deploy.tmp-123",
      "skills/aiq-deploy",
    );
    expect(rename).toHaveBeenNthCalledWith(
      1,
      "/work/skills/aiq-deploy",
      expect.stringMatching(/^\/work\/skills\/\.aiq-deploy\.backup-/),
    );
    expect(rename).toHaveBeenNthCalledWith(
      2,
      "/work/skills/.aiq-deploy.tmp-123",
      "/work/skills/aiq-deploy",
    );
    expect(rm).toHaveBeenCalledWith(
      expect.stringMatching(/^\/work\/skills\/\.aiq-deploy\.backup-/),
      {
        recursive: true,
        force: true,
      },
    );
    expect(mockSpinner.succeed).toHaveBeenCalledWith(
      `aiq-deploy: updated -> ${commit.slice(0, 12)}`,
    );
  });

  it("trusts the stored install fingerprint when the resolve endpoint cannot match", async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: { version: "2.0.0" },
        moderation: null,
      })
      .mockResolvedValueOnce({
        match: null,
        latestVersion: { version: "2.0.0" },
      });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "demo",
      installedVersion: "1.0.0",
      installedAt: 123,
      fingerprint: "hash",
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);
    vi.mocked(rm).mockResolvedValue();

    await cmdUpdate(makeOpts(), "demo", {}, false);

    expect(mockLog).not.toHaveBeenCalledWith(
      "demo: local changes (no match). Use --force to overwrite.",
    );
    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({ slug: "demo", version: "2.0.0" }),
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith("/work/skills/demo", {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "demo",
      installedVersion: "2.0.0",
      installedAt: 123,
      fingerprint: "hash",
    });
  });

  it("treats an installed bundle fingerprint that includes skill-card.md as synced", async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: { version: "1.0.0" },
        moderation: null,
      })
      .mockResolvedValueOnce({
        match: { version: "1.0.0" },
        latestVersion: { version: "1.0.0" },
      });
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue(null);
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
      { relPath: "skill-card.md", bytes: new Uint8Array([2]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "bundle-fingerprint", files: [] });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);

    await cmdUpdate(makeOpts(), "demo", {}, false);

    const [, resolveArgs] = mockApiRequest.mock.calls[1] ?? [];
    const url = new URL(String(resolveArgs?.url));
    expect(url.pathname).toBe(ApiRoutes.resolve);
    expect(url.searchParams.get("slug")).toBe("demo");
    expect(url.searchParams.get("hash")).toBe("bundle-fingerprint");
    expect(mockDownloadZip).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(mockSpinner.succeed).toHaveBeenCalledWith("demo up to date v1.0.0");
  });

  it("backfills resolved owner metadata when the installed version is unchanged", async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: { version: "1.0.0" },
        owner: { handle: "openclaw" },
        moderation: null,
      })
      .mockResolvedValueOnce({
        match: { version: "1.0.0" },
        latestVersion: { version: "1.0.0" },
      });
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "demo",
      installedVersion: "1.0.0",
      installedAt: 123,
      fingerprint: "hash",
    });
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);

    await cmdUpdate(makeOpts(), "demo", {}, false);

    const [, resolveArgs] = mockApiRequest.mock.calls[1] ?? [];
    expect(new URL(String(resolveArgs?.url)).searchParams.get("ownerHandle")).toBe("openclaw");
    expect(mockDownloadZip).not.toHaveBeenCalled();
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        demo: { version: "1.0.0", installedAt: 123, ownerHandle: "openclaw" },
      },
    });
  });

  it("writes identical installedAt to origin and lockfile on update", async () => {
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "2.0.0" },
      owner: null,
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        demo: { version: "1.0.0", installedAt: 100 },
      },
    });
    vi.mocked(readSkillOrigin).mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "demo",
      installedVersion: "1.0.0",
      installedAt: 100,
      fingerprint: "hash",
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);
    vi.mocked(rm).mockResolvedValue();

    await cmdUpdate(makeOpts(), "demo", {}, false);

    const originInstalledAt = vi.mocked(writeSkillOrigin).mock.calls[0]?.[1]?.installedAt;
    const lockfileInstalledAt =
      vi.mocked(writeLockfile).mock.calls[0]?.[1]?.skills?.demo?.installedAt;
    expect(originInstalledAt).toBeDefined();
    expect(lockfileInstalledAt).toBeDefined();
    expect(originInstalledAt).toBe(lockfileInstalledAt);
  });

  it("keeps the installed directory when an update download fails", async () => {
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);
    mockApiRequest.mockResolvedValue({
      latestVersion: { version: "2.0.0" },
      moderation: null,
    });
    mockDownloadZip.mockRejectedValue(new Error("network down"));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(listSkillFiles).mockResolvedValue([]);

    await expect(cmdUpdate(makeOpts(), "demo", {}, false)).rejects.toThrow("network down");

    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/work/skills/.demo.tmp-123", {
      recursive: true,
      force: true,
    });
    expect(rm).not.toHaveBeenCalledWith("/work/skills/demo", {
      recursive: true,
      force: true,
    });
    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("persists successful --all updates before a later skill fails", async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        latestVersion: { version: "2.0.0" },
        moderation: null,
      })
      .mockRejectedValueOnce(new Error("registry down"));
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        first: { version: "1.0.0", installedAt: 111 },
        second: { version: "1.0.0", installedAt: 222 },
      },
    });
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([]);

    await expect(cmdUpdate(makeOpts(), undefined, { all: true }, false)).rejects.toThrow(
      "registry down",
    );

    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        first: { version: "2.0.0", installedAt: expect.any(Number) },
        second: { version: "1.0.0", installedAt: 222 },
      },
    });
    const writeOrder = vi.mocked(writeLockfile).mock.invocationCallOrder[0];
    const secondRequestOrder = mockApiRequest.mock.invocationCallOrder[1];
    expect(writeOrder).toBeLessThan(secondRequestOrder);
  });
});

describe("pin commands", () => {
  it("pins an installed skill and preserves its version metadata", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(writeLockfile).mockResolvedValue();

    await cmdPin(makeOpts(), "demo", { reason: "scanner hold" });

    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        demo: {
          version: "1.0.0",
          installedAt: 123,
          pinned: true,
          pinReason: "scanner hold",
        },
      },
    });
    expect(mockLog).toHaveBeenCalledWith("Pinned demo: scanner hold");
  });

  it("reports when an installed skill is already pinned without changes", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        demo: { version: "1.0.0", installedAt: 123, pinned: true, pinReason: "scanner hold" },
      },
    });

    await cmdPin(makeOpts(), "demo");

    expect(writeLockfile).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('Skill "demo" is already pinned: scanner hold');
  });

  it("unpinned skills clear pin metadata and keep install ownership", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        demo: {
          version: "1.0.0",
          installedAt: 123,
          ownerHandle: "openclaw",
          pinned: true,
          pinReason: "scanner hold",
        },
      },
    });
    vi.mocked(writeLockfile).mockResolvedValue();

    await cmdUnpin(makeOpts(), "demo");

    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        demo: {
          version: "1.0.0",
          installedAt: 123,
          ownerHandle: "openclaw",
        },
      },
    });
    expect(mockLog).toHaveBeenCalledWith("Unpinned demo");
  });

  it("unpin preserves skills.sh provenance and trust state", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        [sourceRef]: {
          version: "a".repeat(40),
          installedAt: 123,
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: "https://github.com/patrick-erichsen/skills/tree/abc/skills/html",
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
          pinned: true,
          pinReason: "hold",
        },
      },
    });

    await cmdUnpin(makeOpts(), sourceRef);

    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        [sourceRef]: {
          version: "a".repeat(40),
          installedAt: 123,
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: "https://github.com/patrick-erichsen/skills/tree/abc/skills/html",
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
        },
      },
    });
  });
});

describe("cmdList", () => {
  it("does not report a tracked skills.sh install as a manual skill", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        [sourceRef]: {
          version: "a".repeat(40),
          installedAt: 123,
          sourceRef,
          sourceKind: "skills-sh",
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
        },
      },
    });
    await cmdList(makeOpts());

    expect(skillStore.listManualSkills).toHaveBeenCalledWith("/work/skills", new Set(["html"]));
    expect(mockLog).toHaveBeenCalledWith(`${sourceRef}  ${"a".repeat(40)}  Not scanned by ClawHub`);
  });

  it("shows pinned state in list output", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        demo: { version: "1.0.0", installedAt: 123, pinned: true, pinReason: "scanner hold" },
        other: { version: "2.0.0", installedAt: 456 },
      },
    });

    await cmdList(makeOpts());

    expect(mockLog).toHaveBeenCalledWith("demo  1.0.0  pinned (scanner hold)");
    expect(mockLog).toHaveBeenCalledWith("other  2.0.0");
  });
});

describe("cmdInstall", () => {
  it("installs a skills.sh catalog ref from the exact synchronized GitHub resolver", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    const commit = "a".repeat(40);
    const installedFiles = [{ path: "SKILL.md", sha256: "b".repeat(64), size: 1 }];
    const contentHash = skillStore.buildGitHubFolderContentHash(installedFiles);
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest
      .mockResolvedValueOnce({
        ok: true,
        slug: sourceRef,
        installKind: "github",
        github: {
          repo: "patrick-erichsen/skills",
          path: "skills/html",
          commit,
          contentHash,
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
        },
        provenance: {
          source: "skills.sh",
          reference: sourceRef,
        },
        trust: {
          clawhubScan: "unscanned",
          label: "Not scanned by ClawHub",
        },
        canonicalRef: null,
      })
      .mockResolvedValueOnce({ ok: true });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    hashSkillFilesMock.mockReturnValue({ fingerprint: "hash", files: installedFiles });

    await cmdInstall(makeOpts(), sourceRef);

    expect(mockApiRequest).toHaveBeenNthCalledWith(
      1,
      "https://clawhub.ai",
      {
        method: "GET",
        path: `${ApiRoutes.skillsSh}/patrick-erichsen/skills/html/install`,
        token: "tkn",
      },
      expect.anything(),
    );
    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/patrick-erichsen/skills/zip/${commit}`,
    });
    expect(extractGitHubZipPathToDir).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "/work/skills/html",
      "skills/html",
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith("/work/skills/html", {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef,
      sourceKind: "skills-sh",
      sourceRepository: "patrick-erichsen/skills",
      sourcePath: "skills/html",
      sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
      clawhubScan: "unscanned",
      trustLabel: "Not scanned by ClawHub",
      artifactIdentity: githubArtifactIdentity(
        "patrick-erichsen/skills",
        "skills/html",
        commit,
        contentHash,
      ),
      installedVersion: commit,
      installedAt: expect.any(Number),
      fingerprint: "hash",
    });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        [sourceRef]: {
          version: commit,
          installedAt: expect.any(Number),
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
        },
      },
    });
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "https://clawhub.ai",
      expect.objectContaining({
        path: LegacyApiRoutes.cliTelemetryInstall,
        body: {
          event: "install",
          slug: "html",
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
          clawhubScan: "unscanned",
          trustLabel: "Not scanned by ClawHub",
          version: commit,
        },
      }),
      expect.anything(),
    );
    expect(mockSpinner.succeed).toHaveBeenCalledWith(
      expect.stringContaining("(Not scanned by ClawHub)"),
    );
  });

  it("resolves a scanned Hosted Mode alias through its canonical native archive", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest
      .mockResolvedValueOnce({
        ok: true,
        slug: "html",
        installKind: "archive",
        archive: {
          version: "2.0.0",
          downloadUrl: "https://clawhub.ai/api/v1/download?slug=html&version=2.0.0",
        },
        provenance: {
          source: "skills.sh",
          reference: sourceRef,
          repository: "patrick-erichsen/skills",
          path: "skills/html",
          sourceUrl: "https://skills.sh/patrick-erichsen/skills/html",
        },
        trust: {
          clawhubScan: "scanned",
          label: "Scanned by ClawHub",
        },
        canonicalRef: "@openclaw/html",
      })
      .mockResolvedValueOnce({ ok: true });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await cmdInstall(makeOpts(), sourceRef);

    expect(mockDownloadZip).toHaveBeenCalledWith("https://clawhub.ai", {
      slug: "html",
      ownerHandle: "openclaw",
      version: "2.0.0",
      token: "tkn",
    });
    expect(writeSkillOrigin).toHaveBeenCalledWith("/work/skills/html", {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef,
      sourceKind: "skills-sh",
      sourceRepository: "patrick-erichsen/skills",
      sourcePath: "skills/html",
      sourceUrl: "https://skills.sh/patrick-erichsen/skills/html",
      canonicalRef: "@openclaw/html",
      clawhubScan: "scanned",
      trustLabel: "Scanned by ClawHub",
      artifactIdentity: archiveArtifactIdentity("@openclaw/html", "2.0.0"),
      installedVersion: "2.0.0",
      installedAt: expect.any(Number),
      fingerprint: undefined,
    });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        [sourceRef]: {
          version: "2.0.0",
          installedAt: expect.any(Number),
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: "https://skills.sh/patrick-erichsen/skills/html",
          canonicalRef: "@openclaw/html",
          clawhubScan: "scanned",
          trustLabel: "Scanned by ClawHub",
        },
      },
    });
  });

  it("rejects a skills.sh resolver response that omits external trust metadata", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      slug: sourceRef,
      installKind: "github",
      github: {
        repo: "patrick-erichsen/skills",
        path: "skills/html",
        commit: "a".repeat(40),
        contentHash: "b".repeat(64),
        sourceUrl: "https://github.com/patrick-erichsen/skills/tree/main/skills/html",
      },
    });

    await expect(cmdInstall(makeOpts(), sourceRef)).rejects.toThrow(
      "skills.sh catalog resolver did not preserve the requested external provenance",
    );
    expect(mockFetchBinary).not.toHaveBeenCalled();
    expect(writeSkillOrigin).not.toHaveBeenCalled();
    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("installs a scanned Repo Sync alias from its canonical pinned GitHub descriptor", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    const commit = "a".repeat(40);
    const installedFiles = [{ path: "SKILL.md", sha256: "b".repeat(64), size: 1 }];
    const contentHash = skillStore.buildGitHubFolderContentHash(installedFiles);
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest
      .mockResolvedValueOnce({
        ok: true,
        slug: "html",
        installKind: "github",
        github: {
          repo: "patrick-erichsen/skills",
          path: "skills/html",
          commit,
          contentHash,
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
        },
        provenance: {
          source: "skills.sh",
          reference: sourceRef,
          repository: "patrick-erichsen/skills",
          path: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
        },
        trust: {
          clawhubScan: "scanned",
          label: "Scanned by ClawHub",
        },
        canonicalRef: "@openclaw/html",
      })
      .mockResolvedValueOnce({ ok: true });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    hashSkillFilesMock.mockReturnValue({ fingerprint: "hash", files: installedFiles });

    await cmdInstall(makeOpts(), sourceRef);

    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/patrick-erichsen/skills/zip/${commit}`,
    });
    expect(writeSkillOrigin).toHaveBeenCalledWith("/work/skills/html", {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef,
      sourceKind: "skills-sh",
      sourceRepository: "patrick-erichsen/skills",
      sourcePath: "skills/html",
      sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
      canonicalRef: "@openclaw/html",
      clawhubScan: "scanned",
      trustLabel: "Scanned by ClawHub",
      artifactIdentity: githubArtifactIdentity(
        "patrick-erichsen/skills",
        "skills/html",
        commit,
        contentHash,
      ),
      installedVersion: commit,
      installedAt: expect.any(Number),
      fingerprint: "hash",
    });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        [sourceRef]: {
          version: commit,
          installedAt: expect.any(Number),
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
          canonicalRef: "@openclaw/html",
          clawhubScan: "scanned",
          trustLabel: "Scanned by ClawHub",
        },
      },
    });
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "https://clawhub.ai",
      expect.objectContaining({
        path: LegacyApiRoutes.cliTelemetryInstall,
        body: {
          event: "install",
          slug: "html",
          sourceRef,
          sourceKind: "skills-sh",
          sourceRepository: "patrick-erichsen/skills",
          sourcePath: "skills/html",
          sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
          canonicalRef: "@openclaw/html",
          clawhubScan: "scanned",
          trustLabel: "Scanned by ClawHub",
          version: commit,
        },
      }),
      expect.anything(),
    );
  });

  it("rejects the legacy slash-form skills.sh reference before auth or network access", async () => {
    await expect(cmdInstall(makeOpts(), "skills-sh/patrick-erichsen/skills/html")).rejects.toThrow(
      "Invalid skills.sh ref: use skills-sh:owner/repo/slug",
    );
    expect(mockGetOptionalAuthToken).not.toHaveBeenCalled();
    expect(registryMocks.getRegistry).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it.each([
    "skills-sh:",
    "skills-sh:owner/repo",
    "skills-sh:owner/repo/slug/extra",
    "skills-sh:owner/../slug",
    "skills-sh:./repo/slug",
    "skills-sh:owner/./slug",
    "skills-sh:owner/repo/.",
    "skills-sh:owner/repo/slug?ref=main",
  ])("rejects invalid skills.sh reference %s before network access", async (sourceRef) => {
    await expect(cmdInstall(makeOpts(), sourceRef)).rejects.toThrow(
      "Invalid skills.sh ref: use skills-sh:owner/repo/slug",
    );
    expect(mockGetOptionalAuthToken).not.toHaveBeenCalled();
    expect(registryMocks.getRegistry).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("blocks a skills.sh install when the slug target belongs to another source", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    statMock.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
    readSkillOriginMock.mockResolvedValue({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "html",
      sourceRef: "skills-sh:other/repo/html",
      installedVersion: "a".repeat(40),
      installedAt: 1,
    });

    await expect(cmdInstall(makeOpts(), sourceRef, undefined, true)).rejects.toThrow(
      `Install target collision: /work/skills/html is owned by skills-sh:other/repo/html`,
    );
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("rejects a skills.sh install whose extracted folder hash differs from the resolver", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    const commit = "a".repeat(40);
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      slug: sourceRef,
      installKind: "github",
      github: {
        repo: "patrick-erichsen/skills",
        path: "skills/html",
        commit,
        contentHash: "b".repeat(64),
        sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
      },
      provenance: {
        source: "skills.sh",
        reference: sourceRef,
      },
      trust: {
        clawhubScan: "unscanned",
        label: "Not scanned by ClawHub",
      },
      canonicalRef: null,
    });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    listTextFilesMock.mockResolvedValue([{ relPath: "SKILL.md", bytes: new Uint8Array([1]) }]);
    hashSkillFilesMock.mockReturnValue({
      fingerprint: "local-fingerprint",
      files: [{ path: "SKILL.md", sha256: "c".repeat(64), size: 1 }],
    });

    await expect(cmdInstall(makeOpts(), sourceRef)).rejects.toThrow(
      "Downloaded skills.sh folder hash does not match the approved ClawHub resolver",
    );
    expect(writeSkillOrigin).not.toHaveBeenCalled();
    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("rejects a scanned Repo Sync alias whose pinned GitHub bytes differ from the resolver", async () => {
    const sourceRef = "skills-sh:patrick-erichsen/skills/html";
    const commit = "a".repeat(40);
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      slug: "html",
      installKind: "github",
      github: {
        repo: "patrick-erichsen/skills",
        path: "skills/html",
        commit,
        contentHash: "b".repeat(64),
        sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
      },
      provenance: {
        source: "skills.sh",
        reference: sourceRef,
        repository: "patrick-erichsen/skills",
        path: "skills/html",
        sourceUrl: `https://github.com/patrick-erichsen/skills/tree/${commit}/skills/html`,
      },
      trust: {
        clawhubScan: "scanned",
        label: "Scanned by ClawHub",
      },
      canonicalRef: "@openclaw/html",
    });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    listTextFilesMock.mockResolvedValue([{ relPath: "SKILL.md", bytes: new Uint8Array([1]) }]);
    hashSkillFilesMock.mockReturnValue({
      fingerprint: "local-fingerprint",
      files: [{ path: "SKILL.md", sha256: "c".repeat(64), size: 1 }],
    });

    await expect(cmdInstall(makeOpts(), sourceRef)).rejects.toThrow(
      "Downloaded skills.sh folder hash does not match the approved ClawHub resolver",
    );
    expect(writeSkillOrigin).not.toHaveBeenCalled();
    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("passes optional auth token to API + download requests", async () => {
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockImplementation(async (_registry, args) => {
      if (args.path === LegacyApiRoutes.cliTelemetryInstall) return { ok: true };
      return {
        skill: {
          slug: "demo",
          displayName: "Demo",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: { version: "1.0.0" },
        owner: null,
        moderation: null,
      };
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdInstall(makeOpts(), "demo");

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    expect(requestArgs?.token).toBe("tkn");
    const [, zipArgs] = mockDownloadZip.mock.calls[0] ?? [];
    expect(zipArgs?.token).toBe("tkn");
    expect(mockApiRequest).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({
        method: "POST",
        path: LegacyApiRoutes.cliTelemetryInstall,
        token: "tkn",
        body: {
          event: "install",
          slug: "demo",
          version: "1.0.0",
        },
      }),
      expect.anything(),
    );
  });

  it("does not fail installs when install telemetry fails", async () => {
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockImplementation(async (_registry, args) => {
      if (args.path === LegacyApiRoutes.cliTelemetryInstall) throw new Error("telemetry down");
      return {
        skill: {
          slug: "demo",
          displayName: "Demo",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: { version: "1.0.0" },
        owner: null,
        moderation: null,
      };
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(stat).mockRejectedValue(new Error("missing"));

    await expect(cmdInstall(makeOpts(), "demo")).resolves.toBeUndefined();

    expect(writeLockfile).toHaveBeenCalled();
  });

  it("installs source-backed skills from the GitHub resolver response", async () => {
    const commit = "a".repeat(40);
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest
      .mockResolvedValueOnce({
        skill: {
          slug: "aiq-deploy",
          displayName: "AIQ Deploy",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: null,
        owner: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "aiq-deploy",
        installKind: "github",
        github: {
          repo: "NVIDIA/skills",
          path: "skills/aiq-deploy",
          commit,
          contentHash: "hash-aiq-deploy",
          sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
        },
      });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractGitHubZipPathToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockRejectedValue(new Error("missing"));

    await cmdInstall(makeOpts(), "aiq-deploy");

    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "https://clawhub.ai",
      {
        method: "GET",
        path: `${ApiRoutes.skills}/${encodeURIComponent("aiq-deploy")}/install`,
        token: "tkn",
        acceptedStatuses: [403, 409, 410, 423],
      },
      expect.anything(),
    );
    expect(mockDownloadZip).not.toHaveBeenCalled();
    expect(mockFetchBinary).toHaveBeenCalledWith("https://clawhub.ai", {
      url: `https://codeload.github.com/NVIDIA/skills/zip/${commit}`,
    });
    expect(extractGitHubZipPathToDir).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "/work/skills/aiq-deploy",
      "skills/aiq-deploy",
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith("/work/skills/aiq-deploy", {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "aiq-deploy",
      installedVersion: commit,
      installedAt: expect.any(Number),
      fingerprint: "hash",
    });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        "aiq-deploy": { version: commit, installedAt: expect.any(Number) },
      },
    });
  });

  it("passes force-install to source-backed install resolution", async () => {
    const commit = "a".repeat(40);
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest
      .mockResolvedValueOnce({
        skill: {
          slug: "aiq-deploy",
          displayName: "AIQ Deploy",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: null,
        owner: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        slug: "aiq-deploy",
        installKind: "github",
        github: {
          repo: "NVIDIA/skills",
          path: "skills/aiq-deploy",
          commit,
          contentHash: "hash-aiq-deploy",
          sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
        },
      });
    mockFetchBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await cmdInstall(makeOpts(), "aiq-deploy", undefined, false, true);

    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "https://clawhub.ai",
      expect.objectContaining({
        method: "GET",
        path: `${ApiRoutes.skills}/${encodeURIComponent("aiq-deploy")}/install?forceInstall=1`,
        token: "tkn",
      }),
      expect.anything(),
    );
  });

  it("installs owner-qualified skill refs using owner-scoped API requests", async () => {
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "1.0.0" },
      owner: { handle: "openclaw" },
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdInstall(makeOpts(), "@openclaw/demo");

    const [, requestArgs] = mockApiRequest.mock.calls[0] ?? [];
    expect(requestArgs?.url).toContain("/api/v1/skills/demo?");
    expect(new URL(String(requestArgs?.url)).searchParams.get("ownerHandle")).toBe("openclaw");
    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({
        slug: "demo",
        version: "1.0.0",
        ownerHandle: "openclaw",
        token: "tkn",
      }),
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith(
      "/work/skills/@openclaw/demo",
      expect.objectContaining({
        slug: "demo",
        ownerHandle: "openclaw",
        installedVersion: "1.0.0",
      }),
    );
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {
        "@openclaw/demo": {
          version: "1.0.0",
          installedAt: expect.any(Number),
          ownerHandle: "openclaw",
        },
      },
    });
    expect(mockApiRequest).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({
        method: "POST",
        path: LegacyApiRoutes.cliTelemetryInstall,
        token: "tkn",
        body: {
          event: "install",
          slug: "demo",
          ownerHandle: "openclaw",
          version: "1.0.0",
        },
      }),
      expect.anything(),
    );
  });

  it("keeps same-slug installs from different owners isolated", async () => {
    const lock = {
      version: 1 as const,
      skills: {} as Record<string, { version: string; installedAt: number; ownerHandle?: string }>,
    };
    mockApiRequest.mockImplementation(async (_registry, args) => {
      const ownerHandle = args.url ? new URL(args.url).searchParams.get("ownerHandle") : null;
      return {
        skill: {
          slug: "demo",
          displayName: "Demo",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: { version: ownerHandle === "alice" ? "1.0.0" : "2.0.0" },
        owner: { handle: ownerHandle },
        moderation: null,
      };
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockImplementation(async () => lock);
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(stat).mockRejectedValue(new Error("missing"));

    await cmdInstall(makeOpts(), "@alice/demo");
    await cmdInstall(makeOpts(), "@bob/demo");

    expect(writeSkillOrigin).toHaveBeenNthCalledWith(
      1,
      "/work/skills/@alice/demo",
      expect.objectContaining({ ownerHandle: "alice", slug: "demo" }),
    );
    expect(writeSkillOrigin).toHaveBeenNthCalledWith(
      2,
      "/work/skills/@bob/demo",
      expect.objectContaining({ ownerHandle: "bob", slug: "demo" }),
    );
    expect(lock.skills).toEqual({
      "@alice/demo": { version: "1.0.0", installedAt: expect.any(Number), ownerHandle: "alice" },
      "@bob/demo": { version: "2.0.0", installedAt: expect.any(Number), ownerHandle: "bob" },
    });
  });

  it("keeps the requested owner namespace when installing through an owner alias", async () => {
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "1.0.0" },
      owner: { handle: "target" },
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdInstall(makeOpts(), "@source/old-demo");

    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({
        slug: "old-demo",
        ownerHandle: "source",
      }),
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith(
      "/work/skills/@source/old-demo",
      expect.objectContaining({ slug: "old-demo", ownerHandle: "source" }),
    );
    expect(mockApiRequest).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({
        method: "POST",
        path: LegacyApiRoutes.cliTelemetryInstall,
        token: "tkn",
        body: {
          event: "install",
          slug: "demo",
          ownerHandle: "target",
          version: "1.0.0",
        },
      }),
      expect.anything(),
    );
  });

  it("uses the resolved slug when an unqualified alias resolves to an owner-scoped skill", async () => {
    mockGetOptionalAuthToken.mockResolvedValue("tkn");
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "1.0.0" },
      owner: { handle: "target" },
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdInstall(makeOpts(), "old-demo");

    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({
        slug: "demo",
        ownerHandle: "target",
      }),
    );
    expect(writeSkillOrigin).toHaveBeenCalledWith(
      "/work/skills/old-demo",
      expect.objectContaining({ slug: "demo", ownerHandle: "target" }),
    );
  });

  it("blocks force reinstall when a skill is pinned", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "0.9.0", installedAt: 123, pinned: true, pinReason: "hold" } },
    });
    vi.mocked(stat).mockRejectedValue(new Error("missing"));

    await expect(cmdInstall(makeOpts(), "demo", undefined, true)).rejects.toThrow(/is pinned/i);

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockDownloadZip).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("does not rm local directory when skill is malware-blocked (--force)", async () => {
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>); // target exists
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "1.0.0" },
      owner: null,
      moderation: { isMalwareBlocked: true, isSuspicious: false },
    });

    await expect(cmdInstall(makeOpts(), "demo", undefined, true)).rejects.toThrow(/malware/i);

    expect(rm).not.toHaveBeenCalled();
  });

  it("does not rm local directory when API fetch fails (--force)", async () => {
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>); // target exists
    mockApiRequest.mockRejectedValue(new Error("Skill not found"));

    await expect(cmdInstall(makeOpts(), "demo", undefined, true)).rejects.toThrow(/not found/i);

    expect(rm).not.toHaveBeenCalled();
  });

  it("keeps the installed directory when force reinstall download fails", async () => {
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>);
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "1.0.0" },
      owner: null,
      moderation: null,
    });
    mockDownloadZip.mockRejectedValue(new Error("network down"));
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "0.9.0", installedAt: 123 } },
    });

    await expect(cmdInstall(makeOpts(), "demo", undefined, true)).rejects.toThrow("network down");

    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/work/skills/.demo.tmp-123", {
      recursive: true,
      force: true,
    });
    expect(rm).not.toHaveBeenCalledWith("/work/skills/demo", {
      recursive: true,
      force: true,
    });
    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("does not rm local directory when requested version lookup fails (--force)", async () => {
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>); // target exists
    mockApiRequest
      .mockResolvedValueOnce({
        skill: {
          slug: "demo",
          displayName: "Demo",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: { version: "1.0.0" },
        owner: null,
        moderation: null,
      })
      .mockRejectedValueOnce(new Error("Version not found"));

    await expect(cmdInstall(makeOpts(), "demo", "9.9.9", true)).rejects.toThrow(
      /version not found/i,
    );

    expect(rm).not.toHaveBeenCalled();
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "https://clawhub.ai",
      expect.objectContaining({
        path: `${ApiRoutes.skills}/${encodeURIComponent("demo")}/versions/${encodeURIComponent("9.9.9")}`,
      }),
      expect.anything(),
    );
  });

  it("validates requested version before rm when all checks pass (--force)", async () => {
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>); // target exists
    mockApiRequest
      .mockResolvedValueOnce({
        skill: {
          slug: "demo",
          displayName: "Demo",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: { version: "1.0.0" },
        owner: null,
        moderation: null,
      })
      .mockResolvedValueOnce({
        version: {
          version: "9.9.9",
          createdAt: 0,
          changelog: "",
          changelogSource: null,
          license: null,
          files: [],
        },
        skill: { slug: "demo", displayName: "Demo" },
      });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();

    await cmdInstall(makeOpts(), "demo", "9.9.9", true);

    expect(mockDownloadZip).toHaveBeenCalledWith(
      "https://clawhub.ai",
      expect.objectContaining({ slug: "demo", version: "9.9.9" }),
    );
    expect(extractZipToDir).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "/work/skills/.demo.tmp-123",
    );
    const versionLookupOrder = mockApiRequest.mock.invocationCallOrder[1];
    const downloadOrder = mockDownloadZip.mock.invocationCallOrder[0];
    const firstRenameOrder = vi.mocked(rename).mock.invocationCallOrder[0];
    expect(versionLookupOrder).toBeLessThan(downloadOrder);
    expect(downloadOrder).toBeLessThan(firstRenameOrder);
  });

  it("stages replacement before swapping an existing install (--force)", async () => {
    vi.mocked(stat).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof stat>>); // target exists
    mockApiRequest.mockResolvedValue({
      skill: {
        slug: "demo",
        displayName: "Demo",
        summary: null,
        tags: {},
        stats: {},
        createdAt: 0,
        updatedAt: 0,
      },
      latestVersion: { version: "1.0.0" },
      owner: null,
      moderation: null,
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();

    await cmdInstall(makeOpts(), "demo", undefined, true);

    expect(mockDownloadZip).toHaveBeenCalled();
    expect(extractZipToDir).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "/work/skills/.demo.tmp-123",
    );
    expect(rename).toHaveBeenNthCalledWith(
      1,
      "/work/skills/demo",
      expect.stringMatching(/^\/work\/skills\/\.demo\.backup-/),
    );
    expect(rename).toHaveBeenNthCalledWith(2, "/work/skills/.demo.tmp-123", "/work/skills/demo");
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/^\/work\/skills\/\.demo\.backup-/), {
      recursive: true,
      force: true,
    });
    const downloadOrder = mockDownloadZip.mock.invocationCallOrder[0];
    const firstRenameOrder = vi.mocked(rename).mock.invocationCallOrder[0];
    expect(downloadOrder).toBeLessThan(firstRenameOrder);
  });

  it("writes identical installedAt to origin and lockfile on install", async () => {
    mockApiRequest.mockImplementation(async (_registry, args) => {
      if (args.path === LegacyApiRoutes.cliTelemetryInstall) return { ok: true };
      return {
        skill: {
          slug: "demo",
          displayName: "Demo",
          summary: null,
          tags: {},
          stats: {},
          createdAt: 0,
          updatedAt: 0,
        },
        latestVersion: { version: "1.0.0" },
        owner: null,
        moderation: null,
      };
    });
    mockDownloadZip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(writeSkillOrigin).mockResolvedValue();
    vi.mocked(extractZipToDir).mockResolvedValue();
    vi.mocked(listSkillFiles).mockResolvedValue([
      { relPath: "SKILL.md", bytes: new Uint8Array([1]) },
    ]);
    vi.mocked(hashSkillFiles).mockReturnValue({ fingerprint: "hash", files: [] });
    vi.mocked(stat).mockRejectedValue(new Error("missing"));
    vi.mocked(rm).mockResolvedValue();

    await cmdInstall(makeOpts(), "demo");

    const originInstalledAt = vi.mocked(writeSkillOrigin).mock.calls[0]?.[1]?.installedAt;
    const lockfileInstalledAt =
      vi.mocked(writeLockfile).mock.calls[0]?.[1]?.skills?.demo?.installedAt;
    expect(originInstalledAt).toBeDefined();
    expect(lockfileInstalledAt).toBeDefined();
    expect(originInstalledAt).toBe(lockfileInstalledAt);
  });
});

describe("cmdUninstall", () => {
  it("requires --yes when input is disabled", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });

    await expect(cmdUninstall(makeOpts(), "demo", {}, false)).rejects.toThrow(/--yes/i);
  });

  it("prompts when interactive and proceeds on confirm", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();
    mockIsInteractive.mockReturnValue(true);
    mockPromptConfirm.mockResolvedValue(true);

    await cmdUninstall(makeOpts(), "demo", {}, true);

    expect(mockPromptConfirm).toHaveBeenCalledWith("Uninstall demo?");
    expect(rm).toHaveBeenCalledWith("/work/skills/demo", { recursive: true, force: true });
    expect(writeLockfile).toHaveBeenCalled();
  });

  it("prints Cancelled and does not remove when prompt declines", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    mockIsInteractive.mockReturnValue(true);
    mockPromptConfirm.mockResolvedValue(false);

    await cmdUninstall(makeOpts(), "demo", {}, true);

    expect(mockLog).toHaveBeenCalledWith("Cancelled.");
    expect(rm).not.toHaveBeenCalled();
    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("rejects unsafe slugs", async () => {
    await expect(cmdUninstall(makeOpts(), "../evil", { yes: true }, false)).rejects.toThrow(
      /invalid slug/i,
    );
    await expect(cmdUninstall(makeOpts(), "demo/..", { yes: true }, false)).rejects.toThrow(
      /invalid slug/i,
    );
  });

  it("fails when skill is not installed", async () => {
    vi.mocked(readLockfile).mockResolvedValue({ version: 1, skills: {} });

    await expect(cmdUninstall(makeOpts(), "missing", {}, false)).rejects.toThrow(
      "Not installed: missing",
    );
  });

  it("removes skill directory and lockfile entry with --yes flag", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();

    await cmdUninstall(makeOpts(), "demo", { yes: true }, false);

    expect(rm).toHaveBeenCalledWith("/work/skills/demo", { recursive: true, force: true });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: {},
    });
    expect(mockSpinner.succeed).toHaveBeenCalledWith("Uninstalled demo");
  });

  it("does not update lockfile if remove fails", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(rm).mockRejectedValue(new Error("nope"));

    await expect(cmdUninstall(makeOpts(), "demo", { yes: true }, false)).rejects.toThrow("nope");

    expect(writeLockfile).not.toHaveBeenCalled();
  });

  it("updates lockfile after removing directory", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();

    await cmdUninstall(makeOpts(), "demo", { yes: true }, false);

    const rmCallMock = vi.mocked(rm);
    const writeLockfileCallMock = vi.mocked(writeLockfile);
    expect(rmCallMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeLockfileCallMock.mock.invocationCallOrder[0],
    );
  });

  it("removes skill and updates lockfile keeping other skills", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: {
        demo: { version: "1.0.0", installedAt: 123 },
        other: { version: "2.0.0", installedAt: 456 },
      },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();

    await cmdUninstall(makeOpts(), "demo", { yes: true }, false);

    expect(rm).toHaveBeenCalledWith("/work/skills/demo", { recursive: true, force: true });
    expect(writeLockfile).toHaveBeenCalledWith("/work", {
      version: 1,
      skills: { other: { version: "2.0.0", installedAt: 456 } },
    });
  });

  it("trims slug whitespace", async () => {
    vi.mocked(readLockfile).mockResolvedValue({
      version: 1,
      skills: { demo: { version: "1.0.0", installedAt: 123 } },
    });
    vi.mocked(writeLockfile).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();

    await cmdUninstall(makeOpts(), "  demo  ", { yes: true }, false);

    expect(rm).toHaveBeenCalledWith("/work/skills/demo", { recursive: true, force: true });
  });
});
