# Langy Reader

Langy Reader is a self-hosted EPUB and PDF library for language learning. Organize books into categories, hover or tap for word help, and generate a summary of the page you are reading.

See it in action at https://langy.srtw.win | Screenshots at https://imgur.com/a/wzt5KDB

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

The stack also includes a local `language` service for lemma analysis and audio alignment. Its first build installs Spanish and English spaCy models, lookup data for additional supported languages, and a multilingual Whisper model. These models run offline after the build. Narration connects to your existing Kokoro server.

## Reading controls

| Key | Action |
| --- | --- |
| Right arrow or Space | Next page |
| Left arrow | Previous page |
| F | Full screen |
| S | Open or close the current page summary |
| P | Play or pause narration |

Change any key in **Settings → Hotkeys**. Navigation and summary buttons also work on touchscreens.

Open **Contents** to jump to a chapter or a PDF bookmark. **Reading outline** in EPUBs builds a navigable list from headings, section breaks, and the opening words of passages. It opens automatically for books with fewer than two linked entries. Long stretches of uninterrupted text get approximate reading markers. The outline is built locally from the uploaded EPUB. PDFs also support a direct page-number jump.

**Appearance** controls EPUB font, size, line spacing and page width. Choose Paper, Sepia, Dark or Dusk and a reader background. PDFs retain their page layout and have fit and zoom controls. Scanned PDFs display normally and need selectable text for summaries and word help.

**Language help** controls what happens when you hover or tap. Choose a translation, target-language definition, synonyms, or Off. Translation and summary languages default to English and accept language names or [BCP 47 codes](https://www.w3.org/International/articles/language-tags/), including Spanish. Definitions and synonyms use the language set on the book. EPUB metadata supplies a language when available. AI output quality varies with the language and model.

**Dictionary synonyms** look up words and recorded inflections in local WordNet and Wiktionary indexes. Each group shows its source and meaning. When a source has a definition for the word, Langy can show that meaning even when it has no synonym. The bundled reading notes cover selected regional and literary terms, including *tiliches* and *entilichada* in *Pedro Páramo*.

To fill uncovered entries, enable **Explain missing synonym entries with AI** under **Settings → Language help**. In this mode the reader sends the surrounding passage to the configured AI connection and displays the answer as an AI context explanation. The option is off initially. Dictionary lookups run offline.

The summary panel sits to the right of the book or below it on narrow screens. Leave it open to get a new summary as you turn pages. Page summaries stay within three short sentences. Select **Go deeper** for a fuller explanation or choose a suggested question about the page. The AI generates the questions from the reading context and answers them when selected. For longer books, Langy looks across the earlier pages for relevant passages. It can also include relevant historical or author background.

## Lemmas and reading demand

Books are analyzed automatically after import, including books already in the library when the updated app first opens. **Analysis & audio** shows whole-book and per-section unique lemma counts. Hover help also shows a detected lemma. Spanish and English use contextual spaCy models; other supported languages use lookup tables. If lemmatization is unavailable for a language, the app labels its counts as word forms. Detected proper names are excluded from vocabulary totals.

Langy estimates the reading demand from passages sampled across the book with the configured language model. Its rubric follows the broad Novice, Intermediate, Advanced, Superior and Distinguished ranges in the ACTFL reading guidelines. It considers discourse, syntax, context, vocabulary and inference. The book panel shows a rationale, sample count and quotations verified against the sampled text. The library can filter by the estimated reading range. These provisional text estimates have not been calibrated against formal proficiency assessments. [ACTFL proficiency guidelines](https://www.actfl.org/proficiency-guidelines-overview)

The OPI assesses a person's speaking. Langy's reading estimate describes text demand. A reader's proficiency requires performance assessment. [ACTFL OPI](https://www.actfl.org/assessments/postsecondary-assessments/opi)

## Kokoro narration

Open **Settings → Narration** on your personal installation. Enter your Kokoro API base URL, such as `http://host.docker.internal:8880/v1`, model `kokoro`, and a voice for the book's language, such as `ef_dora` or `em_alex` for Spanish. The optional API key stays on the server. **Save and find voices** tests the connection and accepts both voice IDs and objects returned by Kokoro. You can also initialize the connection with `READER_KOKORO_URL`, `READER_KOKORO_VOICE`, and `READER_KOKORO_API_KEY`.

Enable **Show narration player** or select the headphone button in the reader. **Generate book audio**, available in the player and under **Analysis & audio**, creates one complete MP3 for the entire book. The same recording plays continuously across displayed pages and source sections. Its scrub bar has chapter ticks and a chapter menu, and the MP3 contains chapter metadata. EPUB markers use the table of contents and headings; unlabelled text uses section breaks or clearly labelled reading markers. PDFs use bookmarks when available, with page markers as a fallback.

Pages always follow playback and scrubbing, including jumps across chapters and repeated scrubs while paused. **Settings → Narration → Highlight spoken words** independently controls the visible word highlight. Font changes preserve playback position. Turning a page manually seeks to that page in the full recording; clicking a synchronized word or chapter marker also seeks while preserving play or pause state. PDFs stay linked to their fixed page numbers. Scanned pages need an OCR text layer to be narrated.

Select **Podcast mode** in the audio player for larger playback controls: rewind or fast-forward **10 seconds**, play/pause, previous/next audio chapter, and speed presets from **0.5× to 2×**. The chapter buttons use the same markers as the scrub bar. Skips and chapter jumps preserve play or pause state; page following stays active with highlighting on or off. Choose **Compact player** to return to the smaller controls. The podcast layout and playback speed are remembered in this browser and can also be set in **Settings → Narration**. Supported browsers also expose play/pause, 10-second seeking, and chapter actions to device media controls. Audio downloads remain available under **Analysis & audio → Download complete book MP3**.

The persistent queue reuses compatible recordings already generated by the previous version, then assembles the complete book. Internal processing runs in sections and resumes interrupted work after a restart. The final file is published only after every readable section finishes. Choose **Replace existing recordings** to regenerate, or **Cancel queued audio** to cancel the book job; an active internal section may finish and remain cached. Completed books have one **Download complete book MP3** link. Empty pages are skipped.

The demo defaults to disconnected audio preview (`READER_DEMO_AUDIO_PREVIEW=1`). The headphones button, narration settings and podcast layout remain visible, while generation is disabled and no Kokoro requests are made. Personal installations are unaffected. An owner explicitly enabling narration on another demo can set `READER_DEMO_AUDIO_PREVIEW=0` and configure that demo's Kokoro connection.

Word timestamps come from local speech recognition matched to the source words. Recognition retries a chunk when it finds no matches, including short headings that can be mistaken for silence. When words still cannot be matched, Langy estimates their positions between matched timestamps or the boundaries of the generated audio chunk. Page following stays active, approximate sections are labelled, and estimated words are never shown as synchronized highlights. These estimates cannot guarantee exact page or word timing. Numeric headings are included; decorative sections without letters or numbers are skipped. Joining decoded audio by its sample count prevents encoder padding from accumulating into chapter timing drift. Playback speed can be changed independently of generation speed. Kokoro and voice support determine narration languages. The demo owner configures its Kokoro connection through environment variables. Demo sections remain limited to 20,000 characters for narration.

After a synchronization error, choose **Retry book audio** without **Replace existing recordings**. Langy rebuilds sections whose cached recordings have no usable timestamps while reusing valid sections.

To update an existing demo after applying the feature patch, build and start both services:

```bash
sudo docker compose --env-file .env.demo -p langy-demo \
  -f compose.yaml -f compose.tunnel.yaml up -d --build --no-deps language reader
```

For the personal stack, use `sudo docker compose up -d --build --no-deps language reader`.

## Choose an AI provider and model

Open **Settings → AI connection** on your personal instance. The setting applies to that entire instance.

| Provider | Example | Model selection |
| --- | --- | --- |
| Bundled Ollama | Installed by Compose | Qwen3 4B Instruct by default |
| Existing Ollama server | `http://host.docker.internal:11434` | Find available models or enter a tag |
| OpenAI-compatible API | `http://host.docker.internal:8000/v1` | Find available models or enter a model ID |

If the chatbot server is on a different machine, use an address reachable from the reader container. For a service running on the same Docker host, `host.docker.internal` points to that host. Configure the upstream service to listen on an interface the container can reach. Enter an API key if the server requires one. The key is stored in the server’s data volume and stays out of browser responses.

For a smaller bundled model, set `READER_MODEL=qwen3:1.7b` and run `docker compose up -d --build` again. If you saved a model in the connection screen, select the newly installed tag there too. To use an existing API from the start, run `docker compose up -d --build --no-deps language reader`, then configure it in Settings.

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

## Thesaurus sources

The Docker build indexes [Princeton WordNet 3.0](https://wordnet.princeton.edu/), the human-built dictionaries in [Open Multilingual Wordnet 1.4](https://omwn.org/omw1.html), and selected senses and forms from the [Spanish Wiktionary contributors](https://es.wiktionary.org/) via [Kaikki’s Wiktextract export](https://kaikki.org/eswiktionary/rawdata.html). The Wiktionary index, including abbreviated glosses, is distributed separately under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Source licenses and citations are retained under `server/thesaurus-data/licenses/`. The reading notes carry their sources in `server/reading-lexicon.js`. For a build outside Docker, run `npm run build:thesaurus` to download and index the same dictionaries.
