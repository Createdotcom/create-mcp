/**
 * Create App Hosting, slice X2 — the AI Gateway's PROVIDER and MODEL catalogue, as data (2026-10-03).
 * Dependency-free: read by the control plane (`apps/api/src/apps-hosting/ai-gateway/*`), the hosting MCP
 * tools, the CLI, the dashboard and the generated model list (`docs/apps/ai-models.md`).
 *
 * PROVIDERS. Each has ONE fixed origin (no customer-supplied URL exists anywhere — the SSRF guard in
 * `guardedTransport` refuses every other origin), an adapter (`openai` and `anthropic` native, `gemini`
 * native for Google — its own `usageMetadata` reports thinking tokens apart, which the OpenAI-compatible
 * endpoint does not reliably do — and `openai_compatible` for the rest), the env names of Create's key and
 * of the vendor agreement that lets Create's key serve customer traffic, where the provider processes data,
 * and whether it is an AGGREGATOR (routes to other companies' servers it picks).
 *
 * MODELS. Every price is a FOUNDER PROPOSAL (USD per 1M tokens). `price.checked` is the day the number was
 * read from the provider's own pricing page; a model whose price (or exact upstream id) was not read there
 * has `createKeys: false` — Create's keys never serve it, a project's own key (BYOK) may. A price with
 * `validUntil` stops Create's keys serving the model after that day (a scheduled provider price change).
 */

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

export const AI_PROVIDERS = ['openai', 'anthropic', 'google', 'mistral', 'xai', 'groq', 'together', 'fireworks', 'deepinfra', 'cerebras', 'openrouter'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const isAiProvider = (value: unknown): value is AiProvider => typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);

/** How the gateway talks to a provider. */
export type AiAdapter = 'openai' | 'anthropic' | 'gemini' | 'openai_compatible';
/** Where a provider processes requests. `global`: not pinned (an aggregator routes to servers anywhere). */
export type AiDataRegion = 'US' | 'EU' | 'global';
export const AI_DATA_REGIONS: readonly AiDataRegion[] = ['US', 'EU', 'global'];

export type AiProviderInfo = {
  id: AiProvider;
  label: string;
  /** The ONLY origin the gateway connects to for this provider. */
  origin: string;
  adapter: AiAdapter;
  /** Chat path under the origin (Gemini: the model-specific path is built from the catalogue's upstream id). */
  chatPath: string;
  /**
   * Embeddings path under the origin (OpenAI shape), or null when the gateway sends this provider no embeddings.
   * Gemini: the native `:batchEmbedContents` path is built from the catalogue's upstream id under this path.
   */
  embeddingsPath: string | null;
  company: { name: string; country: string };
  dataRegion: AiDataRegion;
  /** Routes requests to other companies' servers of its choosing (OpenRouter). */
  aggregator: boolean;
  /** Create's key for the provider (env). */
  envKey: string;
  /** The signed DPA (and BAA, where offered) reference that lets Create's key carry customer prompts (env). */
  agreementEnv: string;
  /** OpenAI-compatible receipts: are reasoning tokens inside `completion_tokens`, or reported apart? (`total_tokens` wins when larger.) */
  reasoningTokens: 'in_completion' | 'separate';
  /** OpenAI-compatible requests: the output-limit field and whether `stream_options.include_usage` is accepted. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  streamOptions: boolean;
  /** Field name for a sampling seed, or null when the provider has none. */
  seedField: 'seed' | 'random_seed' | null;
  /** One line on data terms for the runbook and the docs (what the founder checks before the agreement). */
  dataTerms: string;
};

const p = (info: Omit<AiProviderInfo, 'envKey' | 'agreementEnv' | 'embeddingsPath'> & { embeddingsPath?: string | null }): AiProviderInfo => ({
  ...info,
  embeddingsPath: info.embeddingsPath ?? null,
  envKey: `APPS_AI_${info.id.toUpperCase()}_API_KEY`,
  agreementEnv: `APPS_AI_${info.id.toUpperCase()}_VENDOR_AGREEMENT`,
});

export const AI_PROVIDER_INFO: Readonly<Record<AiProvider, AiProviderInfo>> = {
  openai: p({ id: 'openai', label: 'OpenAI', origin: 'https://api.openai.com', adapter: 'openai', chatPath: '/v1/chat/completions', embeddingsPath: '/v1/embeddings', company: { name: 'OpenAI', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_completion_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'API data not used for training by default; zero-retention by agreement; DPA + BAA available.' }),
  anthropic: p({ id: 'anthropic', label: 'Anthropic', origin: 'https://api.anthropic.com', adapter: 'anthropic', chatPath: '/v1/messages', company: { name: 'Anthropic', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_tokens', streamOptions: false, seedField: null, dataTerms: 'API data not used for training by default; zero-retention by agreement; DPA + BAA available.' }),
  google: p({ id: 'google', label: 'Google Gemini', origin: 'https://generativelanguage.googleapis.com', adapter: 'gemini', chatPath: '/v1beta/models', embeddingsPath: '/v1beta/models', company: { name: 'Google', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'separate', maxTokensField: 'max_tokens', streamOptions: false, seedField: 'seed', dataTerms: 'Paid tier only (free-tier prompts may be used to improve products); Gemini API terms + DPA; check BAA coverage (Vertex AI has one).' }),
  mistral: p({ id: 'mistral', label: 'Mistral AI', origin: 'https://api.mistral.ai', adapter: 'openai_compatible', chatPath: '/v1/chat/completions', embeddingsPath: '/v1/embeddings', company: { name: 'Mistral AI', country: 'FR' }, dataRegion: 'EU', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_tokens', streamOptions: false, seedField: 'random_seed', dataTerms: 'EU-hosted; DPA available; opt out of training on the paid plan; zero-retention on request.' }),
  xai: p({ id: 'xai', label: 'xAI', origin: 'https://api.x.ai', adapter: 'openai_compatible', chatPath: '/v1/chat/completions', company: { name: 'xAI', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'separate', maxTokensField: 'max_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'Check API data retention (30 days by default) and the DPA; no BAA known.' }),
  groq: p({ id: 'groq', label: 'Groq', origin: 'https://api.groq.com', adapter: 'openai_compatible', chatPath: '/openai/v1/chat/completions', company: { name: 'Groq', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'Open models on Groq hardware; no training on API data; DPA available; check zero-retention.' }),
  together: p({ id: 'together', label: 'Together AI', origin: 'https://api.together.xyz', adapter: 'openai_compatible', chatPath: '/v1/chat/completions', embeddingsPath: '/v1/embeddings', company: { name: 'Together AI', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'Open models; opt out of training and retention in account settings; DPA available.' }),
  fireworks: p({ id: 'fireworks', label: 'Fireworks AI', origin: 'https://api.fireworks.ai', adapter: 'openai_compatible', chatPath: '/inference/v1/chat/completions', company: { name: 'Fireworks AI', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'Open models; zero data retention by default for serverless (confirm); DPA available.' }),
  deepinfra: p({ id: 'deepinfra', label: 'DeepInfra', origin: 'https://api.deepinfra.com', adapter: 'openai_compatible', chatPath: '/v1/openai/chat/completions', embeddingsPath: '/v1/openai/embeddings', company: { name: 'DeepInfra', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'Open models hosted in the US; states no storage of prompts; confirm DPA.' }),
  cerebras: p({ id: 'cerebras', label: 'Cerebras', origin: 'https://api.cerebras.ai', adapter: 'openai_compatible', chatPath: '/v1/chat/completions', company: { name: 'Cerebras', country: 'US' }, dataRegion: 'US', aggregator: false, reasoningTokens: 'in_completion', maxTokensField: 'max_completion_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'Open models on Cerebras hardware; confirm retention and the DPA.' }),
  openrouter: p({ id: 'openrouter', label: 'OpenRouter', origin: 'https://openrouter.ai', adapter: 'openai_compatible', chatPath: '/api/v1/chat/completions', company: { name: 'OpenRouter', country: 'US' }, dataRegion: 'global', aggregator: true, reasoningTokens: 'in_completion', maxTokensField: 'max_tokens', streamOptions: true, seedField: 'seed', dataTerms: 'AGGREGATOR: requests go to third-party hosts OpenRouter picks (any country); the gateway asks for hosts that do not collect data. Never for health data.' }),
};

export const AI_PROVIDER_ORIGINS: Readonly<Record<AiProvider, string>> = Object.fromEntries(AI_PROVIDERS.map((id) => [id, AI_PROVIDER_INFO[id].origin])) as Record<AiProvider, string>;
export const AI_PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = Object.fromEntries(AI_PROVIDERS.map((id) => [id, AI_PROVIDER_INFO[id].label])) as Record<AiProvider, string>;

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

export type AiPlan = 'hobby' | 'pro';

/**
 * Per-token list prices in USD per 1M tokens — numerically the same as micro-USD per token. `cacheWrite`
 * is the price of writing a prompt-cache entry (Anthropic 5-minute writes and OpenAI's reported writes:
 * 1.25× input; providers that cache automatically without a write price charge the input price).
 * `cacheWrite1h` (2026-10-04): Anthropic's 1-hour cache writes (2× input); absent = `cacheWrite`.
 * Embedding models have `output: 0` (input-only price).
 */
export type AiRates = { input: number; cachedRead: number; cacheWrite: number; cacheWrite1h?: number; output: number };

/** What a model is for: chat (`/chat/completions`, `/messages`, `/responses`) or embeddings (`/embeddings`). */
export type AiModelKind = 'chat' | 'embedding';

/** An embedding model's shape (2026-10-04). */
export type AiEmbeddingSpec = {
  /** Default (and largest) output dimensions. */
  dimensions: number;
  /** The provider takes a smaller `dimensions` (OpenAI `dimensions`, Gemini `outputDimensionality`): its smallest, else null (not accepted). */
  minDimensions: number | null;
  /** The provider's per-input token limit (it refuses longer inputs; the gateway does not tokenise). */
  maxInputTokens: number;
  /** Inputs per request the provider accepts (the gateway's own cap may be lower). */
  maxBatch: number;
  /** The provider returns a usage receipt for embeddings. false: Create's keys never serve it (it would always bill the bound). */
  receipt: boolean;
};

/** Quality/capability tier shown to customers (and what the plan allowlist is made of). */
export const AI_MODEL_TIERS = ['frontier', 'strong', 'fast', 'budget'] as const;
export type AiModelTier = (typeof AI_MODEL_TIERS)[number];
export type AiModelSpeed = 'fastest' | 'fast' | 'standard';

/**
 * Reasoning ("thinking") tokens: `none` — the model does not reason; `included` — they count against
 * `max_tokens`, so the worst case already holds them; `extra` — they are NOT bounded by `max_tokens`, so the
 * reservation adds `reasoningReserveTokens` (the model's largest thinking budget) of output.
 */
export type AiReasoning = 'none' | 'included' | 'extra';

export type AiModel = {
  /** The id customers send: `<provider>/<model>`. The bare upstream id is accepted too when it is unique. */
  id: string;
  provider: AiProvider;
  /** The provider's own model id (never caller-supplied). */
  upstream: string;
  label: string;
  rates: AiRates;
  /**
   * Long-context price tier: past this many INPUT tokens the whole request is priced at `rates` — strictly
   * above it, or at-or-above it when `inclusive` (each provider's own documented boundary: Gemini "prompts
   * > 200k", xAI "≥200k").
   */
  longContext?: { aboveInputTokens: number; inclusive?: boolean; rates: AiRates };
  contextTokens: number;
  maxOutputTokens: number;
  /** Plan tiers whose projects may use it (derived from `tier` through `AI_PLAN_MODEL_TIERS`). */
  plans: readonly AiPlan[];
  /** false: the model rejects temperature/top_p/top_k (Claude 5-family); the gateway drops them on translated requests. */
  samplingParams: boolean;
  /**
   * Review H2: the largest `max_tokens` a NON-streaming request may ask for — what the model can generate
   * well inside the gateway's whole-request deadline at its slow end. Larger answers must stream.
   */
  maxNonStreamingOutputTokens: number;
  tier: AiModelTier;
  speed: AiModelSpeed;
  /** Function tools. */
  tools: boolean;
  reasoning: AiReasoning;
  reasoningReserveTokens: number;
  /** The provider accepts `reasoning_effort` for this model (otherwise the gateway does not forward it). */
  reasoningEffort: boolean;
  /**
   * Gemini: the model accepts `thinkingConfig.thinkingBudget`, so the gateway caps thinking at
   * `reasoningReserveTokens` — the reserve then is a provider-enforced bound, not only an estimate.
   */
  thinkingBudgetParam: boolean;
  /** The provider reports usage at the end of a STREAM. false: Create's keys serve it without streaming only. */
  streamUsage: boolean;
  openWeights: boolean;
  /** Who made the model (not who serves it). */
  origin: { developer: string; country: string };
  /** FOUNDER PROPOSAL. `checked`: the day the price was read on the provider's own page (null: never). */
  price: { checked: string | null; source: string; validUntil?: string };
  /** Create's keys may serve it (price and upstream id confirmed). false: the project's own key only. */
  createKeys: boolean;
  /** Chat or embeddings (2026-10-04). */
  kind: AiModelKind;
  /** Takes image inputs (`image_url` content parts) on chat and Responses (2026-10-04). */
  vision: boolean;
  /** Embedding models only. */
  embedding: AiEmbeddingSpec | null;
};

/** The plan allowlist, as data (FOUNDER: proposal). Free/Hobby: everything but the frontier tier; Pro and Team: all. */
export const AI_PLAN_MODEL_TIERS: Readonly<Record<AiPlan, readonly AiModelTier[]>> = {
  hobby: ['strong', 'fast', 'budget'],
  pro: ['frontier', 'strong', 'fast', 'budget'],
};

type Optional = 'samplingParams' | 'maxNonStreamingOutputTokens' | 'reasoningReserveTokens' | 'streamUsage' | 'tools' | 'reasoningEffort' | 'thinkingBudgetParam' | 'kind' | 'vision' | 'embedding';
type Seed = Omit<AiModel, 'plans' | Optional> & Partial<Pick<AiModel, Optional>>;

const r = (input: number, cachedRead: number, output: number, cacheWrite = input): AiRates => ({ input, cachedRead, cacheWrite, output });
/** Anthropic: 5-minute writes 1.25× input, 1-hour writes 2× input (anthropic.com pricing, prompt caching). */
const ra = (input: number, cachedRead: number, output: number): AiRates => ({ input, cachedRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2, output });
/** Embeddings: input only. */
const re = (input: number): AiRates => ({ input, cachedRead: input, cacheWrite: input, output: 0 });
const EMBED_CHECKED = '2026-10-04';
/** An embedding model's fixed fields (no output, no streaming, no tools; the budget tier: every plan). */
const embed = (s: Pick<AiModel, 'id' | 'provider' | 'upstream' | 'label' | 'openWeights' | 'origin' | 'price' | 'createKeys'> & { input: number; spec: AiEmbeddingSpec; contextTokens?: number }): Seed => ({
  id: s.id,
  provider: s.provider,
  upstream: s.upstream,
  label: s.label,
  rates: re(s.input),
  contextTokens: s.contextTokens ?? s.spec.maxInputTokens,
  maxOutputTokens: 0,
  maxNonStreamingOutputTokens: 0,
  tier: 'budget',
  speed: 'fast',
  reasoning: 'none',
  openWeights: s.openWeights,
  origin: s.origin,
  price: s.price,
  createKeys: s.createKeys && s.spec.receipt,
  kind: 'embedding',
  embedding: s.spec,
  tools: false,
  streamUsage: false,
  samplingParams: false,
  reasoningEffort: false,
  vision: false,
});
const CHECKED = '2026-10-03';
const UNCHECKED = (source: string) => ({ checked: null, source });

const SEEDS: Seed[] = [
  // --- Anthropic and OpenAI (unchanged from the X2 launch catalogue; prices checked 2026-09-28 / 2026-09-24) ---
  { id: 'anthropic/claude-opus-5', vision: true, provider: 'anthropic', upstream: 'claude-opus-5', label: 'Claude Opus 5', rates: ra(5, 0.5, 25), contextTokens: 1_000_000, maxOutputTokens: 128_000, samplingParams: false, maxNonStreamingOutputTokens: 4_096, tier: 'frontier', speed: 'standard', reasoning: 'included', openWeights: false, origin: { developer: 'Anthropic', country: 'US' }, price: { checked: '2026-09-28', source: 'anthropic.com pricing' }, createKeys: true },
  { id: 'anthropic/claude-sonnet-5', vision: true, provider: 'anthropic', upstream: 'claude-sonnet-5', label: 'Claude Sonnet 5', rates: ra(2, 0.2, 10), contextTokens: 1_000_000, maxOutputTokens: 128_000, samplingParams: false, tier: 'strong', speed: 'standard', reasoning: 'included', openWeights: false, origin: { developer: 'Anthropic', country: 'US' }, price: { checked: '2026-09-28', source: 'anthropic.com pricing' }, createKeys: true },
  { id: 'anthropic/claude-haiku-4-5', vision: true, provider: 'anthropic', upstream: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', rates: ra(1, 0.1, 5), contextTokens: 200_000, maxOutputTokens: 64_000, tier: 'fast', speed: 'fast', reasoning: 'included', openWeights: false, origin: { developer: 'Anthropic', country: 'US' }, price: { checked: '2026-09-28', source: 'anthropic.com pricing' }, createKeys: true },
  { id: 'openai/gpt-6-sol', vision: true, provider: 'openai', upstream: 'gpt-6-sol', label: 'GPT-6 Sol', rates: r(2, 0.2, 10, 2.5), contextTokens: 400_000, maxOutputTokens: 128_000, tier: 'strong', speed: 'standard', reasoning: 'included', openWeights: false, origin: { developer: 'OpenAI', country: 'US' }, price: { checked: '2026-09-24', source: 'site-generation pricing (developers.openai.com)' }, createKeys: true },
  { id: 'openai/gpt-6-astra', vision: true, provider: 'openai', upstream: 'gpt-6-astra', label: 'GPT-6 Astra', rates: r(10, 1, 50, 12.5), contextTokens: 400_000, maxOutputTokens: 128_000, tier: 'frontier', speed: 'standard', reasoning: 'included', openWeights: false, origin: { developer: 'OpenAI', country: 'US' }, price: { checked: '2026-09-24', source: 'site-generation pricing (developers.openai.com)' }, createKeys: true },

  // --- Google Gemini (native API; prices read on ai.google.dev/gemini-api/docs/pricing, paid tier) ---
  // Thinking tokens are billed as output and reported apart (`thoughtsTokenCount`); the reserve is a thinking budget.
  // Context windows are conservative lower bounds until confirmed (they only gate display and the long-context filter).
  { id: 'google/gemini-3.1-pro-preview', vision: true, provider: 'google', upstream: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', rates: r(2, 0.2, 12), longContext: { aboveInputTokens: 200_000, rates: r(4, 0.4, 18) }, contextTokens: 1_000_000, maxOutputTokens: 32_768, tier: 'frontier', speed: 'standard', reasoning: 'extra', reasoningReserveTokens: 32_768, openWeights: false, origin: { developer: 'Google', country: 'US' }, price: { checked: CHECKED, source: 'ai.google.dev pricing' }, createKeys: true },
  { id: 'google/gemini-2.5-pro', vision: true, provider: 'google', upstream: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', rates: r(1.25, 0.125, 10), longContext: { aboveInputTokens: 200_000, rates: r(2.5, 0.25, 15) }, contextTokens: 1_000_000, maxOutputTokens: 32_768, tier: 'strong', speed: 'standard', reasoning: 'extra', reasoningReserveTokens: 32_768, thinkingBudgetParam: true, openWeights: false, origin: { developer: 'Google', country: 'US' }, price: { checked: CHECKED, source: 'ai.google.dev pricing' }, createKeys: true },
  { id: 'google/gemini-3.5-flash', vision: true, provider: 'google', upstream: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', rates: r(1.5, 0.15, 9), contextTokens: 200_000, maxOutputTokens: 32_768, tier: 'strong', speed: 'fast', reasoning: 'extra', reasoningReserveTokens: 24_576, openWeights: false, origin: { developer: 'Google', country: 'US' }, price: { checked: CHECKED, source: 'ai.google.dev pricing' }, createKeys: true },
  // Promotional price "through December 31, 2026" ($1.50 / $7.50 from 2027-01-01): Create's keys stop serving it after validUntil until the row is updated.
  { id: 'google/gemini-3.8-flash', vision: true, provider: 'google', upstream: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', rates: r(0.75, 0.075, 3.75), contextTokens: 200_000, maxOutputTokens: 32_768, tier: 'fast', speed: 'fast', reasoning: 'extra', reasoningReserveTokens: 24_576, openWeights: false, origin: { developer: 'Google', country: 'US' }, price: { checked: CHECKED, source: 'ai.google.dev pricing (promotional)', validUntil: '2026-12-31' }, createKeys: true },

  // --- xAI (prices read on docs.x.ai/docs/models; ≥200k input priced double) ---
  { id: 'xai/grok-4.7', vision: true, provider: 'xai', upstream: 'grok-4.7', label: 'Grok 4.7', rates: r(2, 0.5, 6), longContext: { aboveInputTokens: 200_000, inclusive: true, rates: r(4, 1, 12) }, contextTokens: 500_000, maxOutputTokens: 32_768, tier: 'frontier', speed: 'standard', reasoning: 'extra', reasoningReserveTokens: 32_768, openWeights: false, origin: { developer: 'xAI', country: 'US' }, price: { checked: CHECKED, source: 'docs.x.ai models' }, createKeys: true },
  { id: 'xai/grok-4.3', vision: true, provider: 'xai', upstream: 'grok-4.3', label: 'Grok 4.3', rates: r(1.25, 0.2, 2.5), longContext: { aboveInputTokens: 200_000, inclusive: true, rates: r(2.5, 0.4, 5) }, contextTokens: 1_000_000, maxOutputTokens: 32_768, tier: 'strong', speed: 'fast', reasoning: 'extra', reasoningReserveTokens: 32_768, openWeights: false, origin: { developer: 'xAI', country: 'US' }, price: { checked: CHECKED, source: 'docs.x.ai models' }, createKeys: true },

  // --- Mistral (EU). Model ids and per-model prices not confirmed on the provider's API pricing page: own key only. ---
  { id: 'mistral/mistral-large-latest', provider: 'mistral', upstream: 'mistral-large-latest', label: 'Mistral Large 3', rates: r(0.5, 0.5, 1.5), contextTokens: 128_000, maxOutputTokens: 32_768, tier: 'strong', speed: 'fast', reasoning: 'none', openWeights: true, origin: { developer: 'Mistral AI', country: 'FR' }, price: UNCHECKED('mistral.ai/pricing marketing text ("Mistral Large $0.5 / $1.5"); API id unconfirmed'), createKeys: false },
  { id: 'mistral/mistral-small-latest', provider: 'mistral', upstream: 'mistral-small-latest', label: 'Mistral Small 4', rates: r(0.1, 0.1, 0.3), contextTokens: 128_000, maxOutputTokens: 32_768, tier: 'budget', speed: 'fast', reasoning: 'none', openWeights: true, origin: { developer: 'Mistral AI', country: 'FR' }, price: UNCHECKED('estimate; not on a pricing page read'), createKeys: false },

  // --- Groq (prices read on console.groq.com/docs/models) ---
  { id: 'groq/gpt-oss-120b', reasoningEffort: true, provider: 'groq', upstream: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Groq)', rates: r(0.15, 0.15, 0.6), contextTokens: 131_072, maxOutputTokens: 65_536, tier: 'fast', speed: 'fastest', reasoning: 'included', openWeights: true, origin: { developer: 'OpenAI', country: 'US' }, price: { checked: CHECKED, source: 'console.groq.com/docs/models' }, createKeys: true },
  { id: 'groq/gpt-oss-20b', reasoningEffort: true, provider: 'groq', upstream: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Groq)', rates: r(0.075, 0.075, 0.3), contextTokens: 131_072, maxOutputTokens: 65_536, tier: 'budget', speed: 'fastest', reasoning: 'included', openWeights: true, origin: { developer: 'OpenAI', country: 'US' }, price: { checked: CHECKED, source: 'console.groq.com/docs/models' }, createKeys: true },
  { id: 'groq/llama-3.3-70b-versatile', provider: 'groq', upstream: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)', rates: r(0.59, 0.59, 0.79), contextTokens: 131_072, maxOutputTokens: 32_768, tier: 'budget', speed: 'fastest', reasoning: 'none', openWeights: true, origin: { developer: 'Meta', country: 'US' }, price: UNCHECKED('earlier Groq list price; not shown on the models page read'), createKeys: false },
  { id: 'groq/llama-3.1-8b-instant', provider: 'groq', upstream: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (Groq)', rates: r(0.05, 0.05, 0.08), contextTokens: 131_072, maxOutputTokens: 32_768, tier: 'budget', speed: 'fastest', reasoning: 'none', openWeights: true, origin: { developer: 'Meta', country: 'US' }, price: UNCHECKED('earlier Groq list price; not shown on the models page read'), createKeys: false },

  // --- Together AI (prices read on together.ai/pricing) ---
  { id: 'together/gpt-oss-120b', reasoningEffort: true, provider: 'together', upstream: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Together)', rates: r(0.15, 0.15, 0.6), contextTokens: 131_072, maxOutputTokens: 32_768, tier: 'fast', speed: 'fast', reasoning: 'included', openWeights: true, origin: { developer: 'OpenAI', country: 'US' }, price: { checked: CHECKED, source: 'together.ai/pricing' }, createKeys: true },
  { id: 'together/llama-3.3-70b', provider: 'together', upstream: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B (Together)', rates: r(1.04, 1.04, 1.04), contextTokens: 131_072, maxOutputTokens: 32_768, tier: 'budget', speed: 'fast', reasoning: 'none', openWeights: true, origin: { developer: 'Meta', country: 'US' }, price: { checked: CHECKED, source: 'together.ai/pricing' }, createKeys: true },
  { id: 'together/deepseek-v4-flash', provider: 'together', upstream: 'deepseek-ai/DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash (Together)', rates: r(0.3, 0.3, 1.2), contextTokens: 128_000, maxOutputTokens: 32_768, tier: 'budget', speed: 'fast', reasoning: 'included', openWeights: true, origin: { developer: 'DeepSeek', country: 'CN' }, price: UNCHECKED('together.ai/pricing lists "DeepSeek V4.1 Flash"; API id unconfirmed'), createKeys: false },

  // --- DeepInfra (exact ids and prices read on deepinfra.com/pricing) ---
  { id: 'deepinfra/deepseek-v4-flash', provider: 'deepinfra', upstream: 'deepseek-ai/DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash (DeepInfra)', rates: r(0.09, 0.018, 0.18), contextTokens: 128_000, maxOutputTokens: 32_768, tier: 'budget', speed: 'fast', reasoning: 'included', openWeights: true, origin: { developer: 'DeepSeek', country: 'CN' }, price: { checked: CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true },
  { id: 'deepinfra/deepseek-v4-pro', provider: 'deepinfra', upstream: 'deepseek-ai/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro (DeepInfra)', rates: r(1.3, 0.1, 2.6), contextTokens: 128_000, maxOutputTokens: 32_768, tier: 'strong', speed: 'standard', reasoning: 'included', openWeights: true, origin: { developer: 'DeepSeek', country: 'CN' }, price: { checked: CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true },
  { id: 'deepinfra/kimi-k2.6', provider: 'deepinfra', upstream: 'moonshotai/Kimi-K2.6', label: 'Kimi K2.6 (DeepInfra)', rates: r(0.75, 0.15, 3.5), contextTokens: 128_000, maxOutputTokens: 32_768, tier: 'strong', speed: 'standard', reasoning: 'included', openWeights: true, origin: { developer: 'Moonshot AI', country: 'CN' }, price: { checked: CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true },
  { id: 'deepinfra/llama-3.3-70b', provider: 'deepinfra', upstream: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B (DeepInfra)', rates: r(0.1, 0.1, 0.32), contextTokens: 131_072, maxOutputTokens: 32_768, tier: 'budget', speed: 'fast', reasoning: 'none', openWeights: true, origin: { developer: 'Meta', country: 'US' }, price: { checked: CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true },
  { id: 'deepinfra/qwen3.5-9b', provider: 'deepinfra', upstream: 'Qwen/Qwen3.5-9B', label: 'Qwen 3.5 9B (DeepInfra)', rates: r(0.1, 0.1, 0.15), contextTokens: 32_768, maxOutputTokens: 8_192, tier: 'budget', speed: 'fast', reasoning: 'included', tools: true, openWeights: true, origin: { developer: 'Alibaba (Qwen)', country: 'CN' }, price: { checked: CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true },
  { id: 'deepinfra/gemma-4-31b', provider: 'deepinfra', upstream: 'google/gemma-4-31B-it-turbo', label: 'Gemma 4 31B (DeepInfra)', rates: r(0.09, 0.05, 0.34), contextTokens: 128_000, maxOutputTokens: 8_192, tier: 'budget', speed: 'fast', reasoning: 'none', openWeights: true, origin: { developer: 'Google', country: 'US' }, price: { checked: CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true },
  { id: 'deepinfra/mistral-small-3.2', provider: 'deepinfra', upstream: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', label: 'Mistral Small 3.2 24B (DeepInfra)', rates: r(0.075, 0.075, 0.2), contextTokens: 128_000, maxOutputTokens: 8_192, tier: 'budget', speed: 'fast', reasoning: 'none', openWeights: true, origin: { developer: 'Mistral AI', country: 'FR' }, price: { checked: CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true },

  // --- Fireworks, Cerebras: prices not on the pages read (fireworks.ai/pricing, cerebras.ai/pricing): own key only. ---
  { id: 'fireworks/gpt-oss-120b', reasoningEffort: true, provider: 'fireworks', upstream: 'accounts/fireworks/models/gpt-oss-120b', label: 'GPT-OSS 120B (Fireworks)', rates: r(0.15, 0.15, 0.6), contextTokens: 131_072, maxOutputTokens: 32_768, tier: 'fast', speed: 'fast', reasoning: 'included', openWeights: true, origin: { developer: 'OpenAI', country: 'US' }, price: UNCHECKED('assumed equal to other hosts; Fireworks price not read'), createKeys: false },
  { id: 'fireworks/llama-3.3-70b', provider: 'fireworks', upstream: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B (Fireworks)', rates: r(0.9, 0.9, 0.9), contextTokens: 131_072, maxOutputTokens: 16_384, tier: 'budget', speed: 'fast', reasoning: 'none', openWeights: true, origin: { developer: 'Meta', country: 'US' }, price: UNCHECKED('earlier Fireworks size-bucket price; not read'), createKeys: false },
  { id: 'cerebras/gpt-oss-120b', reasoningEffort: true, provider: 'cerebras', upstream: 'gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)', rates: r(0.25, 0.25, 0.69), contextTokens: 131_072, maxOutputTokens: 32_768, tier: 'fast', speed: 'fastest', reasoning: 'included', openWeights: true, origin: { developer: 'OpenAI', country: 'US' }, price: UNCHECKED('earlier Cerebras list price; not on the page read'), createKeys: false },
  { id: 'cerebras/qwen-3.8-27b', provider: 'cerebras', upstream: 'qwen-3.8-27b', label: 'Qwen 3.8 27B (Cerebras)', rates: r(0.6, 0.6, 1.2), contextTokens: 128_000, maxOutputTokens: 16_384, tier: 'budget', speed: 'fastest', reasoning: 'included', openWeights: true, origin: { developer: 'Alibaba (Qwen)', country: 'CN' }, price: UNCHECKED('placeholder; Cerebras price not read'), createKeys: false },

  // --- OpenRouter (AGGREGATOR; price depends on the host it picks): own key only. ---
  { id: 'openrouter/llama-3.3-70b', provider: 'openrouter', upstream: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OpenRouter)', rates: r(0.13, 0.13, 0.4), contextTokens: 131_072, maxOutputTokens: 16_384, tier: 'budget', speed: 'standard', reasoning: 'none', openWeights: true, origin: { developer: 'Meta', country: 'US' }, price: UNCHECKED('varies by routed host'), createKeys: false },
  { id: 'openrouter/deepseek-v4-flash', provider: 'openrouter', upstream: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash (OpenRouter)', rates: r(0.3, 0.3, 1.2), contextTokens: 128_000, maxOutputTokens: 16_384, tier: 'budget', speed: 'standard', reasoning: 'included', openWeights: true, origin: { developer: 'DeepSeek', country: 'CN' }, price: UNCHECKED('varies by routed host'), createKeys: false },

  // --- Embeddings (2026-10-04; `/apps-ai/v1/embeddings`). Input-only prices; FOUNDER PROPOSALS like every row. ---
  // OpenAI (read on developers.openai.com pricing, "Specialized models"): `dimensions` may shorten the vector.
  embed({ id: 'openai/text-embedding-3-small', provider: 'openai', upstream: 'text-embedding-3-small', label: 'text-embedding-3-small', input: 0.02, spec: { dimensions: 1536, minDimensions: 1, maxInputTokens: 8191, maxBatch: 2048, receipt: true }, openWeights: false, origin: { developer: 'OpenAI', country: 'US' }, price: { checked: EMBED_CHECKED, source: 'developers.openai.com pricing' }, createKeys: true }),
  embed({ id: 'openai/text-embedding-3-large', provider: 'openai', upstream: 'text-embedding-3-large', label: 'text-embedding-3-large', input: 0.13, spec: { dimensions: 3072, minDimensions: 1, maxInputTokens: 8191, maxBatch: 2048, receipt: true }, openWeights: false, origin: { developer: 'OpenAI', country: 'US' }, price: { checked: EMBED_CHECKED, source: 'developers.openai.com pricing' }, createKeys: true }),
  // Google (price read on ai.google.dev pricing, paid tier). The native batchEmbedContents answer documents NO token
  // receipt, so Create's keys never serve it (every request would bill the byte bound): own key only.
  embed({ id: 'google/gemini-embedding-2', provider: 'google', upstream: 'gemini-embedding-2', label: 'Gemini Embedding 2', input: 0.2, spec: { dimensions: 3072, minDimensions: 128, maxInputTokens: 8192, maxBatch: 100, receipt: false }, openWeights: false, origin: { developer: 'Google', country: 'US' }, price: { checked: EMBED_CHECKED, source: 'ai.google.dev pricing (no usage receipt documented)' }, createKeys: false }),
  // Mistral (EU): price not on a page read.
  embed({ id: 'mistral/mistral-embed', provider: 'mistral', upstream: 'mistral-embed', label: 'Mistral Embed', input: 0.1, spec: { dimensions: 1024, minDimensions: null, maxInputTokens: 8192, maxBatch: 512, receipt: true }, openWeights: false, origin: { developer: 'Mistral AI', country: 'FR' }, price: UNCHECKED('earlier Mistral list price; not on the page read'), createKeys: false }),
  // DeepInfra open models (exact ids and prices read on deepinfra.com/pricing, "Embeddings").
  embed({ id: 'deepinfra/bge-large-en-v1.5', provider: 'deepinfra', upstream: 'BAAI/bge-large-en-v1.5', label: 'BGE Large EN v1.5 (DeepInfra)', input: 0.01, spec: { dimensions: 1024, minDimensions: null, maxInputTokens: 512, maxBatch: 1024, receipt: true }, openWeights: true, origin: { developer: 'BAAI', country: 'CN' }, price: { checked: EMBED_CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true }),
  embed({ id: 'deepinfra/bge-m3', provider: 'deepinfra', upstream: 'BAAI/bge-m3', label: 'BGE-M3 (DeepInfra)', input: 0.01, spec: { dimensions: 1024, minDimensions: null, maxInputTokens: 8192, maxBatch: 1024, receipt: true }, openWeights: true, origin: { developer: 'BAAI', country: 'CN' }, price: { checked: EMBED_CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true }),
  embed({ id: 'deepinfra/e5-large-v2', provider: 'deepinfra', upstream: 'intfloat/e5-large-v2', label: 'E5 Large v2 (DeepInfra)', input: 0.01, spec: { dimensions: 1024, minDimensions: null, maxInputTokens: 512, maxBatch: 1024, receipt: true }, openWeights: true, origin: { developer: 'Microsoft (intfloat)', country: 'US' }, price: { checked: EMBED_CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true }),
  embed({ id: 'deepinfra/multilingual-e5-large-instruct', provider: 'deepinfra', upstream: 'intfloat/multilingual-e5-large-instruct', label: 'Multilingual E5 Large Instruct (DeepInfra)', input: 0.01, spec: { dimensions: 1024, minDimensions: null, maxInputTokens: 512, maxBatch: 1024, receipt: true }, openWeights: true, origin: { developer: 'Microsoft (intfloat)', country: 'US' }, price: { checked: EMBED_CHECKED, source: 'deepinfra.com/pricing' }, createKeys: true }),
  // Together: embedding prices are not on its pricing page as read: own key only.
  embed({ id: 'together/bge-base-en-v1.5', provider: 'together', upstream: 'BAAI/bge-base-en-v1.5', label: 'BGE Base EN v1.5 (Together)', input: 0.008, spec: { dimensions: 768, minDimensions: null, maxInputTokens: 512, maxBatch: 512, receipt: true }, openWeights: true, origin: { developer: 'BAAI', country: 'CN' }, price: UNCHECKED('earlier Together list price; embeddings not on together.ai/pricing as read'), createKeys: false }),
];

const nonStreamDefault = (s: Seed): number => Math.min(8_192, s.maxOutputTokens);

export const AI_MODELS: readonly AiModel[] = SEEDS.map((s) => ({
  ...s,
  samplingParams: s.samplingParams ?? true,
  maxNonStreamingOutputTokens: s.maxNonStreamingOutputTokens ?? nonStreamDefault(s),
  reasoningReserveTokens: s.reasoning === 'extra' ? (s.reasoningReserveTokens ?? 32_768) : 0,
  streamUsage: s.streamUsage ?? true,
  tools: s.tools ?? true,
  // OpenAI's own models take it (the OpenAI adapter forwards it as before); elsewhere only where a model says so.
  reasoningEffort: s.reasoningEffort ?? s.provider === 'openai',
  thinkingBudgetParam: s.thinkingBudgetParam ?? false,
  kind: s.kind ?? 'chat',
  vision: s.vision ?? false,
  embedding: s.embedding ?? null,
  plans: (['hobby', 'pro'] as const).filter((plan) => AI_PLAN_MODEL_TIERS[plan].includes(s.tier)),
}));

const BY_ID = new Map(AI_MODELS.map((m) => [m.id, m]));

/** `anthropic/claude-sonnet-5`, or a bare upstream id (`claude-sonnet-5`) when exactly one model has it. */
export function findAiModel(id: string | null | undefined): AiModel | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) return null;
  const direct = BY_ID.get(id);
  if (direct) return direct;
  const bare = AI_MODELS.filter((m) => m.upstream === id);
  return bare.length === 1 ? bare[0]! : null;
}

export const aiModelsForPlan = (plan: AiPlan): AiModel[] => AI_MODELS.filter((m) => m.plans.includes(plan));

/**
 * Create's keys may serve this model now: its price and upstream id were confirmed, and a scheduled price
 * change (`price.validUntil`, a UTC day) has not passed. Otherwise only a project's own key serves it.
 */
export function aiCreateKeysServe(model: AiModel, now: Date): boolean {
  if (!model.createKeys) return false;
  if (model.price.validUntil && now.getTime() >= Date.parse(`${model.price.validUntil}T00:00:00.000Z`) + 86_400_000) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Money helpers that depend on the model (rates by context size, the reasoning reserve)
// ---------------------------------------------------------------------------------------------

/** The rates a receipt is billed at: the long-context tier when its input passed the threshold. */
export function aiRatesFor(model: Pick<AiModel, 'rates' | 'longContext'>, inputTokens: number): AiRates {
  const lc = model.longContext;
  if (!lc) return model.rates;
  const past = lc.inclusive ? inputTokens >= lc.aboveInputTokens : inputTokens > lc.aboveInputTokens;
  return past ? lc.rates : model.rates;
}

/** The rates a RESERVATION uses: the dearer tier whenever the input bound could pass the threshold. */
export function aiReservationRates(model: Pick<AiModel, 'rates' | 'longContext'>, inputTokenBound: number): AiRates {
  return aiRatesFor(model, inputTokenBound);
}

/** The output a request can be billed for at worst: `max_tokens`, plus the thinking reserve when thinking is not bounded by it. */
export function aiWorstOutputTokens(model: Pick<AiModel, 'reasoning' | 'reasoningReserveTokens'>, maxTokens: number): number {
  return maxTokens + (model.reasoning === 'extra' ? model.reasoningReserveTokens : 0);
}

// ---------------------------------------------------------------------------------------------
// Cost transparency: a blended price, a cost index against a reference model, the cheapest model that can do X
// ---------------------------------------------------------------------------------------------

/** The reference model of the cost index (×1). */
export const AI_COST_REFERENCE_MODEL = 'anthropic/claude-sonnet-5';

/** USD per 1M tokens of a typical 3:1 input:output mix. */
export const aiBlendedRate = (rates: AiRates): number => (3 * rates.input + rates.output) / 4;

/** How expensive a model is next to the reference, two significant figures (×0.05 … ×5). */
export function aiCostIndex(model: Pick<AiModel, 'rates'>): number {
  const ref = BY_ID.get(AI_COST_REFERENCE_MODEL)!;
  const ratio = aiBlendedRate(model.rates) / aiBlendedRate(ref.rates);
  return Number(ratio.toPrecision(2));
}

/** What a request must be able to do ("the cheapest model that can …"). */
export type AiModelNeeds = { tools?: boolean; longContext?: boolean; reasoning?: boolean; vision?: boolean; /** Default `chat`. */ kind?: AiModelKind };
/** "Long context": at least this many tokens. */
export const AI_LONG_CONTEXT_TOKENS = 200_000;

export function aiModelCan(model: AiModel, needs: AiModelNeeds): boolean {
  return (
    model.kind === (needs.kind ?? 'chat') &&
    (!needs.tools || model.tools) &&
    (!needs.longContext || model.contextTokens >= AI_LONG_CONTEXT_TOKENS) &&
    (!needs.reasoning || model.reasoning !== 'none') &&
    (!needs.vision || model.vision)
  );
}

/** The models that can do `needs`, cheapest first (blended price, then id). */
export function aiCheapestFirst(models: readonly AiModel[], needs: AiModelNeeds = {}): AiModel[] {
  return models.filter((m) => aiModelCan(m, needs)).sort((a, b) => aiBlendedRate(a.rates) - aiBlendedRate(b.rates) || a.id.localeCompare(b.id));
}

const TIER_RANK: Record<AiModelTier, number> = { frontier: 3, strong: 2, fast: 1, budget: 0 };

/**
 * "Save money": for a model a project used, the cheapest OTHER model among `candidates` of the same tier
 * that can do at least what it can (tools, reasoning), and what the same tokens would have cost there
 * (provider list price; the caller applies markup). An ESTIMATE: other model families count tokens
 * differently. Null when nothing cheaper qualifies.
 */
export function aiCheaperAlternative(model: AiModel, candidates: readonly AiModel[], usage: { inputTokens: number; outputTokens: number }): { model: AiModel; costMicrousd: number; currentCostMicrousd: number } | null {
  const cost = (m: AiModel) => Math.ceil(usage.inputTokens * m.rates.input + usage.outputTokens * m.rates.output);
  const current = cost(model);
  let best: { model: AiModel; costMicrousd: number } | null = null;
  for (const m of candidates) {
    if (m.id === model.id || m.kind !== model.kind || TIER_RANK[m.tier] !== TIER_RANK[model.tier]) continue;
    // Embedding vectors from different models live in different spaces: never a drop-in "saving".
    if (model.kind === 'embedding') continue;
    if (model.tools && !m.tools) continue;
    if (model.reasoning !== 'none' && m.reasoning === 'none') continue;
    const c = cost(m);
    if (c < current && (!best || c < best.costMicrousd || (c === best.costMicrousd && m.id < best.model.id))) best = { model: m, costMicrousd: c };
  }
  return best ? { ...best, currentCostMicrousd: current } : null;
}

// ---------------------------------------------------------------------------------------------
// Aliases and the default model
// ---------------------------------------------------------------------------------------------

/**
 * Model aliases customers can call (`create/cheap` …): each resolves, per request, to the FIRST model in its
 * list that the project may use (plan, project allowlist, token, model policy) and that has a key that can
 * serve it. FOUNDER: proposals; changing a list is a deploy and needs no customer code change.
 * `create/default` is also what a request without `model` uses (a project may set its own default model).
 */
export const AI_MODEL_ALIASES: Readonly<Record<string, { description: string; models: readonly string[]; kind: AiModelKind }>> = {
  'create/default': { description: 'The project’s default model (its own setting, else Create’s default for the plan).', models: ['groq/gpt-oss-120b', 'together/gpt-oss-120b', 'deepinfra/llama-3.3-70b', 'anthropic/claude-haiku-4-5'], kind: 'chat' },
  'create/cheap': { description: 'A capable, cheap open model.', models: ['groq/gpt-oss-120b', 'together/gpt-oss-120b', 'deepinfra/llama-3.3-70b', 'groq/gpt-oss-20b', 'google/gemini-3.8-flash'], kind: 'chat' },
  'create/fast': { description: 'The fastest capable model.', models: ['groq/gpt-oss-120b', 'groq/gpt-oss-20b', 'google/gemini-3.8-flash', 'anthropic/claude-haiku-4-5'], kind: 'chat' },
  'create/best': { description: 'The strongest model the plan allows.', models: ['anthropic/claude-opus-5', 'openai/gpt-6-astra', 'google/gemini-3.1-pro-preview', 'anthropic/claude-sonnet-5', 'openai/gpt-6-sol', 'deepinfra/kimi-k2.6', 'deepinfra/deepseek-v4-pro', 'groq/gpt-oss-120b'], kind: 'chat' },
  /**
   * Embeddings (2026-10-04). Resolves to the first model the project may use — by plan, allowlist, token and
   * policy ONLY, never by which key happens to be available — so a project's vectors stay in one space. The
   * answer's `model` names it; pin a model id for stored vectors.
   */
  'create/embed': { description: 'An embedding model (the vectors’ space follows the project’s policy, not key availability).', models: ['openai/text-embedding-3-small', 'deepinfra/bge-m3'], kind: 'embedding' },
};
export const AI_DEFAULT_ALIAS = 'create/default';
export const isAiModelAlias = (id: string | null | undefined): boolean => typeof id === 'string' && Object.prototype.hasOwnProperty.call(AI_MODEL_ALIASES, id);

// ---------------------------------------------------------------------------------------------
// Per-project model policy
// ---------------------------------------------------------------------------------------------

/**
 * Which models a project may reach, beyond its plan and allowlist: by provider, by where the MODEL was made
 * (ISO 3166-1 alpha-2 of the developer), by where the PROVIDER processes data, open weights only, and no
 * aggregators. Enforced on every request (and in the views). Default: every provider hosted in the US or the
 * EU (an aggregator's hosts are `global`, so it is off until the project allows `global`).
 */
export type AiModelPolicy = {
  /** null: every provider (minus `denyProviders`). */
  allowProviders: AiProvider[] | null;
  denyProviders: AiProvider[];
  /** null: models from every country (minus `denyOriginCountries`). */
  allowOriginCountries: string[] | null;
  denyOriginCountries: string[];
  hostingRegions: AiDataRegion[];
  openWeightsOnly: boolean;
  noAggregators: boolean;
};

export const AI_DEFAULT_MODEL_POLICY: AiModelPolicy = { allowProviders: null, denyProviders: [], allowOriginCountries: null, denyOriginCountries: [], hostingRegions: ['US', 'EU'], openWeightsOnly: false, noAggregators: false };

const COUNTRY = /^[A-Z]{2}$/;

/** A stored or submitted policy, validated and normalised (sorted, unique, upper-case countries); null on anything malformed. */
export function normalizeAiModelPolicy(raw: unknown): AiModelPolicy | null {
  if (raw === null || raw === undefined) return { ...AI_DEFAULT_MODEL_POLICY };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = { ...AI_DEFAULT_MODEL_POLICY, ...(raw as Partial<AiModelPolicy>) };
  const providers = (list: unknown, nullable: boolean): AiProvider[] | null | undefined => {
    if (list === null && nullable) return null;
    if (!Array.isArray(list) || list.length > AI_PROVIDERS.length || !list.every(isAiProvider)) return undefined;
    return [...new Set(list as AiProvider[])].sort();
  };
  const countries = (list: unknown, nullable: boolean): string[] | null | undefined => {
    if (list === null && nullable) return null;
    if (!Array.isArray(list) || list.length > 50 || !list.every((c) => typeof c === 'string' && COUNTRY.test(c.toUpperCase()))) return undefined;
    return [...new Set((list as string[]).map((c) => c.toUpperCase()))].sort();
  };
  const allowProviders = providers(v.allowProviders, true);
  const denyProviders = providers(v.denyProviders, false);
  const allowOriginCountries = countries(v.allowOriginCountries, true);
  const denyOriginCountries = countries(v.denyOriginCountries, false);
  const regions = Array.isArray(v.hostingRegions) && v.hostingRegions.every((r) => (AI_DATA_REGIONS as readonly unknown[]).includes(r)) ? [...new Set(v.hostingRegions)].sort() : undefined;
  if (allowProviders === undefined || denyProviders === undefined || allowOriginCountries === undefined || denyOriginCountries === undefined || regions === undefined) return null;
  if (typeof v.openWeightsOnly !== 'boolean' || typeof v.noAggregators !== 'boolean') return null;
  const known = new Set(Object.keys(AI_DEFAULT_MODEL_POLICY));
  if (Object.keys(raw as object).some((k) => !known.has(k))) return null;
  return { allowProviders, denyProviders: denyProviders!, allowOriginCountries, denyOriginCountries: denyOriginCountries!, hostingRegions: regions, openWeightsOnly: v.openWeightsOnly, noAggregators: v.noAggregators };
}

/**
 * Review M1 (fail CLOSED): a STORED policy that no longer validates (a provider or region renamed, a value
 * written by an older build, a hand edit) is never replaced by the default. Deny lists keep their known
 * entries (unknown ones dropped); allow lists keep their known entries and, if none is left, allow NOTHING;
 * malformed flags and regions take their restrictive value; unknown fields are ignored. `needsAttention`
 * says something was dropped or repaired — the API logs it and shows it so a person re-saves the policy.
 */
export function storedAiModelPolicy(raw: unknown): { policy: AiModelPolicy; needsAttention: boolean } {
  if (raw === null || raw === undefined) return { policy: { ...AI_DEFAULT_MODEL_POLICY }, needsAttention: false };
  const exact = normalizeAiModelPolicy(raw);
  if (exact) return { policy: exact, needsAttention: false };
  const nothing: AiModelPolicy = { allowProviders: [], denyProviders: [], allowOriginCountries: [], denyOriginCountries: [], hostingRegions: [], openWeightsOnly: true, noAggregators: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { policy: nothing, needsAttention: true };
  const v = raw as Record<string, unknown>;
  const country = (c: unknown): c is string => typeof c === 'string' && COUNTRY.test(c.toUpperCase());
  const known = <T,>(list: unknown, ok: (x: unknown) => x is T, map: (x: T) => T = (x) => x): T[] => (Array.isArray(list) ? [...new Set(list.filter(ok).map(map))].sort() : []);
  /** null/absent = no restriction; an array keeps its known entries ([] when none survive: allow nothing); anything else = allow nothing. */
  const allow = <T,>(list: unknown, ok: (x: unknown) => x is T, map?: (x: T) => T): T[] | null => (list === null || list === undefined ? null : known(list, ok, map));
  const policy: AiModelPolicy = {
    allowProviders: allow(v.allowProviders, isAiProvider),
    denyProviders: known(v.denyProviders, isAiProvider),
    allowOriginCountries: allow(v.allowOriginCountries, country, (c) => c.toUpperCase()),
    denyOriginCountries: known(v.denyOriginCountries, country, (c) => c.toUpperCase()),
    hostingRegions: v.hostingRegions === undefined ? [...AI_DEFAULT_MODEL_POLICY.hostingRegions] : known(v.hostingRegions, (x): x is AiDataRegion => (AI_DATA_REGIONS as readonly unknown[]).includes(x)),
    openWeightsOnly: typeof v.openWeightsOnly === 'boolean' ? v.openWeightsOnly : v.openWeightsOnly === undefined ? false : true,
    noAggregators: typeof v.noAggregators === 'boolean' ? v.noAggregators : v.noAggregators === undefined ? false : true,
  };
  return { policy, needsAttention: true };
}

/** Why the policy blocks `model` (null: allowed). */
export function aiPolicyBlocks(policy: AiModelPolicy, model: AiModel): string | null {
  const provider = AI_PROVIDER_INFO[model.provider];
  if (policy.allowProviders && !policy.allowProviders.includes(model.provider)) return `${provider.label} is not in the project’s allowed providers`;
  if (policy.denyProviders.includes(model.provider)) return `${provider.label} is denied by the project’s model policy`;
  if (policy.allowOriginCountries && !policy.allowOriginCountries.includes(model.origin.country)) return `models made in ${model.origin.country} are not allowed by the project’s model policy`;
  if (policy.denyOriginCountries.includes(model.origin.country)) return `models made in ${model.origin.country} are denied by the project’s model policy`;
  if (!policy.hostingRegions.includes(provider.dataRegion)) return `${provider.label} processes data in region ${provider.dataRegion}, which the project’s model policy does not allow`;
  if (policy.openWeightsOnly && !model.openWeights) return 'the project’s model policy allows open-weights models only';
  if (policy.noAggregators && provider.aggregator) return `${provider.label} is an aggregator, which the project’s model policy does not allow`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The model list page (docs), generated from this catalogue
// ---------------------------------------------------------------------------------------------

const money = (n: number): string => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
const served = (m: AiModel): string => (m.createKeys ? (m.price.validUntil ? `yes (price until ${m.price.validUntil})` : 'yes') : 'own key only');

// ---------------------------------------------------------------------------------------------
// Images and embeddings: bounds the reservation uses (2026-10-04)
// ---------------------------------------------------------------------------------------------

/**
 * Tokens the RESERVATION holds per image, per provider — upper bounds from each provider's documented sizing,
 * rounded up (FOUNDER: conservative proposals; the bill is always the provider's receipt, an excess is an
 * alerted `overrun`). The formulas:
 *   - OpenAI: tile models 85 + 170 × tiles (≤ 1,445 at `high`); patch models ≤ 1,536 patches × a model
 *     multiplier (≤ ~2.7k); newer high-resolution modes more — 8,192 covers every documented case.
 *   - Anthropic: ≈ width × height / 750 after its resize (≤ ~1,600 at 1.15 MP; high-resolution models up to
 *     ~4,800) — 5,000.
 *   - Gemini: 258 per 768 × 768 tile (2.x) or a fixed 280–2,240 by media resolution (3.x); a large image
 *     can tile many times — 16,384.
 *   - Any other (OpenAI-compatible hosts' vision models): resolution-dependent and undocumented — 16,384.
 */
export const AI_IMAGE_TOKEN_BOUNDS: Readonly<Record<'openai' | 'anthropic' | 'google' | 'default', { tokens: number; basis: string }>> = {
  openai: { tokens: 8_192, basis: 'tiles 85 + 170 × tiles (≤ 1,445), patches ≤ 1,536 × model multiplier; rounded up for high-resolution modes' },
  anthropic: { tokens: 5_000, basis: '≈ width × height / 750 after resize (≤ ~1,600; high-resolution models ≤ ~4,800)' },
  google: { tokens: 16_384, basis: '258 per 768 × 768 tile (2.x) or 280–2,240 by media resolution (3.x); many tiles for large images' },
  default: { tokens: 16_384, basis: 'undocumented per host; resolution-dependent' },
};

export const aiImageTokenBound = (provider: AiProvider): number => (AI_IMAGE_TOKEN_BOUNDS[provider as 'openai' | 'anthropic' | 'google'] ?? AI_IMAGE_TOKEN_BOUNDS.default).tokens;

/** Inputs one `/embeddings` request may carry (a model's own `maxBatch` may be lower). */
export const AI_EMBEDDING_MAX_INPUTS = 2_048;
/**
 * The answer's size bound: inputs × dimensions may be at most this many numbers (≈ 10 MB of JSON), so a
 * batch of large vectors cannot blow the answer buffer. 3,072 dimensions → 170 inputs; 1,024 → 512.
 */
export const AI_EMBEDDING_MAX_FLOATS = 524_288;
/** Special tokens a provider may add per embedding input (BOS/EOS and the like): the bound adds this per input. */
export const AI_EMBEDDING_PER_INPUT_TOKENS = 8;

/** An upper bound on an embedding request's billable tokens: ONE token per UTF-8 byte of every input, plus per-input special tokens. */
export function aiEmbeddingInputBound(inputBytes: readonly number[]): number {
  return inputBytes.reduce((sum, b) => sum + b + AI_EMBEDDING_PER_INPUT_TOKENS, 0);
}

/** Markdown for `/docs/apps/ai-models.md` and the committed `docs/apps/ai-models.md` (a test pins them equal). */
export function aiModelsMarkdown(): string {
  const lines: string[] = [
    '# AI Gateway models',
    '',
    `Generated from the catalogue in \`packages/shared/src/apps-ai-catalog.ts\` — do not edit by hand. Prices are USD per 1M tokens at the provider's list price (Create adds its markup on its own keys) and are **proposals pending founder confirmation**. "Own key only" models are served only with the project's own provider key until their price is confirmed. Cost index: a 3:1 input:output blend relative to \`${AI_COST_REFERENCE_MODEL}\` (×1).`,
    '',
    '## Aliases',
    '',
    '| Alias | Resolves to (first the project may use) |',
    '|---|---|',
    ...Object.entries(AI_MODEL_ALIASES).map(([alias, a]) => `| \`${alias}\` | ${a.models.map((m) => `\`${m}\``).join(', ')} — ${a.description} |`),
    '',
    '## Chat models (cheapest first)',
    '',
    'Cache write: the price of writing a prompt-cache entry (Anthropic 5-minute writes; the 1-hour price in brackets). Images: the model takes `image_url` parts on `/chat/completions` and `input_image` on `/responses`; the reservation holds a per-image bound (below), the bill is the provider’s receipt.',
    '',
    '| Model | Tier | Plans | In / cached / cache write / out | Cost index | Context | Speed | Tools | Images | Reasoning | Open weights | Made by | Served by (region) | Create keys |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...aiCheapestFirst(AI_MODELS).map((m) => {
      const info = AI_PROVIDER_INFO[m.provider];
      const lc = m.longContext ? ` (${m.longContext.inclusive ? '≥' : '>'}${m.longContext.aboveInputTokens / 1000}k in: ${money(m.longContext.rates.input)} / ${money(m.longContext.rates.output)})` : '';
      const write = `${money(m.rates.cacheWrite)}${m.rates.cacheWrite1h !== undefined ? ` (1h ${money(m.rates.cacheWrite1h)})` : ''}`;
      return `| \`${m.id}\` | ${m.tier} | ${m.plans.join(', ')} | ${money(m.rates.input)} / ${money(m.rates.cachedRead)} / ${write} / ${money(m.rates.output)}${lc} | ×${aiCostIndex(m)} | ${Math.round(m.contextTokens / 1000)}k | ${m.speed} | ${m.tools ? 'yes' : 'no'} | ${m.vision ? 'yes' : 'no'} | ${m.reasoning} | ${m.openWeights ? 'yes' : 'no'} | ${m.origin.developer} (${m.origin.country}) | ${info.label}${info.aggregator ? ' (aggregator)' : ''} (${info.dataRegion}) | ${served(m)} |`;
    }),
    '',
    '## Embedding models (cheapest first)',
    '',
    '`POST /apps-ai/v1/embeddings` (OpenAI shape). Input-only prices. Vectors from different models are not comparable: pin a model id for stored vectors (`create/embed` follows the project’s policy, never key availability).',
    '',
    '| Model | Plans | Input | Dimensions | `dimensions` param | Max input tokens | Batch | Open weights | Made by | Served by (region) | Create keys |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...aiCheapestFirst(AI_MODELS, { kind: 'embedding' }).map((m) => {
      const info = AI_PROVIDER_INFO[m.provider];
      const e = m.embedding!;
      return `| \`${m.id}\` | ${m.plans.join(', ')} | ${money(m.rates.input)} | ${e.dimensions} | ${e.minDimensions === null ? 'no' : `${e.minDimensions}–${e.dimensions}`} | ${e.maxInputTokens} | ${Math.min(e.maxBatch, AI_EMBEDDING_MAX_INPUTS)} | ${m.openWeights ? 'yes' : 'no'} | ${m.origin.developer} (${m.origin.country}) | ${info.label} (${info.dataRegion}) | ${served(m)}${e.receipt ? '' : ' (no usage receipt)'} |`;
    }),
    '',
    '## Image inputs: what the reservation holds per image',
    '',
    'The gateway does not decode images, so before a request it reserves a conservative per-image token bound for the provider (the bill is always the provider’s receipt). Image bytes do not count toward the 1 MB text bound.',
    '',
    '| Provider | Tokens reserved per image | Basis |',
    '|---|---|---|',
    ...Object.entries(AI_IMAGE_TOKEN_BOUNDS).map(([p, b]) => `| ${p === 'default' ? 'any other' : AI_PROVIDER_INFO[p as AiProvider].label} | ${b.tokens.toLocaleString('en-US')} | ${b.basis} |`),
    '',
    '## Providers',
    '',
    '| Provider | Origin | Company | Region | Aggregator | Data terms |',
    '|---|---|---|---|---|---|',
    ...AI_PROVIDERS.map((id) => {
      const i = AI_PROVIDER_INFO[id];
      return `| ${i.label} (\`${id}\`) | ${i.origin} | ${i.company.name} (${i.company.country}) | ${i.dataRegion} | ${i.aggregator ? 'yes' : 'no'} | ${i.dataTerms} |`;
    }),
    '',
  ];
  return lines.join('\n');
}
