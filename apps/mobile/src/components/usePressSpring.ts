import {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

/** Quick and nearly critically damped: answers the finger without a visible bounce. */
export const PRESS_SPRING = {
  damping: 26,
  stiffness: 400,
  mass: 0.6,
  reduceMotion: ReduceMotion.System,
} as const;

/** Shrinks a control under the finger and springs it back, ChatGPT-style. */
export function usePressSpring(pressedScale = 0.88) {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return {
    style,
    onPressIn: () => {
      scale.value = withSpring(pressedScale, PRESS_SPRING);
    },
    onPressOut: () => {
      scale.value = withSpring(1, PRESS_SPRING);
    },
  };
}
