# Contributing to Vesper

Thanks for helping. Vesper is a Windows desktop app (Electron) and a web app in one: the Electron main process runs
Vesper's own server, and the same React client is served to the desktop window and to browsers on other devices.

## Build and run

Requires Node 24 and Windows 10/11 x64.

```bash
npm install
npm run dev
```

`npm run dev` starts the desktop app with live reload. `npm run serve` builds and runs the standalone server for
browsers. The README's "For developers" table lists every command.

## Tests

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript for the main process and server, the web client and the e2e suites |
| `npm test` | Unit and integration tests (Vitest on Electron's Node; no network, no paid APIs: providers are mocked) |
| `npm run e2e` | Builds, then the Playwright suites: the desktop window and headless Chromium against the built server |
| `npm run deps:check` | Every dependency version is pinned exactly (and installed at that version) |
| `npm run release:check` | The release build contains no test hooks, test routes or test switches |

The e2e suites need a desktop session and a GPU; run them for anything that touches the UI. Test-only code (the
`window.__vesperTest` hooks, `/api/test/*`, `VESPER_*` switches) must sit behind `__VESPER_TEST__` so the release build
drops it.

## Pull requests

- CI (`.github/workflows/ci.yml`, on `windows-latest`) runs `npm ci`, `npm run typecheck` and `npm test` for every pull
  request and every push to `main`. Keep it green.
- Pin new dependencies to an exact version (`npm run deps:check`).
- Settings live only in `src/shared/settings.ts`; every setting needs a control (`data-setting`) and a Settings search
  entry — `tests/unit/web/settings-coverage.test.ts` checks both.
- Anything that sends data off the PC needs a disclosure in `src/shared/privacy.ts` and a place on the Privacy page.
- Decisions are recorded in `docs/07-AMENDMENTS.md` (the authoritative list); architecture is in
  `docs/02-ARCHITECTURE.md`, testing in `docs/05-TESTING.md`.

## Releases

Maintainers release with `npm run release <x.y.z>`; GitHub Actions then builds and publishes the GitHub Release that
installed copies update from. See the README's "Releasing" section.
