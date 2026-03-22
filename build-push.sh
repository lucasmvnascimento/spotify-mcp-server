#!/usr/bin/env bash
set -euo pipefail

REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/spotify-mcp-server"
COMMIT=$(git rev-parse --short HEAD)

aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

docker build --platform linux/amd64 -t "${ECR_URI}:${COMMIT}" -t "${ECR_URI}:latest" .

docker push "${ECR_URI}:${COMMIT}"
docker push "${ECR_URI}:latest"

echo "✅ Pushed ${ECR_URI}:${COMMIT}"
echo "   COMMIT=${COMMIT}"
