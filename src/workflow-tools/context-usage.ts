import { tool } from "@opencode-ai/plugin";

const ENTRY_LIMIT = 3;
const OPENAI_PROVIDERS = new Set(["openai", "azure", "opencode"]);
const TIKTOKEN_PACKAGE = "js-tiktoken";
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

export type ContextUsageClient = {
  session?: {
    messages?: (input: { path: { id: string } }) => Promise<unknown>;
  };
};

type TokenizerSpec =
  | { kind: "tiktoken"; model: string }
  | { kind: "transformers"; hub: string }
  | { kind: "approx" };

type TokenizerEntry = {
  alias: string;
  spec: TokenizerSpec;
};

type TokenizerRegistry = {
  openai: Map<string, TokenizerEntry>;
  transformers: Map<string, TokenizerEntry>;
  providerDefaults: Map<string, TokenizerSpec>;
  defaultOpenAI?: TokenizerEntry;
};

type TokenModel = {
  name: string;
  spec: TokenizerSpec;
};

type SessionMessage = {
  info: SessionMessageInfo;
  parts: SessionMessagePart[];
};

type SessionMessageInfo = {
  id: string;
  role: string;
  modelID?: string;
  providerID?: string;
  system: string[];
  tokens?: unknown;
};

type SessionMessagePart =
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: string; state: ToolPartState }
  | { type: string };

type ToolPartState = {
  status?: string;
  output?: string;
};

type CategoryEntrySource = {
  label: string;
  content: string;
};

type CategoryEntry = {
  label: string;
  tokens: number;
};

type CategorySummary = {
  label: string;
  totalTokens: number;
  entries: CategoryEntry[];
};

type ContextSummary = {
  sessionID: string;
  model: TokenModel;
  categories: {
    system: CategorySummary;
    user: CategorySummary;
    assistant: CategorySummary;
    tools: CategorySummary;
    reasoning: CategorySummary;
  };
  totalTokens: number;
};

type TokenizerCandidate = {
  key: string;
  original: string;
};

type TokenEncoder = {
  encode: (content: string) => unknown;
};

type SingleStringFunction = (value: string) => unknown;

let registryPromise: Promise<TokenizerRegistry> | undefined;
const tiktokenCache = new Map<string, TokenEncoder | null>();
const transformerCache = new Map<string, TokenEncoder | null>();
let tiktokenModule: Promise<unknown> | undefined;
let transformersModule: Promise<unknown> | undefined;

export class TokenizerResolutionError extends Error {
  readonly models: string[];
  readonly providers: string[];

  constructor(message: string, details: { models?: string[]; providers?: string[] } = {}) {
    super(message);
    this.name = "TokenizerResolutionError";
    this.models = details.models ?? [];
    this.providers = details.providers ?? [];
  }
}

export function createContextUsageTool(client: ContextUsageClient = {}) {
  return tool({
    description:
      "Get detailed token usage analysis for the current session. When this tool is called, analyze the results and provide a concise summary rather than reproducing the visual output.",
    args: {
      sessionID: tool.schema.string().optional(),
      limitMessages: tool.schema.number().int().min(1).max(10).optional(),
    },
    async execute(args, context) {
      const sessionID = args.sessionID ?? context.sessionID;
      if (!sessionID) throw new Error("No session ID available for context summary");
      const messages = await loadSessionMessages(client, sessionID);
      if (messages.length === 0) return `Session ${sessionID} has no messages yet.`;

      let tokenModel: TokenModel;
      try {
        tokenModel = await resolveTokenModel(messages);
      } catch (error) {
        if (error instanceof TokenizerResolutionError) {
          return formatTokenizerResolutionError(error, sessionID);
        }
        throw error;
      }

      const summary = await buildContextSummary({
        sessionID,
        messages,
        tokenModel,
        entryLimit: args.limitMessages ?? ENTRY_LIMIT,
      });

      return formatSummary(summary);
    },
  });
}

async function loadSessionMessages(
  client: ContextUsageClient,
  sessionID: string,
): Promise<SessionMessage[]> {
  const loader = client.session?.messages;
  if (!loader)
    throw new Error("Conductor context_usage requires an OpenCode client with session.messages");
  const response = await loader({ path: { id: sessionID } });
  const payload = responseData(response);
  if (!Array.isArray(payload)) return [];
  const messages: SessionMessage[] = [];
  for (const item of payload) {
    const message = toSessionMessage(item);
    if (message) messages.push(message);
  }
  return messages;
}

function responseData(response: unknown): unknown {
  if (isRecord(response) && Array.isArray(response.data)) return response.data;
  return response;
}

function toSessionMessage(value: unknown): SessionMessage | undefined {
  if (!isRecord(value)) return undefined;
  const info = toSessionMessageInfo(value.info);
  const parts = toSessionMessageParts(value.parts);
  return { info, parts };
}

function toSessionMessageInfo(value: unknown): SessionMessageInfo {
  if (!isRecord(value)) return { id: "", role: "", system: [] };
  return {
    id: readString(value, "id") ?? "",
    role: readString(value, "role") ?? "",
    modelID: readString(value, "modelID"),
    providerID: readString(value, "providerID"),
    system: readStringArray(value.system),
    tokens: value.tokens,
  };
}

function toSessionMessageParts(value: unknown): SessionMessagePart[] {
  if (!Array.isArray(value)) return [];
  const parts: SessionMessagePart[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const type = readString(item, "type");
    if (!type) continue;
    if (type === "text") {
      const text = readString(item, "text") ?? "";
      const syntheticValue = item.synthetic;
      const synthetic = typeof syntheticValue === "boolean" ? syntheticValue : undefined;
      parts.push({ type, text, synthetic });
      continue;
    }
    if (type === "reasoning") {
      parts.push({ type, text: readString(item, "text") ?? "" });
      continue;
    }
    if (type === "tool") {
      parts.push({
        type,
        tool: readString(item, "tool") ?? "tool",
        state: toToolPartState(item.state),
      });
      continue;
    }
    parts.push({ type });
  }
  return parts;
}

function toToolPartState(value: unknown): ToolPartState {
  if (!isRecord(value)) return {};
  return {
    status: readString(value, "status"),
    output: stringFromUnknown(value.output),
  };
}

async function buildContextSummary(input: {
  sessionID: string;
  messages: SessionMessage[];
  tokenModel: TokenModel;
  entryLimit: number;
}): Promise<ContextSummary> {
  const { sessionID, messages, tokenModel, entryLimit } = input;
  const systemPrompts = collectSystemPrompts(messages);
  const userTexts = collectMessageTexts(messages, "user");
  const assistantTexts = collectMessageTexts(messages, "assistant");
  const toolOutputs = collectToolOutputs(messages);
  const reasoningTraces = collectReasoningTexts(messages);

  const [system, user, assistant, tools, reasoning] = await Promise.all([
    buildCategory("system", systemPrompts, tokenModel, entryLimit),
    buildCategory("user", userTexts, tokenModel, entryLimit),
    buildCategory("assistant", assistantTexts, tokenModel, entryLimit),
    buildCategory("tools", toolOutputs, tokenModel, entryLimit),
    buildCategory("reasoning", reasoningTraces, tokenModel, entryLimit),
  ]);

  const summary: ContextSummary = {
    sessionID,
    model: tokenModel,
    categories: { system, user, assistant, tools, reasoning },
    totalTokens:
      system.totalTokens +
      user.totalTokens +
      assistant.totalTokens +
      tools.totalTokens +
      reasoning.totalTokens,
  };
  applyTokenTelemetry(summary, messages);
  return summary;
}

async function buildCategory(
  label: string,
  texts: CategoryEntrySource[],
  model: TokenModel,
  entryLimit: number,
): Promise<CategorySummary> {
  const results: CategoryEntry[] = [];
  for (const item of texts) {
    const tokens = await countTokens(item.content, model);
    if (tokens > 0) results.push({ label: item.label, tokens });
  }
  results.sort((a, b) => b.tokens - a.tokens);
  const totalTokens = results.reduce((sum, entry) => sum + entry.tokens, 0);
  return { label, totalTokens, entries: results.slice(0, entryLimit) };
}

function collectSystemPrompts(messages: SessionMessage[]): CategoryEntrySource[] {
  const prompts = new Map<string, string>();
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const prompt of message.info.system) {
      const trimmed = prompt.trim();
      if (trimmed) prompts.set(trimmed, trimmed);
    }
  }
  return Array.from(prompts.values()).map((content, index) => ({
    label: identifySystemPrompt(content, index + 1),
    content,
  }));
}

function identifySystemPrompt(content: string, index: number): string {
  const lower = content.toLowerCase();
  if (lower.includes("opencode") && lower.includes("cli") && content.length > 500)
    return "System#MainPrompt";
  if (lower.includes("opencode") && lower.includes("cli") && content.length <= 500)
    return "System#ShortPrompt";
  if (lower.includes("agent") && lower.includes("mode")) return "System#AgentMode";
  if (lower.includes("permission") || lower.includes("allowed") || lower.includes("deny"))
    return "System#Permissions";
  if (lower.includes("tool") && (lower.includes("rule") || lower.includes("guideline")))
    return "System#ToolRules";
  if (lower.includes("format") || lower.includes("style") || lower.includes("concise"))
    return "System#Formatting";
  if (lower.includes("project") || lower.includes("repository") || lower.includes("codebase"))
    return "System#ProjectContext";
  if (lower.includes("session") || lower.includes("context") || lower.includes("memory"))
    return "System#SessionMgmt";
  if (content.includes("@") && (content.includes(".md") || content.includes(".txt")))
    return "System#FileRefs";
  if (content.includes("name:") && content.includes("description:")) return "System#AgentDef";
  if (lower.includes("code") && (lower.includes("convention") || lower.includes("standard")))
    return "System#CodeGuidelines";
  if (lower.includes("opencode")) {
    if (content.includes("```") || content.includes("examples")) return "System#MainWithExamples";
    if (index === 1) return "System#Main-A";
    if (index === 2) return "System#Main-B";
    return `System#Main-${index}`;
  }
  return `System#${index}`;
}

function collectMessageTexts(
  messages: SessionMessage[],
  role: "user" | "assistant",
): CategoryEntrySource[] {
  const results: CategoryEntrySource[] = [];
  let index = 0;
  for (const message of messages) {
    if (message.info.role !== role) continue;
    const content = extractText(message.parts);
    if (!content) continue;
    index += 1;
    results.push({ label: `${capitalize(role)}#${index}`, content });
  }
  return results;
}

function collectToolOutputs(messages: SessionMessage[]): CategoryEntrySource[] {
  const toolOutputs = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part)) continue;
      if (part.state.status !== "completed") continue;
      const output = (part.state.output ?? "").trim();
      if (!output) continue;
      const existing = toolOutputs.get(part.tool) ?? "";
      toolOutputs.set(part.tool, existing + (existing ? "\n\n" : "") + output);
    }
  }
  return Array.from(toolOutputs.entries()).map(([toolName, content]) => ({
    label: toolName,
    content,
  }));
}

function collectReasoningTexts(messages: SessionMessage[]): CategoryEntrySource[] {
  const results: CategoryEntrySource[] = [];
  let index = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isReasoningPart(part)) continue;
      const text = part.text.trim();
      if (!text) continue;
      index += 1;
      results.push({ label: `Reasoning#${index}`, content: text });
    }
  }
  return results;
}

function extractText(parts: SessionMessagePart[]): string {
  return parts
    .filter(isTextPart)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function applyTokenTelemetry(summary: ContextSummary, messages: SessionMessage[]): void {
  const assistants = messages.filter(
    (message) => message.info.role === "assistant" && message.info.tokens !== undefined,
  );
  let pick: SessionMessage | undefined;
  for (let index = assistants.length - 1; index >= 0; index -= 1) {
    const candidate = assistants[index];
    if (!candidate) continue;
    const tokens = tokenUsage(candidate.info.tokens);
    if (
      tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite >
      0
    ) {
      pick = candidate;
      break;
    }
  }
  if (!pick) pick = assistants[assistants.length - 1];
  if (!pick) return;

  const tokens = tokenUsage(pick.info.tokens);
  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const assistantTokens = tokens.output;
  const reasoningTokens = tokens.reasoning;
  const promptMeasured =
    summary.categories.system.totalTokens +
    summary.categories.user.totalTokens +
    summary.categories.tools.totalTokens;

  scalePromptCategories(summary, promptTokens, promptMeasured);
  scaleCategory(summary.categories.assistant, assistantTokens, "Assistant output");
  scaleCategory(summary.categories.reasoning, reasoningTokens, "Reasoning");
  summary.totalTokens =
    summary.categories.system.totalTokens +
    summary.categories.user.totalTokens +
    summary.categories.assistant.totalTokens +
    summary.categories.tools.totalTokens +
    summary.categories.reasoning.totalTokens;
}

function tokenUsage(value: unknown): {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
} {
  if (!isRecord(value)) return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const cache = isRecord(value.cache) ? value.cache : {};
  return {
    input: readNumber(value, "input"),
    output: readNumber(value, "output"),
    reasoning: readNumber(value, "reasoning"),
    cacheRead: readNumber(cache, "read"),
    cacheWrite: readNumber(cache, "write"),
  };
}

function scalePromptCategories(summary: ContextSummary, actual: number, measured: number): void {
  const categories = [summary.categories.system, summary.categories.user, summary.categories.tools];
  if (actual <= 0) {
    for (const category of categories) {
      category.totalTokens = 0;
      category.entries = [];
    }
    return;
  }
  if (measured <= 0) {
    const share = actual / categories.length;
    for (const category of categories) {
      category.entries = [{ label: category.entries[0]?.label ?? category.label, tokens: share }];
      category.totalTokens = share;
    }
    return;
  }
  const factor = actual / measured;
  let accumulated = 0;
  for (const category of categories) {
    const scaled = scaleEntries(category.entries, factor);
    category.totalTokens = scaled;
    accumulated += scaled;
  }
  const diff = actual - accumulated;
  const firstCategory = categories[0];
  if (Math.abs(diff) > 1e-6 && firstCategory) {
    firstCategory.totalTokens += Math.round(diff);
    const firstEntry = firstCategory.entries[0];
    if (firstEntry) firstEntry.tokens += Math.round(diff);
  }
}

function scaleCategory(category: CategorySummary, actual: number, fallbackLabel: string): void {
  if (actual <= 0) {
    category.totalTokens = 0;
    category.entries = [];
    return;
  }
  const measured = category.totalTokens;
  if (measured <= 0) {
    category.entries = [{ label: fallbackLabel, tokens: actual }];
    category.totalTokens = actual;
    return;
  }
  const factor = actual / measured;
  const scaled = scaleEntries(category.entries, factor);
  category.totalTokens = scaled;
  const diff = actual - scaled;
  const firstEntry = category.entries[0];
  if (Math.abs(diff) > 1e-6 && firstEntry) {
    const rounded = Math.round(diff);
    firstEntry.tokens += rounded;
    category.totalTokens += rounded;
  }
}

function scaleEntries(entries: CategoryEntry[], factor: number): number {
  let total = 0;
  for (const entry of entries) {
    entry.tokens = Math.round(entry.tokens * factor);
    total += entry.tokens;
  }
  return total;
}

async function countTokens(content: string, model: TokenModel): Promise<number> {
  if (!content.trim()) return 0;
  if (model.spec.kind === "tiktoken") {
    const encoder = await loadTiktokenEncoder(model.spec.model);
    const count = encoder ? encodedLength(encoder.encode(content)) : undefined;
    return count ?? approximateTokenCount(content);
  }
  if (model.spec.kind === "transformers") {
    const tokenizer = await loadTransformersTokenizer(model.spec.hub);
    const count = tokenizer ? encodedLength(tokenizer.encode(content)) : undefined;
    return count ?? approximateTokenCount(content);
  }
  return approximateTokenCount(content);
}

function approximateTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
}

async function loadTiktokenEncoder(model: string): Promise<TokenEncoder | null> {
  if (tiktokenCache.has(model)) return tiktokenCache.get(model) ?? null;
  const mod = await loadOptionalTiktokenModule();
  const record = isRecord(mod) ? mod : {};
  const encodingForModel = readSingleStringFunction(record, "encoding_for_model");
  const getEncoding = readSingleStringFunction(record, "get_encoding");
  let encoder: TokenEncoder | null = null;
  if (encodingForModel) encoder = toTokenEncoder(encodingForModel(model));
  if (!encoder && getEncoding) encoder = toTokenEncoder(getEncoding("cl100k_base"));
  tiktokenCache.set(model, encoder);
  return encoder;
}

async function loadOptionalTiktokenModule(): Promise<unknown> {
  if (!tiktokenModule) tiktokenModule = import(TIKTOKEN_PACKAGE).catch(() => null);
  return tiktokenModule;
}

async function loadTransformersTokenizer(hub: string): Promise<TokenEncoder | null> {
  if (transformerCache.has(hub)) return transformerCache.get(hub) ?? null;
  const mod = await loadOptionalTransformersModule();
  const record = isRecord(mod) ? mod : {};
  const autoTokenizer = isRecord(record.AutoTokenizer) ? record.AutoTokenizer : {};
  const fromPretrained = readSingleStringFunction(autoTokenizer, "from_pretrained");
  const tokenizer = fromPretrained ? toTokenEncoder(await fromPretrained(hub)) : null;
  transformerCache.set(hub, tokenizer);
  return tokenizer;
}

async function loadOptionalTransformersModule(): Promise<unknown> {
  if (!transformersModule) transformersModule = import(TRANSFORMERS_PACKAGE).catch(() => null);
  return transformersModule;
}

function toTokenEncoder(value: unknown): TokenEncoder | null {
  if (!isRecord(value)) return null;
  const encode = readSingleStringFunction(value, "encode");
  return encode ? { encode } : null;
}

function encodedLength(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value) && typeof value.length === "number") return value.length;
  return undefined;
}

async function resolveTokenModel(messages: readonly SessionMessage[]): Promise<TokenModel> {
  const registry = await loadTokenizerRegistry();
  const seenModels: TokenizerCandidate[] = [];
  const seenProviders: TokenizerCandidate[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const originalModel = message.info.modelID;
    const originalProvider = message.info.providerID;
    const modelID = normalizeModelKey(originalModel);
    const providerID = normalizeProviderKey(originalProvider);

    rememberCandidate(seenModels, modelID, originalModel);
    rememberCandidate(seenProviders, providerID, originalProvider);
    const resolved = resolveFromHints({ modelID, providerID, originalModel, registry });
    if (resolved) return resolved;
  }

  for (const provider of seenProviders) {
    const spec = registry.providerDefaults.get(provider.key);
    if (spec) return { name: provider.original, spec };
  }

  for (const model of seenModels) {
    const suggestion = suggestTokenizerAlias(registry, model.key);
    if (suggestion) return { name: model.original, spec: suggestion.spec };
  }

  throw new TokenizerResolutionError("No tokenizer could be resolved for the current session.", {
    models: seenModels.map((entry) => entry.original),
    providers: seenProviders.map((entry) => entry.original),
  });
}

function rememberCandidate(
  bucket: TokenizerCandidate[],
  key: string | undefined,
  original: string | undefined,
): void {
  if (!key) return;
  if (bucket.some((entry) => entry.key === key)) return;
  bucket.push({ key, original: original ?? key });
}

function resolveFromHints(input: {
  modelID: string | undefined;
  providerID: string | undefined;
  originalModel: string | undefined;
  registry: TokenizerRegistry;
}): TokenModel | undefined {
  const { modelID, providerID, originalModel, registry } = input;
  if (providerID && OPENAI_PROVIDERS.has(providerID)) {
    const entry = lookupOpenAIModel(registry, modelID);
    if (entry) return { name: originalModel ?? entry.alias, spec: entry.spec };
    if (!modelID && registry.defaultOpenAI)
      return {
        name: originalModel ?? registry.defaultOpenAI.alias,
        spec: registry.defaultOpenAI.spec,
      };
  }
  if (modelID) {
    const openaiEntry = lookupOpenAIModel(registry, modelID);
    if (openaiEntry) return { name: originalModel ?? openaiEntry.alias, spec: openaiEntry.spec };
    const transformerEntry = lookupTransformersModel(registry, modelID);
    if (transformerEntry)
      return { name: originalModel ?? transformerEntry.alias, spec: transformerEntry.spec };
  }
  if (providerID) {
    const providerSpec = registry.providerDefaults.get(providerID);
    if (providerSpec) return { name: originalModel ?? providerID, spec: providerSpec };
  }
  return undefined;
}

function lookupOpenAIModel(
  registry: TokenizerRegistry,
  modelID: string | undefined,
): TokenizerEntry | undefined {
  if (!modelID) return undefined;
  const direct = registry.openai.get(modelID);
  if (direct) return direct;
  const trimmed = modelID.replace(/-latest$/, "");
  if (trimmed !== modelID) return registry.openai.get(trimmed);
  const base = modelID.split(":")[0];
  if (base && base !== modelID) return registry.openai.get(base);
  return undefined;
}

function lookupTransformersModel(
  registry: TokenizerRegistry,
  modelID: string | undefined,
): TokenizerEntry | undefined {
  if (!modelID) return undefined;
  const direct = registry.transformers.get(modelID);
  if (direct) return direct;
  const base = modelID.split(":")[0];
  if (base && base !== modelID) return registry.transformers.get(base);
  return undefined;
}

function suggestTokenizerAlias(
  registry: TokenizerRegistry,
  modelID: string,
): TokenizerEntry | undefined {
  let bestEntry: TokenizerEntry | undefined;
  let bestScore = 0;
  for (const entry of uniqueEntries(registry)) {
    const score = similarity(modelID, entry.matchKey);
    if (score >= 0.5 && score > bestScore) {
      bestEntry = entry;
      bestScore = score;
    }
  }
  return bestEntry;
}

function uniqueEntries(registry: TokenizerRegistry): Array<TokenizerEntry & { matchKey: string }> {
  const bucket = new Map<string, TokenizerEntry & { matchKey: string }>();
  for (const [key, entry] of registry.openai.entries()) {
    if (!bucket.has(entry.alias))
      bucket.set(entry.alias, { alias: entry.alias, spec: entry.spec, matchKey: key });
  }
  for (const [key, entry] of registry.transformers.entries()) {
    if (!bucket.has(entry.alias))
      bucket.set(entry.alias, { alias: entry.alias, spec: entry.spec, matchKey: key });
  }
  return Array.from(bucket.values());
}

async function loadTokenizerRegistry(): Promise<TokenizerRegistry> {
  if (!registryPromise) registryPromise = buildTokenizerRegistry();
  return registryPromise;
}

function buildTokenizerRegistry(): Promise<TokenizerRegistry> {
  const openaiEntries = createOpenAIEntries(BUILTIN_OPENAI_FALLBACK);
  const transformerEntries = createTransformerEntries(BUILTIN_TRANSFORMERS_FALLBACK);
  return Promise.resolve({
    openai: openaiEntries.map,
    transformers: transformerEntries.map,
    providerDefaults: deriveProviderDefaults(transformerEntries.map),
    defaultOpenAI: openaiEntries.defaultEntry,
  });
}

function createOpenAIEntries(source: Record<string, string>): {
  map: Map<string, TokenizerEntry>;
  defaultEntry?: TokenizerEntry;
} {
  const map = new Map<string, TokenizerEntry>();
  let defaultEntry: TokenizerEntry | undefined;
  for (const [alias, encoding] of Object.entries(source)) {
    const entry: TokenizerEntry = { alias, spec: { kind: "tiktoken", model: encoding } };
    for (const key of buildAliasKeys(alias)) {
      if (!map.has(key)) map.set(key, entry);
    }
    if (!defaultEntry || alias === "gpt-4o") defaultEntry = entry;
  }
  return { map, defaultEntry };
}

function createTransformerEntries(source: Record<string, string>): {
  map: Map<string, TokenizerEntry>;
} {
  const map = new Map<string, TokenizerEntry>();
  for (const [alias, hub] of Object.entries(source)) {
    const entry: TokenizerEntry = { alias, spec: { kind: "transformers", hub } };
    for (const key of buildAliasKeys(alias)) {
      if (!map.has(key)) map.set(key, entry);
    }
  }
  return { map };
}

function deriveProviderDefaults(
  transformers: Map<string, TokenizerEntry>,
): Map<string, TokenizerSpec> {
  const defaults = new Map<string, TokenizerSpec>();
  const hints = [
    { provider: "anthropic", patterns: ["claude"] },
    { provider: "meta", patterns: ["llama"] },
    { provider: "mistral", patterns: ["mistral", "codestral", "devstral"] },
    { provider: "deepseek", patterns: ["deepseek"] },
    { provider: "google", patterns: ["gemma", "palm", "gemini"] },
  ];
  const entries = Array.from(
    new Map(Array.from(transformers.values()).map((entry) => [entry.alias, entry])).values(),
  );
  for (const hint of hints) {
    const match = entries.find((entry) =>
      hint.patterns.some(
        (pattern) => entry.alias.includes(pattern) || transformerHub(entry).includes(pattern),
      ),
    );
    if (match) defaults.set(hint.provider, match.spec);
  }
  return defaults;
}

function transformerHub(entry: TokenizerEntry): string {
  return entry.spec.kind === "transformers" ? entry.spec.hub.toLowerCase() : "";
}

function buildAliasKeys(alias: string): Set<string> {
  const keys = new Set<string>();
  const normalized = normalizeModelKey(alias);
  if (!normalized) return keys;
  keys.add(normalized);
  if (normalized.includes(":")) {
    const base = normalized.split(":")[0];
    if (base) keys.add(base);
  }
  if (normalized.endsWith("-latest")) keys.add(normalized.slice(0, -7));
  return keys;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length, 1);
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const insert = (current[j - 1] ?? 0) + 1;
      const deleteCost = (previous[j] ?? 0) + 1;
      const replace = (previous[j - 1] ?? 0) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      current[j] = Math.min(insert, deleteCost, replace);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length] ?? 0;
}

function formatSummary(summary: ContextSummary): string {
  const categories = [
    { label: "SYSTEM", tokens: summary.categories.system.totalTokens },
    { label: "USER", tokens: summary.categories.user.totalTokens },
    { label: "ASSISTANT", tokens: summary.categories.assistant.totalTokens },
    { label: "TOOLS", tokens: summary.categories.tools.totalTokens },
    { label: "REASONING", tokens: summary.categories.reasoning.totalTokens },
  ];
  return formatVisualSummary(
    summary.sessionID,
    summary.model.name,
    summary.totalTokens,
    categories,
    collectTopEntries(summary, 10),
  );
}

function formatVisualSummary(
  sessionID: string,
  modelName: string,
  totalTokens: number,
  categories: Array<{ label: string; tokens: number }>,
  topEntries: CategoryEntry[],
): string {
  const lines: string[] = [`Context Analysis: Session ${sessionID}`, ""];
  const maxTokens = Math.max(...categories.map((category) => category.tokens), 1);
  for (const category of categories) {
    if (category.tokens === 0) continue;
    const percentage = totalTokens > 0 ? ((category.tokens / totalTokens) * 100).toFixed(1) : "0.0";
    const barWidth = Math.round((category.tokens / maxTokens) * 30);
    const bar = "█".repeat(barWidth) + "░".repeat(Math.max(0, 30 - barWidth));
    lines.push(
      `${category.label.padEnd(9)} ${bar} ${percentage.padStart(5)}% (${formatNumber(category.tokens).padStart(6)})`,
    );
  }
  lines.push("", `Total: ${formatNumber(totalTokens)} tokens`);
  if (topEntries.length > 0) {
    lines.push("", "Top Contributors:");
    for (const entry of topEntries) {
      const percentage = totalTokens > 0 ? ((entry.tokens / totalTokens) * 100).toFixed(1) : "0.0";
      lines.push(
        `${`• ${entry.label}`.padEnd(16)} ${formatNumber(entry.tokens)} tokens (${percentage}%)`,
      );
    }
  }
  return lines.join("\n");
}

function collectTopEntries(summary: ContextSummary, limit: number): CategoryEntry[] {
  return [
    ...summary.categories.system.entries,
    ...summary.categories.user.entries,
    ...summary.categories.assistant.entries,
    ...summary.categories.tools.entries,
    ...summary.categories.reasoning.entries,
  ]
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

function formatTokenizerResolutionError(
  error: TokenizerResolutionError,
  sessionID: string,
): string {
  const lines = [`Unable to resolve a tokenizer for session ${sessionID}.`, error.message];
  if (error.models.length > 0) lines.push(`Models considered: ${error.models.join(", ")}`);
  if (error.providers.length > 0) lines.push(`Providers observed: ${error.providers.join(", ")}`);
  lines.push("Install or update tokenizer dependencies if exact tokenizer counts are required.");
  return lines.filter(Boolean).join("\n");
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readSingleStringFunction(
  record: Record<string, unknown>,
  key: string,
): SingleStringFunction | undefined {
  const value = record[key];
  return isSingleStringFunction(value) ? value : undefined;
}

function isSingleStringFunction(value: unknown): value is SingleStringFunction {
  return typeof value === "function";
}

function stringFromUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function normalizeModelKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .trim();
}

function normalizeProviderKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.toLowerCase().trim();
}

function isTextPart(
  part: SessionMessagePart,
): part is { type: "text"; text: string; synthetic?: boolean } {
  return part.type === "text";
}

function isReasoningPart(part: SessionMessagePart): part is { type: "reasoning"; text: string } {
  return part.type === "reasoning";
}

function isToolPart(
  part: SessionMessagePart,
): part is { type: "tool"; tool: string; state: ToolPartState } {
  return part.type === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const BUILTIN_OPENAI_FALLBACK: Record<string, string> = {
  "gpt-5": "gpt-4o",
  "o4-mini": "gpt-4o",
  o3: "gpt-4o",
  "o3-mini": "gpt-4o",
  o1: "gpt-4o",
  "o1-pro": "gpt-4o",
  "gpt-4.1": "gpt-4o",
  "gpt-4.1-mini": "gpt-4o",
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4-turbo": "gpt-4",
  "gpt-4": "gpt-4",
  "gpt-3.5-turbo": "gpt-3.5-turbo",
  "text-embedding-3-large": "text-embedding-3-large",
  "text-embedding-3-small": "text-embedding-3-small",
  "text-embedding-ada-002": "text-embedding-ada-002",
};

const BUILTIN_TRANSFORMERS_FALLBACK: Record<string, string> = {
  "claude-3-5-sonnet": "Xenova/claude-tokenizer",
  "claude-3-7-sonnet": "Xenova/claude-tokenizer",
  "claude-sonnet-4": "Xenova/claude-tokenizer",
  "claude-opus-4": "Xenova/claude-tokenizer",
  "gemini-2.5-pro": "Xenova/gemini-tokenizer",
  "llama-3.1": "Xenova/llama-tokenizer",
  "mistral-large": "Xenova/mistral-tokenizer",
  "deepseek-chat": "Xenova/deepseek-tokenizer",
};
