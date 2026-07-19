# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting set up

See [Local development](README.md#local-development) in the README. Short version:

```bash
npm install
cp .dev.vars.example .dev.vars          # fill in your values
cp shopify.app.toml.example shopify.app.toml
npm run db:migrate
npm run dev
```

Testing changes end to end needs a Shopify development store and a SimplyPrint
account. Development stores are free with a Shopify Partner account.

## Before opening a pull request

```bash
npm run build      # must pass
npm run typecheck  # see the note below
```

**About `npm run typecheck`:** the project currently reports pre-existing type
errors, almost all of them in `app/routes/app.products.tsx`. They do not block
the build. Please make sure your change does not *add* new ones. Comparing the
error count before and after your change is enough.

Cleaning up those existing errors is a genuinely useful contribution and a good
first issue.

## Guidelines

- Keep pull requests focused on one thing.
- Match the surrounding code style; there is no enforced formatter.
- Update the README when you change setup steps, configuration, or behaviour.
- Never commit real credentials, store domains, or customer data. `.dev.vars`
  and `shopify.app.toml` are gitignored for exactly this reason.

## Reporting bugs

Please include:

- What you expected and what happened instead
- Relevant output from the app's **Sync Logs** page
- Relevant output from `npx wrangler tail`, with credentials redacted

## Security

Please do not open a public issue for a security problem. Report it privately
through [GitHub security advisories](https://github.com/dennisklappe/Shopify2SimplyPrint/security/advisories/new).

## License

By contributing you agree that your contributions are licensed under the
[GNU GPL v3](LICENSE), the same license as the project.
