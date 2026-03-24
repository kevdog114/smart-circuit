# ⚡ Smart Circuit

A web-based electronic circuit design tool with an integrated AI assistant (Google Gemini). Supports schematic capture, PCB layout, JLCPCB component sourcing, EasyEDA import/export, and SPICE simulation.

## Features

- **Schematic Editor** — Canvas-based editor with drag-and-drop components, wiring, and net labels
- **PCB Layout** — Place footprints, route traces, and export for manufacturing
- **AI Assistant** — Gemini-powered copilot that can add components, suggest circuits, and layout PCBs
- **JLCPCB Library** — Search and source parts directly from JLCPCB/LCSC with real-time pricing and stock
- **Import / Export** — EasyEDA Standard & Pro formats, KiCad export
- **SPICE Simulation** — Run transient, AC, and DC analyses with ngspice (WASM)

---

## Quick Start (Docker)

The fastest way to run Smart Circuit is with Docker.

### Pull and run

```bash
docker run -d \
  --name smart-circuit \
  -p 3001:3001 \
  -e GEMINI_API_KEY=your_api_key_here \
  -v smart-circuit-data:/app/data \
  ghcr.io/kevdog114/smart-circuit:main
```

Then open **http://localhost:3001** in your browser.

### Docker Compose

1. Create a `.env` file with your API key:

   ```env
   GEMINI_API_KEY=your_api_key_here
   ```

2. Start the service:

   ```bash
   docker compose up -d
   ```

3. Open **http://localhost:3001**

To build locally instead of pulling from the registry, uncomment the `build: .` line in `docker-compose.yml`.

---

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- npm 10+

### Install & run

```bash
# Install dependencies (uses npm workspaces)
npm install

# Create server/.env with your Gemini API key
echo "GEMINI_API_KEY=your_key_here" > server/.env

# Start both client & server in dev mode
npm run dev
```

- **Client** (Vite): http://localhost:5173
- **Server** (Express): http://localhost:3001

### Project structure

```
smart-circuit/
├── client/          # Vite + TypeScript frontend (schematic/PCB editors)
├── server/          # Express + TypeScript backend (API proxy, project storage)
├── docs/            # Architecture & design documentation
├── Dockerfile       # Multi-stage production build
├── docker-compose.yml
└── package.json     # npm workspaces root
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key for the AI assistant |
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | No | — | Set to `production` in Docker (auto-set) |

---

## Docker Build (Manual)

```bash
# Build the image
docker build -t smart-circuit .

# Run it
docker run -p 3001:3001 -e GEMINI_API_KEY=your_key smart-circuit
```

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Data Model](docs/DATA_MODEL.md)
- [API Contracts](docs/API_CONTRACTS.md)
- [EasyEDA Format](docs/EASYEDA_FORMAT.md)
- [LLM Integration](docs/LLM_INTEGRATION.md)
- [Component Library](docs/COMPONENT_LIBRARY.md)
- [Contributing](docs/CONTRIBUTING.md)

---

## License

Private — see repository for details.
