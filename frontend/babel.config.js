// Reanimated 4.x replaced its own plugin with react-native-worklets/plugin.
// MUST be the LAST entry in plugins or animations + gesture-handler hooks
// silently break.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-worklets/plugin"],
  };
};
