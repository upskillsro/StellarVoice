from huggingface_hub import hf_hub_download
import os

print("Downloading Kokoro ONNX model files...")
hf_hub_download("hexgrad/Kokoro-82M", "kokoro-v1.0.onnx", local_dir=".")
hf_hub_download("hexgrad/Kokoro-82M", "voices-v1.0.bin", local_dir=".")
print("Done!")
