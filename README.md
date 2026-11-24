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

Books, categories and reader preferences live in the data volume. Reading preferences follow the configured reader account across browsers and devices: appearance, language choices, pinyin, shortcuts, audio controls and selected recordings. The first browser imports its existing preferences into an empty account; later browsers load the saved account choices. Local caching keeps reading available offline and retries changed preferences when connected. Device names and the device’s progress-sync toggle stay local; reading positions use the separate progress-sync feature. Demo preferences are private to each expiring visitor session. Back up the data volume to preserve uploaded files, the catalog and account preferences.

Selecting an EPUB or PDF in **Import book** fills in its title, author and primary language from embedded metadata. When no language is declared, Langy samples readable text to estimate it. A missing title falls back to the filename; an undetectable language defaults to Spanish. Review or change the fields before importing, or use **Book details** (the pencil on a library card) afterward. Blank fields request automatic details; saved details are retained when the file supplies none. Your edits take precedence over automatic suggestions; language folders still apply their configured language. Detection runs locally without an AI API. Scanned or locked PDFs and files with incomplete metadata may need manual details. Books use one primary language by default; enable **Multiple languages in this book** to detect passages among explicitly selected languages.

The stack also includes a local `language` service for lemma analysis and audio alignment. Its first build installs Spanish, English and Portuguese spaCy models, lookup data for additional supported languages, and the multilingual Whisper **small** model. These models run offline after the build and require no paid API. Set `READER_WHISPER_MODEL=base`, `small`, `medium` or `large-v3` in `.env` before building to choose the recognizer; larger models require more download space, RAM and CPU time. Rebuild both `language` and `reader` after changing it. Narration connects to your existing Kokoro server.

## Reading controls

The default **Quiet library** keeps statistics in **Reading history** and book tools under **Book options**. **Show reading details** expands book statistics and tools. Filters remain available in both views. Search, level, sort and status use one compact row. Star a book to mark it **Currently reading** and keep it first, including when sorting by vocabulary density. Unstar it to remove the pin. **Set aside** saves a separate status and removes the book from the default **On shelf** view; choose **Set aside** or **All books** to find it, then **Return to shelf** when desired. Neither action changes completion, text, audio or bookmarks. Starring a set-aside book returns it to the shelf. These choices persist across browsers; demo visitors have separate temporary choices.

The reader’s **Immersion mode** button, also available in Appearance settings, hides page numbers, progress bars and audio clocks. Word help, summaries and playback controls remain available. Tracking continues in the background, with no reading targets, streaks or rewards.

**Interface language** is separate from book, summary and translation languages. Choose English, Spanish, Portuguese or Mandarin; technical help and server errors can fall back to English. **Native language (L1)** is optional. Setting English, for example, excludes English from book vocabulary breakdowns, the seen/likely-known catalogue, below-threshold lists and vocabulary-overlap recommendations. Actual reading records are retained, so changing or clearing L1 updates these views without rescanning books or losing exposure history. Literal book word counts and reading-time totals remain available for every language.

**Reading history** shows total active reading time and a per-language breakdown. Time pauses after **two minutes without interaction**, while the app is hidden/unfocused, or while a dialog is open. Page turns, keyboard/touch actions, scrolling and intentional word lookups renew activity; automatic audio page turns and passive mouse movement do not. Long sleep/timer gaps are excluded, retries are idempotent, and overlapping intervals from multiple tabs/devices count once. Mixed-language time is an estimate based on visible text, not a measurement of eye movements. Server totals persist across sessions and book deletion; offline intervals sync on reconnection.

Select the reader’s **search** button for whole-book phrase search and a **character guide**. A search result jumps to its text position and updates normal page/audio following; the previous-location button returns to where you were. Search ignores case and accents, including Spanish/Portuguese diacritics, and supports Mandarin. Character explanations use only excerpts reached by your current page. The summary panel also has an **Ask the chatbot** box with **Current page** and **Book so far** scopes. Answers use your summary language and configured model. Earlier context is selected within a bounded budget; later text is excluded before prompting. The model may still misinterpret or invent details, so these tools do not guarantee spoiler-free or error-free answers.

## Offline reading and Android

Choose **Book options → Save offline**, select whether to include a synced recording, then **Add to download queue**. The dialog closes immediately so you can keep reading or queue other books. Open **Downloads** in the library or the Android app menu to see each book’s status, progress bar and transferred bytes, cancel a queued/active transfer, or retry a failed download. Books download one at a time. The device saves the queue and resumes interrupted jobs after reopening or reconnecting; interrupted transfers restart safely. Keep Langy open while downloads run—Android may suspend a WebView after the app is backgrounded. Byte counts measure the current book/audio file; the bar also includes dictionary and reader preparation.

Langy saves the EPUB/PDF, indexed text, available dictionary entries, bookmarks, the reader’s fonts/PDF resources and optional complete audio. Wait for **Available offline on this device** before disconnecting. A failed, cancelled or interrupted replacement keeps the previous completed pack. Remove a pack using the same dialog.

Offline reading supports page navigation, saved dictionary help, Mandarin pinyin, whole-book search and downloaded audio with synchronized page following. Dictionary coverage varies by language and the installed datasets; offline meaning lookup does not call an AI API. New AI answers, audio generation, PDF OCR and external imports require the server. Browser storage limits apply, especially to long audiobooks; download without audio or remove another pack if space is insufficient. Packs with over 150,000 dictionary candidates need smaller volumes.

Bookmarks, completion/currently-reading/set-aside changes, reader preferences, reading positions, time and vocabulary exposure remain on the device when offline. Reconnection retries pending changes, including positions from books you have closed. A newer position on another device is retained until you choose how to resolve it. Offline packs and bookmark outboxes are tied to the signed-in account; switching accounts online removes the prior account’s local packs and outbox. Keep these downloads on your personal device.

The Android app is built by [Build Android APK](https://github.com/Attach7830/Langy-Reader/actions/workflows/android.yml). Download and extract **Langy-Reader-Android** from the latest successful run’s Artifacts, then install `app-debug.apk` (Android 8+). In **Server connection**, enter your public HTTPS Langy URL and the same username/password used in your browser. For example, use `https://books.srtw.win`; do not enter your Audiobookshelf URL. The app stores its remembered login encrypted with Android Keystore and keeps external links in your browser. Update your server before downloading reading packs. Its initial connection and each new pack need Internet/server access; downloaded packs remain usable without it. Browser offline packs likewise need HTTPS or localhost.

This is a sideloadable preview, not a Play Store release. Version 1.1 uses the **Langy Reader Preview** app (`win.srtw.langy.preview2`), which installs alongside the original preview: that earlier build failed to retain its signing key and cannot receive a compatible update. Keep the old app until its pending reading changes have synced; sign into the same server in the new app and download offline packs there. The old app’s offline files are not deleted or transferred automatically.

The build now signs with an explicit, cached key, verifies its public certificate against `android/preview-signing.sha256`, and fails rather than silently replacing a missing signing identity. The owner’s private backup can restore the key through the repository secret `LANGY_ANDROID_KEYSTORE_BASE64` if its cache is lost. The canonical repository also uploads an encrypted key backup readable only with the owner’s separately retained private backup key. Neither private key nor plaintext keystore is committed or uploaded as a public artifact. Forks generate their own identity and do not use the canonical backup recipient. Production distribution still needs a managed release key. The APK has been compiled in CI; physical-device behavior should be checked on your Android/WebView version.

## Audiobookshelf

Open **Settings → Devices → Audiobookshelf**, enter its full server URL and API key, and select **Save and connect Audiobookshelf**. Separate machines are supported: for example, Langy on `192.168.1.10` can connect to ABS on `http://192.168.1.20:13378` if that is your configured ABS port. Choose the destination library/folder and save again. The key stays on the Langy server in a private settings file and is never sent to the reader browser. Its ABS account needs the corresponding upload/download permissions.

Under a book’s **Analysis & audio → Audiobookshelf**, export the selected complete MP3, EPUB/PDF, embedded cover when present, and metadata/chapters. Let ABS scan the files, reopen the dialog, choose the resulting title and confirm that both apps have the **same recording** to link listening positions. Similar duration alone cannot identify an edition safely. Alternatively select an existing ABS audiobook and **Import audio and sync with this book**. Its tracks are downloaded in order, assembled where necessary and automatically queued for alignment; the imported recording is linked to that ABS title. The usual 200-track, 1 GiB, 72-hour recording limits apply.

Transfers run in the background with a visible status. Playback positions use audio seconds from the linked recording, not book percentages. Langy’s alignment maps those seconds to the text. Selecting a different recording never reuses the old recording’s ABS link. If another device changes the ABS position, choose **Resume ABS position** or **Keep this position**; offline listening positions are retained for a later retry. Changing the ABS connection/key requires linking recordings for that connection again. Live compatibility still depends on your installed ABS version and permissions.

Book recommendations include **Search Anna’s Archive**, opening a search for the recommended title and author on your configured mirror. You choose the edition and import it normally. Single and bulk Anna’s Archive downloads enter the background queue immediately. **Queue if unavailable** is enabled by default, retrying transient failures every six hours; individual requests can opt out, and the global Book sources setting can disable retries. Invalid credentials are not retried automatically. Free slow-download browser checks still require user interaction.

Open **Settings → Language → My reading languages** to save the languages you read. Import book and bulk downloads suggest only that list for primary/additional languages, while blank fields still use automatic detection and other valid language codes remain accepted. The list follows your reader account across browsers. Portuguese (`pt`, `pt-BR`, `pt-PT`) is supported by analysis, hover requests, language-aware narration and PDF OCR (`por`).

Open **Bookmarks** in the reader toolbar, or press **M** (customizable), to save the current EPUB/PDF position with a label and optional note. Saved bookmarks follow your library across browsers; opening one uses the same page/audio navigation and allows returning with the previous-location control. Repeatedly saving the same source position updates its note instead of adding duplicates. Demo bookmarks are private to each visitor.

While reading, **[** rewinds audio ten seconds and **]** skips forward ten seconds, including with the toolbar hidden. Both shortcuts are customizable in Settings. Scroll over the playback speed control to change speed in **0.05×** steps between 0.5× and 2×; ordinary page scrolling is unchanged.

**Import book** and **Book details** include six selectable default covers: Terracotta, Forest, Ocean, Night sky, Parchment and Plum geometry. Previews show your title and author. The choice is saved with the book across browsers. **Original / automatic** restores the embedded image when available, or the existing generated cover; choosing a design never alters the EPUB/PDF or deletes the original cover.

On mobile, **swipe left to go forward or right to go back**; swipe turning is on by default for EPUBs and PDFs. **Tap the center third of the reading area to toggle full screen** by default. In the Android app, full screen hides the native Langy Reader title bar and system bars too. Tap the center again or use Back to leave it. **Settings → Appearance → Reading controls** independently controls swipe turning, optional left/right edge taps (off by default), and center-tap full screen. With center-tap full screen disabled, center word taps retain word help and audio seeking. Links, controls, text selections, long presses and pinch gestures keep their normal actions. Vertical scrolling stays available, and zoomed PDFs use horizontal dragging to pan rather than turn pages. Page turns, layout changes and source jumps render sequentially; a stalled page times out and reopening restores your saved location.

Each library card and **Analysis & audio** shows the book's **word count**, including repeated words, names and numbers. This counts surface word occurrences in readable text using Unicode word segmentation, independently of unique lemmas and vocabulary filters. Mandarin Han-character occurrences are shown separately. EPUB counts are extracted locally before lemma analysis and recover automatically for existing books even if the language service is unavailable. PDF text extraction still needs the language service. Illustrations and image-only sections are skipped without changing chapter positions; text stored only in images needs OCR and contributes no selectable words.

**Total words read** at the top of the library estimates reading volume from displayed passages and books marked read. Saved page-view history is included automatically. Overlapping views and layout changes within a reading session count once; reopening a book starts a new session, so rereading counts again. Marking a book read fills only the source positions not already tracked, and marking it unread removes that inferred contribution while retaining tracked reading. Mandarin characters have their own total. Pending completed books contribute when text counting finishes; lemma analysis can finish separately. Counting runs locally without AI API calls, and totals refresh when you return to the library.

Each library card has **Mark as read**, which adds a saved **Read** badge. Select **Mark as unread** to undo it, and use the **All books / Unread / Read** filter to browse by completion. Status is stored on the server and persists across browsers and restarts; demo visitors have their own temporary status, including for the shared sample book. Marking read preserves the reading position and contributes the analyzed book's vocabulary as one complete reading, including books already marked read before this update. If analysis is pending, the contribution appears when it finishes. Marking unread removes the inferred completion contribution and keeps actual tracked reading.

In the category editor, optionally choose a **Folder language**. Saving assigns it to books already in the folder; imports and books moved there also inherit it as their primary language. Books using automatic detection become restricted to the folder language, while explicitly selected additional languages are preserved for mixed-language books. Changing a book's language queues fresh analysis without replacing the book file, audio or bookmark. Clearing the folder language stops automatic assignment and keeps the books' current language settings.

| Key | Action |
| --- | --- |
| Right arrow | Next page |
| Space | Play or pause when narration is enabled; next page when narration is off (default) |
| Left arrow | Previous page |
| F | Full screen |
| S | Open or close the current page summary |
| P | Play or pause narration |
| A | Show or hide the audio toolbar without pausing narration |
| Y | Show or hide inline pinyin |
| B | Return to the location before following an internal book link |
| Down / Up, while a word popup is open | Cycle the active entry’s meanings |

Change assigned keys in **Settings → Hotkeys**. Space always controls playback while narration is enabled; when narration is off, its assigned action applies. **A** toggles the audio toolbar while playback and page following continue. Existing custom key assignments are preserved when new shortcuts are introduced; a conflicting new shortcut starts unassigned. Navigation and summary buttons also work on touchscreens. Hold Left or Right to continue turning pages at keyboard-repeat speed; only one page change runs at a time, with at most two pending turns. Toggle shortcuts ignore held-key repeats.

Following an internal EPUB or PDF hyperlink records the location you left. Use the **Back to previous location** arrow in the reader header or **B** to return, including after paging through a footnote section. Nested links can be retraced one at a time. EPUB returns use stable text CFIs, and PDF returns retain the page and scroll position. Normal page turns, narration following and layout changes do not add return steps. Return history resets when the book closes. PDF link annotations are clickable; external PDF web links open in a separate tab.

Reading preferences, pinyin visibility, typography, theme, audio preferences and custom hotkeys are saved in persistent browser storage for this site and restored on later sessions. Saving a partial preference update keeps the other saved settings. Preferences are separate for different browser profiles and site addresses.

Open **Sections** in the reader (or **Book sections** in the Android menu) to filter and jump to a chapter, book section or PDF bookmark. **Reading outline** in EPUBs builds a navigable list from headings, section breaks, and the opening words of passages. It opens automatically for books with fewer than two linked entries. Long stretches of uninterrupted text get approximate reading markers. The outline is built locally from the EPUB and works offline. PDFs also support a direct page-number jump. Section jumps join the reader’s back history.

**Appearance** controls EPUB font, size, line spacing and page width. Choose Paper, Sepia, Dark, Dusk or the near-black Midnight theme and a reader background. PDFs retain their page layout and have fit and zoom controls. Scanned PDFs display normally and need selectable text for summaries and word help.

**Language help** controls what happens when you hover or tap. Choose a translation, target-language definition, synonyms, or Off. Translation and summary languages default to English and accept language names or [BCP 47 codes](https://www.w3.org/International/articles/language-tags/), including Spanish. Definitions and synonyms use the language set on the book. EPUB metadata supplies a language when available. AI output quality varies with the language and model.

**Dictionary synonyms** look up words and recorded inflections in local WordNet and Wiktionary indexes. Each group shows its source and meaning. When a source has a definition for the word, Langy can show that meaning even when it has no synonym. The bundled reading notes cover selected regional and literary terms, including *tiliches* and *entilichada* in *Pedro Páramo*.

To fill uncovered entries, enable **Explain missing synonym entries with AI** under **Settings → Language help**. In this mode the reader sends the surrounding passage to the configured AI connection and displays the answer as an AI context explanation. The option is off initially. Dictionary lookups run offline.

The summary panel sits to the right of the book or below it on narrow screens. Leave it open to get a new summary as you turn pages. Page summaries stay within three short sentences. Select **Go deeper** for a fuller explanation or choose a suggested question about the page. Go deeper uses short, separate sections: **On this page** (up to two sentences), **What it means** (up to three), and optional **Useful context** (one sentence). It focuses on the current page's events, wording and implications, using earlier or historical context only to clarify a detail on that page. It requests original wording and avoids a whole-story synopsis, general biography or publication dates. If the response mostly copies the supplied text or omits the explanation, Langy retries once; a second unsuccessful response shows an error you can retry. Short supporting quotations remain allowed. The AI generates the questions from the reading context and answers them when selected. For longer books, Langy looks across the earlier pages for relevant passages.

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

Omit `--tunnel` if you do not use `compose.tunnel.yaml`. The helper requires a running personal reader using a named Docker volume and an existing `.env`. It refuses an unmounted destination or a nonempty destination `library` folder. It builds the reader and verifies its copy tools can run before downtime, stops it to copy all books, recordings, settings and SQLite databases, and compares every copied file before switching. The copy uses the reader's named image without downloading a helper image. Keep this terminal open until it completes.

The helper preserves permissions, retains the original volume and a private `.env.storage-before-*` backup, and sets `READER_DATA_SOURCE` and `READER_STORAGE_ID` in `.env`. Existing credentials, including literal dollar signs, are retained. The reader validates the destination's `.langy-storage-id` before opening any databases; an absent drive or wrong folder causes startup to fail instead of initializing a new library. A failed copy or startup restores the old settings and attempts to restart the original volume. Copies left by an incomplete migration require inspection before retrying.

Your usual Compose commands, including the tunnel override, continue to use the configured host folder through `.env`; no separate storage override is needed. Refresh the library's storage meter and verify books, recordings and reading progress after migration. The original volume remains a backup on the previous filesystem, so it continues using that disk's space until you choose to remove it. Do not remove it until the migrated installation has been checked. New installations can keep using the default named volume without these optional settings.

## Lemmas and reading demand

Books are analyzed automatically after import, including books already in the library when the updated app first opens. **Analysis & audio** shows whole-book and per-section vocabulary counts. Spanish, English and Portuguese use contextual spaCy models; other supported languages use lookup tables. Hover help also shows a detected lemma. If lemmatization is unavailable, the app labels its counts as word forms. Detected proper names are excluded from lemma totals.

Spanish future subjunctives such as **hubiere → haber**, **tuviere → tener** and **hiciere → hacer** use attested conjugation paradigms from the installed lookup dictionary, including compound forms such as *hubieres terminado*. Context preserves nouns such as *cantares* and *pesares*. Ambiguous forms show **Possible lemmas** on hover; an unresolved form contributes one provisional lemma, rather than counting every candidate. Existing Spanish and mixed-language books are queued for fresh analysis once after this update, and saved reading exposures are reindexed when it finishes. Book files, bookmarks and audio do not need to be replaced. See [the targeted validation](benchmarks/lemmas/SPANISH-FUTURE.md) for measured results and limits.

Spanish vocabulary normalization also separates attached pronouns: **achicarme / achicándome → achicar + yo**, **agregarlo → agregar + él**, and **aproximarse / aproximársele → aproximar**, with each pronoun tracked at its own source position. Combined model outputs such as “achicar yo” are no longer inventory entries. Attested preterites share their infinitive, including **oyó / oyeron → oír**. Adjective gender/number variants and dictionary-attested noun pairs such as **adulto / adulta / adultos / adultas** share a base word. Participles identified as verbal participles, including **almizclado / almizclada**, contribute to **almizclar**; lexical nouns such as *vestido*, *bolsa* and *música* retain their noun reading. This learner grouping can differ from strict dictionary/UD lemma conventions. Existing Spanish analyses and exposure histories refresh once after upgrade, without changing source words, audio timing or book files. See [the normalization checks](benchmarks/lemmas/SPANISH-FORMS.md) for scope and remaining errors.

Spanish now uses a local dictionary with **668,422 tagged grammatical readings** from [FreeLing's Spanish Resource Grammar data](https://github.com/TALP-UPC/FreeLing/tree/0bae6b7f6d1b405e67658895de54b59bfb3b6338/data/es/dictionary/entries), alongside contextual spaCy analysis. Noun/adjective paradigms and imperative forms come from those grammatical records, covering pairs such as **profesoras → profesor**, **escritoras → escritor**, **investigadoras → investigador** and **leonas → león**. The same clitic grammar applies to any supported verb, including up to three attached pronouns, accent restoration and imperative letter changes. Distinct nouns such as *manzano/manzana* stay separate. Ambiguous readings retain their alternatives on hover. Unknown entries use a conservative lookup fallback; contextual tagging can still be wrong.

The Docker build downloads checksum-pinned dictionary sources and builds the local index. Runtime analysis requires no download, LLM or paid API. The original lexical sources, LGPL-LR license and attribution accompany the derived index in `/opt/models/spanish-morphology/`. Existing Spanish books and exposure histories refresh once after this dictionary upgrade. See [the generalized-rule validation](benchmarks/lemmas/SPANISH-GENERALIZATION.md) for reproducible checks and benchmark limitations.

Mandarin uses **unique Han characters**, with a separate count of character occurrences. English, Portuguese and other languages keep their own lemma/word-form counts. The library and analysis table show separate language totals for mixed books; Mandarin characters are never added to a lemma total. Punctuation, English letters and pinyin annotations are excluded from Han counts. Simplified and traditional variants are distinct written characters. The Mandarin reading estimate receives the character inventory and character coverage within the book, together with sampled passages; it considers character familiarity, compound-word meanings and sentence demands. There are no fixed character-to-ACTFL/HSK score cutoffs.

Langy estimates the reading demand from passages sampled across the book with the configured language model. Its rubric follows the broad Novice, Intermediate, Advanced, Superior and Distinguished ranges in the ACTFL reading guidelines. It considers discourse, syntax, context, vocabulary and inference. The book panel shows a rationale, sample count and quotations verified against the sampled text. The library can filter by the estimated reading range. These provisional text estimates have not been calibrated against formal proficiency assessments. [ACTFL proficiency guidelines](https://www.actfl.org/proficiency-guidelines-overview)

Reading-demand estimation has its own queue, so narration, audiobook synchronization and rescans do not hold it up. Only one automatic estimate runs at a time. The analysis panel distinguishes queued and running requests, shows elapsed time and errors, and offers **Retry reading estimate** (or **Restart reading estimate** while pending) without repeating vocabulary analysis. A request has a hard 100-second deadline in addition to the AI connection's request timeout. Interrupted requests resume after a restart; missing estimates for analyzed books are queued automatically. An unavailable or slow model is reported as an error instead of leaving the estimate pending indefinitely.

The OPI assesses a person's speaking. Langy's reading estimate describes text demand. A reader's proficiency requires performance assessment. [ACTFL OPI](https://www.actfl.org/assessments/postsecondary-assessments/opi)

## Seen vocabulary and recommendations

Langy records vocabulary from the text visible on a page after it remains displayed briefly, independently of whether audio is enabled. Inflected words use the analyzed lemma; proper names are excluded in line with book analysis. Mandarin uses individual Han characters, and each other language keeps its own lemma or word-form inventory. **Vocabulary** in the library opens the saved catalogue, with language/search filters and dates. Records are shared by browsers using the personal installation; demo visitors keep separate, expiring catalogues. Previous reading and KOReader progress do not automatically mark vocabulary as seen. A bounded browser queue retries temporarily failed saves.

Vocabulary analysis treats a bound **anti-** prefix as part of its word, including joined and hyphenated forms. It does not add a separate `anti` lemma for `antihéroes` / `anti-héroes`; independently written `anti` and unrelated words such as `antiguo` retain their ordinary analysis. Tokens containing numerals, including Unicode digits and split forms such as `U2`, `4x4` and `COVID-19`, are excluded from lemma inventories. These filters do not remove text or reduce the independent surface word/read counts. Existing analyses refresh once after upgrading; saved reading ranges are retained and their vocabulary contributions are rebuilt.

**Vocabulary → Exposures before likely known** sets a threshold from 1 to 10,000, initially 20. The catalogue shows each item's exposure count and whether it reaches the threshold, with separate likely-known totals for every language and Mandarin characters. The library can sort by **Lowest below-threshold vocabulary density**, and book analysis shows likely-known counts alongside seen and not-yet-seen vocabulary. This estimate uses tracked reading plus inferred exposures from books marked read; the catalogue separates those sources. The default is an adjustable heuristic, not a validated mastery cutoff. Changing the threshold recalculates the estimate immediately and keeps the reading history.

A read mark counts each analyzed lemma or character occurrence in a book once, adding only source positions not already encountered in tracked reading. A partially read book therefore fills its remaining gaps; a fully tracked first pass is not counted again. Additional tracked rereading sessions are retained. Repeated read marks and reanalysis do not inflate the tally. Marking unread removes the inferred contribution alone. The read mark is evidence supplied by you, not proof of attention, comprehension or mastery; saved progress and KOReader positions alone do not create it.

Each occurrence of a lemma or character counts once per reading session. Inflected forms contribute to the same lemma; overlapping pages, retries and font/layout changes do not count the same occurrence again. Reopening a book to reread it starts a new session. Earlier saved reading ranges are reused conservatively as a single legacy session per book because previous versions did not distinguish rereading sessions. Language corrections rebuild the occurrence catalogue from those saved ranges.

Library cards and **Analysis & audio** show how many unique items are **Not yet seen**, separately for each language. This is an exposure estimate, not proof that a word is unknown or mastered. **Lowest unfamiliar vocabulary density** sorts by `distinct unseen lemmas ÷ surface word count × 1,000`, lowest first. **Lowest below-threshold vocabulary density** uses distinct lemmas below your saved exposure threshold in the numerator. Book cards show the raw count and rate; for example, 300 unseen lemmas in 100,000 words is 3 per 1,000, ranking ahead of 100 in 10,000 words (10 per 1,000). The denominator includes repeated words, names and numbers, matching the book's word count. The numerator counts each unfamiliar lemma once regardless of its frequency; the rate is not a percentage of unknown word occurrences or a proficiency score.

Mandarin uses distinct unfamiliar Han characters per 1,000 Han-character occurrences. Mixed books calculate a separate rate for each language and use the mean of those rates for sorting, without adding lemma counts to character counts or letting familiar text in one language dilute another language's rate. Missing or zero-length text has no rate and sorts after measured books; a genuine rate of zero sorts first. Existing books gain these rates from their saved text automatically without reuploading or AI requests. When a book's language selection changes, its saved reading ranges are reanalyzed to correct the catalogue as well as its book statistics.

Select **Find books with similar vocabulary** in a book's analysis panel to see other analyzed books from your library, ranked by the average per-language Jaccard overlap of their vocabulary inventories, then by lower unfamiliar vocabulary density when similarity ties. Matches show shared vocabulary and the candidate's not-yet-seen counts and rates. Mandarin character overlap is compared separately from lemma overlap. Recommendation calculation is local, needs no AI call, and does not infer similarity of plot or genre.

### Discover books beyond your library

Open **Discover** in the header or **Discover books** in the library sidebar. Choose a book language (blank uses the most common primary language in your library), optionally describe what you want to read, and select **Find recommendations**. The model configured under **Settings → AI connection** examines library titles, authors, categories and read status, plans web searches, then selects up to six books from verified catalogue records. Each recommendation includes a brief connection to specific library books and source links. Bundled Ollama and your own local Ollama/OpenAI-compatible server are supported; no separate paid model or search API is required. A paid provider selected in AI connection retains that provider's normal billing.

Discovery uses a bundled, private [SearXNG](https://docs.searxng.org/admin/installation-docker.html) search service and the [Open Library Search API](https://openlibrary.org/dev/docs/api/search) for title/author records. Model-proposed titles are search leads until verified; the model can select only returned catalogue IDs. Books already in the library, duplicate titles, unsupported languages and unsafe source URLs are filtered out. Imported recommendations disappear from saved results. This verifies catalogue identity, not every literary interpretation; the explanation remains an AI suggestion. External books do not get estimated vocabulary overlap or reading difficulty until imported and analyzed.

The initial `docker compose up -d --build` starts search too. To add it to an existing installation without rebuilding language or Ollama:

```bash
docker compose --env-file .env -f compose.yaml -f compose.tunnel.yaml \
  up -d --build --no-deps search reader
```

Omit `-f compose.tunnel.yaml` if you do not use the repository's tunnel stack. Search exposes no host port and needs no public hostname. Its configuration and cache use `search_config` and `search_cache` volumes; the upstream startup script creates a random secret from the configuration template on first launch. To reuse an existing SearXNG instance, set `READER_SEARCH_URL` in `.env` to its base URL and enable its JSON search format. If general search fails, the app explicitly labels catalogue-only recommendations; if no candidate can be verified, it displays an error rather than unverified titles.

Discovery runs on request in a background queue with cancellation, time limits and explicit progress. Results persist across restarts, are reused for matching requests for up to 24 hours, and are marked stale when the library or selected model changes. Larger libraries are fully counted and sampled for bounded AI context. Search queries use titles, authors, language names and literary topics; full book text and vocabulary records are not sent to the web search services. Internet access is required for search and catalogue lookup. Demo results are scoped to each visitor and expire with that visitor. Open Library requests are cached, serialized and spaced to respect its default request limit.

Open **Analysis & audio → Words below threshold** for a searchable, language-filtered list of that book's lemmas or Mandarin characters with fewer exposures than your saved likely-known threshold. Items are sorted by the fewest recorded exposures first; ties prioritize items occurring more often in that book. Each row shows its exposure count, frequency in the book, and an expandable example from the original text. Opening the list does not record reading exposures. Zero means no recorded encounters, not proven unfamiliarity; read-book contributions are included and the same written item in different languages stays separate.

The **Meanings** selector offers **English translation**, **Spanish synonyms / equivalents**, or **Spanish definition**. Meanings load progressively for ten items per page using the configured AI connection and the book's example passage. Spanish synonyms come from local dictionaries and are labelled as possible senses; when no synonyms are available, a labelled Spanish definition is generated instead. Other languages receive Spanish equivalents in synonyms mode. Generated meanings are labelled as AI output and do not alter lemma analysis or exposure counts. Successful meanings are cached with the book analysis, example passage, output mode and AI connection; changes to those inputs invalidate them. Errors can be retried per row. Demo AI rate limits apply, and every demo visitor has their own vocabulary threshold and exposure history.

## Benchmark lemma accuracy

A separate benchmark compares Langy's checked-out analyzer with Stanza using a supplied answer key. It includes pinned published Spanish, Portuguese and English annotations, an original challenge key, and separate Mandarin character checks. It writes a readable summary and a CSV of disagreements without accessing or changing your library or running reader. The first build downloads the public models/reference data; inference then runs locally without paid APIs.

```bash
cd ~/Langy-Reader &&
git pull --ff-only &&
bash scripts/benchmark-lemmas.sh
```

Results are saved under `benchmark-results/`. See [the benchmark instructions](benchmarks/lemmas/README.md) for the answer-key provenance, model versions, scoring conventions and options. Original challenge labels have not had independent human adjudication; published treebank and novel accuracy should be assessed separately.

## Mixed-language books, Mandarin and Portuguese

Books are monolingual by default, using their automatically detected or manually chosen primary language even when EPUB tags suggest other languages. In **Book details** (the pencil on a library card), enable **Multiple languages in this book**, add each language, and save. For a Mandarin–English book, select Chinese/Mandarin and English. Analysis, hover help, pinyin and narration are restricted to that selection, including when EPUB tags disagree. Excluding the primary language makes the first selection primary. Saving automatically queues fresh analysis of the existing file and removes stale totals while it runs; no reupload is needed. An empty extra-language field never requires another selection: Enter can save the book, and with no selections the primary language is used automatically. Turn this option off to return to the primary language only. The same choices are available during import. Existing unrestricted analyses are refreshed automatically; explicit multilingual selections are preserved.

When multiple languages are enabled, Langy uses EPUB `lang` / `xml:lang` tags and script/passage detection for word help, vocabulary analysis and narration. Mandarin, English and Portuguese passages can coexist in a book without sharing a vocabulary counter. Automatic identification of short, untagged passages can be ambiguous; correct language tags and the primary **Book language** help. Portuguese analysis supports `pt`, `pt-BR` and `pt-PT`; inflected forms are mapped to lemmas and known contractions are included in the vocabulary analysis.

Hover or tap Chinese text to see **the whole word's meaning, tone-marked pinyin, and the meanings/readings of each character**. Compound meanings are displayed separately from character meanings: a compound need not mean the literal combination of its characters. Simplified and traditional headwords come from the bundled [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict) dictionary, with [Unicode Unihan](https://www.unicode.org/reports/tr38/) readings and definitions for additional characters. [pinyin-pro](https://github.com/zh-lx/pinyin-pro) supplies phrase-aware pronunciation; dictionary readings correct recognized compounds and alternatives remain visible for ambiguous readings. Unknown meanings/readings are explicitly unavailable. The normal English gloss lookup is local and needs no LLM/API request. Other hover modes still use their configured dictionaries or AI connection.

Mandarin dictionary popups show **one card at a time**, beginning with the whole word’s first dictionary definition and pinyin. **Down / Up** move through the word and its characters in order, for example **有意思 → 有 → 意 → 思**. The **▾** selector jumps to a card; **More meanings** expands that card’s other definitions. The compound and all character sections are never stacked on screen together. Other languages use the compact selector to cycle dictionary senses. **Escape** closes the popup (or an open alternatives list first). Closing resets the next lookup to the whole-word card, including cached lookups. A late AI translation preserves the selected card and appears only on the whole-word card.

Enable **Settings → Language → Show pinyin above Chinese text** to keep pronunciation visible while reading. Turn it off to remove Langy's inline pronunciation; the setting follows your reader account and does not disable hover pronunciation. Pinyin is drawn above the original text (alongside vertical text), without changing EPUB/PDF text nodes, source word offsets or saved progress paths. It updates after page turns, resizing and font changes. Reflowable EPUBs reserve additional line spacing; fixed PDFs need selectable text and retain their original layout. Publisher-provided ruby annotations retain their source formatting. Noto Sans SC/TC font fallbacks are bundled for Chinese; very rare glyphs still depend on font coverage.

Under **Settings → Narration**, **Match Kokoro voices to passage languages** switches voices as the language changes, while preserving one continuous book recording. Standard Kokoro presets include Mandarin `zf_xiaobei`, Portuguese `pf_dora`, and English `af_heart`; your server must provide the selected voices. Set per-language overrides to use other voices, including a European Portuguese voice supplied by your TTS server. Kokoro's Portuguese presets use Brazilian Portuguese. Custom voice IDs without a recognized Kokoro language prefix retain your chosen voice unless an override is provided. Narration stays disconnected in the demo.

Uploaded mixed-language recordings use multilingual speech recognition instead of forcing the primary language. Alignment can match simplified recognized speech to traditional source text while leaving the book itself unchanged. Existing mixed-language recordings can be synced again or rescanned; changing narration voices requires generating new audio. Recognition quality still depends on the model and the recording, and estimates remain labelled.

CC-CEDICT data is distributed under CC BY-SA 4.0, Unihan under the Unicode license, pinyin-pro under MIT, and Noto fonts under the SIL Open Font License. Source links and notices are included with the dictionary and font packages. Dictionary definitions are indexed separately from application code.

## Kokoro narration

The top-right headphone button and the customizable **A** shortcut share the same audio-toolbar toggle. Either can show narration when it was disabled, then hide or show the toolbar without stopping playback. The button's pressed state indicates toolbar visibility; narration itself can still be disabled in Settings.

Open **Settings → Narration** on your personal installation. Enter your Kokoro API base URL, such as `http://host.docker.internal:8880/v1`, model `kokoro`, and a voice for the book's language, such as `ef_dora` or `em_alex` for Spanish. The optional API key stays on the server. **Save and find voices** tests the connection and accepts both voice IDs and objects returned by Kokoro. You can also initialize the connection with `READER_KOKORO_URL`, `READER_KOKORO_VOICE`, and `READER_KOKORO_API_KEY`.

Select **Audio** (the headphone button) in the reader to show audio controls. **Generate book audio**, available in the player and under **Analysis & audio**, creates one complete MP3 for the entire book. The same recording plays continuously across displayed pages and source sections. Its scrub bar has chapter ticks and a chapter menu, and the MP3 contains chapter metadata. EPUB markers use the table of contents and headings; unlabelled text uses section breaks or clearly labelled reading markers. PDFs use bookmarks when available, with page markers as a fallback.

The headphones button and **A** shortcut toggle the same audio toolbar while playback and page following continue. Space still plays and pauses; press the button or shortcut again to reveal the controls. Use full screen and **Appearance → Auto-hide docks in full screen** for a view with only the book text.

## Upload your own audiobooks

On a self-hosted installation, open a book's **Analysis & audio → Your audiobooks**. Upload MP3, M4A, M4B, OGG/Opus, WAV, FLAC or AAC, give the recording a name, then select **Sync with book** when preparation finishes. Uploads do not require Kokoro. A reverse proxy may impose a smaller upload limit.

Select one complete audiobook or up to **200 chapter files**, totalling **1 GiB** and at most **72 hours per recording**. File names are sorted naturally (`1`, `2`, `10`); use **Move up / Move down** before uploading to set the chapter order. Background preparation normalizes and joins them into one continuous MP3, with file boundaries in the player's chapter menu and scrub bar. Alignment still uses the actual book text, so audio chapters can differ from EPUB sections or displayed pages. Preparation resumes after a server restart. Original chapter files remain individually downloadable, and **Download complete MP3** downloads the joined recording with embedded chapter metadata. Upload another set under a different name to keep multiple narrators or editions.

Syncing runs in the background using the local multilingual speech model. Transcript checkpoints survive a restart and can be reused for another sync. Unique phrase anchors align recognized speech to the book; the resulting match percentage is displayed. Abridged audio, introductions, OCR errors and different editions can reduce coverage. Recordings with too little matching speech are rejected. Unmatched positions within matched sections are estimated for page following, and estimated words are never highlighted. Sections absent from the recording are skipped during playback.

Upload and sync several recordings of the same book, then choose **Recording** in its reader to select a narrator or edition. Each book’s recording selection follows your reader account. Generated narration stays available as a separate choice. Original recordings can be downloaded or removed independently in **Your audiobooks**. The public demo shows these options without accepting audio uploads.

Pages always follow playback and scrubbing, including jumps across chapters and repeated scrubs while paused. **Settings → Narration → Highlight spoken words** independently controls the visible word highlight. Font changes preserve playback position. Turning a page manually seeks to that page in the full recording; clicking a synchronized word or chapter marker also seeks while preserving play or pause state. PDFs stay linked to their fixed page numbers. Scanned pages need an OCR text layer to be narrated.

Select **Podcast mode** in the audio player for larger playback controls: rewind or fast-forward **10 seconds**, play/pause, previous/next audio chapter, and speed presets from **0.5× to 2×**. The chapter buttons use the same markers as the scrub bar. Skips and chapter jumps preserve play or pause state; page following stays active with highlighting on or off. Choose **Compact player** to return to the smaller controls. The podcast layout and playback speed are controlled in the player and saved with your account. Settings retains connection/generation options and optional word highlighting. Supported browsers also expose play/pause, 10-second seeking, and chapter actions to device media controls. Audio downloads remain available under **Analysis & audio → Download complete book MP3**.

The player's elapsed and total times and chapter-marker labels reflect the selected playback speed. At 2×, a one-hour recording shows 30 minutes. Hover over the time counter for remaining listening time and the original recording position. Changing speed updates these estimates immediately; seeking, chapter jumps, word timing and device media controls still use the original recording timestamps.

## Import iVoox audiobooks

Under **Analysis & audio → Your audiobooks → Import from iVoox**, paste a publicly downloadable **episode** link. For an audiobook split into episodes, paste one link per line in chapter order. Episode links from `ivoox.com`, localized iVoox hosts and supported iVoox short links are accepted; podcast series and playlist pages need individual episode links instead. The same 200-chapter, 1 GiB and 72-hour recording limits apply. Downloads and chapter preparation run in the background; choose **Sync with book** when the recording is ready.

The importer reads the episode's published download metadata without executing page scripts, then follows public HTTPS download redirects with private-network protection and streaming size checks. It checks each file with ffmpeg before publishing the joined recording. Login-only, paid and preview-only episodes without a public full download are rejected with a message. No iVoox account credentials are collected. Cancel an import from the audio panel. Downloads interrupted by a server restart need to be imported again; accepted chapter preparation and completed recordings persist. External importing is disabled in the public demo.

## Scan PDF books with OCR

Select **Scan PDF with OCR** on a PDF library card. Choose from the OCR language packs matching **My reading languages**, select an OCR mode and optional rotation correction, then select **Create searchable copy**. The local language service runs OCRmyPDF/Tesseract with installed language packs; the Docker image includes all packaged Tesseract languages, including English, Spanish, Portuguese, simplified Mandarin and traditional Mandarin. Processing is offline after the build and needs no paid API. Choose only languages actually present; Tesseract does not automatically identify an unknown language.

OCR creates a separate PDF book with a selectable text layer and inherits its title/author, category and cover. The selected OCR languages correct the copy’s language metadata where needed. The original file and its reading/audio/bookmarks remain intact. Open the searchable copy to use word help, summaries, analysis and narration. **Replace existing OCR** is the default: it replaces a detected hidden OCR layer while preserving visible digital text. **Only scan pages without text** retains existing text pages. Both use at least 300 DPI; skew correction is available in the latter mode because OCRmyPDF cannot combine it with lossless OCR replacement. PDF pinyin uses transformed screen geometry and one size per line; ambiguous or overlapping text boxes are withheld instead of drawing illegible labels. Up to ten scans can wait in the queue, with one document processed at a time; jobs survive restarts. Input/output are capped at 120 MiB, 2,000 pages and one hour per scan. Poor images or unsuitable language choices may still produce errors, and pages containing partial text can still need a clearer scan or a different OCR engine. OCR is available on personal installations.

## Rescan missed audio words

Alignment recovery is automatic. After complete book generation or audiobook synchronization, Langy queues a fresh local recognition pass when word positions are missing, estimated or flagged for review. Existing compatible recordings are checked after upgrading too. Each pass keeps good anchors, processes bounded audio windows, and records its final alignment signature so it does not continually rescan its own results. This uses the local language service, without manual word/time anchors or paid APIs. Recognition cannot recover speech absent from the recording or guarantee exact timing; source and voice quality still matter.

Choose **Rescan missed words** beside a synced uploaded recording, chapter-file audiobook, iVoox import or completed generated narration. This uses the existing audio and the bundled local speech recognizer; it does not regenerate narration, contact Kokoro, or incur AI API fees. Langy extracts short clips around unconfirmed text spans and recognizes them again with a fresh decoding pass, including gaps across previously unmatched sections. Existing recognized word positions are preserved, and candidates must fit the neighbouring matches and recording boundaries. Recognition confidence and non-silent audio checks reject weak candidates; words are not forced onto omitted or different text.

The panel shows progress, newly found matches and remaining unconfirmed words. Results are applied atomically when the pass completes. Playback remains available using its existing alignment while work is pending; retry resumes completed clip checkpoints after an error or restart. **Cancel rescan** discards the pending pass and keeps the current alignment. The active reader refreshes its timing cache without restarting the audio. The audio file and its embedded metadata stay unchanged; the player's timing and markers are refreshed. A rescan can still leave gaps, and retained recognition matches may themselves contain errors. Estimated positions continue to support page following and are never highlighted as recognized words. Rescanning is available on self-hosted installations.

## Generated narration and timing

The persistent queue reuses compatible recordings, then assembles the complete book. Internal processing runs in sections and resumes interrupted work after a restart. The final file is published only after every readable section finishes. Choose **Replace existing recordings** to regenerate, or **Cancel queued audio** to cancel the book job; an active internal section may finish and remain cached. Completed books have one **Download complete book MP3** link. Empty pages are skipped.

The demo defaults to disconnected audio preview (`READER_DEMO_AUDIO_PREVIEW=1`). The headphones button, narration settings and podcast layout remain visible, while generation is disabled and no Kokoro requests are made. Personal installations are unaffected. An owner explicitly enabling narration on another demo can set `READER_DEMO_AUDIO_PREVIEW=0` and configure that demo's Kokoro connection.

EPUB narration preserves heading and paragraph boundaries without modifying the original reading text or offsets. Standalone chapter counters are spoken as labels (for example `1` becomes `第1章` in Mandarin), titles are separate utterances, and explicit silence separates them from the body. Existing books recover this structural metadata automatically without reuploading. PDF text extraction cannot supply equivalent heading structure reliably.

Mandarin body chunks are limited to about 180 source characters and prefer sentence/clause boundaries and intact compound words. This bounds alignment work instead of recognizing 1,800 characters at once. Whole-book audio remains one downloadable file, and pauses are included in its timestamps and chapter markers. This narration version has a new cache signature: generate or retry book audio to adopt it; previous recordings remain available.

Word timestamps come from local speech recognition matched to the source words. Recognition retries low-coverage chunks as well as empty ones, including short headings that can be mistaken for silence. Complementary matches are merged only when they fit unchanged neighbouring timestamps. Mandarin prompts preserve natural text, matching handles simplified/traditional characters, and denser phrase anchors tolerate recognition errors in long recordings. Recognition confidence is retained for review. When words still cannot be matched, Langy estimates their positions between matched timestamps or the boundaries of the generated audio chunk. Page following stays active, approximate sections are labelled, and estimated words are never shown as synchronized highlights. These estimates cannot guarantee exact page or word timing. Numeric headings are included; decorative sections without letters or numbers are skipped. Joining decoded audio by its sample count prevents encoder padding from accumulating into chapter timing drift. Playback speed can be changed independently of generation speed. Kokoro and voice support determine narration languages. The demo owner configures its Kokoro connection through environment variables. Demo sections remain limited to 20,000 characters for narration.

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

**Automatic** download mode offers a **free slow download** when the fast API reports an exhausted allowance. This fallback is enabled initially and can be disabled in Book sources; **Fast download only** retains the quota error. Choose **Free slow download** to use that path directly without a membership key. A wrong or expired membership key still reports its authentication error.

Slow downloads open the edition's public book page, where you choose a slow partner server and complete any wait and browser verification. Langy keeps the requested edition, category, language and cover. Afterward, either paste the final file link to download on the server or upload the downloaded EPUB/PDF into the pending import. Both paths verify the same MD5 and 120 MiB cap before importing. The library's **Continue slow download** button reopens a pending import after closing the dialog. Browser challenges, waiting pages and HTML error pages are not imported as books. No membership key is sent to a slow partner, and final signed file URLs are not returned in job responses. Pending imports are stored in the data volume and can be continued after restarting. Anna’s Archive documents its [slow-download browser verification and waitlists](https://annas-archive.gl/faq#slow), so this path may require a browser step rather than an unattended server download.

In **Import book**, select **Anna’s Archive**, paste the edition's book link or MD5, and choose a category. EPUB metadata is used when available; title, author and language can also be entered. Downloads run in the background with progress, are capped at **120 MiB**, verified against the requested MD5, and pass the same EPUB/PDF validation as manual uploads. Unsupported formats are rejected. Queued jobs survive restarts; interrupted transfers restart from the beginning and completed imports are not added twice. Only one Anna’s Archive file downloads at a time. Membership fees and download quotas belong to Anna’s Archive; Langy does not provide a shared key or integrated catalogue search. See the [official API FAQ](https://annas-archive.gl/faq#api).

In Anna’s Archive import, enable **Download multiple books** for up to **50 rows**, each with its own edition link/MD5, title and author. Primary/additional languages, category, cover and download method are shared by the batch. Enable **All books use the author entered below** to override every row with one author. Blank per-book metadata falls back to the downloaded file. Rows are validated before queuing, duplicate editions within a batch are rejected, and downloads run sequentially. The library’s **Book downloads** list shows each result, slow-download continuation and retry/cancel actions.

**Retry unavailable downloads every 6 hours** is enabled initially in Book sources. Connection failures, temporarily unavailable servers and fast-only quota errors receive a saved next-attempt time. The server checks due jobs in the background, requests a fresh member URL for each retry and preserves the queue across restarts. Authentication errors, invalid files and size-limit failures require fixing their cause. Slow downloads still respect browser verification; a final signed link is never saved for reuse six hours later. Turn retries off in Book sources or cancel a waiting job to stop its automatic attempts.

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
