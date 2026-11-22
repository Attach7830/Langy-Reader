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
| Right arrow | Next page |
| Space | Play or pause when narration is enabled; next page when narration is off (default) |
| Left arrow | Previous page |
| F | Full screen |
| S | Open or close the current page summary |
| P | Play or pause narration |
| A | Show or hide the audio toolbar without pausing narration |

Change assigned keys in **Settings → Hotkeys**. Space always controls playback while narration is enabled; when narration is off, its assigned action applies. **A** toggles the **Hide audio toolbar** preference while playback and page following continue. If A was already assigned to another action in an older installation, that assignment is preserved and the new toolbar shortcut starts unassigned. Navigation and summary buttons also work on touchscreens.

Open **Contents** to jump to a chapter or a PDF bookmark. **Reading outline** in EPUBs builds a navigable list from headings, section breaks, and the opening words of passages. It opens automatically for books with fewer than two linked entries. Long stretches of uninterrupted text get approximate reading markers. The outline is built locally from the uploaded EPUB. PDFs also support a direct page-number jump.

**Appearance** controls EPUB font, size, line spacing and page width. Choose Paper, Sepia, Dark, Dusk or the near-black Midnight theme and a reader background. PDFs retain their page layout and have fit and zoom controls. Scanned PDFs display normally and need selectable text for summaries and word help.

**Language help** controls what happens when you hover or tap. Choose a translation, target-language definition, synonyms, or Off. Translation and summary languages default to English and accept language names or [BCP 47 codes](https://www.w3.org/International/articles/language-tags/), including Spanish. Definitions and synonyms use the language set on the book. EPUB metadata supplies a language when available. AI output quality varies with the language and model.

**Dictionary synonyms** look up words and recorded inflections in local WordNet and Wiktionary indexes. Each group shows its source and meaning. When a source has a definition for the word, Langy can show that meaning even when it has no synonym. The bundled reading notes cover selected regional and literary terms, including *tiliches* and *entilichada* in *Pedro Páramo*.

To fill uncovered entries, enable **Explain missing synonym entries with AI** under **Settings → Language help**. In this mode the reader sends the surrounding passage to the configured AI connection and displays the answer as an AI context explanation. The option is off initially. Dictionary lookups run offline.

The summary panel sits to the right of the book or below it on narrow screens. Leave it open to get a new summary as you turn pages. Page summaries stay within three short sentences. Select **Go deeper** for a fuller explanation or choose a suggested question about the page. The AI generates the questions from the reading context and answers them when selected. For longer books, Langy looks across the earlier pages for relevant passages. It can also include relevant historical or author background.

## Connect an OPDS reader

Your self-hosted installation publishes an [OPDS 1.2](https://specs.opds.io/opds-1.2.html) catalog at **`http://YOUR_SERVER_IP:8088/opds`**. Open **Settings → Devices** to copy the address for your current installation. No extra container or model is needed.

On Xteink with [CrossPoint firmware](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/USER_GUIDE.md), open **Settings → Connectivity → OPDS Servers → Add Server**:

- Server name: `Langy`.
- Server URL: `http://YOUR_SERVER_IP:8088/opds`, or your installation's HTTPS hostname followed by `/opds`.
- Username/password: the `READER_USER` and `READER_PASSWORD` from your server's `.env` when sign-in is enabled. CrossPoint supports HTTP Basic authentication; it cannot complete an interactive Cloudflare Access login.

Browse **All EPUB books**, **Recently added**, or **Categories**, or search by title/author. Feeds contain at most 20 entries per page for small readers. Downloads keep the original EPUB and its table of contents. The separate **PDF books** catalog serves original PDFs for compatible readers; Langy does not convert them for Xteink. Other OPDS clients can also use `/opds/books?format=all`.

The Xteink must be able to reach that server address over Wi-Fi. `localhost` refers to the device itself. Use HTTPS for connections outside your trusted home network. The catalog, search, covers and downloads all use the same Langy sign-in; passwords are not included in catalog URLs. OPDS is disabled in demo mode to keep visitors' uploads private.

OPDS supplies books to the device. Its firmware handles reading and dictionary lookup; Langy's AI summaries and audio synchronization remain in the browser. Reading position uses the separate sync connection below. Actual Xteink hardware has not been tested.

## Sync reading progress with CrossPoint or KOReader

Langy includes a single-account **KOReader Sync (KOSync)** endpoint at **`http://YOUR_SERVER_IP:8088/kosync`**. No extra container, model, or paid service is needed. Your Xteink can keep CrossPoint firmware; KOReader Sync is the protocol used to exchange reading positions. Open **Settings → Devices** in Langy to copy your installation's sync URL and set a name for each browser.

On CrossPoint, open **Settings → Connectivity → CrossPoint Sync**:

| Setting | Value |
| --- | --- |
| Server type | **KoSync** |
| Server URL | Your Langy address followed by `/kosync` |
| Username | `READER_USER` (default `reader`) |
| Password | Your `READER_PASSWORD` |
| Document matching | **Binary/content**, if your version offers a choice |

Authenticate with that account. Account registration is disabled. For KOReader, choose the same custom server under **Progress sync**, use content-based document matching, and log in with these credentials. CrossPoint and KOReader versions may label their controls differently. On CrossPoint, open the reader menu and select **Sync Progress** before switching devices. **Sync On Sleep** is optional on versions that offer it; leave **Sync Clippings** off for this server. See the [CrossPoint sync guide](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/USER_GUIDE.md#367-koreader-sync-quick-setup).

**Download the original EPUB from Langy's OPDS catalog**, then open that same book in Langy. Matching uses the same sampled file checksum as KOReader and CrossPoint, so renaming a file is fine but editing or converting it can produce a different document ID. Use an address both devices can reach; use HTTPS when accessing it outside your home network. Interactive Cloudflare Access login pages cannot be completed by these sync clients.

Langy saves page changes after a short pause, checks on opening a book, when returning to the browser, and every 20 seconds while the reader is visible. Opening a book resumes its shared position automatically when this browser has no unsynced changes. An update arriving while you read, or a conflict with offline reading, offers **Resume there** and **Keep this position**. The browser uses version checks to avoid silently overwriting another device's newer position. Native KOSync clients use the protocol's last-write-wins behavior; sync before switching readers. Moving backward intentionally is supported.

EPUB progress is mapped through source text locations and Unicode offsets, rather than device-specific page numbers. If a reader emits a location Langy cannot resolve, it resumes approximately and tells you. Reflowed pages can start a little before the saved word. PDFs share fixed page positions with compatible readers. The sync button retries an unavailable connection; local browser progress remains saved offline. You can disable syncing for a browser in **Settings → Devices**. This transfers reading position only, not bookmarks, annotations, vocabulary, or audio time.

Device connections require a password. If you prefer separate sync credentials, add `READER_SYNC_USER` and `READER_SYNC_PASSWORD` to `.env` and restart the reader service; blank values use the corresponding Langy login. Browser-to-browser sync also works on a trusted LAN installation without a password, but native device authentication stays disabled until a password is configured. The sync password or its derived key is never sent to the browser settings API. Progress is stored in `progress.sqlite` in Langy's data volume; include the volume in backups. The public demo disables shared progress sync entirely.

Protocol requests, position mapping, browser conflicts, and offline recovery have automated coverage. Physical CrossPoint/KOReader devices still need an end-to-end check after deployment.

## Available storage

The library shows **available space and total capacity on the drive containing Langy's data directory**, including space shared with other files and applications. In Docker this is the filesystem backing the `library` volume or your configured host folder. The bar includes used and reserved space; the available figure reflects space usable by the reader process. This is server storage, not the Xteink's SD card.

The meter updates when the library refreshes and every minute while it is visible. Select **Refresh** beside the meter to check immediately, including after adding or removing audiobook recordings. If the filesystem cannot report space, the app shows that availability is unavailable.

Demo visitors see only their personal upload allowance (four books, 20 MiB each); the demo does not expose the server's disk capacity. The shared demo storage cap still applies independently.

## Move an existing library to another drive

Prepare and mount the destination drive first, with a persistent mount configured in `/etc/fstab`. The migration helper does not format disks. For example, with your data drive already mounted at `/srv/langy`, run from the repository:

```bash
git pull --ff-only
sudo bash scripts/migrate-storage.sh /srv/langy --tunnel
```

Omit `--tunnel` if you do not use `compose.tunnel.yaml`. The helper requires a running personal reader using a named Docker volume and an existing `.env`. It refuses an unmounted destination or a nonempty destination `library` folder. It builds the reader before downtime, stops it to copy all books, recordings, settings and SQLite databases, and compares every copied file before switching. The copy uses the running reader's existing image without downloading a helper image. Keep this terminal open until it completes.

The helper preserves permissions, retains the original volume and a private `.env.storage-before-*` backup, and sets `READER_DATA_SOURCE` and `READER_STORAGE_ID` in `.env`. Existing credentials, including literal dollar signs, are retained. The reader validates the destination's `.langy-storage-id` before opening any databases; an absent drive or wrong folder causes startup to fail instead of initializing a new library. A failed copy or startup restores the old settings and attempts to restart the original volume. Copies left by an incomplete migration require inspection before retrying.

Your usual Compose commands, including the tunnel override, continue to use the configured host folder through `.env`; no separate storage override is needed. Refresh the library's storage meter and verify books, recordings and reading progress after migration. The original volume remains a backup on the previous filesystem, so it continues using that disk's space until you choose to remove it. Do not remove it until the migrated installation has been checked. New installations can keep using the default named volume without these optional settings.

## Lemmas and reading demand

Books are analyzed automatically after import, including books already in the library when the updated app first opens. **Analysis & audio** shows whole-book and per-section vocabulary counts. Spanish, English and Portuguese use contextual spaCy models; other supported languages use lookup tables. Hover help also shows a detected lemma. If lemmatization is unavailable, the app labels its counts as word forms. Detected proper names are excluded from lemma totals.

Mandarin uses **unique Han characters**, with a separate count of character occurrences. English, Portuguese and other languages keep their own lemma/word-form counts. The library and analysis table show separate language totals for mixed books; Mandarin characters are never added to a lemma total. Punctuation, English letters and pinyin annotations are excluded from Han counts. Simplified and traditional variants are distinct written characters. The Mandarin reading estimate receives the character inventory and character coverage within the book, together with sampled passages; it considers character familiarity, compound-word meanings and sentence demands. There are no fixed character-to-ACTFL/HSK score cutoffs.

Langy estimates the reading demand from passages sampled across the book with the configured language model. Its rubric follows the broad Novice, Intermediate, Advanced, Superior and Distinguished ranges in the ACTFL reading guidelines. It considers discourse, syntax, context, vocabulary and inference. The book panel shows a rationale, sample count and quotations verified against the sampled text. The library can filter by the estimated reading range. These provisional text estimates have not been calibrated against formal proficiency assessments. [ACTFL proficiency guidelines](https://www.actfl.org/proficiency-guidelines-overview)

The OPI assesses a person's speaking. Langy's reading estimate describes text demand. A reader's proficiency requires performance assessment. [ACTFL OPI](https://www.actfl.org/assessments/postsecondary-assessments/opi)

## Mixed-language books, Mandarin and Portuguese

Langy uses EPUB `lang` / `xml:lang` tags and script/passage detection for word help, vocabulary analysis and narration. Mandarin, English and Portuguese passages can coexist in a book without sharing a vocabulary counter. Automatic identification of short, untagged passages can be ambiguous; correct language tags and the primary **Book language** help. Existing books are reanalyzed automatically after this update; re-uploading an EPUB is unnecessary. Portuguese analysis supports `pt`, `pt-BR` and `pt-PT`; inflected forms are mapped to lemmas and known contractions are included in the vocabulary analysis.

Hover or tap Chinese text to see **the whole word's meaning, tone-marked pinyin, and the meanings/readings of each character**. Compound meanings are displayed separately from character meanings: a compound need not mean the literal combination of its characters. Simplified and traditional headwords come from the bundled [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict) dictionary, with [Unicode Unihan](https://www.unicode.org/reports/tr38/) readings and definitions for additional characters. [pinyin-pro](https://github.com/zh-lx/pinyin-pro) supplies phrase-aware pronunciation; dictionary readings correct recognized compounds and alternatives remain visible for ambiguous readings. Unknown meanings/readings are explicitly unavailable. The normal English gloss lookup is local and needs no LLM/API request. Other hover modes still use their configured dictionaries or AI connection.

Enable **Settings → Language → Show pinyin above Chinese text** to keep pronunciation visible while reading. Turn it off to remove Langy's inline pronunciation; the setting persists in this browser and does not disable hover pronunciation. Pinyin is drawn above the original text (alongside vertical text), without changing EPUB/PDF text nodes, source word offsets or saved progress paths. It updates after page turns, resizing and font changes. Reflowable EPUBs reserve additional line spacing; fixed PDFs need selectable text and retain their original layout. Publisher-provided ruby annotations retain their source formatting. Noto Sans SC/TC font fallbacks are bundled for Chinese; very rare glyphs still depend on font coverage.

Under **Settings → Narration**, **Match Kokoro voices to passage languages** switches voices as the language changes, while preserving one continuous book recording. Standard Kokoro presets include Mandarin `zf_xiaobei`, Portuguese `pf_dora`, and English `af_heart`; your server must provide the selected voices. Set per-language overrides to use other voices, including a European Portuguese voice supplied by your TTS server. Kokoro's Portuguese presets use Brazilian Portuguese. Custom voice IDs without a recognized Kokoro language prefix retain your chosen voice unless an override is provided. Narration stays disconnected in the demo.

Uploaded mixed-language recordings use multilingual speech recognition instead of forcing the primary language. Alignment can match simplified recognized speech to traditional source text while leaving the book itself unchanged. Existing mixed-language recordings can be synced again or rescanned; changing narration voices requires generating new audio. Recognition quality still depends on the model and the recording, and estimates remain labelled.

CC-CEDICT data is distributed under CC BY-SA 4.0, Unihan under the Unicode license, pinyin-pro under MIT, and Noto fonts under the SIL Open Font License. Source links and notices are included with the dictionary and font packages. Dictionary definitions are indexed separately from application code.

## Kokoro narration

Open **Settings → Narration** on your personal installation. Enter your Kokoro API base URL, such as `http://host.docker.internal:8880/v1`, model `kokoro`, and a voice for the book's language, such as `ef_dora` or `em_alex` for Spanish. The optional API key stays on the server. **Save and find voices** tests the connection and accepts both voice IDs and objects returned by Kokoro. You can also initialize the connection with `READER_KOKORO_URL`, `READER_KOKORO_VOICE`, and `READER_KOKORO_API_KEY`.

Enable **Narration** or select the headphone button in the reader. **Generate book audio**, available in the player and under **Analysis & audio**, creates one complete MP3 for the entire book. The same recording plays continuously across displayed pages and source sections. Its scrub bar has chapter ticks and a chapter menu, and the MP3 contains chapter metadata. EPUB markers use the table of contents and headings; unlabelled text uses section breaks or clearly labelled reading markers. PDFs use bookmarks when available, with page markers as a fallback.

**Settings → Narration → Hide audio toolbar** hides the entire audio player while playback and page following continue. Space still plays and pauses. Clear the option to bring the controls back. Use full screen and **Appearance → Auto-hide docks in full screen** for a view with only the book text.

## Upload your own audiobooks

On a self-hosted installation, open a book's **Analysis & audio → Your audiobooks**. Upload MP3, M4A, M4B, OGG/Opus, WAV, FLAC or AAC, give the recording a name, then select **Sync with book** when preparation finishes. Uploads do not require Kokoro. A reverse proxy may impose a smaller upload limit.

Select one complete audiobook or up to **200 chapter files**, totalling **1 GiB** and at most **72 hours per recording**. File names are sorted naturally (`1`, `2`, `10`); use **Move up / Move down** before uploading to set the chapter order. Background preparation normalizes and joins them into one continuous MP3, with file boundaries in the player's chapter menu and scrub bar. Alignment still uses the actual book text, so audio chapters can differ from EPUB sections or displayed pages. Preparation resumes after a server restart. Original chapter files remain individually downloadable, and **Download complete MP3** downloads the joined recording with embedded chapter metadata. Upload another set under a different name to keep multiple narrators or editions.

Syncing runs in the background using the local multilingual speech model. Transcript checkpoints survive a restart and can be reused for another sync. Unique phrase anchors align recognized speech to the book; the resulting match percentage is displayed. Abridged audio, introductions, OCR errors and different editions can reduce coverage. Recordings with too little matching speech are rejected. Unmatched positions within matched sections are estimated for page following, and estimated words are never highlighted. Sections absent from the recording are skipped during playback.

Upload and sync several recordings of the same book, then choose **Recording** in its reader to select a narrator or edition. Each book's selection is remembered in this browser. Generated narration stays available as a separate choice. Original recordings can be downloaded or removed independently in **Your audiobooks**. The public demo shows these options without accepting audio uploads.

Pages always follow playback and scrubbing, including jumps across chapters and repeated scrubs while paused. **Settings → Narration → Highlight spoken words** independently controls the visible word highlight. Font changes preserve playback position. Turning a page manually seeks to that page in the full recording; clicking a synchronized word or chapter marker also seeks while preserving play or pause state. PDFs stay linked to their fixed page numbers. Scanned pages need an OCR text layer to be narrated.

Select **Podcast mode** in the audio player for larger playback controls: rewind or fast-forward **10 seconds**, play/pause, previous/next audio chapter, and speed presets from **0.5× to 2×**. The chapter buttons use the same markers as the scrub bar. Skips and chapter jumps preserve play or pause state; page following stays active with highlighting on or off. Choose **Compact player** to return to the smaller controls. The podcast layout and playback speed are remembered in this browser and can also be set in **Settings → Narration**. Supported browsers also expose play/pause, 10-second seeking, and chapter actions to device media controls. Audio downloads remain available under **Analysis & audio → Download complete book MP3**.

## Import iVoox audiobooks

Under **Analysis & audio → Your audiobooks → Import from iVoox**, paste a publicly downloadable **episode** link. For an audiobook split into episodes, paste one link per line in chapter order. Episode links from `ivoox.com`, localized iVoox hosts and supported iVoox short links are accepted; podcast series and playlist pages need individual episode links instead. The same 200-chapter, 1 GiB and 72-hour recording limits apply. Downloads and chapter preparation run in the background; choose **Sync with book** when the recording is ready.

The importer reads the episode's published download metadata without executing page scripts, then follows public HTTPS download redirects with private-network protection and streaming size checks. It checks each file with ffmpeg before publishing the joined recording. Login-only, paid and preview-only episodes without a public full download are rejected with a message. No iVoox account credentials are collected. Cancel an import from the audio panel. Downloads interrupted by a server restart need to be imported again; accepted chapter preparation and completed recordings persist. External importing is disabled in the public demo.

## Rescan missed audio words

Choose **Rescan missed words** beside a synced uploaded recording, chapter-file audiobook, iVoox import or completed generated narration. This uses the existing audio and the bundled local speech recognizer; it does not regenerate narration, contact Kokoro, or incur AI API fees. Langy extracts short clips around unconfirmed text spans and recognizes them again with a fresh decoding pass, including gaps across previously unmatched sections. Existing recognized word positions are preserved, and candidates must fit the neighbouring matches and recording boundaries. Recognition confidence and non-silent audio checks reject weak candidates; words are not forced onto omitted or different text.

The panel shows progress, newly found matches and remaining unconfirmed words. Results are applied atomically when the pass completes. Playback remains available using its existing alignment while work is pending; retry resumes completed clip checkpoints after an error or restart. **Cancel rescan** discards the pending pass and keeps the current alignment. The active reader refreshes its timing cache without restarting the audio. The audio file and its embedded metadata stay unchanged; the player's timing and markers are refreshed. A rescan can still leave gaps, and retained recognition matches may themselves contain errors. Estimated positions continue to support page following and are never highlighted as recognized words. Rescanning is available on self-hosted installations.

## Generated narration and timing

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

## Anna’s Archive imports

On your self-hosted installation, open **Settings → Book sources**. Choose one of the listed official mirrors, enter your own membership key, and save. The instance-wide key is stored in a private file in the data volume, is not returned by settings or job responses, and is not placed in browser storage. Saving does not consume a download; membership eligibility and allowance are checked when you import.

In **Import book**, select **Anna’s Archive**, paste the edition's book link or MD5, and choose a category. EPUB metadata is used when available; title, author and language can also be entered. Downloads run in the background with progress, are capped at **120 MiB**, verified against the requested MD5, and pass the same EPUB/PDF validation as manual uploads. Unsupported formats are rejected. An interrupted server restart requires retrying an unfinished download; check your library first. Only one Anna’s Archive import runs at a time. Membership fees and download quotas belong to Anna’s Archive; Langy does not provide a shared key or integrated catalogue search. See the [official API FAQ](https://annas-archive.gl/faq#api).

The public demo shows where to configure a personal installation and does not accept membership keys or external book downloads. Include `archive-settings.json` in private data-volume backups, keep it out of Git, and use **Remove saved membership key** to disconnect.

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
