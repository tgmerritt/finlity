# CLAUDE.md: Finlity frontend (`src/web/`)

Repo-wide guidance lives in the root `CLAUDE.md`. This file covers the TypeScript/Vite frontend only.

## Stack

TypeScript (ES2022, strict), Vite, Vitest, ESLint + Prettier. Plotly.js is loaded via CDN. There is no React/Vue framework: the UI is direct DOM manipulation through typed helpers in `src/ui/`.

**Module aliases:** import from `@/...`, which resolves to `src/web/src/`.

## Build behavior

- Output goes to `src/web/dist/` (entry: `app.js`, chunks under `chunks/`).
- **Sourcemaps only in dev.** Production strips ~744 KB of `.map` files; do not enable them for a production build.
- **`manualChunks`** (in `vite.config.ts`) splits the bundle into `page-*`, `feature-*`, and `shared` chunks so changing one page does not bust the cache for the rest. Keep new pages/features in the existing chunk groups rather than collapsing them; production `app.js` is ~8 KB (gzip ~3.25 KB) and should stay that way.
- The Dockerfile builds the frontend in a separate Node 20 stage, then copies `dist/` into the Python image. Production Docker bakes `dist/` in, so rebuild the image after a frontend change.
- The dev container does **not** hot-reload TypeScript. Run `npm run dev` here separately and let Vite proxy `/api` to the FastAPI dev container.

## Design system

GitHub Primer color palette (commit `07b1b09` redesign).

**All UI must have proper contrast in both light and dark modes.** Test hover states, tooltips, and chart elements in each theme, not just the default one. Dark-mode check:

```js
document.documentElement.getAttribute('data-theme') === 'dark'
```

## Checks before pushing

```bash
npm run typecheck                  # tsc --noEmit
npm test                           # vitest
npm run lint                       # eslint
NODE_ENV=production npm run build  # smoke-check chunk splitting
```

## API field gotcha

API responses sometimes use shorter names than the frontend expects (e.g. the API returns `gross` where some legacy code expects `gross_pay`). Cross-check `src/api/*.py` against `src/web/src/types/api.d.ts` before assuming a field name.
