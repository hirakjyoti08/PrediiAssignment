import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // keep native runtimes (embedding model, FAISS) out of the bundle
  serverExternalPackages: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
    "faiss-node",
  ],
};

export default nextConfig;