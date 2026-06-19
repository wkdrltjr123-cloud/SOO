# OBS Timer Web

## Local test

Run `start_obs_timer_server.bat`, then use:

- OBS display: `http://127.0.0.1:17171/display`
- Controller: `http://127.0.0.1:17171/control`

## Public web hosting

Host this `outputs` folder on a Node-capable service. The app uses only Node built-ins and does not require `npm install`.

Use:

- Start command: `npm start`
- Port: use the platform-provided `PORT` environment variable, or set `OBS_TIMER_PORT`

After deployment, open the public `/control` URL first. It will generate a room and a private control key.

- Put the generated `.../display?room=...` URL into OBS Browser Source.
- Keep the generated `.../control?room=...&key=...` URL private for whoever controls the timer.

Anyone with the display URL can see the timer. Only someone with the control URL and key can change it.
