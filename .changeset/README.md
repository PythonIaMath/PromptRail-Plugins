# Changesets

Every user-facing change should include a changeset:

```sh
npm run changeset
```

Select the package, choose `patch`, `minor`, or `major`, and write a concise
release note. On pushes to `main`, GitHub Actions creates or updates the
release pull request. Merging that pull request updates `CHANGELOG.md`, tags
the release, and publishes the package to npm.
