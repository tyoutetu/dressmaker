# Customer reference art (sent to the model)

- `rose.webp` — Rose's reference portrait
- `priya.webp` — Priya's reference portrait

These files are the identity reference for each customer. `lib/npcAssets.ts`
converts them to PNG with a correct MIME type before they go to the provider, so
the model never has to guess the format.

They are bundled into the serverless function by the `includeFiles` entry in
`vercel.json` (`assets/npcs/**`) and are not served publicly by the API.

Add a customer by dropping `<id>.webp` here, the matching portrait in
`web/public/npcs/`, and an entry in `api/lib/npcs.ts` with `enabled: true`.
