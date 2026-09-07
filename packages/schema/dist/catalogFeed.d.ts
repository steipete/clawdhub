import { type inferred } from "arktype";
export declare const CatalogFeedStateSchema: import("arktype/internal/variants/string.ts").StringType<"available" | "blocked" | "deprecated" | "disabled" | "recommended", {}>;
export type CatalogFeedState = (typeof CatalogFeedStateSchema)[inferred];
export declare const CatalogFeedPublisherTrustSchema: import("arktype/internal/variants/string.ts").StringType<"community" | "official", {}>;
export type CatalogFeedPublisherTrust = (typeof CatalogFeedPublisherTrustSchema)[inferred];
export declare const CatalogFeedGitHubSourceSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    repo: string;
    path: string;
    commit: string;
    contentHash: string;
}, {}>;
export type CatalogFeedGitHubSource = (typeof CatalogFeedGitHubSourceSchema)[inferred];
export declare const CatalogFeedInstallCandidateSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    sourceRef: string;
    package: string;
    version: string;
    integrity: string;
    github?: {
        repo: string;
        path: string;
        commit: string;
        contentHash: string;
    } | undefined;
}, {}>;
export type CatalogFeedInstallCandidate = (typeof CatalogFeedInstallCandidateSchema)[inferred];
export declare const CatalogFeedOpenClawSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    plugin: {
        id: string;
        label?: string | undefined;
    };
    providers: {
        id: string;
        envVars?: string[] | undefined;
        authChoices?: {
            method: string;
            choiceId: string;
            choiceLabel: string;
            choiceHint?: string | undefined;
            assistantPriority?: number | undefined;
            assistantVisibility?: "manual-only" | "visible" | undefined;
            groupId?: string | undefined;
            groupLabel?: string | undefined;
            groupHint?: string | undefined;
            optionKey?: string | undefined;
            cliFlag?: string | undefined;
            cliOption?: string | undefined;
            cliDescription?: string | undefined;
            deprecatedChoiceIds?: string[] | undefined;
            onboardingScopes?: ("image-generation" | "music-generation" | "text-inference")[] | undefined;
            appGuidedSecret?: boolean | undefined;
            appGuidedAuth?: "device-code" | "oauth" | undefined;
            appGuidedActionLabel?: string | undefined;
            onboardingFeatured?: boolean | undefined;
            icon?: string | undefined;
            website?: string | undefined;
        }[] | undefined;
    }[];
    modelCatalog?: {
        providers: {
            [x: string]: {
                defaultModel?: string | undefined;
                models: {
                    id: string;
                    name?: string | undefined;
                    input?: ("document" | "image" | "text")[] | undefined;
                    reasoning?: boolean | undefined;
                    contextWindow?: number | undefined;
                    maxTokens?: number | undefined;
                }[];
            };
        };
    } | undefined;
}, {}>;
export type CatalogFeedOpenClaw = (typeof CatalogFeedOpenClawSchema)[inferred];
export declare const CatalogFeedPluginEntrySchema: import("arktype/internal/variants/object.ts").ObjectType<{
    id: string;
    title: string;
    description?: string | undefined;
    icon?: string | undefined;
    version: string;
    state: "available" | "blocked" | "deprecated" | "disabled" | "recommended";
    featured?: boolean | undefined;
    featuredAt?: number | undefined;
    publisher: {
        id: string;
        trust: "community" | "official";
    };
    install: {
        candidates: {
            sourceRef: string;
            package: string;
            version: string;
            integrity: string;
            github?: {
                repo: string;
                path: string;
                commit: string;
                contentHash: string;
            } | undefined;
        }[];
    };
    type: "plugin";
    openclaw?: {
        plugin: {
            id: string;
            label?: string | undefined;
        };
        providers: {
            id: string;
            envVars?: string[] | undefined;
            authChoices?: {
                method: string;
                choiceId: string;
                choiceLabel: string;
                choiceHint?: string | undefined;
                assistantPriority?: number | undefined;
                assistantVisibility?: "manual-only" | "visible" | undefined;
                groupId?: string | undefined;
                groupLabel?: string | undefined;
                groupHint?: string | undefined;
                optionKey?: string | undefined;
                cliFlag?: string | undefined;
                cliOption?: string | undefined;
                cliDescription?: string | undefined;
                deprecatedChoiceIds?: string[] | undefined;
                onboardingScopes?: ("image-generation" | "music-generation" | "text-inference")[] | undefined;
                appGuidedSecret?: boolean | undefined;
                appGuidedAuth?: "device-code" | "oauth" | undefined;
                appGuidedActionLabel?: string | undefined;
                onboardingFeatured?: boolean | undefined;
                icon?: string | undefined;
                website?: string | undefined;
            }[] | undefined;
        }[];
        modelCatalog?: {
            providers: {
                [x: string]: {
                    defaultModel?: string | undefined;
                    models: {
                        id: string;
                        name?: string | undefined;
                        input?: ("document" | "image" | "text")[] | undefined;
                        reasoning?: boolean | undefined;
                        contextWindow?: number | undefined;
                        maxTokens?: number | undefined;
                    }[];
                };
            };
        } | undefined;
    } | undefined;
}, {}>;
export type CatalogFeedPluginEntry = (typeof CatalogFeedPluginEntrySchema)[inferred];
export declare const CatalogFeedSkillEntrySchema: import("arktype/internal/variants/object.ts").ObjectType<{
    id: string;
    title: string;
    description?: string | undefined;
    icon?: string | undefined;
    version: string;
    state: "available" | "blocked" | "deprecated" | "disabled" | "recommended";
    featured?: boolean | undefined;
    featuredAt?: number | undefined;
    publisher: {
        id: string;
        trust: "community" | "official";
    };
    install: {
        candidates: {
            sourceRef: string;
            package: string;
            version: string;
            integrity: string;
            github?: {
                repo: string;
                path: string;
                commit: string;
                contentHash: string;
            } | undefined;
        }[];
    };
    type: "skill";
}, {}>;
export type CatalogFeedSkillEntry = (typeof CatalogFeedSkillEntrySchema)[inferred];
export declare const CatalogFeedEntrySchema: import("arktype/internal/variants/object.ts").ObjectType<{
    id: string;
    title: string;
    description?: string | undefined;
    icon?: string | undefined;
    version: string;
    state: "available" | "blocked" | "deprecated" | "disabled" | "recommended";
    featured?: boolean | undefined;
    featuredAt?: number | undefined;
    publisher: {
        id: string;
        trust: "community" | "official";
    };
    install: {
        candidates: {
            sourceRef: string;
            package: string;
            version: string;
            integrity: string;
            github?: {
                repo: string;
                path: string;
                commit: string;
                contentHash: string;
            } | undefined;
        }[];
    };
    type: "plugin";
    openclaw?: {
        plugin: {
            id: string;
            label?: string | undefined;
        };
        providers: {
            id: string;
            envVars?: string[] | undefined;
            authChoices?: {
                method: string;
                choiceId: string;
                choiceLabel: string;
                choiceHint?: string | undefined;
                assistantPriority?: number | undefined;
                assistantVisibility?: "manual-only" | "visible" | undefined;
                groupId?: string | undefined;
                groupLabel?: string | undefined;
                groupHint?: string | undefined;
                optionKey?: string | undefined;
                cliFlag?: string | undefined;
                cliOption?: string | undefined;
                cliDescription?: string | undefined;
                deprecatedChoiceIds?: string[] | undefined;
                onboardingScopes?: ("image-generation" | "music-generation" | "text-inference")[] | undefined;
                appGuidedSecret?: boolean | undefined;
                appGuidedAuth?: "device-code" | "oauth" | undefined;
                appGuidedActionLabel?: string | undefined;
                onboardingFeatured?: boolean | undefined;
                icon?: string | undefined;
                website?: string | undefined;
            }[] | undefined;
        }[];
        modelCatalog?: {
            providers: {
                [x: string]: {
                    defaultModel?: string | undefined;
                    models: {
                        id: string;
                        name?: string | undefined;
                        input?: ("document" | "image" | "text")[] | undefined;
                        reasoning?: boolean | undefined;
                        contextWindow?: number | undefined;
                        maxTokens?: number | undefined;
                    }[];
                };
            };
        } | undefined;
    } | undefined;
} | {
    id: string;
    title: string;
    description?: string | undefined;
    icon?: string | undefined;
    version: string;
    state: "available" | "blocked" | "deprecated" | "disabled" | "recommended";
    featured?: boolean | undefined;
    featuredAt?: number | undefined;
    publisher: {
        id: string;
        trust: "community" | "official";
    };
    install: {
        candidates: {
            sourceRef: string;
            package: string;
            version: string;
            integrity: string;
            github?: {
                repo: string;
                path: string;
                commit: string;
                contentHash: string;
            } | undefined;
        }[];
    };
    type: "skill";
}, {}>;
export type CatalogFeedEntry = (typeof CatalogFeedEntrySchema)[inferred];
export declare const CatalogFeedSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    schemaVersion: number;
    id: string;
    generatedAt: string;
    sequence: number;
    expiresAt: string;
    description?: string | undefined;
    entries: ({
        id: string;
        title: string;
        description?: string | undefined;
        icon?: string | undefined;
        version: string;
        state: "available" | "blocked" | "deprecated" | "disabled" | "recommended";
        featured?: boolean | undefined;
        featuredAt?: number | undefined;
        publisher: {
            id: string;
            trust: "community" | "official";
        };
        install: {
            candidates: {
                sourceRef: string;
                package: string;
                version: string;
                integrity: string;
                github?: {
                    repo: string;
                    path: string;
                    commit: string;
                    contentHash: string;
                } | undefined;
            }[];
        };
        type: "plugin";
        openclaw?: {
            plugin: {
                id: string;
                label?: string | undefined;
            };
            providers: {
                id: string;
                envVars?: string[] | undefined;
                authChoices?: {
                    method: string;
                    choiceId: string;
                    choiceLabel: string;
                    choiceHint?: string | undefined;
                    assistantPriority?: number | undefined;
                    assistantVisibility?: "manual-only" | "visible" | undefined;
                    groupId?: string | undefined;
                    groupLabel?: string | undefined;
                    groupHint?: string | undefined;
                    optionKey?: string | undefined;
                    cliFlag?: string | undefined;
                    cliOption?: string | undefined;
                    cliDescription?: string | undefined;
                    deprecatedChoiceIds?: string[] | undefined;
                    onboardingScopes?: ("image-generation" | "music-generation" | "text-inference")[] | undefined;
                    appGuidedSecret?: boolean | undefined;
                    appGuidedAuth?: "device-code" | "oauth" | undefined;
                    appGuidedActionLabel?: string | undefined;
                    onboardingFeatured?: boolean | undefined;
                    icon?: string | undefined;
                    website?: string | undefined;
                }[] | undefined;
            }[];
            modelCatalog?: {
                providers: {
                    [x: string]: {
                        defaultModel?: string | undefined;
                        models: {
                            id: string;
                            name?: string | undefined;
                            input?: ("document" | "image" | "text")[] | undefined;
                            reasoning?: boolean | undefined;
                            contextWindow?: number | undefined;
                            maxTokens?: number | undefined;
                        }[];
                    };
                };
            } | undefined;
        } | undefined;
    } | {
        id: string;
        title: string;
        description?: string | undefined;
        icon?: string | undefined;
        version: string;
        state: "available" | "blocked" | "deprecated" | "disabled" | "recommended";
        featured?: boolean | undefined;
        featuredAt?: number | undefined;
        publisher: {
            id: string;
            trust: "community" | "official";
        };
        install: {
            candidates: {
                sourceRef: string;
                package: string;
                version: string;
                integrity: string;
                github?: {
                    repo: string;
                    path: string;
                    commit: string;
                    contentHash: string;
                } | undefined;
            }[];
        };
        type: "skill";
    })[];
}, {}>;
export type CatalogFeed = (typeof CatalogFeedSchema)[inferred];
/**
 * Cross-repo wire contract with OpenClaw's hosted feed consumer. Bump this only
 * after the matching OpenClaw parser/validation support has shipped, otherwise
 * clients reject the hosted feed and fall back to bundled data.
 */
export declare const CATALOG_FEED_SCHEMA_VERSION = 1;
export declare const CATALOG_FEED_ID = "clawhub-official";
export declare const CATALOG_FEED_SOURCE_REF = "public-clawhub";
export declare const CATALOG_FEED_GITHUB_SOURCE_REF = "public-github";
export declare const CATALOG_SKILLS_FEED_ID = "clawhub-official-skills";
export declare const CATALOG_SKILLS_FEED_DESCRIPTION = "Skills published by verified OpenClaw publishers on ClawHub.";
export declare function parseCatalogFeed(value: unknown): CatalogFeed;
export declare function serializeCatalogFeed(feed: CatalogFeed): string;
