# AirSense

AirSense is a local environmental dashboard for air quality, weather, outdoor guidance, and area maps. It uses a React/Vite frontend, a Python/FastAPI backend, OpenAQ and OpenWeatherMap data sources, and InfluxDB for time-series storage.

## Project layout

- `backend/` — FastAPI service and Python dependencies
- `frontend/` — React and TypeScript dashboard
- `docs/` — project notes
- `.env.example` — names of required settings (no real keys)
- `.gitignore` — keeps secrets and generated files out of Git

## Run on Windows (PowerShell)

Start InfluxDB in Docker first if you want database storage. Keep that Docker window/service running.

### Backend terminal

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Open `backend/.env` and enter your own private API keys and InfluxDB settings. Never upload or share that file. Then start the backend:

```powershell
python -m uvicorn main:app --reload --port 8000
```

### Frontend terminal

Open a second terminal from the project root:

```powershell
cd frontend
npm install
npm run dev
```

Open the local address Vite prints, usually `http://localhost:5173/`.

## Git safety

Commit `.env.example`, but never commit `.env`, API keys, passwords, tokens, `.venv`, `node_modules`, or `dist`. Git ignores those local files and folders.
