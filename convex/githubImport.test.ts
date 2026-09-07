/* @vitest-environment node */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { __test } from "./githubImport";
import { buildGitHubZipForTests } from "./lib/githubImport";
import { publishVersionForUser } from "./lib/skillPublish";

vi.mock("./_generated/api", () => ({
  internal: {
    githubIdentity: {
      getGitHubProviderAccountIdInternal: Symbol("getGitHubProviderAccountIdInternal"),
    },
    skills: {
      getSkillBySlugInternal: Symbol("getSkillBySlugInternal"),
    },
    publishers: {
      resolvePublishTargetForUserInternal: Symbol("resolvePublishTargetForUserInternal"),
    },
  },
}));

vi.mock("./lib/skillPublish", () => ({
  publishVersionForUser: vi.fn(),
}));

const IMPORT_COMMIT = "a".repeat(40);
const IMPORT_OWNER = "vyctorbrzezowski";
const IMPORT_REPO = "public-skill";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function buildOwnedImportZip(
  entries: Record<string, string> = {
    [`${IMPORT_REPO}/SKILL.md`]: "# Demo skill\n",
    [`${IMPORT_REPO}/notes.md`]: "notes\n",
  },
) {
  return buildGitHubZipForTests(entries);
}

function makeOwnedImportFetch(zip: Uint8Array) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url === `https://api.github.com/user/123`) {
      return {
        ok: true,
        json: async () => ({
          id: 123,
          login: IMPORT_OWNER,
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
        }),
      };
    }
    if (url === `https://api.github.com/repos/${IMPORT_OWNER}/${IMPORT_REPO}`) {
      return {
        ok: true,
        json: async () => ({
          name: IMPORT_REPO,
          full_name: `${IMPORT_OWNER}/${IMPORT_REPO}`,
          private: false,
          visibility: "public",
          owner: { id: 123, login: IMPORT_OWNER },
          archived: false,
          disabled: false,
          fork: false,
        }),
      };
    }
    if (url === `https://api.github.com/repos/${IMPORT_OWNER}/${IMPORT_REPO}/commits/main`) {
      return {
        ok: true,
        json: async () => ({ sha: IMPORT_COMMIT }),
      };
    }
    if (url === `https://codeload.github.com/${IMPORT_OWNER}/${IMPORT_REPO}/zip/${IMPORT_COMMIT}`) {
      return {
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function makeImportCtx(overrides?: {
  store?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}) {
  let nextStorageId = 1;
  const store = overrides?.store ?? vi.fn(async () => `storage:${nextStorageId++}` as const);
  const del = overrides?.delete ?? vi.fn(async () => undefined);
  return {
    runQuery: vi.fn().mockResolvedValue("123"),
    runMutation: vi.fn().mockResolvedValue({ publisherId: "publishers:1" }),
    storage: {
      store,
      delete: del,
    },
  };
}

function makeImportArgs(overrides: Record<string, unknown> = {}) {
  return {
    url: `https://github.com/${IMPORT_OWNER}/${IMPORT_REPO}/tree/main`,
    commit: IMPORT_COMMIT,
    candidatePath: "",
    selectedPaths: ["SKILL.md", "notes.md"],
    slug: "public-skill",
    ownerHandle: IMPORT_OWNER,
    displayName: "Public Skill",
    version: "1.0.0",
    tags: ["latest"],
    acceptLicenseTerms: true,
    ...overrides,
  };
}

const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalGitHubAppEnv = {
  appId: process.env.GITHUB_APP_ID,
  installationId: process.env.GITHUB_APP_INSTALLATION_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
};

describe("githubImport", () => {
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  afterEach(() => {
    vi.mocked(publishVersionForUser).mockReset();
    if (originalGitHubToken) {
      process.env.GITHUB_TOKEN = originalGitHubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    for (const [key, value] of [
      ["GITHUB_APP_ID", originalGitHubAppEnv.appId],
      ["GITHUB_APP_INSTALLATION_ID", originalGitHubAppEnv.installationId],
      ["GITHUB_APP_PRIVATE_KEY", originalGitHubAppEnv.privateKey],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("formats storage failure message with file context", () => {
    const message = __test.buildStoreFailureMessage("skill/SKILL.md", 123, new Error("disk full"));
    expect(message).toBe('Failed to store file "skill/SKILL.md" (123 bytes). disk full');
  });

  it("formats publish failure message with fallback text", () => {
    expect(__test.buildPublishFailureMessage(new Error("slug exists"))).toBe(
      "Import failed during publish: slug exists. Check skill format, slug availability, and try again.",
    );
    expect(
      __test.buildPublishFailureMessage(
        new Error(
          'Uncaught ConvexError: Publisher handle "@local-owner" is already claimed at ensurePersonalPublisherForUser (../../convex/lib/publishers.ts:235:4)',
        ),
      ),
    ).toBe(
      'Import failed during publish: Publisher handle "@local-owner" is already claimed. Check skill format, slug availability, and try again.',
    );
    expect(__test.buildPublishFailureMessage("unexpected")).toBe(
      "Import failed during publish: unexpected. Check skill format, slug availability, and try again.",
    );
  });

  it("filters mac junk files while unzipping archive entries", () => {
    const zip = buildGitHubZipForTests({
      "demo-repo/skill/SKILL.md": "# Demo",
      "demo-repo/skill/notes.md": "notes",
      "demo-repo/skill/.DS_Store": "junk",
      "demo-repo/skill/._notes.md": "junk",
      "demo-repo/__MACOSX/._SKILL.md": "junk",
    });

    const entries = __test.unzipToEntries(zip);
    expect(Object.keys(entries).sort()).toEqual([
      "demo-repo/skill/SKILL.md",
      "demo-repo/skill/notes.md",
    ]);
  });

  it("rejects a public repo owned by another GitHub account before repo lookup", async () => {
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 123,
        login: "vyctorbrzezowski",
        avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
      }),
    });

    await expect(
      __test.requireOwnedPublicGitHubRepoForImport(
        ctx as never,
        "users:1" as never,
        "someone-else",
        "public-skill",
        fetchMock as never,
      ),
    ).rejects.toThrow(/owned by your GitHub account/i);

    expect(ctx.runQuery).toHaveBeenCalledWith(
      internal.githubIdentity.getGitHubProviderAccountIdInternal,
      { userId: "users:1" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/123",
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": "clawhub/github-import" }),
      }),
    );
  });

  it("rejects a public repo when GitHub metadata owner id does not match the signed-in user", async () => {
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          login: "vyctorbrzezowski",
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "public-skill",
          full_name: "vyctorbrzezowski/public-skill",
          private: false,
          visibility: "public",
          owner: { id: 456, login: "vyctorbrzezowski" },
        }),
      });

    await expect(
      __test.requireOwnedPublicGitHubRepoForImport(
        ctx as never,
        "users:1" as never,
        "vyctorbrzezowski",
        "public-skill",
        fetchMock as never,
      ),
    ).rejects.toThrow(/owned by your GitHub account/i);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/vyctorbrzezowski/public-skill",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("rejects direct URL preview from another public GitHub owner before repo lookup", async () => {
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 123,
        login: "vyctorbrzezowski",
        avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
      }),
    });

    await expect(
      __test.previewGitHubImportForUser(
        ctx as never,
        "users:1" as never,
        { url: "https://github.com/someone-else/public-skill" },
        fetchMock as never,
      ),
    ).rejects.toThrow(/owned by your GitHub account/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/123",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("rejects direct URL candidate preview from another public GitHub owner before repo lookup", async () => {
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 123,
        login: "vyctorbrzezowski",
        avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
      }),
    });

    await expect(
      __test.previewGitHubImportCandidateForUser(
        ctx as never,
        "users:1" as never,
        {
          url: "https://github.com/someone-else/public-skill",
          candidatePath: "",
        },
        fetchMock as never,
      ),
    ).rejects.toThrow(/owned by your GitHub account/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/123",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("rejects direct URL publish from another public GitHub owner before repo lookup", async () => {
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 123,
        login: "vyctorbrzezowski",
        avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
      }),
    });

    await expect(
      __test.importGitHubSkillForUser(
        ctx as never,
        "users:1" as never,
        {
          url: "https://github.com/someone-else/public-skill",
          commit: "a".repeat(40),
          candidatePath: "",
          selectedPaths: ["SKILL.md"],
          slug: "public-skill",
          displayName: "Public Skill",
          version: "1.0.0",
          tags: ["latest"],
          acceptLicenseTerms: true,
        },
        fetchMock as never,
      ),
    ).rejects.toThrow(/owned by your GitHub account/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/123",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("lists only owned public skill file candidates", async () => {
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          login: "vyctorbrzezowski",
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            name: "clawhub",
            full_name: "vyctorbrzezowski/clawhub",
            html_url: "https://github.com/vyctorbrzezowski/clawhub",
            default_branch: "main",
            pushed_at: "2026-05-27T00:00:00Z",
            updated_at: "2026-05-27T00:00:00Z",
            language: "TypeScript",
            fork: false,
            archived: false,
            disabled: false,
            private: false,
            visibility: "public",
            owner: { id: 123, login: "vyctorbrzezowski" },
          },
          {
            name: "docs",
            full_name: "vyctorbrzezowski/docs",
            html_url: "https://github.com/vyctorbrzezowski/docs",
            default_branch: "main",
            pushed_at: "2026-05-26T00:00:00Z",
            updated_at: "2026-05-26T00:00:00Z",
            fork: false,
            archived: false,
            disabled: false,
            private: false,
            visibility: "public",
            owner: { id: 123, login: "vyctorbrzezowski" },
          },
          {
            name: "forked-skill",
            full_name: "vyctorbrzezowski/forked-skill",
            default_branch: "main",
            fork: true,
            archived: false,
            disabled: false,
            private: false,
            visibility: "public",
            owner: { id: 123, login: "vyctorbrzezowski" },
          },
          {
            name: "archived-skill",
            full_name: "vyctorbrzezowski/archived-skill",
            default_branch: "main",
            fork: false,
            archived: true,
            disabled: false,
            private: false,
            visibility: "public",
            owner: { id: 123, login: "vyctorbrzezowski" },
          },
          {
            name: "private-skill",
            private: true,
            visibility: "private",
            owner: { id: 123, login: "vyctorbrzezowski" },
          },
          {
            name: "org-skill",
            private: false,
            visibility: "public",
            owner: { id: 456, login: "openclaw" },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          truncated: false,
          tree: [
            { path: "SKILL.md", type: "blob" },
            { path: "skills/copilot/SKILL.md", type: "blob" },
            { path: "legacy/skills.md", type: "blob" },
            { path: ".agents/skills/internal/SKILL.md", type: "blob" },
            { path: "README.md", type: "blob" },
            { path: "skill.md", type: "tree" },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          truncated: false,
          tree: [
            { path: "README.md", type: "blob" },
            { path: "guides/usage.md", type: "blob" },
          ],
        }),
      });

    const result = await __test.listOwnedPublicGitHubReposForUser(
      ctx as never,
      "users:1" as never,
      { page: 1, perPage: 30 },
      fetchMock as never,
    );

    expect(result.account.login).toBe("vyctorbrzezowski");
    expect(result.account.avatarUrl).toBe("https://avatars.githubusercontent.com/u/123?v=4");
    expect(result.repos).toEqual([
      expect.objectContaining({
        owner: "vyctorbrzezowski",
        name: "clawhub",
        repoName: "clawhub",
        repoFullName: "vyctorbrzezowski/clawhub",
        fullName: "vyctorbrzezowski/clawhub",
        htmlUrl: "https://github.com/vyctorbrzezowski/clawhub",
        candidatePath: "",
        skillPath: "SKILL.md",
        importable: true,
      }),
      expect.objectContaining({
        owner: "vyctorbrzezowski",
        name: "copilot",
        repoName: "clawhub",
        repoFullName: "vyctorbrzezowski/clawhub",
        fullName: "vyctorbrzezowski/clawhub/skills/copilot",
        htmlUrl: "https://github.com/vyctorbrzezowski/clawhub/tree/main/skills/copilot",
        candidatePath: "skills/copilot",
        skillPath: "skills/copilot/SKILL.md",
        importable: true,
      }),
      expect.objectContaining({
        owner: "vyctorbrzezowski",
        name: "legacy",
        repoName: "clawhub",
        repoFullName: "vyctorbrzezowski/clawhub",
        fullName: "vyctorbrzezowski/clawhub/legacy",
        htmlUrl: "https://github.com/vyctorbrzezowski/clawhub/tree/main/legacy",
        candidatePath: "legacy",
        skillPath: "legacy/skills.md",
        importable: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/users/vyctorbrzezowski/repos?type=owner&sort=pushed&direction=desc&per_page=30&page=1",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/vyctorbrzezowski/clawhub/git/trees/main?recursive=1",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.github.com/repos/vyctorbrzezowski/docs/git/trees/main?recursive=1",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("uses GitHub code search for owned skill file discovery when a token is configured", async () => {
    process.env.GITHUB_TOKEN = "github-token";
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const ownedRepo = {
      name: "skills",
      full_name: "vyctorbrzezowski/skills",
      html_url: "https://github.com/vyctorbrzezowski/skills",
      default_branch: "main",
      pushed_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
      fork: false,
      archived: false,
      disabled: false,
      private: false,
      visibility: "public",
      owner: { id: 123, login: "vyctorbrzezowski" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          login: "vyctorbrzezowski",
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { path: "SKILL.md", repository: ownedRepo },
            { path: "tools/review/SKILL.md", repository: ownedRepo },
            { path: ".agents/skills/internal/SKILL.md", repository: ownedRepo },
            {
              path: "SKILL.md",
              repository: {
                ...ownedRepo,
                name: "forked",
                full_name: "vyctorbrzezowski/forked",
                fork: true,
              },
            },
            { path: "README.md", repository: ownedRepo },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ path: "legacy/skills.md", repository: ownedRepo }],
        }),
      });

    const result = await __test.listOwnedPublicGitHubReposForUser(
      ctx as never,
      "users:1" as never,
      { page: 1, perPage: 30 },
      fetchMock as never,
    );

    expect(result.repos).toEqual([
      expect.objectContaining({
        name: "skills",
        repoName: "skills",
        candidatePath: "",
        skillPath: "SKILL.md",
      }),
      expect.objectContaining({
        name: "review",
        repoName: "skills",
        candidatePath: "tools/review",
        skillPath: "tools/review/SKILL.md",
      }),
      expect.objectContaining({
        name: "legacy",
        repoName: "skills",
        candidatePath: "legacy",
        skillPath: "legacy/skills.md",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const searchUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(searchUrl.pathname).toBe("/search/code");
    expect(searchUrl.searchParams.get("q")).toBe("filename:SKILL.md user:vyctorbrzezowski");
    const legacySearchUrl = new URL(fetchMock.mock.calls[2]?.[0] as string);
    expect(legacySearchUrl.pathname).toBe("/search/code");
    expect(legacySearchUrl.searchParams.get("q")).toBe("filename:skills.md user:vyctorbrzezowski");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer github-token" }),
      }),
    );
  });

  it("falls back from an out-of-scope GitHub App token for public repo lookup", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    process.env.GITHUB_APP_ID = "3536245";
    process.env.GITHUB_APP_INSTALLATION_ID = "987654";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          token: "ghs_app_token",
          expires_at: "2027-02-02T13:00:00Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 123,
          login: "vyctorbrzezowski",
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          name: "public-skill",
          full_name: "vyctorbrzezowski/public-skill",
          private: false,
          visibility: "public",
          owner: { id: 123, login: "vyctorbrzezowski" },
        }),
      );

    await expect(
      __test.requireOwnedPublicGitHubRepoForImport(
        ctx as never,
        "users:1" as never,
        "vyctorbrzezowski",
        "public-skill",
        fetchMock as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        full_name: "vyctorbrzezowski/public-skill",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghs_app_token" }),
      }),
    );
    expect(fetchMock.mock.calls[3]?.[1]?.headers).not.toHaveProperty("Authorization");
  });

  it("uses the GitHub App token for bounded repo discovery", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    process.env.GITHUB_APP_ID = "3536245";
    process.env.GITHUB_APP_INSTALLATION_ID = "987654";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          token: "ghs_app_token",
          expires_at: "2027-02-02T13:00:00Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 123,
          login: "vyctorbrzezowski",
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            name: "public-skill",
            full_name: "vyctorbrzezowski/public-skill",
            html_url: "https://github.com/vyctorbrzezowski/public-skill",
            default_branch: "main",
            private: false,
            visibility: "public",
            owner: { id: 123, login: "vyctorbrzezowski" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          truncated: false,
          tree: [{ path: "SKILL.md", type: "blob" }],
        }),
      );

    const result = await __test.listOwnedPublicGitHubReposForUser(
      ctx as never,
      "users:1" as never,
      { page: 1, perPage: 30 },
      fetchMock as never,
    );

    expect(result.repos).toEqual([
      expect.objectContaining({
        repoFullName: "vyctorbrzezowski/public-skill",
        skillPath: "SKILL.md",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghs_app_token" }),
      }),
    );
  });

  it("falls back to the repo archive when GitHub truncates the discovery tree", async () => {
    const ctx = {
      runQuery: vi.fn().mockResolvedValue("123"),
    };
    const zip = buildGitHubZipForTests({
      "large-repo/tools/review/SKILL.md": "# Review",
      "large-repo/tools/review/notes.md": "notes",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          login: "vyctorbrzezowski",
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            name: "large-repo",
            full_name: "vyctorbrzezowski/large-repo",
            html_url: "https://github.com/vyctorbrzezowski/large-repo",
            default_branch: "main",
            fork: false,
            archived: false,
            disabled: false,
            private: false,
            visibility: "public",
            owner: { id: 123, login: "vyctorbrzezowski" },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          truncated: true,
          tree: [{ path: "README.md", type: "blob" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
      });

    const result = await __test.listOwnedPublicGitHubReposForUser(
      ctx as never,
      "users:1" as never,
      { page: 1, perPage: 30 },
      fetchMock as never,
    );

    expect(result.repos).toEqual([
      expect.objectContaining({
        name: "review",
        repoName: "large-repo",
        candidatePath: "tools/review",
        skillPath: "tools/review/SKILL.md",
      }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://codeload.github.com/vyctorbrzezowski/large-repo/zip/main",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("validates import metadata before storing Convex blobs", async () => {
    const ctx = makeImportCtx();
    const fetchMock = makeOwnedImportFetch(buildOwnedImportZip());

    await expect(
      __test.importGitHubSkillForUser(
        ctx as never,
        "users:1" as never,
        makeImportArgs({ version: "not-semver" }),
        fetchMock as never,
      ),
    ).rejects.toThrow(/Version must be valid semver/);

    expect(ctx.storage.store).not.toHaveBeenCalled();
    expect(ctx.storage.delete).not.toHaveBeenCalled();
    expect(publishVersionForUser).not.toHaveBeenCalled();
  });

  it("deletes stored blobs when publishVersionForUser fails after a successful store", async () => {
    const ctx = makeImportCtx();
    const fetchMock = makeOwnedImportFetch(buildOwnedImportZip());
    vi.mocked(publishVersionForUser).mockRejectedValueOnce(new Error("slug exists"));

    await expect(
      __test.importGitHubSkillForUser(
        ctx as never,
        "users:1" as never,
        makeImportArgs(),
        fetchMock as never,
      ),
    ).rejects.toThrow(/Import failed during publish: slug exists/);

    expect(ctx.storage.store).toHaveBeenCalledTimes(2);
    expect(ctx.storage.delete).toHaveBeenCalledTimes(2);
    expect(ctx.storage.delete).toHaveBeenCalledWith("storage:1");
    expect(ctx.storage.delete).toHaveBeenCalledWith("storage:2");
  });

  it("deletes already-stored blobs when a later store call fails", async () => {
    const store = vi
      .fn()
      .mockResolvedValueOnce("storage:1")
      .mockRejectedValueOnce(new Error("disk full"));
    const del = vi.fn(async () => undefined);
    const ctx = makeImportCtx({ store, delete: del });
    const fetchMock = makeOwnedImportFetch(buildOwnedImportZip());

    await expect(
      __test.importGitHubSkillForUser(
        ctx as never,
        "users:1" as never,
        makeImportArgs(),
        fetchMock as never,
      ),
    ).rejects.toThrow(/Failed to store file "notes.md" \(6 bytes\)\. disk full/);

    expect(store).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("storage:1");
    expect(publishVersionForUser).not.toHaveBeenCalled();
  });
});
