---
name: sveltekit-runway-init
description: Initialize a cloned GitHub template repo into a SvelteKit app that provisions a Railway project, links the current GitHub repo as the app service, and optionally adds self-hosted Convex and Plausible templates with synced public URLs.
---

# SvelteKit Railway Init

Use this skill when the user has already created a new GitHub repo from the template and cloned it locally.

## Workflow

Run the bootstrap from the repo root:

- `bun run init --`
- `bun run init -- --convex`
- `bun run init -- --plausible`
- `bun run init -- --convex --plausible`

The bootstrap:

- uses the root folder name as the project name
- uses that same name for the Railway app service
- validates that `origin` points to GitHub
- scaffolds SvelteKit + Bun + Tailwind in the current repo root
- creates a Railway project
- adds the current GitHub repo as the Railway app service
- optionally deploys self-hosted Convex and/or Plausible templates
- generates Railway public domains
- writes those URLs into the Railway app service variables and local `.env.local`

## Rerun

If service domains change later, rerun:

- `bun run sync-urls`

This command reloads bootstrap state from `.bootstrap/state.json`, refreshes Railway domains, and rewrites app env values without recreating the project.

## Important assumptions

- This repo is a GitHub template repo, not a finished starter app.
- The user clones their own repo before running init.
- The cloned repo has been pushed to GitHub already.
- The user's Railway account is linked to GitHub, and the Railway GitHub app can access the target repo.
- Optional template-specific variables are entered interactively as `KEY=VALUE` lines during init.
- Convex is self-hosted on Railway in this flow, not Convex Cloud.
