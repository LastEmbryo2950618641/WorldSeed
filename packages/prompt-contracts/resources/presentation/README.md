# Shared presentation presets

The two directories under `表现输出` contain the original reusable presentation
library: 41 prose style documents and 11 description documents. Keep these files
in version control. The desktop package includes this directory through its
existing `prompt-contracts/resources` resource mapping.

At startup the backend installs these presets into the application data directory
`shared-workspace/表现输出`. All projects read and edit that single writable library.
Bundled files are install-time seeds, not a second editable copy. Existing edits
and user deletions survive restarts. New preset paths are installed on upgrades;
changes to already installed presets do not overwrite user content.

Legacy project rules are imported once. Conflicting contents are retained with a
content-derived migration suffix. Original project files remain untouched as
backups. Project history does not restore shared presentation rules.

`表现输出/本作品描写` remains project-local and is not part of this library.
