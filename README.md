# v2lixx.github.io

Personal portfolio for **Seung Min Shin** (`@v2lixx`) — Security Researcher, Ajou University.

## Live

After deployment: <https://v2lixx.github.io/>

## Files

```
.
├── index.html       # main page (about, vulns, contact)
├── styles.css       # terminal/CLI themed stylesheet
├── main.js          # theme toggle, CRT toggle, typewriter, active nav
├── profile.jpg      # avatar image
├── .nojekyll        # disable GitHub Pages' Jekyll processing
└── README.md
```

## Deploy

1. Create a new **public** GitHub repository named **exactly** `v2lixx.github.io`
   (must match your GitHub username — required for the `username.github.io` root domain).
2. Push the contents of this folder to the `main` branch:

   ```bash
   cd v2lixx.github.io     # or whatever you named the local folder
   git init
   git add .
   git commit -m "init: portfolio v1"
   git branch -M main
   git remote add origin git@github.com:v2lixx/v2lixx.github.io.git
   git push -u origin main
   ```

   If you use HTTPS instead of SSH, swap the remote URL for
   `https://github.com/v2lixx/v2lixx.github.io.git`.

3. On GitHub: **Settings → Pages → Build and deployment**
   - Source: *Deploy from a branch*
   - Branch: `main` / root (`/`)
4. Wait ~1 minute, then open <https://v2lixx.github.io/>.

## Customizing

- **Avatar**: swap `profile.jpg` for any 1:1 square image (~400×400 or larger).
- **Add new vulnerabilities**: copy a `<li>` block inside the matching
  `<div class="vendor-block">` in `index.html`. To add a new vendor, copy a whole
  `vendor-block`.
- **Severity badge classes**: `critical` | `high` | `medium` | `low`.
- **Theme**: dark by default; users can toggle to light from the top-right
  `dark`/`light` button. Choice is persisted in `localStorage`.
- **CRT scanline**: off by default; toggled with the `crt` button next to the theme toggle.

## Design notes

- Layout rhythm (max-width container, date-on-left grid, small-caps section heading,
  vuln-list density) follows the structure of <https://smlijun.github.io/>.
- Personal touches: terminal-green accent (`#00d97e`), `$` prompt heading prefix,
  blinking cursor, very subtle scanline + grain, hover RGB-split glitch on the name,
  vertical timeline with vendor groups instead of a flat table.

— 2026
