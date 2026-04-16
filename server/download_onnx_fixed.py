from huggingface_hub import hf_hub_download
import shutil
import os

print("Downloading Kokoro ONNX model...")
m = hf_hub_download("onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model.onnx")
shutil.copy(m, "kokoro-v1.0.onnx")

print("Downloading Kokoro Voice...")
v = hf_hub_download("onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_heart.bin")
shutil.copy(v, "voices.bin")

print("Done downloading ONNX files!")
