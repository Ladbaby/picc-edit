# picc-edit

Claude Code style **Edit** tool for [pi](https://pi.dev) — a faithful port of Claude Code's `Edit` tool, overriding pi's built-in `edit`.

Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.

> pi's built-in `edit` is a thin multi-edit wrapper: input `path` (relative or
> absolute) + `edits: [{oldText, newText}]`, no "must read first" guard, no
> quote normalization, no `replace_all`. This extension replicates Claude Code's
> `Edit`: the `file_path` + `old_string` / `new_string` (+ optional
> `replace_all`) input shape, a session-scoped read-first guard, exact string
> matching with curly-quote normalization, and a structured diff result.

## Usage

Install via `pi install npm:@ladbabynpm/picc-edit`.

## Tool

- **Name:** `edit` (default; overrides pi's built-in `edit`) or `Edit` — configurable (see below).
- **Parameters:** `file_path` (absolute, required), `old_string` (required), `new_string` (required), `replace_all` (optional, default `false`).
- **Behavior:**
  - **Existing file** — must have been read this session (any read tool), and must not
    have been modified since that read. `old_string` is matched (with curly-quote
    normalization) and must be unique unless `replace_all` is set. Returns `The file
    <path> has been updated successfully.` (or the `replace_all` variant) with a
    structured diff.
  - **New file** — `old_string` must be `""`; creates the file.
  - Writes with explicit LF handling (the model's sent line endings are respected
    as-is — no repo resampling).
- **Read-first guard:** reads are observed from pi `tool_result` events for any read
  tool (`read`/`Read`), so it works whether the file was read with pi's built-in
  `read` or picc-read's `Read`. The map is cleared on `session_start`.

## Configuration

| Setting | Where | Values | Default |
|---|---|---|---|
| `toolName` | `config.json` | `"edit"` \| `"Edit"` | `"edit"` |
| `PICC_EDIT_TOOL_NAME` | env | `"edit"` \| `"Edit"` | — |
| `PICC_EDIT_CONFIG_PATH` | env | absolute path to a config.json | `~/.pi/agent/extensions/picc-edit/config.json` |

Precedence for the tool name: `PICC_EDIT_TOOL_NAME` env > `config.json` > `"edit"`.

## What is omitted from the live source

No pi equivalent, so left out: permission checks (`checkWritePermissionForTool`),
`checkTeamMemSecrets`, `validateInputForSettingsFileEdit`, team-memory guards,
skill discovery, `diagnosticTracker`, `fileHistory`, LSP `didChange`/`didSave`,
`notifyVscodeFileUpdated`, `fetchSingleFileGitDiff`, and analytics.

## Development

```bash
npm install
npm run lint        # biome check
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
```

## References

- Claude Code Edit tool: `tools/FileEditTool/FileEditTool.ts` (+ `prompt.ts`, `utils.ts`, `constants.ts`)
- Claude Code helpers: `utils/file.ts`, `utils/fileRead.ts`, `utils/diff.ts`, `utils/path.ts`
