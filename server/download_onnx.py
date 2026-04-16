from huggingface_hub import hf_hub_download
import os
import shutil

print("Downloading Kokoro ONNX model files...")

onnx_path = hf_hub_download("onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/kokoro-v1.0.onnx")
shutil.copy(onnx_path, "kokoro-v1.0.onnx")

voices_path = hf_hub_download("onnx-community/Kokoro-82M-v1.0-ONNX", "voices.bin")
shutil.copy(voices_path, "voices.bin")

print("Done! ONNX and Voices copied locally.")
