# Reader

Reader is an Obsidian plugin for reading EPUB files inside your vault.

## Features

- Open `.epub` files in a dedicated reader view
- Search and open EPUB files from the command palette
- Navigate with:
  - Desktop right sidebar toolbar: `Prev` / `Next`, TOC, chapter title
  - Mobile top toolbar: `Prev` / `Next`, TOC, chapter title (toggle with `Show controls`)
  - Keyboard: `Left Arrow` / `Right Arrow`
  - Commands: `Previous page` / `Next page`
- Jump by table of contents (TOC)
- Show current chapter title
- Restore your last reading position when reopening a book
- Choose page layout:
  - `Spread (auto)`
  - `Two pages`
  - `Single page`
  - `Infinite scroll`
- Choose appearance:
  - `Follow Obsidian`
  - `Light`
  - `Dark`
  - `Sepia`
- Footnote popover support:
  - Desktop: hover
  - Touch devices: long press

## How to use

1. Open the command palette.
2. Run `Open epub file`.
3. Select a book from the list.
4. On desktop, use the right sidebar toolbar. On mobile, use the top toolbar.
5. You can also use arrow keys or commands for page navigation.
6. Use the TOC dropdown to jump between sections.

## Settings

- `Reopen at last position`: Continue where you left off.
- `Page display mode`: Choose paged or continuous reading style.
- `Appearance theme`: Match Obsidian or force light/dark/sepia.

## Privacy

Reader works locally in your vault and does not require network access for reading EPUB files.
