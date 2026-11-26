# GPU audio alignment

Langy normally runs Whisper locally on the CPU with `int8` computation and up to four threads. Audio generation calls Kokoro and then aligns the resulting chunks with Whisper. A busy CPU can therefore leave Kokoro idle between requests, even though book generation is still progressing. Alignment repair also shares the language worker. A long queue does not itself mean Kokoro is disconnected.

The optional `compose.gpu.yaml` moves Whisper alignment, recording transcription and repair recognition onto an NVIDIA GPU. It does not change Kokoro, Ollama or PaddleOCR. The ordinary Compose stack remains CPU-only. Models are baked into the image and inference has no paid API dependency.

## Requirements

Use a Linux Docker host with a compatible NVIDIA GPU, driver and NVIDIA Container Toolkit. Test container access first:

```bash
sudo docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

This proves Docker can see the GPU. It does not test Whisper kernels or available model memory. Leave room for other GPU workloads. Start with the default `READER_WHISPER_MODEL=small`; larger models may not fit alongside an LLM. `small` with `float16` is the starting configuration for an RTX 2080 Ti, not a guarantee of a particular speed or memory footprint.

The optional image includes pinned CUDA 12 cuBLAS/NVRTC and cuDNN 9 libraries. These libraries live inside the image; there is no need to install a matching CUDA toolkit on the host. The host still needs its NVIDIA driver and Container Toolkit. See the [faster-whisper GPU requirements](https://github.com/SYSTRAN/faster-whisper#gpu), [NVIDIA Container Toolkit test](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/sample-workload.html), and [Compose GPU reservations](https://docs.docker.com/compose/how-tos/gpu-support/).

## Enable GPU alignment

From your checkout, pull the update and run:

```bash
git pull --ff-only
sudo bash scripts/enable-gpu-alignment.sh
```

If you use additional Compose overlays, pass them to the script, for example:

```bash
sudo bash scripts/enable-gpu-alignment.sh compose.ocr.yaml
```

The script builds the optional image while the current services run, then starts a temporary container which loads the local model and consumes a transcription of silent audio. Consuming the transcription exercises real encoder/decoder kernels. The check exits unsuccessfully if CUDA, its libraries or model memory cannot be used; it never silently selects CPU. Only after the check passes does the script briefly stop a running reader, replace the language container, wait for its health check and resume the reader. The temporary check container is removed automatically. No data volume is deleted or changed by this script.

Queued work resumes after the reader starts. Completed audio sections are retained; an interrupted section may restart. Existing failed tasks need **Retry**. This change speeds recognition, but full-book generation and extensive repairs can still take time, and Kokoro's own synthesis time remains.

## Verify and inspect progress

```bash
sudo docker compose -f compose.yaml -f compose.gpu.yaml exec -T language \
  python -c 'import json, urllib.request; print(json.dumps(json.load(urllib.request.urlopen("http://127.0.0.1:8000/alignment/status")), indent=2))'

sudo docker compose -f compose.yaml -f compose.gpu.yaml logs -f --tail=60 language
```

Status reads do not load models or use GPU memory. Immediately after a restart, `loaded` can be false and `effective` null. After the first alignment, expect `effective.device` to be `cuda` and `effective.computeType` to be `float16`. The logs report the actual device, compute type, audio duration, processing seconds and time waiting for the language lock for each `/align`, `/transcribe` or `/rescan` operation. Processing time includes model loading on the first request. Logs contain no book text, audio payloads or credentials. The language service remains private to the inference network; this adds no public port.

To rerun actual inference independently:

```bash
sudo docker compose -f compose.yaml -f compose.gpu.yaml run --rm --no-deps language python -m whisper_runtime
```

That temporary container needs additional model memory if the running language service already has its model loaded. Check free memory with `nvidia-smi` before doing this during active jobs.

## Options and updates

Optional `.env` values:

```dotenv
READER_WHISPER_MODEL=small
READER_ALIGNMENT_GPU=0
READER_WHISPER_COMPUTE_TYPE=float16
READER_WHISPER_CPU_THREADS=4
```

`READER_ALIGNMENT_GPU` is the host GPU index or UUID reserved for this container; Whisper uses logical device 0 inside the selected container. `int8_float16` is an alternative to `float16` when GPU memory is tight. The runtime verifies device support and reports the actual compute type. Re-run the script after changing these values. Rebuild the reader too if you change the model size, so recording metadata uses the matching model identity.

Include `-f compose.gpu.yaml` whenever rebuilding or recreating `language` in later updates, after any other overlays. Otherwise a plain Compose rebuild returns that service to its normal CPU configuration.

To return to CPU, rebuild and recreate just the language service without the GPU overlay, with a brief reader pause:

```bash
sudo docker compose -f compose.yaml build language
sudo docker compose -f compose.yaml stop reader
sudo docker compose -f compose.yaml up -d --no-deps --wait language
sudo docker compose -f compose.yaml start reader
```

If the service update fails, start the reader again with the final command and inspect the language logs. The GPU activation script also attempts to resume a previously running reader on failure.
