export default () => {
  let verifiedAssetList: Record<string, string[]> = {};
  try {
    if (process.env.VERIFIED_ASSET_LIST) {
      verifiedAssetList = JSON.parse(process.env.VERIFIED_ASSET_LIST) as Record<
        string,
        string[]
      >;
    }
  } catch {
    // Ignore parse error
  }

  return {
    horizonUrl: process.env.HORIZON_URL,
    verifiedAssetList,
  };
};
