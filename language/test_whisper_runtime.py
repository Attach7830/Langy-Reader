import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch

from whisper_runtime import AlignmentRuntimeError, Configuration, WhisperRuntime, check


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.runtime = WhisperRuntime()
        self.backend = types.SimpleNamespace(get_cuda_device_count=Mock(return_value=1),
                                             get_supported_compute_types=Mock(return_value={"int8", "int8_float16", "float16"}))
        self.model = types.SimpleNamespace(model=types.SimpleNamespace(device="cpu", compute_type="int8_float32"))
        self.factory = Mock(return_value=self.model)
        self.dependencies = patch.dict("sys.modules", {"ctranslate2": self.backend,
                                    "faster_whisper": types.SimpleNamespace(WhisperModel=self.factory)})
        self.dependencies.start()
        self.addCleanup(self.dependencies.stop)
        self.libraries = patch("whisper_runtime.ctypes.CDLL")
        self.cdll = self.libraries.start()
        self.addCleanup(self.libraries.stop)

    def test_cpu_default_preserves_quantization_local_only_and_single_cached_model(self):
        with patch("os.cpu_count", return_value=16):
            self.assertIs(self.runtime.load(), self.runtime.load())
        self.factory.assert_called_once_with("./models/whisper", device="cpu", device_index=0,
                                             compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)
        self.backend.get_cuda_device_count.assert_not_called()
        self.cdll.assert_not_called()
        self.assertEqual(self.runtime.status()["effective"], {"device": "cpu", "computeType": "int8_float32"})

    def test_status_is_lazy_even_when_cuda_is_requested(self):
        os.environ["LANGY_WHISPER_DEVICE"] = "cuda"
        status = self.runtime.status()
        self.assertEqual(status["configuredDevice"], "cuda")
        self.assertFalse(status["loaded"])
        self.assertIsNone(status["effective"])
        self.factory.assert_not_called()
        self.backend.get_cuda_device_count.assert_not_called()

    def test_cuda_uses_float16_and_reports_actual_device(self):
        os.environ.update(LANGY_WHISPER_DEVICE="cuda", LANGY_MODELS="/opt/models", LANGY_WHISPER_CPU_THREADS="6")
        self.model.model = types.SimpleNamespace(device="cuda", compute_type="float16")
        with self.assertLogs("uvicorn.error.alignment", level="INFO") as log:
            self.runtime.load()
        self.assertEqual(self.factory.call_args.kwargs["device"], "cuda")
        self.assertEqual(self.factory.call_args.kwargs["compute_type"], "float16")
        self.assertEqual(self.factory.call_args.kwargs["cpu_threads"], 6)
        self.assertEqual(self.cdll.call_count, 2)
        self.assertEqual(self.runtime.status()["effective"]["device"], "cuda")
        self.assertIn("device=cuda", " ".join(log.output))

    def test_cuda_can_use_lower_memory_compute_type(self):
        os.environ.update(LANGY_WHISPER_DEVICE="cuda", LANGY_WHISPER_COMPUTE_TYPE="int8_float16")
        self.model.model = types.SimpleNamespace(device="cuda", compute_type="int8_float16")
        self.runtime.load()
        self.assertEqual(self.factory.call_args.kwargs["compute_type"], "int8_float16")

    def test_no_visible_gpu_fails_without_cpu_fallback(self):
        os.environ["LANGY_WHISPER_DEVICE"] = "cuda"
        self.backend.get_cuda_device_count.return_value = 0
        with self.assertRaisesRegex(AlignmentRuntimeError, "no NVIDIA GPU"):
            self.runtime.load()
        self.factory.assert_not_called()
        self.assertEqual(self.runtime.status()["error"]["code"], "cuda")

    def test_missing_cuda_libraries_report_actionable_error_and_do_not_load_model(self):
        os.environ["LANGY_WHISPER_DEVICE"] = "cuda"
        self.cdll.side_effect = OSError("libcudnn.so.9 missing /private/path")
        with self.assertRaises(AlignmentRuntimeError) as raised:
            self.runtime.load()
        self.assertEqual(raised.exception.code, "cuda")
        self.assertNotIn("/private/path", str(raised.exception))
        self.factory.assert_not_called()

    def test_invalid_settings_are_rejected_before_loading(self):
        for settings in ({"LANGY_WHISPER_DEVICE": "auto"}, {"LANGY_WHISPER_CPU_THREADS": "0"},
                         {"LANGY_WHISPER_CPU_THREADS": "many"}, {"LANGY_WHISPER_COMPUTE_TYPE": "guess"}):
            with self.subTest(settings=settings), patch.dict(os.environ, settings):
                with self.assertRaises(AlignmentRuntimeError):
                    Configuration.read()
        self.factory.assert_not_called()

    def test_unsupported_hardware_compute_type_cannot_silently_fall_back(self):
        os.environ["LANGY_WHISPER_COMPUTE_TYPE"] = "float32"
        with self.assertRaisesRegex(AlignmentRuntimeError, "unsupported on this device"):
            self.runtime.load()
        self.factory.assert_not_called()

    def test_unexpected_cpu_model_in_cuda_mode_is_rejected(self):
        os.environ["LANGY_WHISPER_DEVICE"] = "cuda"
        with self.assertRaisesRegex(AlignmentRuntimeError, "requested device"):
            self.runtime.load()
        self.assertFalse(self.runtime.status()["loaded"])

    def test_queued_operation_logs_wait_processing_time_and_no_content(self):
        self.runtime.load()
        with patch("whisper_runtime.time.monotonic", side_effect=[10, 12, 15]), self.assertLogs("uvicorn.error.alignment", "INFO") as log:
            with self.runtime.operation("align", 60, threading.Lock()):
                pass
        status = self.runtime.status()["lastOperation"]
        self.assertEqual(status, {"task": "align", "audioSeconds": 60, "waitSeconds": 2, "state": "complete", "processingSeconds": 3})
        self.assertIn("device=cpu", " ".join(log.output))
        self.assertIn("processing_seconds=3.00", " ".join(log.output))

    def test_lazy_generator_out_of_memory_failure_is_reported_and_retry_can_succeed(self):
        os.environ["LANGY_WHISPER_DEVICE"] = "cuda"
        with self.assertRaises(AlignmentRuntimeError) as raised:
            with self.runtime.operation("rescan", 45, threading.Lock()):
                raise RuntimeError("CUDA out of memory SECRET_BOOK_TEXT")
        self.assertEqual(raised.exception.code, "memory")
        self.assertNotIn("SECRET", json.dumps(self.runtime.status()))
        self.assertEqual(self.runtime.status()["lastOperation"]["state"], "error")
        with self.runtime.operation("rescan", 45, threading.Lock()):
            pass
        self.assertIsNone(self.runtime.status()["error"])

    def test_preflight_consumes_generator_so_actual_inference_errors_fail_the_check(self):
        def segments():
            raise RuntimeError("CUDA kernel error")
            yield
        self.model.transcribe = Mock(return_value=(segments(), None))
        with patch("whisper_runtime.runtime", self.runtime), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(check(), 1)
        self.assertFalse(json.loads(output.getvalue())["ok"])

    def test_preflight_success_reports_device_and_nonzero_audio(self):
        self.model.transcribe = Mock(return_value=(iter([]), None))
        with patch("whisper_runtime.runtime", self.runtime), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(check(), 0)
        report = json.loads(output.getvalue())
        self.assertTrue(report["ok"])
        self.assertEqual(report["effective"]["device"], "cpu")
        self.assertEqual(len(self.model.transcribe.call_args.args[0]), 16000)


class RouteTests(unittest.TestCase):
    def test_all_whisper_routes_surface_runtime_failure_without_losing_health_or_status(self):
        import app
        import numpy as np
        from fastapi import HTTPException
        for route in (app.align, app.transcribe_recording, app.rescan_recording):
            runtime = WhisperRuntime()
            with self.subTest(route=route.__name__), patch("app.whisper_runtime", runtime), patch("app.decode_recording", return_value=np.ones(16000)), patch("app.recognizer", side_effect=RuntimeError("CUDA out of memory SECRET")):
                with self.assertRaises(HTTPException) as raised:
                    route(app.Alignment(audio="YQ==", words=["hello"], language="en"))
                self.assertEqual(raised.exception.status_code, 503)
                self.assertNotIn("SECRET", raised.exception.detail)
                self.assertEqual(app.health(), {"ready": True})
                self.assertEqual(app.alignment_status()["lastOperation"]["state"], "error")


class ActivationScriptTests(unittest.TestCase):
    def run_activation(self, failing_command=""):
        script = Path(__file__).resolve().parents[1] / "scripts" / "enable-gpu-alignment.sh"
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / "commands.jsonl"
            docker = Path(folder) / "docker"
            docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["LANGY_TEST_COMMAND_LOG"], "a") as log: log.write(json.dumps(args) + "\\n")
if os.environ.get("LANGY_TEST_FAIL") and os.environ["LANGY_TEST_FAIL"] in args: sys.exit(7)
if "ps" in args: print("running-reader")
''')
            docker.chmod(0o755)
            environment = {**os.environ, "PATH": folder + os.pathsep + os.environ["PATH"],
                           "LANGY_TEST_COMMAND_LOG": str(log), "LANGY_TEST_FAIL": failing_command}
            result = subprocess.run(["bash", str(script)], env=environment, capture_output=True, text=True)
            commands = [json.loads(line) for line in log.read_text().splitlines()]
            return result, commands

    def test_failed_inference_check_never_stops_existing_services(self):
        result, commands = self.run_activation("run")
        self.assertEqual(result.returncode, 7)
        self.assertFalse(any("stop" in command or "up" in command for command in commands))

    def test_activation_checks_before_stopping_and_only_replaces_language(self):
        result, commands = self.run_activation()
        self.assertEqual(result.returncode, 0, result.stderr)
        verbs = [next(word for word in command if word in {"build", "run", "ps", "stop", "up", "start"}) for command in commands]
        self.assertEqual(verbs, ["build", "run", "ps", "stop", "up", "start"])
        self.assertEqual(next(command for command in commands if "up" in command)[-1], "language")
        self.assertTrue(all("compose.gpu.yaml" in command for command in commands))

    def test_reader_resume_is_attempted_if_language_replacement_fails(self):
        result, commands = self.run_activation("up")
        self.assertEqual(result.returncode, 7)
        self.assertEqual(commands[-1][-2:], ["start", "reader"])


if __name__ == "__main__":
    unittest.main()
