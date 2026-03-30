const { pipeline } = require("@xenova/transformers");

let extractor;

// Load model only once (VERY IMPORTANT)
const loadModel = async () => {
  if (!extractor) {
    extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }
  return extractor;
};

const generateEmbedding = async (text) => {
  const model = await loadModel();

  const output = await model(text, {
    pooling: "mean",
    normalize: true
  });

  return Array.from(output.data);
};

module.exports = {
  generateEmbedding
};