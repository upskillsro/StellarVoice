import onnxruntime as rt
import os
print("abspath:", os.path.abspath("kokoro-v1.0.onnx"))
try:
    s = rt.InferenceSession("kokoro-v1.0.onnx")
    print("SUCCESS LOAD")
except Exception as e:
    print("FAIL:", e)
