import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";

/**
 * Where the one player's picture shows, fitted inside it on black. Several can be mounted, Watch
 * over the mini player: the newest shows the picture, and when it unmounts the one before shows
 * it again, with no break in playback.
 */
export const PlayerSurface: ComponentType<ViewProps> = requireNativeView<ViewProps>("Player");
