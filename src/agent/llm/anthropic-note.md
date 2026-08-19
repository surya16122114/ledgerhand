# Adding another provider

`LlmProvider` is one method. A second provider is a file like `openai.ts` that
maps `LlmRequest` onto that vendor's tool-calling API and maps the response back
to `LlmToolCall[]`.

Nothing above this directory needs to change: the loop consumes `LlmProvider`,
and `provider.model` is what lands in `provenance.model`, so an artifact always
records which model actually wrote it.

The reason this repo ships one live provider rather than three is that a provider
adapter is the least interesting code in the project, and a second one would not
demonstrate anything the first does not.
