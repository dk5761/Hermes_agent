// Stage 2: Reanimated plugin must be LAST in the plugin list — required by
// react-native-gesture-handler + @gorhom/bottom-sheet animations.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-reanimated/plugin"],
  };
};
