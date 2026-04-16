from huggingface_hub import list_repo_files
files = list_repo_files("onnx-community/Kokoro-82M-v1.0-ONNX")
print(files)
