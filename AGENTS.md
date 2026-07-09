- Always make sure after any change is made, python and typescript SDKs remain the same
- Update all documentation: AGENTS.md, CHANGELOG.md, CONTRACT.md, README.md, docstrings of all related functions
- corresponding changes to pyproject.toml, package.json are done
- always build the typescript SDK before commiting changes
- keep commit messages brief and short, but still info dense
- always use commit_type: commit_description format (some commit types are feat, chore, build, fix, refactor, style)
- versioning is MAJOR.MINOR.PATCH, you can bump version based on your judgement, make sure versions are same for typescript and python and are bumped in pyproject.toml and package.json as well and they are always the same.

## Config write semantics (do not regress docs)

- `update_config` / `updateConfig` → `PATCH /api/v1/vault/configs/{tenant_id}/{service}` **replaces** entire `config` and/or `secrets` on the **service row**. Not a per-key merge.
- Omit a top-level field to leave that column unchanged; keys omitted **inside** a provided map are deleted from the row.
- Per-key merge with `_default` is **read-only** (`get_config` / `getConfig` / `preload` only).
- Never document or example a single-key PATCH body as a "merge update" without the full desired map.
