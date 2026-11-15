# Langy Reader

Langy Reader is a self-hosted EPUB and PDF library for language learning. Organize books into categories, hover or tap for word help, and generate a summary of the page you are reading.

## Run it on your server

On a Docker host with Docker Compose installed:

```bash
git clone https://github.com/Attach7830/Langy-Reader.git
cd Langy-Reader
docker compose up -d --build
```

Open `http://YOUR_SERVER_IP:8088`. The first build downloads Qwen3 4B Instruct (about 2.5 GB of model weights) into the Ollama image. Subsequent starts use the baked-in model and can run offline. CPU inference works. As a starting point for the bundled model, allow about 8 GiB of available RAM and 12 GB of free disk space for the images and build cache.

The default listener is available on your LAN. Set `READER_BIND=127.0.0.1` in a copy of `.env.example` named `.env` if you prefer a local reverse proxy. Configure `READER_USER` and `READER_PASSWORD` there to enable sign-in. Use HTTPS when forwarding password-protected traffic beyond the server.

Books and categories live in a named volume. Browser settings and each book’s last position are saved per browser. Back up the `library` volume to preserve uploaded files and the catalog.

## Reading controls

| Key | Action |
| --- | --- |
| Right arrow or Space | Next page |
| Left arrow | Previous page |
| F | Full screen |
| S | Generate a summary on the right |

Change any key in **Settings → Hotkeys**. Navigation and summary buttons also work on touchscreens.

**Appearance** controls EPUB font, size, line spacing and page width. Choose Paper, Sepia, Dark or Dusk and a reader background. PDFs retain their page layout and have fit and zoom controls. Scanned PDFs display normally and need selectable text for summaries and word help.

**Language help** controls what happens when you hover or tap. Choose a translation, target-language definition, synonyms, or Off. Translation and summary languages default to English and accept language names or [BCP 47 codes](https://www.w3.org/International/articles/language-tags/), including Spanish. Definitions and synonyms use the language set on the book. EPUB metadata supplies a language when available. AI output quality varies with the language and model.

## Choose an AI provider and model

Open **Settings → AI connection** on your personal instance. The setting applies to that entire instance.

| Provider | Example | Model selection |
| --- | --- | --- |
| Bundled Ollama | Installed by Compose | Qwen3 4B Instruct by default |
| Existing Ollama server | `http://host.docker.internal:11434` | Find available models or enter a tag |
| OpenAI-compatible API | `http://host.docker.internal:8000/v1` | Find available models or enter a model ID |

If the chatbot server is on a different machine, use an address reachable from the reader container. For a service running on the same Docker host, `host.docker.internal` points to that host. Configure the upstream service to listen on an interface the container can reach. Enter an API key if the server requires one. The key is stored in the server’s data volume and stays out of browser responses.

For a smaller bundled model, set `READER_MODEL=qwen3:1.7b` and run `docker compose up -d --build` again. If you saved a model in the connection screen, select the newly installed tag there too. To use an existing API from the start, run `docker compose up -d --build --no-deps reader`, then configure it in Settings.

## Publish the demo at langy.srtw.win

On the server, start a separate Compose project. The demo has its own volume and uses the bundled model with zero AI API fees. Visitors can import up to four EPUB or PDF books, up to **20 MiB each**. Uploads and categories are private to the visitor’s browser session and expire after 24 hours.

```bash
cp .env.demo.example .env.demo
docker compose --env-file .env.demo -p langy-demo up -d --build
curl -fsS http://127.0.0.1:8089/healthz
```

In [Cloudflare Tunnels](https://one.dash.cloudflare.com/), add a [published application route](https://developers.cloudflare.com/tunnel/get-started/) for `langy.srtw.win`. If the existing tunnel runs on the same host as the demo, set its HTTP service URL to `http://127.0.0.1:8089`.

If you need a new tunnel connector in Docker, create a Cloudflare Tunnel and point the published route to `http://reader:8080`. From the repository directory:

1. Create the private directory with `install -d -m 700 .secrets`.
2. Save the tunnel token by itself in `.secrets/tunnel-token`, then run `chmod 444 .secrets/tunnel-token` so the connector can read its mounted copy.
3. Start the connector and demo together.

```bash
docker compose --env-file .env.demo -p langy-demo \
  -f compose.yaml -f compose.tunnel.yaml up -d --build
```

Once the tunnel is healthy, open [langy.srtw.win](https://langy.srtw.win), open the sample book and press **S**. The first answer can take longer while the model loads.

## Troubleshooting

```bash
docker compose ps
docker compose logs --tail=80 reader ollama
```

If the library loads while AI is starting, you can browse and read immediately. Check the AI status button in the library and verify the selected model is installed. A second Compose project serving the demo uses its own model process and memory. Stop an unused instance or budget RAM for both if you run them on the same machine.
