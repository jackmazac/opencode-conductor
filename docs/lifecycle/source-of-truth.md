# Lifecycle Source Of Truth

Lifecycle modules must prefer vendor-native sources over inferred contracts.

Rules:

- `origin` maps generated output to the schema, IDL, or generator config that owns it.
- `seal` identifies public API objects from native export and protocol surfaces, not semantic guesses.
- `portage` identifies migrations from migration files and database object names.
- `torch` identifies flags from provider registries or static flag keys until provider truth exists.
- A lifecycle decision can block only when its source evidence is fresh for the current spine epoch.
- Stale evidence is historical context only unless a caller explicitly asks for historical reads.

Do not invent parallel contracts when a framework, generator, migration tool, or provider already defines the source of truth.
