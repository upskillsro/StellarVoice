import urllib.request
import os

url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
target = "kokoro-v1.0.onnx"

print(f"Downloading {url} to {target}...")
if os.path.exists(target):
    try:
        os.remove(target)
        print("Removed locked file")
    except Exception as e:
        print("Could not remove old file!!", e)

urllib.request.urlretrieve(url, target)
print("ONNX download complete natively in Python!")
