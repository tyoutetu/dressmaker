# Customer portraits shown on the picker cards

- `rose.webp`
- `priya.webp`

These are the supplied 1024x1024 source portraits, served as-is. The card frames
them with a CSS transform (see `portrait` in `lib/npcs.ts`), so the files
themselves are never edited or cropped. Adding a customer means adding a file
here, the reference art in `assets/npcs/`, and an entry in `lib/npcs.ts`.
