#!/bin/bash
# Deploy Smart Circuit to Portainer via Docker Compose
# Run this on the server at 10.36.0.5

set -e

REPO="https://github.com/kevdog114/smart-circuit.git"
DEPLOY_DIR="/opt/smart-circuit"

echo "=== Smart Circuit Deployment ==="
echo ""

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed"
    exit 1
fi

# Create deployment directory
sudo mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"

# Clone or update the repository
if [ -d ".git" ]; then
    echo "Updating existing repository..."
    git pull origin main
else
    echo "Cloning repository..."
    git clone "$REPO" .
fi

# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo "Creating .env file..."
    cp .env.example .env
    echo "Edit .env to set your GEMINI_API_KEY (optional)"
fi

# Stop existing containers
echo "Stopping existing containers..."
docker compose down || true

# Pull latest PostgreSQL image
echo "Pulling PostgreSQL image..."
docker pull postgres:16-alpine

# Build and start services
echo "Building and starting Smart Circuit..."
docker compose up -d --build

# Wait for services to be healthy
echo "Waiting for services to be healthy..."
sleep 5

# Check status
echo ""
echo "=== Deployment Status ==="
docker compose ps

echo ""
echo "=== Access ==="
echo "Smart Circuit: http://10.36.0.5:3001"
echo "API Health:    http://10.36.0.5:3001/api/health"
echo ""
echo "=== Testing ==="
echo "Test simulation: curl -X POST http://10.36.0.5:3001/api/test/simulate -H 'Content-Type: application/json' -d '{\"circuit\": \"voltage-divider\"}'"
echo "List test circuits: curl http://10.36.0.5:3001/api/test/circuits"
echo ""
echo "Deployment complete!"
