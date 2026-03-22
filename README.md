# SvelteKit Railway Template

This repository is meant to be used as a **GitHub template repository**.

## Flow

1. Create a new repo from this template on GitHub.
2. Clone your new repo locally.
3. Run the bootstrap from the repo root:

```sh
bun run init --
bun run init -- --convex
bun run init -- --plausible
bun run init -- --convex --plausible
```

The initializer:

- derives the project name from the root folder name
- scaffolds a fresh SvelteKit + Bun + Tailwind app into the repo root
- creates the Railway project
- adds the app service from the current GitHub repo
- optionally deploys self-hosted Convex and/or Plausible templates
- generates Railway public domains
- writes the discovered URLs into Railway app variables and local `.env.local`

## Rerun URL sync

If Railway domains change later, refresh the env wiring with:

```sh
bun run sync-urls
```

## Template defaults

- App service name: `web`
- Convex template code: `convex`
- Plausible template code: `mzYEXO`

You can override the template codes before running init:

```sh
RAILWAY_TEMPLATE_CONVEX=your-code bun run init -- --convex
RAILWAY_TEMPLATE_PLAUSIBLE=your-code bun run init -- --plausible
```

## Notes

- `origin` must point at a GitHub repo before you run init.
- Railway CLI auth must already be set up.
- Template-specific secrets are collected interactively during init as `KEY=VALUE` lines.
