# AI-assisted attribute mapping

The web3 mapping editor supports suggestions for the selected category of Wildberries (type 2), Ozon (type 3) and Yandex Market (type 9). Suggestions connect marketplace attributes to existing OpenPIM attributes. They do not generate product values, create attributes, execute expressions, save settings or publish products.

## Configuration

Copy the variables from `ai-mapping.env.example` to the **server** `.env` or deployment environment. Set the API key and a model identifier supported by the selected provider. Restart the server after changing environment variables. Update both server and web3 for this feature.

- `OPENPIM_AI_MAPPING_ENABLED`: only the exact value `true` enables the feature; disabled by default.
- `OPENPIM_AI_PROVIDER`: `openai` (default) or `openai-compatible`.
- `OPENPIM_AI_BASE_URL`: API base URL, ending in `/v1` for the standard OpenAI API. The transport appends `/chat/completions`. For `openai-compatible`, an explicit URL is required.
- `OPENPIM_AI_API_KEY`: required for `openai`; optional for compatible local endpoints. Sent as a Bearer header only to the configured provider. Redirects are refused.
- `OPENPIM_AI_MODEL`: required provider model identifier. The model must support chat messages and the configured structured response format.
- `OPENPIM_AI_RESPONSE_FORMAT`: `json_schema` (default, strict schema) or `json_object` for providers without strict schema support. Server validation applies to both.
- `OPENPIM_AI_TIMEOUT_MS`: total budget for LLM batches, default 60000, allowed 1–300000 milliseconds. Marketplace metadata loading uses the existing channel handler and its transport policies.
- `OPENPIM_AI_MAPPING_BATCH_SIZE`: default 20, allowed 1–30. Lower this when model context/output limits are reached. At most 200 marketplace characteristics are accepted per operation.
- `OPENPIM_AI_USE_SYSTEM_CA`: disabled by default. Set `true` when the configured HTTPS provider's certificate is trusted by the operating system but absent from Node.js's default CA store (for example, a trusted company proxy). This combines Node.js's default CAs with the system store for AI requests only, and keeps certificate verification enabled. Requires a Node.js version exposing `tls.getCACertificates`; verified with Node.js 22.22.3 on Windows. Restart the server after changing this setting.

An OpenAI-compatible local deployment can use, for example, `OPENPIM_AI_PROVIDER=openai-compatible`, `OPENPIM_AI_BASE_URL=http://127.0.0.1:11434/v1`, a locally available model identifier and `OPENPIM_AI_RESPONSE_FORMAT=json_object`. Model/endpoint support must be verified on that deployment. Cloud services may have different structured-output capabilities.

Credentials must stay out of frontend environment variables. The browser receives only availability and suggestions. The provider receives allowlisted characteristic names, descriptions, groups, types and candidate identifiers; marketplace request headers/configuration and product values are never included. Metadata is transmitted to the selected provider, so use an endpoint appropriate for your catalog data.

## User workflow

1. Open a supported channel, select a category and click **Fill with AI**.
2. Review the proposal table. Direct matches are checked initially; numeric, dictionary, relation and model-flagged matches require explicit selection. Unmatched or changed rows cannot be selected.
3. Click **Apply selected**, review the populated editor and save the channel normally.
4. **Undo AI mappings** restores unchanged AI-applied fields; later manual edits remain. After saving, an undo must also be saved if it should persist.

Existing `attrIdent` and `expr` values are preserved. Standard fields starting with `#` and duplicated marketplace attribute IDs are excluded. Localized PIM attributes use the selected content-language suffix (`identifier#ru`, for example). Mapping options, expression fields and source-of-update flags remain untouched. WB/Ozon changes use the existing `changed`/`readingTime` conflict protocol.

Applying does not convert units or reconcile dictionaries. Those mappings must be inspected using the existing expression/options editor. Suggestions never execute generated JavaScript.

## Limits and validation

Candidate ranking uses exact names, shared words, identifiers, groups and dictionary metadata, with the first 30 candidates per characteristic. Visible PIM groups and applicable item types are considered. This is a lexical shortlist, not an embeddings index: unusual synonyms or large ambiguous catalogs can miss a useful candidate. Evaluate on manually reviewed categories before relying on its output.

Before ranking, saved category visibility roots and their subtrees restrict attributes in the same visibility relation domain. Other incoming sources of the selected products on that relation are included. Unknown relation domains, multiple relation domains and standard product-path attributes are preserved rather than excluded by guesswork. Without saved visibility roots the previous type/group filtering remains. See [visibility filtering and Kuppersberg measurements](../ai-mapping/visibility-filter.md).

The server requires authentication, channel configuration edit access and channel view/edit access, and loads all data from the current tenant. It verifies category IDs and language, reloads characteristics through the existing channel handler and validates every proposed candidate. An unknown PIM candidate becomes an unmatched row requiring review; valid suggestions remain available. Unknown marketplace IDs, duplicates, malformed/truncated/refused responses and provider errors fail the operation without partial writes. Only one suggestion request per tenant per server process is allowed at a time; this is not a cluster-wide lock or a persistent rate limit.

If the selected category changes while a request is running, the UI discards its result. At application time, it rechecks each original row, candidate and empty field. It cannot overwrite changed rows. Results do not contain a calibrated accuracy score.

## Verification

Server: `node --test -r ts-node/register/transpile-only tests/ai-mapping.test.cjs tests/ai-mapping-access.test.cjs`, then `npx tsc -p . --noEmit`. Transport tests use a local fake provider, never real keys.

Web3: `npm run test:run -- tests/channels/aiMapping.test.js tests/channels/AIMappingAssistant.test.js tests/channels/aiMappingStore.test.js tests/channels/MappingAttributesAI.test.js tests/channels/MappingAttributesCopyAction.spec.js`, targeted lint, then `npm run build`.
