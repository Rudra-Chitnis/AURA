const cosineSimilarity = (vecA, vecB) => {

  if (!vecA || !vecB) return 0;

  const dotProduct = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);

  const magnitudeA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));

  if (magnitudeA === 0 || magnitudeB === 0) return 0;

  return dotProduct / (magnitudeA * magnitudeB);
};

module.exports = cosineSimilarity;