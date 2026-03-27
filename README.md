# NIGHT FURYS BOT MUSIC

Discord music bot built with `discord.js` voice support, YouTube/Spotify playback helpers, queue controls, and `24/7` mode.

## Features

- Slash commands for play, pause, resume, skip, queue, volume, and loop control
- `24/7` mode with `/247` to keep the bot connected when playback is idle
- YouTube links, Spotify links, and search query support
- Queue panel with playback controls inside Discord

## Requirements

- Node.js 20+
- A Discord application and bot token
- A Discord bot invited with voice permissions

## Environment Setup

1. Copy `.env.example` to `.env`
2. Fill in at least:

```env
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_client_id
```

3. Optional values:

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` for Spotify metadata/support
- `YOUTUBE_COOKIE` if you need a cookie for some YouTube playback cases
- `FFMPEG_PATH` only if you want to override the bundled `ffmpeg-static` path

## Local Setup

```bash
npm install
npm run deploy
npm start
```

## Commands

- `/play`
- `/join`
- `/leave`
- `/skip`
- `/next`
- `/stop`
- `/pause`
- `/resume`
- `/queue`
- `/nowplaying`
- `/volume`
- `/loop`
- `/247`

## GitHub Setup

1. Keep `.env` private and never commit it
2. Commit `.env.example` so others know which variables are required
3. Push the repo to GitHub
4. GitHub Actions will run the syntax check workflow on pushes and pull requests

If you want to clone and run it somewhere else:

```bash
git clone <your-repo-url>
cd NIGHT-FURYS-BOT-MUSIC
npm install
```

Then copy `.env.example` to `.env`, fill your values, run `npm run deploy`, and start the bot with `npm start`.

## Railway Setup

This repo now includes `railway.json` for Railway config-as-code.

What it does:

- Uses Railway's `RAILPACK` builder
- Runs `node deploy.js` before deployment so slash commands stay registered
- Starts the bot with `node index.js`
- Exposes `/health` on Railway's injected `PORT`
- Restarts on failure

### Deploy steps

1. Push this repo to GitHub
2. In Railway, create a new service from the GitHub repo
3. Add these Railway variables:

```env
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_client_id
```

4. Add optional variables if you use them:

```env
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REFRESH_TOKEN=
SPOTIFY_MARKET=US
YOUTUBE_COOKIE=
FFMPEG_PATH=
```

5. Deploy the service

### Notes

- Railway treats this bot as a persistent service, which fits long-running background workers
- The `/health` route only starts when Railway provides a `PORT`, so local development stays unchanged
- `CLIENT_ID` is required on Railway because `node deploy.js` runs before each deployment
- Text commands can run on Railway, but voice playback is blocked in this repo on Railway by design to avoid repeated failed voice joins
- If you deploy on a host with outbound UDP support, voice playback can be enabled there normally
