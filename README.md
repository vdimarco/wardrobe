<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval
- Finds you in each photo with your reference photo, and imports only what you wear or carry
- Skips pieces that are already in your wardrobe or in the import queue
- Imports photos from a shared Google Photos album link or from the Google Photos picker

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `I` | Open the import panel |
| `Enter` or `A` | Approve, or update the crop after you draw a new box |
| `X` | Reject the item |
| `R` | Regenerate the image |
| `Z` | Undo the new crop box |
| `J` / `K` or arrow keys | Next or previous item to review |
| `Esc` | Undo the new crop box, or close the panel |

Shortcuts do nothing while you type in a field. Press `Esc` to leave the field first.

## Import from Google Photos

Google Photos imports run in the background on the server, and you can close the browser while they run. The import panel shows the progress of each import, with buttons to pause, resume and cancel it. New items go to the review queue as the import finds them. An import continues after a restart.

Each import works like this:

1. The server downloads the photos first, because Google's download links expire.
2. It skips photos that look almost the same as a photo it already checked, such as burst shots.
3. A cheap, low-detail check asks if the photo shows you with visible clothes. Landscapes, food, screenshots and photos of other people stop here.
4. Only photos that pass get the full clothing detection. That step also skips pieces you already have.

If 5 photos in a row fail, for example because the API key has no quota left, the import pauses and shows the error.

### Photo picker (recommended for big albums)

The picker uses the [Google Photos Picker API](https://developers.google.com/photos/picker/guides/get-started-picker). You pick up to 2000 photos in Google's own picker for each import. For a bigger album, do more than one import. The app downloads only the photos you pick.

1. In Google Cloud Console, enable the **Google Photos Picker API**.
2. Set up the OAuth consent screen. Add yourself as a test user.
3. Create an OAuth client of type **Web application**. Add `http://localhost:5173/api/import/google-photos/callback` as an authorized redirect URI. For a deployed app, add its own URL and set `GOOGLE_PHOTOS_REDIRECT_URI` to the same value.
4. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.env` and restart the app.

A **Google Photos** button then shows in the import panel. The first time you use it, a window asks you to sign in to Google. The app keeps the token at `data/google-photos-token.json`. Delete that file to disconnect.

### Shared album link

Share an album by link in Google Photos, then paste the link into the import panel. You do not need any setup.

This uses no Google API. The app reads the photo links from the album's web page, so it can stop working if Google changes that page. The page shows only part of a big album, so for a big album use the picker. Anyone who has the album link can see its photos.

## Configuration

| Variable | Default |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `<data dir>/model-reference.png` |
| `WARDROBE_MODEL_REFERENCE_URL` | Optional. A PNG to download when the model reference file is missing |
| `WARDROBE_DATA_DIR` | `RAILWAY_VOLUME_MOUNT_PATH` if set, else `data` |
| `WARDROBE_BATCH_MAX_PHOTOS` | `5000`, the most photos one album link import takes |
| `OPENAI_CHECK_MODEL` | `OPENAI_VISION_MODEL`, the model for the quick check in background imports |
| `GOOGLE_CLIENT_ID` | Optional, for Google Photos |
| `GOOGLE_CLIENT_SECRET` | Optional, for Google Photos |
| `GOOGLE_PHOTOS_REDIRECT_URI` | `<app origin>/api/import/google-photos/callback` |

## Deploy to Railway

The repo has a `railway.json`. Railway builds the app with `npm run build` and starts it with `npm start`.

1. Create a Railway service from this repo.
2. Attach a volume to the service. Any mount path works, for example `/data`. The app keeps the library, the imported images, the import jobs and the Google Photos token on the volume. Without a volume, you lose them at each deploy.
3. Set the variables in the service:
   - `OPENAI_API_KEY`
   - `WARDROBE_MODEL_REFERENCE_URL`: a link to a PNG photo of yourself. At startup, the app downloads it to the volume if the file is not there yet. To change the photo, delete `model-reference.png` from the volume and redeploy.
4. Generate a public domain for the service. The app accepts `*.up.railway.app` and the domain in `RAILWAY_PUBLIC_DOMAIN`. For a custom domain, add it to `preview.allowedHosts` in `vite.config.mjs`.
5. Optional, for the Google Photos picker: add `https://<your domain>/api/import/google-photos/callback` as a redirect URI on your OAuth client. Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Set `GOOGLE_PHOTOS_REDIRECT_URI` only if the app builds the wrong callback URL.

The app has no login. Anyone who can open the URL can import clothes with your OpenAI key and use your Google Photos connection. Keep the URL private.

## License

[MIT](LICENSE)
