// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'expo-crypto',
          message: "Crashes on Android in SDK 58 (expo/expo#51198). Use '@/utils/secure-random'.",
        }],
      }],
    },
  },
]);
