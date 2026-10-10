# Contributing to Knightro Tracker

Thanks for joining the team! Here's how to contribute:

## Current backend and deployment

Production is Vercel + Supabase. Start with [the repository overview](README.md) and [Supabase operations](supabase/README.md). Commit database migrations and Edge Function source alongside frontend changes. Vercel uses `frontend` as its project root. Event updates are manual imports of completed scraper databases; do not add a recurring scraper without an explicit project decision. Keep service keys, proxy/import tokens, `.env` files, and local databases out of Git.

The Python/SQLite and AWS guides are legacy references for local development or an existing older installation.

## Workflow for Teammates

### 1. Create a Branch
Before starting work, create your own branch:
```bash
git checkout -b your-name/feature-name
```

Examples:
- `sarah/map-integration`
- `mike/login-page`
- `alex/database-setup`

### 2. Make Your Changes
- Edit files on your branch
- Test your changes locally
- Commit regularly with clear messages:
```bash
git commit -m "Add map marker clustering"
```

### 3. Push Your Branch
```bash
git push origin your-name/feature-name
```

### 4. Create a Pull Request
1. Go to GitHub
2. Click "Compare & pull request"
3. Write a clear title and description
4. Add screenshots if relevant
5. Click "Create pull request"

### 5. Get Review & Merge
- A teammate reviews your code
- Make any requested changes
- Once approved, merge the PR
- Delete your branch when done

## Commit Message Tips

Good commit messages help everyone understand changes:
- ✅ `Add Google Maps integration`
- ✅ `Fix location update bug`
- ✅ `Update README with setup instructions`
- ❌ `stuff`
- ❌ `fix`

## Branch Naming Convention

Use this pattern: `firstname/what-you-are-doing`

Examples:
- `sarah/authentication`
- `mike/api-endpoints`
- `alex/frontend-styling`

## Questions?

- Ask on Slack
- Comment on the GitHub issue
- Reach out to the team lead

Let's build something cool! 🎓
