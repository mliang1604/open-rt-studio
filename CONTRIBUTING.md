# Contributing

Thanks for your interest in Open RT Studio.

## Ground rules

- **No patient data, ever.** Do not attach, paste or commit real DICOM files,
  screenshots with patient identifiers, or anything derived from them. Use the
  generators in `packages/testdata` or clearly shareable public data.
- **Not for clinical use.** Do not remove or weaken the clinical-use notices.
- Contributions are accepted under the [MPL 2.0](LICENSE). New source files
  carry the header described in [docs/license-headers.md](docs/license-headers.md).

## Workflow

1. Pick an issue. Stories are sized for one pull request and list what "done"
   means.
2. Branch from `main`, make the change, and add or update tests.
3. Run the same checks as CI:

   ```bash
   npm ci
   npm run lint
   npm run format:check
   npm run build
   npm test
   ```

4. Open a pull request that says which issue it closes.

`main` is protected by the **Build & test** check. To set that up on a fork or
a new repository: in Settings, allow auto-merge, then add a branch protection
rule for `main` that requires the `Build & test` status check.

## Code style

- TypeScript is strict. Prettier formats everything; run `npm run format`.
- Follow the patterns in [docs/architecture.md](docs/architecture.md).
- Install with `npm ci`. Only change `package-lock.json` when you are
  deliberately changing dependencies.
