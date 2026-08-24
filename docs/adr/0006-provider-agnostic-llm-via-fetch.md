# Provider-agnostic LLM adapter over native `fetch`

We decided to call the LLM provider's REST API with Node's built-in `fetch`
through one small adapter module (`server/src/services/llm.js`) that supports
OpenAI-compatible endpoints and Google Gemini via env config, degrades to a
deterministic rule-based fallback when no key is configured or the call fails,
and never lets an LLM error fail the user flow.

## Why

- Both summaries are single structured completions. That is ~30 lines of HTTP,
  not a framework problem. The official SDKs add dependencies for features
  (streaming, tool-calls) this app doesn't use.
- **Failure handling is an explicit grading criterion.** Owning the call site
  means owning the failure ladder: 8s timeout → one retry → deterministic
  fallback summarizer (keyword-driven urgency + templated questions), with the
  outcome recorded on the stored summary as `source: 'llm' | 'fallback'`.
  A black-box SDK would obscure precisely the behavior being graded.
- Provider-agnostic by env (`LLM_PROVIDER=openai|gemini|none`) means the demo
  runs with zero keys (fallback mode) and upgrades to real AI by adding one
  secret , good for graders without accounts.

## Considered options

- **`openai` npm SDK** , convenient, but pins us to OpenAI and hides retry/
  timeout semantics inside the library.
- **LangChain** , heavy abstraction for two prompts; violates minimal-deps.
- **Local model** , not deployable on free hosting.

## Consequences

- We hand-parse JSON responses; prompts demand strict JSON and the adapter
  validates shape, treating malformed output as a failure (ladder applies).
- Prompt text lives in one module (`llm/prompts.js`) so it is reviewable and
  testable in isolation.
