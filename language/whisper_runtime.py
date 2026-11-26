"""Lazy, local Whisper runtime with explicit CPU/CUDA selection and safe diagnostics."""
from contextlib import contextmanager
import ctypes
from dataclasses import dataclass
import json
import logging
import os
import threading
import time


logger = logging.getLogger("uvicorn.error.alignment")


class AlignmentRuntimeError(RuntimeError):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Configuration:
    device: str
    compute_type: str
    cpu_threads: int
    folder: str

    @classmethod
    def read(cls):
        device = os.environ.get("LANGY_WHISPER_DEVICE", "cpu").strip().lower()
        if device not in {"cpu", "cuda"}:
            raise AlignmentRuntimeError("configuration", "LANGY_WHISPER_DEVICE must be cpu or cuda.")
        compute = os.environ.get("LANGY_WHISPER_COMPUTE_TYPE", "").strip() or ("float16" if device == "cuda" else "int8")
        if compute not in {"int8", "float16", "float32", "int8_float16", "int8_float32"}:
            raise AlignmentRuntimeError("configuration", "Unsupported LANGY_WHISPER_COMPUTE_TYPE; use int8, float16, float32, int8_float16 or int8_float32.")
        try:
            threads = int(os.environ.get("LANGY_WHISPER_CPU_THREADS", str(min(4, os.cpu_count() or 2))))
            if not 1 <= threads <= 64:
                raise ValueError()
        except ValueError:
            raise AlignmentRuntimeError("configuration", "LANGY_WHISPER_CPU_THREADS must be an integer from 1 to 64.") from None
        return cls(device, compute, threads, os.path.join(os.environ.get("LANGY_MODELS", "./models"), "whisper"))


def runtime_error(error, device):
    if isinstance(error, AlignmentRuntimeError):
        return error
    # Never copy dependency messages into logs/responses: they can contain paths.
    message = str(error).lower()
    if "out of memory" in message or "cublas_status_alloc_failed" in message:
        return AlignmentRuntimeError("memory", "Whisper alignment ran out of memory. Free memory on its configured device or use a smaller READER_WHISPER_MODEL, then retry the job.")
    if device == "cuda" and any(part in message for part in ("cuda", "cudnn", "cublas", "libnvrtc", "driver", "nvidia")):
        return AlignmentRuntimeError("cuda", "CUDA alignment could not start. Use compose.gpu.yaml and run the Whisper GPU check; confirm the NVIDIA driver and Container Toolkit work.")
    return AlignmentRuntimeError("runtime", "Whisper alignment could not run. Check the language service logs and rebuild its local model and runtime, then retry the job.")


class WhisperRuntime:
    def __init__(self):
        self._load_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._model = None
        self._actual = None
        self._last = None
        self._error = None

    def status(self):
        try:
            config = Configuration.read()
            settings = {"configuredDevice": config.device, "computeType": config.compute_type, "cpuThreads": config.cpu_threads}
        except AlignmentRuntimeError as error:
            settings = {"configurationError": error.detail}
        with self._state_lock:
            return {**settings, "model": os.environ.get("LANGY_WHISPER_MODEL", "small"),
                    "loaded": self._model is not None, "effective": self._actual,
                    "lastOperation": self._last, "error": self._error}

    def load(self):
        with self._load_lock:
            if self._model is not None:
                return self._model
            config = Configuration.read()
            try:
                import ctranslate2
                from faster_whisper import WhisperModel
                if config.device == "cuda" and ctranslate2.get_cuda_device_count() < 1:
                    raise AlignmentRuntimeError("cuda", "CUDA alignment was requested but no NVIDIA GPU is available. Start language with compose.gpu.yaml and verify Docker GPU access.")
                supported = ctranslate2.get_supported_compute_types(config.device)
                if config.compute_type not in supported:
                    raise AlignmentRuntimeError("configuration", "The selected Whisper compute type is unsupported on this device. Use int8 for CPU or float16/int8_float16 for a compatible NVIDIA GPU.")
                if config.device == "cuda":
                    # Diagnose missing runtime libraries before entering native inference.
                    ctypes.CDLL("libcublas.so.12")
                    ctypes.CDLL("libcudnn.so.9")
                started = time.monotonic()
                model = WhisperModel(config.folder, device=config.device, device_index=0,
                                     compute_type=config.compute_type, cpu_threads=config.cpu_threads,
                                     num_workers=1, local_files_only=True)
                actual = {"device": model.model.device, "computeType": model.model.compute_type}
                matching_compute = actual["computeType"] == config.compute_type or (config.compute_type == "int8" and actual["computeType"].startswith("int8"))
                if actual["device"] != config.device or not matching_compute:
                    raise AlignmentRuntimeError("configuration", "Whisper did not load with the requested device and compute type. Check the GPU configuration before retrying.")
                with self._state_lock:
                    self._model, self._actual, self._error = model, actual, None
                logger.info("Whisper loaded device=%s compute_type=%s load_seconds=%.2f", actual["device"], actual["computeType"], time.monotonic() - started)
                return model
            except (ImportError, OSError, RuntimeError, ValueError) as error:
                failure = runtime_error(error, config.device)
                with self._state_lock:
                    self._error = {"code": failure.code, "detail": failure.detail}
                logger.error("Whisper load failed device=%s error_code=%s", config.device, failure.code)
                raise failure from None

    @contextmanager
    def operation(self, task, audio_seconds, inference_lock):
        queued = time.monotonic()
        with inference_lock:
            started = time.monotonic()
            operation = {"task": task, "audioSeconds": round(audio_seconds, 3),
                         "waitSeconds": round(started - queued, 3), "state": "running"}
            with self._state_lock:
                self._last = operation
            logger.info("Whisper task=%s started audio_seconds=%.2f wait_seconds=%.2f", task, audio_seconds, started - queued)
            failure = None
            try:
                yield
            except (ImportError, OSError, RuntimeError) as error:
                device = os.environ.get("LANGY_WHISPER_DEVICE", "cpu")
                failure = runtime_error(error, device)
                raise failure from None
            finally:
                elapsed = time.monotonic() - started
                operation = {**operation, "state": "error" if failure else "complete", "processingSeconds": round(elapsed, 3)}
                with self._state_lock:
                    self._last = operation
                    self._error = {"code": failure.code, "detail": failure.detail} if failure else None
                    actual = self._actual or {"device": "unloaded", "computeType": "unloaded"}
                logger.log(logging.ERROR if failure else logging.INFO,
                           "Whisper task=%s state=%s device=%s compute_type=%s audio_seconds=%.2f processing_seconds=%.2f wait_seconds=%.2f error_code=%s",
                           task, operation["state"], actual["device"], actual["computeType"], audio_seconds, elapsed, started - queued, failure.code if failure else "none")


runtime = WhisperRuntime()


def check():
    """Exercise actual encoder/decoder kernels, without downloading or sending text."""
    import numpy as np
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        with runtime.operation("check", 1, threading.Lock()):
            model = runtime.load()
            segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1,
                                           vad_filter=False, word_timestamps=True)
            list(segments)  # Transcription is lazy; consume it to execute CUDA kernels.
        print(json.dumps({"ok": True, **runtime.status()}))
        return 0
    except AlignmentRuntimeError as error:
        print(json.dumps({"ok": False, "code": error.code, "detail": error.detail}))
        return 1


if __name__ == "__main__":
    raise SystemExit(check())
