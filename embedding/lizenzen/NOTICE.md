# Lizenzhinweise zur lokalen KI

Die hier aufgeführten Komponenten stehen unter ihren eigenen Lizenzen.
[Apache License 2.0](Apache-2.0.txt) enthält den vollständigen Lizenztext für
die entsprechend gekennzeichneten Komponenten.

| Komponente | Lizenz und Herkunft |
|---|---|
| Snowflake Arctic Embed M v2.0, ONNX INT8 | Apache 2.0, Snowflake Inc. [Modellrevision](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0/tree/95c2741480856aa9666782eb4afe11959938017f). postbuch.net lagert die Gewichte in `model.data` aus. Die Rechenoperationen und Gewichtswerte bleiben erhalten. |
| XLM-RoBERTa Base, `sentencepiece.bpe.model` | [MIT – Facebook, Inc. and its affiliates](XLM-R-MIT.txt). [Modellrevision](https://huggingface.co/FacebookAI/xlm-roberta-base/tree/e73636d4f797dec63c3081bb6ed5c7b0bb3f2089) · [Lizenz der Originalimplementierung](https://github.com/facebookresearch/fairseq/blob/main/LICENSE). |
| Voyage 4 Nano, Q8-GGUF und Projektionsdatei | Apache 2.0 für das [Originalmodell](https://huggingface.co/MongoDB/voyage-4-nano), mit [Original-NOTICE](Voyage-4-Nano-NOTICE.txt). Die [Konvertierung](https://huggingface.co/jsonMartin/voyage-4-nano-gguf/tree/75e62c7dba5ee8156717a56920976ab128b8c693) ist als `voyageai` gekennzeichnet und verweist für die Lizenz auf das Originalmodell. |
| EmbeddingGemma 2, Q6_K-GGUF | Apache 2.0. [Google DeepMind](https://huggingface.co/google/embeddinggemma-2) · [Gepinnte GGUF-Konvertierung](https://huggingface.co/prithivMLmods/EmbeddingGemma-2-GGUF/tree/ca17235333e975cb5044987c18316b83258b57e4). |
| Gemma 4 12B, Q5_K_M-GGUF, Bildmodul und MTP-Entwurfsmodell | Apache 2.0. [Google DeepMind](https://huggingface.co/google/gemma-4-12B-it) · [Gepinnte Unsloth-Dateien](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/tree/fc034cfff751157913579611efad8462ac1be606). |
| llama.cpp | [MIT – The ggml authors](llama.cpp-MIT.txt). [Embedding-Runtime b12464](https://github.com/ggml-org/llama.cpp/tree/d3c3e242c16b8cbf51400fad410cd69b22d64f35) · [Lokale KI b12182](https://github.com/ggml-org/llama.cpp/tree/b12182). |
| NVIDIA Container Toolkit | Apache 2.0. [NVIDIA-Lizenz](https://github.com/NVIDIA/nvidia-container-toolkit/blob/main/LICENSE). |
| NVIDIA CUDA 12.8.1 im GPU-Image | [NVIDIA Deep Learning Container License](https://developer.download.nvidia.com/licenses/NVIDIA_Deep_Learning_Container_License.pdf) · [CUDA 12.8.1 EULA](https://docs.nvidia.com/cuda/archive/12.8.1/eula/index.html). Das GPU-Image kommt direkt aus der llama.cpp-Registry. |

Im Embedding-Image bleiben die Lizenztexte und Drittanbieterhinweise von
ONNX Runtime und NumPy bei ihren Python-Paketen. [SentencePiece 0.2.2 von
Google](https://github.com/google/sentencepiece/tree/v0.2.2) und
[Abseil](https://github.com/abseil/abseil-cpp/tree/20260526.0) stehen unter
Apache 2.0. Die Lizenztexte für die mit SentencePiece gebündelten
[Darts-clone, esaxx und Protobuf Lite](https://github.com/google/sentencepiece/tree/v0.2.2/third_party)
liegen im Embedding-Image unter `sentencepiece/`. Die Copyright-Dateien
und exakten Quellpaket-Versionen der aus dem llama.cpp-Image kopierten
Ubuntu-Bibliotheken stehen unter `ubuntu/`.
