# Notion → Framer CMS Sync

Automatically syncs a Notion database into a Framer CMS collection every 15 minutes,
using GitHub Actions + Framer's Server API. No one needs to open Framer or click
"Sync" in the plugin — this runs on its own.

## How it works

1. GitHub Actions wakes up every 15 minutes (also runnable manually).
2. `sync.js` reads every row from your Notion database.
3. It connects to your Framer project using the Server API and pushes the rows
   into a CMS collection as items (creating new ones, updating existing ones).

## One-time setup

### 1. Create a Notion integration
1. Go to https://www.notion.so/my-integrations → "New integration".
2. Give it a name, copy the **Internal Integration Token** (starts with `secret_` or `ntn_`).
3. Open your Notion database → `•••` menu (top right) → **Connections** → connect your new integration.
   Without this step Notion will return empty/permission errors.
4. Copy the **database ID** from its URL:
   `https://www.notion.so/yourworkspace/DATABASE_ID?v=...` — the 32-character
   ID right after your workspace name.

### 2. Get your Framer API key
1. In Framer, open your project → **Site Settings → API**.
2. Create/copy the API key (this is your `fr_...` key).
3. Copy your project URL from the browser address bar while your project is
   open, e.g. `https://framer.com/projects/Sites--aabbccddeeff`.
4. Note the exact **name** of the CMS collection you want to sync into
   (case-sensitive).

### 3. Push this project to a GitHub repo
```bash
cd notion-framer-sync
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

### 4. Add GitHub Actions secrets
In your repo: **Settings → Secrets and variables → Actions → New repository secret**.
Add each of these:

| Secret name              | Value                                              |
|---------------------------|----------------------------------------------------|
| `NOTION_TOKEN`             | Your Notion integration token                      |
| `NOTION_DATABASE_ID`       | Your Notion database ID                            |
| `FRAMER_API_KEY`           | Your Framer API key                                |
| `FRAMER_PROJECT_URL`       | Your Framer project URL                            |
| `FRAMER_COLLECTION_NAME`   | The exact name of the target CMS collection        |

### 5. Update the field mapping
Open `sync.js` and edit the bottom section:

```js
const TITLE_PROPERTY_NAME = "Name"; // your Notion title property

const PROPERTY_TO_FIELD_MAP = {
  Name: "Title",           // Notion property "Name" -> Framer field "Title"
  Description: "Description",
  Published: "Published",
  Date: "Date",
  Image: "Image",
};
```
The keys are your **Notion property names**, the values are your **Framer CMS
field names**. Add or remove rows to match your actual database/collection.

### 6. Test it manually before relying on the schedule
In GitHub: **Actions tab → "Notion to Framer Sync" → Run workflow** (this uses
the `workflow_dispatch` trigger). Check the logs — it will tell you which
fields it found in the collection and how many items it synced, or give a
clear error if something's misconfigured (e.g. wrong collection name).

Once that manual run succeeds, the `*/15 * * * *` schedule takes over
automatically — no further action needed.

## Notes / limits

- GitHub Actions' `schedule` cron is best-effort: expect a few minutes of
  jitter, not second-perfect timing. Fine for a content sync, not for
  latency-sensitive jobs.
- The Framer Server API is currently in **open beta** and free; the
  `framer-api` package API surface may change — see
  https://github.com/framer/server-api-examples for up-to-date examples if
  something in `sync.js` errors after a package update.
- Images: the mapping above pulls a raw file URL from Notion's `files`
  property. Framer's image field may need the URL in a specific shape —
  check the item after a sync and adjust `readNotionProperty`'s `"files"`
  case if images don't show correctly.
- This script fully replaces (via `addItems`, which upserts by `id`) items on
  every run — it does not currently delete Framer items whose Notion row was
  deleted. If you need that, add a call to `collection.removeItems()` for any
  Framer item ID no longer present in your Notion rows.
