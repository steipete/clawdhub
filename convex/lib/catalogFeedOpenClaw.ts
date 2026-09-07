import type { CatalogFeedOpenClaw } from "clawhub-schema";

const MAX_PROVIDERS = 32;
const MAX_AUTH_CHOICES = 16;
const MAX_MODELS = 64;
const MAX_PREVIEW_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

type AuthChoice = NonNullable<CatalogFeedOpenClaw["providers"][number]["authChoices"]>[number];
type ModelCatalog = NonNullable<CatalogFeedOpenClaw["modelCatalog"]>;
type ModelPreview = ModelCatalog["providers"][string]["models"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength && !/\p{Cc}/u.test(trimmed) ? trimmed : undefined;
}

function strings(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => text(entry) ?? []))].slice(0, limit);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = text(value, 2048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function projectAuthChoice(raw: Record<string, unknown>): AuthChoice | undefined {
  const method = text(raw.method);
  const choiceId = text(raw.choiceId);
  const choiceLabel = text(raw.choiceLabel);
  if (!method || !choiceId || !choiceLabel) return undefined;
  const choice: AuthChoice = { method, choiceId, choiceLabel };
  for (const key of [
    "choiceHint",
    "groupId",
    "groupLabel",
    "groupHint",
    "optionKey",
    "cliFlag",
    "cliOption",
    "cliDescription",
    "appGuidedActionLabel",
  ] as const) {
    const value = text(raw[key]);
    if (value) choice[key] = value;
  }
  for (const key of ["icon", "website"] as const) {
    const value = httpsUrl(raw[key]);
    if (value) choice[key] = value;
  }
  for (const key of ["appGuidedSecret", "onboardingFeatured"] as const) {
    if (typeof raw[key] === "boolean") choice[key] = raw[key];
  }
  if (typeof raw.assistantPriority === "number" && Number.isFinite(raw.assistantPriority)) {
    choice.assistantPriority = raw.assistantPriority;
  }
  if (raw.assistantVisibility === "visible" || raw.assistantVisibility === "manual-only") {
    choice.assistantVisibility = raw.assistantVisibility;
  }
  if (raw.appGuidedAuth === "oauth" || raw.appGuidedAuth === "device-code") {
    choice.appGuidedAuth = raw.appGuidedAuth;
  }
  const deprecatedChoiceIds = strings(raw.deprecatedChoiceIds);
  if (deprecatedChoiceIds.length) choice.deprecatedChoiceIds = deprecatedChoiceIds;
  const scopes = strings(raw.onboardingScopes).filter(
    (scope) =>
      scope === "text-inference" || scope === "image-generation" || scope === "music-generation",
  );
  if (scopes.length) choice.onboardingScopes = scopes;
  return choice;
}

function projectModel(raw: unknown): ModelPreview | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  if (!id) return undefined;
  const model: ModelPreview = { id };
  const name = text(raw.name);
  if (name) model.name = name;
  const input = strings(raw.input).filter(
    (kind) => kind === "text" || kind === "image" || kind === "document",
  );
  if (input.length) model.input = input;
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  for (const key of ["contextWindow", "maxTokens"] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) model[key] = value;
  }
  return model;
}

function projectModels(
  manifest: Record<string, unknown>,
  metadata: CatalogFeedOpenClaw,
): ModelCatalog | undefined {
  const source =
    isRecord(manifest.modelCatalog) && isRecord(manifest.modelCatalog.providers)
      ? manifest.modelCatalog.providers
      : {};
  const preview: ModelCatalog = { providers: {} };
  for (const { id: providerId } of metadata.providers) {
    const raw = Object.hasOwn(source, providerId) ? source[providerId] : undefined;
    if (!isRecord(raw) || !Array.isArray(raw.models)) continue;
    const defaultModel = text(raw.defaultModel);
    const models = raw.models
      .flatMap((model) => projectModel(model) ?? [])
      .sort(
        (left, right) =>
          Number(right.id === defaultModel) - Number(left.id === defaultModel) ||
          left.id.localeCompare(right.id),
      );
    const selected: ModelPreview[] = [];
    const provider: ModelCatalog["providers"][string] = { models: selected };
    if (models[0]?.id === defaultModel) provider.defaultModel = defaultModel;
    for (const model of models) {
      if (selected.some((entry) => entry.id === model.id)) continue;
      selected.push(model);
      preview.providers[providerId] = provider;
      if (
        jsonBytes(preview) > MAX_PREVIEW_BYTES ||
        jsonBytes({ ...metadata, modelCatalog: preview }) > MAX_METADATA_BYTES
      ) {
        selected.pop();
        if (!selected.length) delete preview.providers[providerId];
        break;
      }
      if (selected.length === MAX_MODELS) break;
    }
    selected.sort((left, right) => left.id.localeCompare(right.id));
  }
  return Object.keys(preview.providers).length ? preview : undefined;
}

export function projectCatalogFeedOpenClaw(
  manifest: unknown,
  runtimeId: string | undefined,
  fallbackLabel: string,
): CatalogFeedOpenClaw | undefined {
  if (!isRecord(manifest) || !runtimeId || text(manifest.id) !== runtimeId) return undefined;
  const providerIds = strings(manifest.providers, Infinity)
    .filter(
      (id) =>
        /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(id) && id !== "constructor" && id !== "prototype",
    )
    .sort()
    .slice(0, MAX_PROVIDERS);
  if (!providerIds.length) return undefined;
  const setup =
    isRecord(manifest.setup) && Array.isArray(manifest.setup.providers)
      ? manifest.setup.providers.filter(isRecord)
      : [];
  const choices = Array.isArray(manifest.providerAuthChoices)
    ? manifest.providerAuthChoices.filter(isRecord)
    : [];
  const label = text(manifest.name) ?? text(fallbackLabel);
  const metadata: CatalogFeedOpenClaw = {
    plugin: { id: runtimeId, ...(label ? { label } : {}) },
    providers: [],
  };
  for (const id of providerIds) {
    const envVars = strings(setup.find((provider) => text(provider.id) === id)?.envVars).filter(
      (name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
    );
    const authChoices = choices
      .filter((choice) => text(choice.provider) === id)
      .flatMap((choice) => projectAuthChoice(choice) ?? [])
      .sort((left, right) => left.choiceId.localeCompare(right.choiceId))
      .filter((choice, index, all) => index === 0 || choice.choiceId !== all[index - 1].choiceId)
      .slice(0, MAX_AUTH_CHOICES);
    const provider: CatalogFeedOpenClaw["providers"][number] = {
      id,
      ...(envVars.length ? { envVars } : {}),
    };
    metadata.providers.push(provider);
    if (jsonBytes(metadata) > MAX_METADATA_BYTES) {
      metadata.providers.pop();
      continue;
    }
    provider.authChoices = [];
    for (const choice of authChoices) {
      provider.authChoices.push(choice);
      if (jsonBytes(metadata) > MAX_METADATA_BYTES) provider.authChoices.pop();
    }
    if (!provider.authChoices.length) delete provider.authChoices;
  }
  // Setup choices take precedence over optional model previews. Only whole
  // providers, choices, and models are admitted; retained metadata is unchanged.
  const modelCatalog = projectModels(manifest, metadata);
  return {
    ...metadata,
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}
