# Opportunity Assist — Landing Site

Public marketing landing page for **Opportunity Assist**, a My True Prosperity product.
*Opportunity Intelligence for Mission-Driven Growth — Stop chasing. Start choosing.*

Static site: plain HTML, CSS, and JS. No build step. Deploys to Netlify.

## Structure
```
opportunity-assist-site/
├── index.html          # Full landing page (SEO meta + JSON-LD baked in)
├── assets/
│   ├── styles.css      # Styles
│   └── app.js          # Mobile nav + footer year
├── netlify/functions/  # Scheduled Supabase availability checks
├── docs/               # One-time Supabase health-check setup SQL
├── robots.txt          # Crawl directives + sitemap reference
├── sitemap.xml         # Sitemap (update as pages are added)
├── netlify.toml        # Netlify config + security/cache headers
└── .gitignore
```

## What's included (SEO / GEO / AEO)
- Unique title + meta description, canonical URL, Open Graph + Twitter cards
- JSON-LD: Organization, SoftwareApplication, Product offers, FAQPage
- One H1, logical H2/H3, crawlable HTML text, descriptive alt/aria
- robots.txt + sitemap.xml, mobile-friendly, fast (no frameworks)

## Run locally
Just open `index.html` in a browser, or serve it:
```bash
python3 -m http.server 8080   # then visit http://localhost:8080
```

## Supabase health checks

The `supabase-healthcheck` Netlify Function runs at 02:00, 10:00, and 18:00 UTC
each day. It performs one read-only query against the `healthcheck` table in
Opportunity Assist and Classroom Credit Score.

Before the function can succeed:

1. Run `docs/supabase-healthcheck.sql` once in each Supabase project's SQL Editor.
2. Add these environment variables in the Netlify UI with Functions access:
   - `OPPORTUNITY_SUPABASE_PUBLISHABLE_KEY`
   - `CCS_SUPABASE_PUBLISHABLE_KEY`
3. Trigger a new production deploy after adding the variables.
4. Open the function in Netlify and select **Run now** to verify both queries.

Use each project's publishable key, or its legacy `anon` key. Never use a
`service_role` or Supabase secret key for this health check.

## Deploy: GitHub → Netlify (recommended)
1. Create an empty GitHub repo named `opportunity-assist`.
2. From this folder, push the existing local repo (already initialized):
   ```bash
   git remote add origin https://github.com/<your-account>/opportunity-assist.git
   git branch -M main
   git push -u origin main
   ```
3. In Netlify: **Add new site → Import an existing project → GitHub →** select `opportunity-assist`.
   - Build command: *(leave blank)*
   - Publish directory: `.`
4. Every `git push` to `main` now auto-deploys.

## Custom domain
In Netlify → Domain settings, add `opportunityassist.com` once the domain is ready.
Update the URLs in `index.html` (og/canonical), `robots.txt`, and `sitemap.xml` if the final domain differs.
