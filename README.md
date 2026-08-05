# Order Parser Express (prototype)

Express-based prototype that accepts file uploads and extracts five canonical fields from order acknowledgement / quotation files:
- ProjectName
- PurchaseOrderNumber
- CustomerNumber
- DonganOrderNumber
- OrderDate

Features:
- Local regex heuristics for fast extraction
- Optional Azure OpenAI path (when AZURE_OPENAI_* env vars set) to improve extraction accuracy
- Dockerfile and GitHub Actions workflow that builds and pushes an image to GHCR

Usage

1. Build and run locally

  npm install
  npm start

Open http://localhost:3000/product_prototype.html and use the frontend to upload files. The server exposes POST /api/parse (multipart form field name: files).

2. Enable Azure OpenAI for better extraction

Set these environment variables in the host or container:
- AZURE_OPENAI_ENDPOINT (e.g. https://your-resource.openai.azure.com)
- AZURE_OPENAI_KEY
- AZURE_OPENAI_DEPLOYMENT (the deployment name)

3. Container image and CI

The included GitHub Actions workflow will build and push the image to ghcr.io/${{ github.repository_owner }}/order-parser-express:latest when pushed to main. Use the pushed image for container-based deployments (Azure Web App for Containers, Azure Container Instances, or Azure App Service).

Security

Do NOT commit keys to the repo. Provide secrets via environment variables or platform app settings.

