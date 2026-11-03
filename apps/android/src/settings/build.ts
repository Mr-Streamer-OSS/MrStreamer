import Constants from "expo-constants";
import { Platform } from "react-native";

/** This build and the phone it runs on, as About and Diagnostics name them. */
export const build = {
  version: Constants.expoConfig?.version ?? "unknown",
  code: String(Constants.expoConfig?.android?.versionCode ?? "unknown"),
  release: Platform.OS === "android" ? String(Platform.constants.Release) : "unknown",
  api: Platform.OS === "android" ? Platform.Version : 0,
};
