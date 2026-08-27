# Fixture Plugin Smoke Checklist

Use this checklist after the fixture plugin is available in a sibling
`../norea-plugins` checkout. Keep the fixture repo unchanged from this project.

## Setup

- Start the fixture plugin's static or dev server from `../norea-plugins`.
- Compile the sibling fixture plugin so the installable source exists at
  `../norea-plugins/.js/plugins/dev/contenttypefixture.js`.
- Use the fixture plugin install path for the target host:
  - Windows desktop: install `../norea-plugins/.js/plugins/dev/contenttypefixture.js`
    through the local plugin upload flow. The fixture content host may stay
    `http://localhost:3000`.
  - Android emulator: install from a dev-only repository manifest whose fixture
    plugin `url` points to
    `http://10.0.2.2:3000/.js/plugins/dev/contenttypefixture.js`. The fixture
    content base must also resolve through `http://10.0.2.2:3000`, not
    `localhost`.
  - Physical Android device: use the development machine's LAN address for both
    the dev-only repository manifest plugin `url` and the fixture content base.
- Do not use the public `.dist/plugins.min.json` unless it includes
  `dev-content-type-fixture`. The normal generated repository index can omit
  development-only fixture plugins.
- Start Norea with a clean enough profile for manual verification.
- For repository-based installs, set Norea's source repository URL to the
  dev-only fixture manifest, refresh the repository list, and install the
  fixture plugin.

## Chapter Download Coverage

- Open the fixture source and add the fixture novel to the library.
- Download the fixture HTML chapter.
- Download the fixture plain text chapter.
- Download the fixture PDF chapter.
- Wait for the download task list to finish without failed tasks.
- Open the Downloads page and verify the fixture novel lists all downloaded
  chapters.

## Database Inspection

Inspect the active `norea.db` SQLite database from the app data directory.

```sql
SELECT id, path, name, is_downloaded, content_type, content_bytes
FROM chapter
WHERE path LIKE '%fixture%'
ORDER BY position;
```

Expected results:

- The downloaded HTML chapter has `is_downloaded = 1`,
  `content_type = 'html'`, and non-zero `content_bytes`.
- The downloaded text chapter has `is_downloaded = 1`,
  `content_type = 'html'`, and non-zero `content_bytes`.
- The downloaded PDF chapter has `is_downloaded = 1`,
  `content_type = 'pdf'`, and non-zero `content_bytes`.

Check the cached body for the HTML chapter:

```sql
SELECT content
FROM chapter
WHERE path LIKE '%fixture%' AND content_type = 'html'
LIMIT 1;
```

Expected results:

- The HTML body is saved in `chapter.content`.
- Image sources that came from fixture media are rewritten to
  `norea-media://chapter/...`.
- The rewritten media URI includes the local chapter id and a cache key.

## Reader Verification

- Open the downloaded HTML chapter while the fixture server is still running.
- Confirm inline images render in the reader.
- Stop the fixture server.
- Reopen the same downloaded HTML chapter.
- Confirm the same images still render from the local media cache.
- Open the text chapter and confirm it renders readable escaped text rather than
  raw HTML markup. The stored body should already be HTML.
- Open the PDF chapter and confirm the reader handles the PDF chapter path
  without overwriting its `content_type`.

## Cleanup Verification

- Delete one downloaded fixture chapter from the Downloads page.
- Confirm that chapter no longer appears as downloaded.
- Re-run the chapter query and confirm its `is_downloaded` is `0`,
  `content` is `NULL`, and `content_bytes` is `0`.
- If the deleted chapter was the HTML chapter, confirm its chapter media cache is
  cleared by reopening it online and verifying media is fetched again.
- Use Settings > Data > downloaded content cleanup to clear all downloaded
  content.
- Re-run the chapter query and confirm no fixture chapters remain downloaded.
- Confirm the local chapter media cache no longer serves fixture images after
  all downloaded content is cleared.
