from huggingface_hub import list_repo_files
for f in list_repo_files("hexgrad/Kokoro-82M"):
    print(f)
