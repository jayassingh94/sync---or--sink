# Sync or Sink

A real-time phone-first party game for 3–8 players. Rooms use four-letter codes, and Socket.IO broadcasts live room state across each player's browser. No accounts are required.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open http://localhost:3000 in several browser windows or phones on the same network. The app includes 46 Global prompts and 46 Desi Pack prompts.

## Public hosting

The app is configured for Render as a single Node web service. This keeps the website and its live WebSocket room server together at one HTTPS URL. To publish, create a GitHub repository with the contents of this folder at its root, then connect that repository to Render using the included `render.yaml` Blueprint. Render builds with `npm install` and runs `npm start`; it supplies the public URL and TLS. The free service can take about a minute to wake after 15 minutes without incoming traffic.

In-memory rooms disappear if the service restarts, which is expected for short party sessions. Use a persistent room store if rooms must survive restarts or scale across multiple server instances.

