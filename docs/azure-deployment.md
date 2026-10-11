# Deploying to Azure App Service

Status: guide · Applies to: this repository, a Linux Azure Web App running Node 22 LTS

The app is one long-running Node server (`npm start` runs `node server.js`) that holds the live chain in memory and writes recordings to disk. It runs on Azure App Service as it is, once the changes below are made. GitHub Pages cannot host it: Pages serves static files only, and the Upstox feed, the signals and the backtester all run in `server.js`.

## Node version

Use **Node 22 LTS** (`NODE|22-lts`). `package.json` requires `node >=22`, and CI tests on Node 22 (the oldest allowed) and Node 24. Do not use anything older than 22.

## Changes needed

| # | Change | Where | Why | Type |
| --- | --- | --- | --- | --- |
| 1 | Add a `DATA_DIR` setting and use it for every file the app writes: `.token.json`, `bt-data/*`, `hedge-cache/`, `logs/`, `replays/` | `server.js` (`TOKEN_FILE`, the `bt-data` paths, `hedge-cache`), `errorlog.js`, `replay.js` | Only `EVENTS_DIR` and `BT_CACHE_DIR` can be moved today. The rest is under the app folder, and a redeploy replaces that folder. | Code, not done yet |
| 2 | Set `DATA_DIR`, `EVENTS_DIR` and `BT_CACHE_DIR` to folders under `/home/data/` | App Service → Environment variables | `/home` is the only storage that survives restarts and redeploys. | Azure |
| 3 | Put a login in front of the app: App Service Authentication (Entra ID), or a password check in `server.js` | Azure → Authentication, or code | The server has no login of its own. A public URL would expose your Upstox session and let anyone spend your Anthropic key. Do this before sharing the URL. | Azure or code |
| 4 | Set `UPSTOX_REDIRECT_URI=https://<app>.azurewebsites.net/callback` and enter the same URL as the Redirect URL of your Upstox developer app | App settings and the Upstox portal | The default is `http://localhost:3000/callback`. The two values must match exactly. | Azure and Upstox |
| 5 | Move the secrets and tuning values into App settings: `UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, `ANTHROPIC_API_KEY`, `FEED_STRIKES` and any other `.env` value you use. Do not set `PORT`. | App Service → Environment variables | `.env` is gitignored and is not deployed. The server reads `process.env`, so app settings work unchanged. App Service sets `PORT` itself. | Azure |
| 6 | Create a Linux Web App with the Node 22 LTS stack on the Basic (B1) plan or higher | Azure portal, CLI or VS Code | The Free and Shared tiers do not allow Always On. | Azure |
| 7 | Turn on **Always On** | Configuration → General settings | Without it the app idles out, and the live feed and the spike recording stop. | Azure |
| 8 | Keep to a single instance: no scale-out, and no slot swaps during market hours | Scale out | Chain state and recordings live in memory and on local disk. A second instance would split them. | Azure |
| 9 | Set the startup command to `node server.js`, or leave the default `npm start` | General settings | Makes the start command explicit. | Azure |
| 10 | Add a deploy stage that builds, zips and deploys: `AzureWebApp@1` with a service connection in `azure-pipelines.yml`, or `azure/webapps-deploy` in `.github/workflows/ci.yml`. Run it only when the lint, test, e2e and security jobs pass. | The pipeline | Both pipelines only check the code today and never deploy. | Code, not done yet |
| 11 | Leave `node_modules`, `events/`, `bt-*`, `.env` and `reports/` out of the package, and run `npm ci --omit=dev` as part of the build | The pipeline | Keeps the package small and stops local data from overwriting what is on the server. | Code, not done yet |
| 12 | Turn on **HTTPS Only** | Settings → TLS/SSL | The Upstox callback and the token must not travel over HTTP. | Azure |

Not needed:

- **Web sockets setting:** the browser does not open a WebSocket to the server. Only the server connects out to Upstox.
- **Host or port change:** `server.listen` binds to all interfaces and reads `PORT`.
- **Shutdown handling:** the server flushes signals and flow data on `SIGTERM`, which App Service sends on a restart or deploy.

After a deploy you still log in with Upstox once each trading day, because the token expires at about 3:30 AM IST.

## Deploying from VS Code

Install the **Azure App Service** extension (`ms-azuretools.vscode-azureappservice`), which brings in **Azure Resources**.

1. Click the Azure icon in the sidebar and choose **Sign in to Azure**.
2. Under **App Service**, click **+ → Create New Web App… (Advanced)**. Enter a globally unique name, create a resource group, choose the runtime stack `Node 22 LTS`, OS Linux, and a new plan on Basic B1 or higher.
3. Right-click the app and choose **Application Settings → Add New Setting**. Add the values from row 5, the three directory settings from row 2, and `SCM_DO_BUILD_DURING_DEPLOYMENT=true` so Azure runs `npm install`. Do not set `PORT`.
4. Right-click the app and choose **Open in Portal**. Turn on **Always On** and **HTTPS Only**.
5. Create `.vscode/settings.json` so the upload leaves local data behind:

   ```json
   {
     "appService.zipIgnorePattern": [
       "node_modules{,/**}", "events{,/**}", "events-demo{,/**}", "bt-cache{,/**}",
       "hedge-cache{,/**}", "logs{,/**}", "replays{,/**}", "reports{,/**}",
       "test-results{,/**}", "playwright-report{,/**}", "bt-data{,/**}",
       ".env", ".token.json", ".git{,/**}", "holdings.xlsx"
     ]
   }
   ```

   `bt-data` and `holdings.xlsx` hold your local saved strategies and portfolio. Check that nothing in them is needed on the server before leaving them out.

6. Right-click the web app and choose **Deploy to Web App…**, pick the project folder and confirm the overwrite prompt. When it finishes, choose **Browse Website**.
7. To read the server's output, right-click the app and choose **Start Streaming Logs**.

Do rows 1 and 3 before the first real deploy. Without row 1, the Upstox token, saved strategies and logs are lost on every deploy. Recordings and the candle cache are safe once `EVENTS_DIR` and `BT_CACHE_DIR` point under `/home/data`.

## Why not GitHub Pages

Pages serves static files, so `server.js` cannot run there. The Upstox API secret also has to stay on a server. The `public/` folder alone could be hosted on Pages with the server elsewhere, but that needs CORS headers, changed front-end URLs and a protected public API, and gains little. A read-only demo built from `npm run demo` data could be hosted on Pages as a showcase.
